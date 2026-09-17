import { realpath, stat, readFile } from "node:fs/promises";
import { dirname, isAbsolute, join, resolve } from "node:path";
import type { DiffHunk, DiffLine, GitChangeKind, GitDiff, GitDiscovery, GitFileStatus, GitStatus } from "../../shared/domain/git.ts";
import { errorFields, logger } from "../logging.ts";

const DEFAULT_LIMIT = 512 * 1024;
const DEFAULT_TIMEOUT = 3000;
const MAX_CONCURRENCY = 4;
const MAX_UNTRACKED_DIFF_FILES = 20;
const MAX_UNTRACKED_DIFF_BYTES = 256 * 1024;
const UNTRACKED_DIFF_CONTEXT = 3;
const encoder = new TextEncoder();
type Options = { signal?: AbortSignal; timeoutMs?: number; maxOutputBytes?: number; allowExitCodes?: number[] };
const CONFLICTED_MERGE_TREE_ENTRY = /^[0-7]{6} [0-9a-f]{40,64} [1-3]\t(.+)$/;
type Result = { stdout: string; stderr: string; code: number; truncated: boolean };

export class GitError extends Error { constructor(message: string, public readonly stderr = "", public readonly code = -1) { super(message); this.name = "GitError"; } }

/** First meaningful line from a failed Git command, for curated error messages. */
const gitDetail = (cause: unknown): string => {
  const text = cause instanceof GitError ? cause.stderr || cause.message : "";
  return (text.split("\n")[0] ?? "").trim().replace(/^(fatal|error):\s*/i, "").replace(/\.$/, "");
};

export class GitService {
  private active = 0;
  private waiting: (() => void)[] = [];
  constructor(private readonly limit = MAX_CONCURRENCY) { if (limit < 1) throw new RangeError("invalid concurrency"); }
  private async slot() { if (this.active >= this.limit) await new Promise<void>((r) => this.waiting.push(r)); this.active++; return () => { this.active--; this.waiting.shift()?.(); }; }
  private async run(cwd: string, args: string[], options: Options = {}): Promise<Result> {
    const startedAt = performance.now();
    const operation = args[0] ?? "unknown";
    const release = await this.slot(); const max = options.maxOutputBytes ?? DEFAULT_LIMIT; const timeout = options.timeoutMs ?? DEFAULT_TIMEOUT;
    let p: Bun.Subprocess;
    try { p = Bun.spawn(["git", "-C", cwd, ...args], { cwd, env: { ...process.env, LC_ALL: "C" }, stdout: "pipe", stderr: "pipe" }); } catch (error) {
      release();
      logger("git").error("Git process could not start", { event: "git.start_failed", operation, durationMs: performance.now() - startedAt, ...errorFields(error) });
      throw new GitError("Unable to start Git", String(error));
    }
    let stopped = false; const kill = () => { if (p.exitCode === null) { stopped = true; p.kill(); } };
    const timer = setTimeout(kill, timeout); const abort = () => kill(); options.signal?.addEventListener("abort", abort, { once: true });
    const read = async (stream: ReadableStream<Uint8Array>) => { const reader = stream.getReader(); const chunks: Uint8Array[] = []; let size = 0; let truncated = false; try { while (true) { const x = await reader.read(); if (x.done) break; if (size < max) { const part = x.value.slice(0, max - size); chunks.push(part); size += part.length; if (part.length < x.value.length) truncated = true; } else truncated = true; } } finally { reader.releaseLock(); } return { text: new TextDecoder().decode(Buffer.concat(chunks)), truncated }; };
    try {
      const [out, err, code] = await Promise.all([read(p.stdout as ReadableStream<Uint8Array>), read(p.stderr as ReadableStream<Uint8Array>), p.exited]);
      const durationMs = performance.now() - startedAt;
      if (stopped || options.signal?.aborted) {
        logger("git").warn("Git operation did not complete", { event: options.signal?.aborted ? "git.cancelled" : "git.timed_out", operation, durationMs });
        throw new GitError(options.signal?.aborted ? "Git operation cancelled" : "Git operation timed out");
      }
      if (code !== 0 && !options.allowExitCodes?.includes(code)) {
        logger("git").warn("Git operation failed", { event: "git.failed", operation, durationMs, exitCode: code, stderrBytes: encoder.encode(err.text).byteLength, truncated: out.truncated || err.truncated });
        throw new GitError("Git command failed", err.text, code);
      }
      logger("git").debug("Git operation completed", { event: "git.completed", operation, durationMs, exitCode: code, truncated: out.truncated || err.truncated });
      return { stdout: out.text, stderr: err.text, code, truncated: out.truncated || err.truncated };
    } finally { clearTimeout(timer); options.signal?.removeEventListener("abort", abort); if (p.exitCode === null) p.kill(); await p.exited.catch(() => {}); release(); }
  }
  async discover(cwd: string, options?: Options): Promise<GitDiscovery> {
    const out = await this.run(cwd, ["rev-parse", "--show-toplevel", "--git-dir", "--git-common-dir", "--abbrev-ref", "HEAD"], options); const lines = out.stdout.trimEnd().split("\n"); if (lines.length < 4) throw new GitError("Invalid Git discovery output");
    const checkoutRoot = await realpath(lines[0]); const gitDir = resolve(cwd, lines[1]); const common = resolve(cwd, lines[2]); const commonPath = await realpath(common); const repositoryRoot = commonPath.endsWith("/.git") ? dirname(commonPath) : commonPath;
    const branchRef = lines[3] === "HEAD" ? null : lines[3]; const mainCheckoutRoot = gitDir === common ? checkoutRoot : commonPath.replace(/\/\.git$/, ""); return { checkoutRoot, mainCheckoutRoot, repositoryRoot, branchRef, detached: branchRef === null };
  }
  async status(cwd: string, options?: Options): Promise<GitStatus> { const d = await this.discover(cwd, options); const r = await this.run(cwd, ["status", "--porcelain=v1", "-z", "--untracked-files=all"], options); const files: GitFileStatus[] = []; const parts = r.stdout.split("\0"); for (let i = 0; i < parts.length; i++) { const s = parts[i]; if (!s) continue; const xy = s.slice(0, 2); let path = s.slice(3), oldPath: string | undefined; if (xy[0] === "R" || xy[1] === "R") { oldPath = parts[++i]; } const conflict = xy === "UU" || xy.includes("U") || xy === "AA" || xy === "DD"; const kind: GitChangeKind = conflict ? "conflict" : xy.includes("R") ? "renamed" : xy.includes("D") ? "deleted" : xy.includes("A") || xy === "??" ? (xy === "??" ? "untracked" : "added") : "modified"; files.push({ path, oldPath, kind, staged: xy[0] !== " " && xy !== "??", workingTree: xy[1] !== " ", binary: false, submodule: xy[0] === "S" || xy[1] === "S" }); } let ahead = 0, behind = 0; try { const b = await this.run(cwd, ["rev-list", "--left-right", "--count", "HEAD...@{upstream}"], options); [ahead, behind] = b.stdout.trim().split(/\s+/).map(Number); } catch {} let aheadOfMain = 0; if (d.mainCheckoutRoot && d.checkoutRoot !== d.mainCheckoutRoot && d.branchRef) { try { aheadOfMain = Number((await this.run(cwd, ["rev-list", "--count", "main..HEAD"], options)).stdout.trim()) || 0; } catch {} } return { ...d, ahead: ahead || 0, behind: behind || 0, aheadOfMain, dirty: files.length > 0, conflicted: files.some((f) => f.kind === "conflict"), truncated: r.truncated, files }; }
  /** Stage paths (repo-relative, pre-validated by the caller). */
  async stage(cwd: string, paths: string[], options?: Options): Promise<void> {
    if (paths.length === 0) throw new GitError("No paths to stage");
    await this.run(cwd, ["add", "--", ...paths], options);
  }
  /** Unstage paths (repo-relative, pre-validated by the caller). */
  async unstage(cwd: string, paths: string[], options?: Options): Promise<void> {
    if (paths.length === 0) throw new GitError("No paths to unstage");
    await this.run(cwd, ["reset", "HEAD", "--", ...paths], options);
  }
  async stageAll(cwd: string, options?: Options): Promise<void> {
    await this.run(cwd, ["add", "-A"], options);
  }
  async unstageAll(cwd: string, options?: Options): Promise<void> {
    await this.run(cwd, ["reset", "HEAD"], options);
  }
  /** Discard all changes to one repo-relative path: tracked files are
   *  restored from HEAD (index and worktree); untracked files are removed
   *  (`git clean -f`, never `-d`, so directories are refused by Git itself).
   *  Unmerged conflict paths are refused. */
  async discard(cwd: string, path: string, options?: Options): Promise<"restored" | "removed"> {
    if (!path) throw new GitError("No path to discard");
    const unmerged = await this.run(cwd, ["ls-files", "-u", "--", path], options);
    if (unmerged.stdout.trim() !== "") throw new GitError(`Cannot discard unmerged path: ${path}`);
    const tracked = await this.run(cwd, ["ls-files", "--", path], options);
    if (tracked.stdout.trim() !== "") {
      await this.run(cwd, ["restore", "--source=HEAD", "--staged", "--worktree", "--", path], options);
      return "restored";
    }
    const candidate = await stat(join(cwd, path)).catch(() => undefined);
    if (!candidate?.isFile()) throw new GitError(`Cannot discard: ${path}`);
    await this.run(cwd, ["clean", "-f", "--", path], options);
    return "removed";
  }
  /** Commit staged changes; returns the new HEAD. Empty messages and
   *  empty indexes fail via validation or Git itself. */
  async commit(cwd: string, message: string, options?: Options): Promise<string> {
    if (message.trim() === "") throw new GitError("Commit message is empty");
    await this.run(cwd, ["commit", "-m", message], options);
    return (await this.run(cwd, ["rev-parse", "HEAD"], options)).stdout.trim();
  }
  async pull(cwd: string, options?: Options): Promise<void> {
    await this.run(cwd, ["pull", "--ff-only"], { timeoutMs: 30_000, ...options });
  }
  async fetch(cwd: string, options?: Options): Promise<void> {
    await this.run(cwd, ["fetch", "--prune"], { timeoutMs: 30_000, ...options });
  }
  /** Predict the conflicts a merge would produce without mutating anything:
   *  `git merge-tree --write-tree` computes the merge from the two commits and
   *  exits 1 with the conflicted paths. Only a clean prediction may proceed to
   *  the real merge, so a failed pre-flight never leaves main mid-merge. */
  private async predictMergeConflicts(cwd: string, mainRef: string, branchRef: string, options?: Options): Promise<{ conflicted: boolean; paths: string[] }> {
    const result = await this.run(cwd, ["merge-tree", "--write-tree", mainRef, branchRef], { timeoutMs: 30_000, ...options, allowExitCodes: [1] });
    if (result.code !== 1) return { conflicted: false, paths: [] };
    const paths: string[] = [];
    for (const line of result.stdout.split("\n")) {
      const match = CONFLICTED_MERGE_TREE_ENTRY.exec(line);
      if (match && !paths.includes(match[1])) paths.push(match[1]);
    }
    return { conflicted: true, paths };
  }
  async mergeIntoMain(cwd: string, options?: Options): Promise<void> {
    const source = await this.discover(cwd, options);
    if (!source.branchRef) throw new GitError("Cannot merge a detached HEAD into main");
    if (!source.mainCheckoutRoot || source.checkoutRoot === source.mainCheckoutRoot || source.branchRef === "main") {
      throw new GitError("The main worktree or branch cannot be merged into itself");
    }
    const main = await this.discover(source.mainCheckoutRoot, options);
    if (main.branchRef !== "main") throw new GitError("The main checkout must be on the main branch before merging");
    const { conflicted, paths } = await this.predictMergeConflicts(source.mainCheckoutRoot, main.branchRef, source.branchRef, options);
    if (conflicted) {
      throw new GitError("Merge conflicts would occur", paths.length > 0 ? `Conflicting files: ${paths.join(", ")}` : "Resolve conflicts before merging into main");
    }
    await this.rebaseOntoMain(source.checkoutRoot, main.branchRef, source.branchRef, options);
    try {
      await this.run(source.mainCheckoutRoot, ["merge", "--ff-only", source.branchRef], { timeoutMs: 30_000, ...options });
    } catch (cause) {
      const detail = gitDetail(cause);
      throw new GitError(`Could not fast-forward "${main.branchRef}" to "${source.branchRef}"${detail ? `: ${detail}` : ""}`);
    }
  }

  /** Replay the source branch onto main before merging so main only ever
   *  fast-forwards. A conflicted or blocked rebase is aborted and reported,
   *  leaving the branch exactly as it was. */
  private async rebaseOntoMain(cwd: string, mainRef: string, branchRef: string, options?: Options): Promise<void> {
    try {
      await this.run(cwd, ["rebase", mainRef], { timeoutMs: 30_000, ...options });
    } catch (cause) {
      const paths = await this.unmergedPaths(cwd, options).catch(() => []);
      await this.run(cwd, ["rebase", "--abort"], { timeoutMs: 30_000, ...options }).catch(() => {});
      const detail = paths.length > 0 ? `conflicting files: ${paths.join(", ")}` : gitDetail(cause);
      throw new GitError(`Could not rebase "${branchRef}" onto "${mainRef}"${detail ? `: ${detail}` : ""}. Resolve the branch and try again.`);
    }
  }

  /** Repo-relative paths left unmerged by an in-progress Git operation. */
  private async unmergedPaths(cwd: string, options?: Options): Promise<string[]> {
    const result = await this.run(cwd, ["diff", "--name-only", "--diff-filter=U"], options);
    return [...new Set(result.stdout.split("\n").map((line) => line.trim()).filter(Boolean))];
  }
  async diff(cwd: string, target: "staged" | "working-tree" = "working-tree", options?: Options): Promise<GitDiff[]> { const args = ["diff", "--no-ext-diff", "--no-color", "--unified=3", "--binary", ...(target === "staged" ? ["--cached"] : [])]; const r = await this.run(cwd, args, options); if (r.truncated) return [{ path: "", binary: false, oversized: true, truncated: true, additions: 0, deletions: 0, hunks: [] }]; const result: GitDiff[] = []; let current: GitDiff | undefined; let hunk: DiffHunk | undefined; for (const line of r.stdout.split("\n")) { if (line.startsWith("diff --git ")) { const m = /^diff --git a\/(.*) b\/(.*)$/.exec(line); current = { path: m?.[2] ?? "", oldPath: m?.[1], binary: false, oversized: false, truncated: false, additions: 0, deletions: 0, hunks: [] }; result.push(current); hunk = undefined; } else if (line.startsWith("Binary files") || line.startsWith("GIT binary patch")) { if (current) current.binary = true; } else if (line.startsWith("@@ ") && current) { const m = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@ ?(.*)/.exec(line); if (m) { hunk = { oldStart: +m[1], oldLines: +(m[2] ?? 1), newStart: +m[3], newLines: +(m[4] ?? 1), header: m[5], lines: [] }; current.hunks.push(hunk); } } else if (hunk && /^[ +\-]/.test(line)) { const kind: DiffLine["kind"] = line[0] === "+" ? "added" : line[0] === "-" ? "removed" : "context"; hunk.lines.push({ kind, text: line.slice(1) }); if (current) { if (kind === "added") current.additions++; if (kind === "removed") current.deletions++; } } }
    if (target === "working-tree" && !r.truncated) {
      try {
        const untracked = await this.untrackedDiffs(cwd, result);
        result.push(...untracked);
      } catch {}
    }
    return result; }

  private async untrackedDiffs(cwd: string, tracked: GitDiff[]): Promise<GitDiff[]> {
    const known = new Set(tracked.map((d) => d.path));
    const status = await this.run(cwd, ["status", "--porcelain=v1", "-z", "--untracked-files=all"]);
    const parts = status.stdout.split("\0");
    const paths: string[] = [];
    for (const part of parts) {
      if (part.startsWith("?? ")) {
        const path = part.slice(3);
        if (path && !known.has(path) && paths.length < MAX_UNTRACKED_DIFF_FILES) paths.push(path);
      }
    }
    const diffs: GitDiff[] = [];
    let budget = MAX_UNTRACKED_DIFF_BYTES;
    for (const path of paths) {
      const diff = await this.untrackedFileDiff(cwd, path, budget);
      if (!diff) continue;
      budget -= diff.bytes;
      diffs.push(diff.entry);
      if (budget <= 0) break;
    }
    return diffs;
  }

  private async untrackedFileDiff(cwd: string, path: string, budget: number): Promise<{ entry: GitDiff; bytes: number } | undefined> {
    if (budget <= 0) return undefined;
    const root = await realpath(cwd);
    const candidate = resolve(root, path);
    const relative = candidate === root ? "" : candidate.slice(root.length + 1);
    if (!relative || relative.startsWith("..") || isAbsolute(relative)) return undefined;
    let size = 0;
    try {
      const s = await stat(candidate);
      if (!s.isFile()) return undefined;
      size = s.size;
    } catch { return undefined; }
    if (size > budget) {
      return { entry: { path, binary: false, oversized: true, truncated: true, additions: 0, deletions: 0, hunks: [] }, bytes: size };
    }
    let data: Buffer;
    try {
      data = await readFile(candidate);
    } catch { return undefined; }
    if (data.includes(0)) {
      return { entry: { path, binary: true, oversized: false, truncated: false, additions: 0, deletions: 0, hunks: [] }, bytes: size };
    }
    const text = new TextDecoder().decode(data);
    const fileLines = text.split("\n");
    if (fileLines.at(-1) === "") fileLines.pop();
    const hunks: DiffHunk[] = [];
    for (let start = 0; start < fileLines.length; start += UNTRACKED_DIFF_CONTEXT * 2 + 50) {
      const chunk = fileLines.slice(start, start + UNTRACKED_DIFF_CONTEXT * 2 + 50);
      hunks.push({
        oldStart: 0,
        oldLines: 0,
        newStart: start + 1,
        newLines: chunk.length,
        header: "untracked file",
        lines: chunk.map((lineText) => ({ kind: "added" as const, text: lineText })),
      });
    }
    const entry: GitDiff = { path, binary: false, oversized: false, truncated: false, additions: fileLines.length, deletions: 0, hunks };
    // Empty untracked file: still surface an add entry with no hunks so the UI
    // shows "No text differences found" on the file card instead of an empty diff.
    return { entry, bytes: size };
  }
  async listWorktrees(cwd: string, options?: Options): Promise<Array<{ path: string; head: string; branchRef: string | null; isBare: boolean; isLocked: boolean; lockReason?: string; isPrunable: boolean }>> {
    const r = await this.run(cwd, ["worktree", "list", "--porcelain"], options);
    const entries: Array<{ path: string; head: string; branchRef: string | null; isBare: boolean; isLocked: boolean; lockReason?: string; isPrunable: boolean }> = [];
    const blocks = r.stdout.trim().split(/\n\n+/);
    for (const block of blocks) {
      if (!block.trim()) continue;
      const lines = block.split("\n");
      let path = "";
      let head = "";
      let branchRef: string | null = null;
      let isBare = false;
      let isLocked = false;
      let lockReason: string | undefined;
      let isPrunable = false;
      for (const line of lines) {
        if (line.startsWith("worktree ")) path = line.slice("worktree ".length).trim();
        else if (line.startsWith("HEAD ")) head = line.slice("HEAD ".length).trim();
        else if (line.startsWith("branch refs/heads/")) branchRef = line.slice("branch refs/heads/".length).trim();
        else if (line.startsWith("branch ")) branchRef = line.slice("branch ".length).trim();
        else if (line === "detached") branchRef = null;
        else if (line === "bare") isBare = true;
        else if (line.startsWith("locked")) { isLocked = true; lockReason = line.slice("locked".length).trim() || undefined; }
        else if (line.startsWith("prunable")) isPrunable = true;
      }
      if (path) {
        const canonical = await realpath(path).catch(() => path);
        entries.push({ path: canonical, head, branchRef, isBare, isLocked, lockReason, isPrunable });
      }
    }
    return entries;
  }
}
