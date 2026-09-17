import { createHash } from "node:crypto";
import { lstat, mkdir, opendir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import fuzzysort from "fuzzysort";
import { MAX_DIRECTORY_ENTRIES, MAX_FILE_BYTES, type FileEntry, type FileListing, type FileRead, type FileRevision, type FileWrite } from "../../shared/domain/files.ts";
import { WorkspaceService, WorkspaceError } from "./service.ts";

export class FileError extends Error { constructor(public readonly code: "not-found" | "invalid-path" | "outside-root" | "archived" | "not-file" | "not-directory" | "binary" | "oversize" | "conflict" | "io", message: string) { super(message); this.name = "FileError"; } }

const GIT_SEARCH_TIMEOUT_MS = 2000;
const MAX_GIT_LS_BYTES = 5_000_000;
const MAX_NAME_LENGTH = 255;
function validateName(name: string): void {
  if (!name || name.length > MAX_NAME_LENGTH || name === "." || name === ".." || name.includes("/") || name.includes("\\") || name.includes("\0")) {
    throw new FileError("invalid-path", "Invalid file name");
  }
}

function validateRelativePath(path: string): void {
  if (!path || path === ".") throw new FileError("invalid-path", "Invalid path");
  const parts = path.split("/");
  for (const part of parts) {
    if (!part || part === "." || part === "..") throw new FileError("invalid-path", "Invalid path");
    validateName(part);
  }
}

function duplicateName(name: string, attempt: number): string {
  const dot = name.lastIndexOf(".");
  const hasExt = dot > 0 && dot < name.length - 1;
  const stem = hasExt ? name.slice(0, dot) : name;
  const ext = hasExt ? name.slice(dot) : "";
  const suffix = attempt === 0 ? " copy" : ` copy ${attempt + 1}`;
  return `${stem}${suffix}${ext}`;
}
const hash = (data: Uint8Array) => createHash("sha256").update(data).digest("hex");
const revision = (s: { mtimeMs: number; size: number }, h: string): FileRevision => ({ hash: h, modifiedAt: s.mtimeMs, size: s.size });

export class FileService {
  constructor(private readonly workspaces: WorkspaceService, private readonly maxBytes = MAX_FILE_BYTES, private readonly maxEntries = MAX_DIRECTORY_ENTRIES) {}
  async list(workspaceId: string, path = ".", cursor?: string): Promise<FileListing> {
    const absolute = await this.resolve(workspaceId, path); const info = await this.safeStat(absolute);
    if (!info.isDirectory()) throw new FileError("not-directory", "Path is not a directory");
    const start = cursor ? Number(cursor) : 0; if (!Number.isInteger(start) || start < 0) throw new FileError("invalid-path", "Invalid directory cursor");
    const entries: FileEntry[] = [];
    let index = 0;
    let hasMore = false;
    const directory = await opendir(absolute);
    try {
      while (true) {
        const item = await directory.read();
        if (!item) break;
        if (!item.isDirectory() && !item.isFile()) continue;
        if (index++ < start) continue;
        if (entries.length >= this.maxEntries) { hasMore = true; break; }
        const child = join(absolute, item.name); const kind = item.isDirectory() ? "directory" : "file";
        let rev: FileRevision | null = null; if (kind === "file") { const s = await stat(child); if (s.size <= this.maxBytes) rev = revision(s, hash(await readFile(child))); }
        entries.push({ name: item.name, kind, path: path === "." ? item.name : `${path}/${item.name}`, revision: rev });
      }
    } finally {
      await directory.close();
    }
    if (!hasMore && start > index) throw new FileError("invalid-path", "Invalid directory cursor");
    return { path, entries, nextCursor: hasMore ? String(start + entries.length) : null };
  }
  async read(workspaceId: string, path: string): Promise<FileRead> { const absolute = await this.resolve(workspaceId, path); const s = await this.safeStat(absolute); if (!s.isFile()) throw new FileError("not-file", "Path is not a file"); if (s.size > this.maxBytes) throw new FileError("oversize", "File is too large"); const data = await readFile(absolute); if (data.includes(0)) throw new FileError("binary", "Binary files are not supported"); return { path, content: new TextDecoder().decode(data), revision: revision(s, hash(data)) }; }
  /**
   * Bounded case-insensitive substring/prefix match from the workspace
   * canonical root. Used by the composer `@` autocomplete. Never follows
   * symlinks; rejects traversal via `resolve()`.
   *
   * Respects gitignore: inside a git checkout the candidate set comes from
   * `git ls-files --cached --others --exclude-standard`, so ignored
   * untracked paths (node_modules/, dist/, .data/, *.har, ...) never
   * surface as mentions. Tracked files still surface even when they match
   * an ignore pattern, matching git semantics. Outside a git checkout it
   * falls back to a bounded walk (always skipping `.git`).
   */
  async search(workspaceId: string, query: string, limit = 20): Promise<{ entries: { path: string; kind: "file" | "directory" }[]; truncated: boolean }> {
    const capped = Math.min(Math.max(Math.floor(limit) || 20, 1), 50);
    const needle = query.slice(0, 64).toLowerCase();
    const root = await this.resolve(workspaceId, ".");
    const gitFiles = await this.listGitFiles(root);
    if (gitFiles !== null) return this.searchGitEntries(root, gitFiles, needle, capped);
    const matches: { path: string; kind: "file" | "directory"; score: number }[] = [];
    const queue: { absolute: string; relative: string }[] = [{ absolute: root, relative: "." }];
    let visited = 0;
    const MAX_VISITED = 5000;
    while (queue.length > 0 && visited < MAX_VISITED && matches.length < capped * 4) {
      const current = queue.shift()!;
      let directory;
      try {
        directory = await opendir(current.absolute);
      } catch {
        continue;
      }
      try {
        while (visited < MAX_VISITED) {
          const item = await directory.read();
          if (!item) break;
          if (!item.isDirectory() && !item.isFile()) continue;
          // `.git` internals are never mentionable, git or not.
          if (item.name === ".git") continue;
          visited += 1;
          const relativePath = current.relative === "." ? item.name : `${current.relative}/${item.name}`;
          if (relativePath.length > 4096) continue;
          const kind = item.isDirectory() ? "directory" : "file";
          if (kind === "directory") {
            // Never follow symlinked directories; opendir follows Dirent
            // type only for real dirs, but double-check via lstat.
            try {
              const childAbsolute = join(current.absolute, item.name);
              const linkCheck = await lstat(childAbsolute);
              if (linkCheck.isSymbolicLink()) continue;
              queue.push({ absolute: childAbsolute, relative: relativePath });
            } catch {
              continue;
            }
          } else {
            try {
              const childAbsolute = join(current.absolute, item.name);
              if ((await lstat(childAbsolute)).isSymbolicLink()) continue;
            } catch {
              continue;
            }
          }
          if (!needle) {
            matches.push({ path: relativePath, kind, score: 1 });
            continue;
          }
          const lowered = relativePath.toLowerCase();
          const base = item.name.toLowerCase();
          if (base.startsWith(needle)) matches.push({ path: relativePath, kind, score: 0 });
          else if (lowered.includes(needle)) matches.push({ path: relativePath, kind, score: 1 });
        }
      } finally {
        await directory.close();
      }
    }
    matches.sort((a, b) => a.score - b.score || (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
    const truncated = matches.length > capped;
    return { entries: matches.slice(0, capped).map(({ path, kind }) => ({ path, kind })), truncated };
  }
  /**
   * Non-ignored file paths under `root` via git, relative to `root`
   * (`git -C root` scopes output to the subtree). Returns null when `root`
   * is not in a git checkout or git fails, so callers fall back to a walk.
   */
  private async listGitFiles(root: string): Promise<string[] | null> {
    let process: ReturnType<typeof Bun.spawn>;
    try {
      process = Bun.spawn(
        ["git", "-C", root, "ls-files", "--cached", "--others", "--exclude-standard", "-z"],
        { stdout: "pipe", stderr: "ignore" },
      );
    } catch {
      return null;
    }
    const timeout = setTimeout(() => {
      if (process.exitCode === null) process.kill();
    }, GIT_SEARCH_TIMEOUT_MS);
    try {
      const buffer = await new Response(process.stdout as ReadableStream).arrayBuffer();
      if (await process.exited !== 0) return null;
      if (buffer.byteLength > MAX_GIT_LS_BYTES) return null;
      const text = new TextDecoder().decode(buffer);
      const files = text
        .split("\0")
        .filter((entry) => entry.length > 0 && entry.length <= 4096)
        .filter((entry) => !entry.startsWith("/") && !entry.split("/").includes(".."));
      return files;
    } catch {
      return null;
    } finally {
      clearTimeout(timeout);
      if (process.exitCode === null) process.kill();
      await process.exited;
    }
  }
  /**
   * Score/filter a git file list with the same prefix-first ordering as the
   * walk fallback. Directories are derived from file parents (an ignored
   * directory has no non-ignored files under it, so it never surfaces).
   * Symlinks are re-checked via lstat to preserve the no-follow invariant.
   */
  private async searchGitEntries(
    root: string,
    gitFiles: string[],
    needle: string,
    capped: number,
  ): Promise<{ entries: { path: string; kind: "file" | "directory" }[]; truncated: boolean }> {
    const directories = new Set<string>();
    for (const file of gitFiles) {
      const parts = file.split("/");
      for (let depth = 1; depth < parts.length; depth += 1) {
        directories.add(parts.slice(0, depth).join("/"));
      }
    }
    const scored: { path: string; kind: "file" | "directory"; score: number }[] = [];
    const score = (relativePath: string): number | null => {
      if (!needle) return 1;
      const lowered = relativePath.toLowerCase();
      const base = relativePath.split("/").at(-1)!.toLowerCase();
      if (base.startsWith(needle)) return 0;
      if (lowered.includes(needle)) return 1;
      return null;
    };
    for (const file of gitFiles) {
      const value = score(file);
      if (value !== null) scored.push({ path: file, kind: "file", score: value });
    }
    for (const directory of directories) {
      const value = score(directory);
      if (value !== null) scored.push({ path: directory, kind: "directory", score: value });
    }
    scored.sort((a, b) => a.score - b.score || (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
    const truncated = scored.length > capped;
    const entries: { path: string; kind: "file" | "directory" }[] = [];
    for (const candidate of scored) {
      if (entries.length >= capped) break;
      try {
        if ((await lstat(join(root, candidate.path))).isSymbolicLink()) continue;
      } catch {
        continue;
      }
      entries.push({ path: candidate.path, kind: candidate.kind });
    }
    return { entries, truncated };
  }
  listDirectory(workspaceId: string, path = ".", cursor?: string) { return this.list(workspaceId, path, cursor); }
  /**
   * Suggest child directories for the Add Project directory picker.
   * Splits a partial host path into a base directory plus a trailing
   * prefix, then fuzzy-matches child directory names server-side.
   * Read-only and bounded; an unresolvable base yields an empty list
   * (not an error) since live typing constantly produces intermediate
   * states. Symlinked children are listed as-is; the final choice is
   * resolved/canonicalized by `registerProject` before it is persisted.
   */
  async suggestDirectories(partialPath: string, limit = 20): Promise<{ base: string; entries: { name: string; path: string }[]; truncated: boolean }> {
    const capped = Math.min(Math.max(Math.floor(limit) || 20, 1), 50);
    const home = process.env.HOME || homedir();
    const trimmed = partialPath.trim();
    let base: string;
    let prefix: string;
    if (trimmed === "" || trimmed === "~") {
      base = home;
      prefix = "";
    } else {
      const expanded = trimmed.startsWith("~") ? join(home, trimmed.slice(1)) : trimmed;
      const absolute = expanded.startsWith("/") ? expanded : resolve(home, expanded);
      if (absolute.endsWith("/")) {
        base = absolute.slice(0, -1) || "/";
        prefix = "";
      } else {
        base = dirname(absolute);
        prefix = basename(absolute);
      }
    }
    try {
      if (!(await stat(base)).isDirectory()) return { base, entries: [], truncated: false };
    } catch {
      return { base, entries: [], truncated: false };
    }
    const names: string[] = [];
    try {
      const directory = await opendir(base);
      try {
        while (names.length < MAX_DIRECTORY_ENTRIES) {
          const item = await directory.read();
          if (!item) break;
          if (!item.isDirectory()) continue;
          names.push(item.name);
        }
      } finally {
        await directory.close();
      }
    } catch {
      return { base, entries: [], truncated: false };
    }
    const ordered: string[] = prefix === "" ? [...names].sort() : fuzzysort.go(prefix, names, { threshold: -10000 }).map((result) => result.target);
    const truncated = ordered.length > capped;
    return { base, entries: ordered.slice(0, capped).map((name) => ({ name, path: join(base, name) })), truncated };
  }
  readFile(workspaceId: string, path: string) { return this.read(workspaceId, path); }
  writeFile(workspaceId: string, path: string, content: string, expected: FileRevision) { return this.write(workspaceId, path, content, expected); }
  async create(workspaceId: string, path: string, kind: "file" | "directory"): Promise<FileEntry> {
    validateRelativePath(path);
    const absolute = await this.resolveForCreate(workspaceId, path);
    try {
      await lstat(absolute);
      throw new FileError("conflict", "A file or directory already exists at that path");
    } catch (e) {
      if (e instanceof FileError) throw e;
      if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw new FileError("io", "Failed to create path");
    }
    try {
      if (kind === "directory") {
        await mkdir(absolute, { recursive: false });
        return { name: basename(path), kind: "directory", path, revision: null };
      }
      await writeFile(absolute, "", { flag: "wx" });
      const s = await stat(absolute);
      return { name: basename(path), kind: "file", path, revision: revision(s, hash(Buffer.from(""))) };
    } catch (e) {
      if (e instanceof FileError) throw e;
      if ((e as NodeJS.ErrnoException).code === "EEXIST") throw new FileError("conflict", "A file or directory already exists at that path");
      throw new FileError("io", "Failed to create path");
    }
  }
  async rename(workspaceId: string, path: string, newPath: string): Promise<{ path: string }> {
    validateRelativePath(path);
    validateRelativePath(newPath);
    if (path === newPath) throw new FileError("invalid-path", "Source and destination are the same");
    const sourceAbsolute = await this.resolve(workspaceId, path);
    await this.safeStat(sourceAbsolute);
    // Prevent moving a directory into itself or one of its children.
    if (newPath === path || newPath.startsWith(`${path}/`)) throw new FileError("invalid-path", "Cannot move a directory into itself");
    const destAbsolute = await this.resolveForCreate(workspaceId, newPath);
    try {
      await lstat(destAbsolute);
      throw new FileError("conflict", "A file or directory already exists at the destination");
    } catch (e) {
      if (e instanceof FileError) throw e;
      if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw new FileError("io", "Failed to rename path");
    }
    try {
      await rename(sourceAbsolute, destAbsolute);
    } catch {
      throw new FileError("io", "Failed to rename path");
    }
    return { path: newPath };
  }
  async remove(workspaceId: string, path: string): Promise<{ path: string }> {
    validateRelativePath(path);
    const absolute = await this.resolve(workspaceId, path);
    await this.safeStat(absolute);
    try {
      await rm(absolute, { recursive: true, force: false });
    } catch {
      throw new FileError("io", "Failed to delete path");
    }
    return { path };
  }
  async duplicate(workspaceId: string, path: string): Promise<{ path: string }> {
    validateRelativePath(path);
    const sourceAbsolute = await this.resolve(workspaceId, path);
    const sourceStat = await this.safeStat(sourceAbsolute);
    if (!sourceStat.isFile()) throw new FileError("not-file", "Only files can be duplicated");
    if (sourceStat.size > this.maxBytes) throw new FileError("oversize", "File is too large to duplicate");
    const parentRequestPath = dirname(path);
    const parentAbsolute = await this.resolve(workspaceId, parentRequestPath);
    const sourceName = basename(path);
    let destName = "";
    let destAbsolute = "";
    let found = false;
    for (let attempt = 0; attempt < 100; attempt++) {
      const candidate = duplicateName(sourceName, attempt);
      validateName(candidate);
      const candidateAbsolute = join(parentAbsolute, candidate);
      try {
        await lstat(candidateAbsolute);
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code === "ENOENT") {
          destName = candidate;
          destAbsolute = candidateAbsolute;
          found = true;
          break;
        }
        throw new FileError("io", "Failed to duplicate file");
      }
    }
    if (!found) throw new FileError("conflict", "Could not find an available duplicate name");
    try {
      const data = await readFile(sourceAbsolute);
      if (data.includes(0)) throw new FileError("binary", "Binary files are not supported");
      await writeFile(destAbsolute, data, { flag: "wx" });
    } catch (e) {
      if (e instanceof FileError) throw e;
      if ((e as NodeJS.ErrnoException).code === "EEXIST") throw new FileError("conflict", "A file or directory already exists at the destination");
      throw new FileError("io", "Failed to duplicate file");
    }
    const destRequestPath = parentRequestPath === "." ? destName : `${parentRequestPath}/${destName}`;
    return { path: destRequestPath };
  }
  async write(workspaceId: string, path: string, content: string, expected: FileRevision): Promise<FileWrite> {
    if (Buffer.byteLength(content) > this.maxBytes || content.includes("\0")) throw new FileError(content.includes("\0") ? "binary" : "oversize", "Content is not supported");
    const absolute = await this.resolveForWrite(workspaceId, path); let before: FileRevision | null = null;
    try { const s = await stat(absolute); if (!s.isFile()) throw new FileError("not-file", "Path is not a file"); const data = await readFile(absolute); before = revision(s, hash(data)); } catch (e) { if (e instanceof FileError) throw e; }
    if (!before || before.hash !== expected.hash || before.modifiedAt !== expected.modifiedAt || before.size !== expected.size) throw new FileError("conflict", "File revision changed");
    const latest = await this.current(absolute); if (!latest || latest.hash !== expected.hash || latest.modifiedAt !== expected.modifiedAt || latest.size !== expected.size) throw new FileError("conflict", "File revision changed");
    const temporary = `${absolute}.passage-${crypto.randomUUID()}`; try { await writeFile(temporary, content, { flag: "wx" }); const final = await this.current(absolute); if (!final || final.hash !== expected.hash || final.modifiedAt !== expected.modifiedAt || final.size !== expected.size) throw new FileError("conflict", "File revision changed"); await rename(temporary, absolute); const s = await stat(absolute); return { path, revision: revision(s, hash(Buffer.from(content))) }; } finally { await rm(temporary, { force: true }); }
  }
  private async resolve(id: string, path: string) { try { return await this.workspaces.resolvePath(id, path); } catch (e) { if (e instanceof WorkspaceError) throw new FileError(e.code === "archived" ? "archived" : e.code === "outside-root" ? "outside-root" : e.code === "not-found" ? "not-found" : "invalid-path", e.message); throw e; } }
  private async resolveForWrite(id: string, path: string) { const parent = await this.resolve(id, dirname(path)); const absolute = join(parent, path.split(/[\\/]/).pop()!); try { const s = await lstat(absolute); if (s.isSymbolicLink()) throw new FileError("outside-root", "Symlinks are not writable"); } catch (e) { if (e instanceof FileError || (e as NodeJS.ErrnoException).code !== "ENOENT") throw e; } return absolute; }
  private async resolveForCreate(id: string, path: string) { const parent = await this.resolve(id, dirname(path)); const name = basename(path); validateName(name); const absolute = join(parent, name); try { const s = await lstat(absolute); if (s.isSymbolicLink()) throw new FileError("outside-root", "Symlinks are not writable"); } catch (e) { if (e instanceof FileError || (e as NodeJS.ErrnoException).code !== "ENOENT") throw e; } return absolute; }
  private async safeStat(path: string) { try { const s = await lstat(path); if (s.isSymbolicLink()) throw new FileError("outside-root", "Symlinks are not allowed"); return s; } catch (e) { if (e instanceof FileError) throw e; throw new FileError("not-found", "Path does not exist"); } }
  private async current(path: string): Promise<FileRevision | null> { try { const s = await stat(path); const data = await readFile(path); return revision(s, hash(data)); } catch { return null; } }
}
