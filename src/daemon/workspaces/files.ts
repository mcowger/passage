import { createHash } from "node:crypto";
import { lstat, readdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { MAX_DIRECTORY_ENTRIES, MAX_FILE_BYTES, type FileEntry, type FileListing, type FileRead, type FileRevision, type FileWrite } from "../../shared/domain/files.ts";
import { WorkspaceService, WorkspaceError } from "./service.ts";

export class FileError extends Error { constructor(public readonly code: "not-found" | "invalid-path" | "outside-root" | "archived" | "not-file" | "not-directory" | "binary" | "oversize" | "too-many-entries" | "conflict" | "io", message: string) { super(message); this.name = "FileError"; } }
const hash = (data: Uint8Array) => createHash("sha256").update(data).digest("hex");
const revision = (s: { mtimeMs: number; size: number }, h: string): FileRevision => ({ hash: h, modifiedAt: s.mtimeMs, size: s.size });

export class FileService {
  constructor(private readonly workspaces: WorkspaceService, private readonly maxBytes = MAX_FILE_BYTES, private readonly maxEntries = MAX_DIRECTORY_ENTRIES) {}
  async list(workspaceId: string, path = ".", cursor?: string): Promise<FileListing> {
    const absolute = await this.resolve(workspaceId, path); const info = await this.safeStat(absolute);
    if (!info.isDirectory()) throw new FileError("not-directory", "Path is not a directory");
    const all = await readdir(absolute, { withFileTypes: true }); if (all.length > this.maxEntries) throw new FileError("too-many-entries", "Directory contains too many entries");
    const start = cursor ? Number(cursor) : 0; if (!Number.isInteger(start) || start < 0 || start > all.length) throw new FileError("invalid-path", "Invalid directory cursor");
    const entries: FileEntry[] = [];
    for (const item of all.slice(start, start + this.maxEntries)) {
      const child = join(absolute, item.name); let kind: "file" | "directory";
      if (item.isDirectory()) kind = "directory"; else if (item.isFile()) kind = "file"; else continue;
      let rev: FileRevision | null = null; if (kind === "file") { const s = await stat(child); if (s.size <= this.maxBytes) rev = revision(s, hash(await readFile(child))); }
      entries.push({ name: item.name, kind, path: path === "." ? item.name : `${path}/${item.name}`, revision: rev });
    }
    return { path, entries, nextCursor: start + entries.length < all.length ? String(start + entries.length) : null };
  }
  async read(workspaceId: string, path: string): Promise<FileRead> { const absolute = await this.resolve(workspaceId, path); const s = await this.safeStat(absolute); if (!s.isFile()) throw new FileError("not-file", "Path is not a file"); if (s.size > this.maxBytes) throw new FileError("oversize", "File is too large"); const data = await readFile(absolute); if (data.includes(0)) throw new FileError("binary", "Binary files are not supported"); return { path, content: new TextDecoder().decode(data), revision: revision(s, hash(data)) }; }
  listDirectory(workspaceId: string, path = ".", cursor?: string) { return this.list(workspaceId, path, cursor); }
  readFile(workspaceId: string, path: string) { return this.read(workspaceId, path); }
  writeFile(workspaceId: string, path: string, content: string, expected: FileRevision) { return this.write(workspaceId, path, content, expected); }
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
  private async safeStat(path: string) { try { const s = await lstat(path); if (s.isSymbolicLink()) throw new FileError("outside-root", "Symlinks are not allowed"); return s; } catch (e) { if (e instanceof FileError) throw e; throw new FileError("not-found", "Path does not exist"); } }
  private async current(path: string): Promise<FileRevision | null> { try { const s = await stat(path); const data = await readFile(path); return revision(s, hash(data)); } catch { return null; } }
}
