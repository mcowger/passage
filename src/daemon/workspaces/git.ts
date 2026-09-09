import { realpath } from "node:fs/promises";
import { dirname, isAbsolute, join, resolve } from "node:path";
import type { DiffHunk, DiffLine, GitChangeKind, GitDiff, GitDiscovery, GitFileStatus, GitStatus } from "../../shared/domain/git.ts";

const DEFAULT_LIMIT = 512 * 1024;
const DEFAULT_TIMEOUT = 3000;
const MAX_CONCURRENCY = 4;
type Options = { signal?: AbortSignal; timeoutMs?: number; maxOutputBytes?: number };
type Result = { stdout: string; stderr: string; code: number; truncated: boolean };

export class GitError extends Error { constructor(message: string, public readonly stderr = "", public readonly code = -1) { super(message); this.name = "GitError"; } }

export class GitService {
  private active = 0;
  private waiting: (() => void)[] = [];
  constructor(private readonly limit = MAX_CONCURRENCY) { if (limit < 1) throw new RangeError("invalid concurrency"); }
  private async slot() { if (this.active >= this.limit) await new Promise<void>((r) => this.waiting.push(r)); this.active++; return () => { this.active--; this.waiting.shift()?.(); }; }
  private async run(cwd: string, args: string[], options: Options = {}): Promise<Result> {
    const release = await this.slot(); const max = options.maxOutputBytes ?? DEFAULT_LIMIT; const timeout = options.timeoutMs ?? DEFAULT_TIMEOUT;
    let p: Bun.Subprocess;
    try { p = Bun.spawn(["git", "-C", cwd, ...args], { cwd, env: { ...process.env, LC_ALL: "C" }, stdout: "pipe", stderr: "pipe" }); } catch (error) { release(); throw new GitError("Unable to start Git", String(error)); }
    let stopped = false; const kill = () => { if (p.exitCode === null) { stopped = true; p.kill(); } };
    const timer = setTimeout(kill, timeout); const abort = () => kill(); options.signal?.addEventListener("abort", abort, { once: true });
    const read = async (stream: ReadableStream<Uint8Array>) => { const reader = stream.getReader(); const chunks: Uint8Array[] = []; let size = 0; let truncated = false; try { while (true) { const x = await reader.read(); if (x.done) break; if (size < max) { const part = x.value.slice(0, max - size); chunks.push(part); size += part.length; if (part.length < x.value.length) truncated = true; } else truncated = true; } } finally { reader.releaseLock(); } return { text: new TextDecoder().decode(Buffer.concat(chunks)), truncated }; };
    try { const [out, err, code] = await Promise.all([read(p.stdout as ReadableStream<Uint8Array>), read(p.stderr as ReadableStream<Uint8Array>), p.exited]); if (stopped || options.signal?.aborted) throw new GitError(options.signal?.aborted ? "Git operation cancelled" : "Git operation timed out"); if (code !== 0) throw new GitError("Git command failed", err.text, code); return { stdout: out.text, stderr: err.text, code, truncated: out.truncated || err.truncated }; } finally { clearTimeout(timer); options.signal?.removeEventListener("abort", abort); if (p.exitCode === null) p.kill(); await p.exited.catch(() => {}); release(); }
  }
  async discover(cwd: string, options?: Options): Promise<GitDiscovery> {
    const out = await this.run(cwd, ["rev-parse", "--show-toplevel", "--git-dir", "--git-common-dir", "--abbrev-ref", "HEAD"], options); const lines = out.stdout.trimEnd().split("\n"); if (lines.length < 4) throw new GitError("Invalid Git discovery output");
    const checkoutRoot = await realpath(lines[0]); const gitDir = resolve(cwd, lines[1]); const common = resolve(cwd, lines[2]); const commonPath = await realpath(common); const repositoryRoot = commonPath.endsWith("/.git") ? dirname(commonPath) : commonPath;
    const branchRef = lines[3] === "HEAD" ? null : lines[3]; const mainCheckoutRoot = gitDir === common ? checkoutRoot : commonPath.replace(/\/\.git$/, ""); return { checkoutRoot, mainCheckoutRoot, repositoryRoot, branchRef, detached: branchRef === null };
  }
  async status(cwd: string, options?: Options): Promise<GitStatus> { const d = await this.discover(cwd, options); const r = await this.run(cwd, ["status", "--porcelain=v1", "-z", "--untracked-files=all"], options); const files: GitFileStatus[] = []; const parts = r.stdout.split("\0"); for (let i = 0; i < parts.length; i++) { const s = parts[i]; if (!s) continue; const xy = s.slice(0, 2); let path = s.slice(3), oldPath: string | undefined; if (xy[0] === "R" || xy[1] === "R") { oldPath = parts[++i]; } const conflict = xy === "UU" || xy.includes("U") || xy === "AA" || xy === "DD"; const kind: GitChangeKind = conflict ? "conflict" : xy.includes("R") ? "renamed" : xy.includes("D") ? "deleted" : xy.includes("A") || xy === "??" ? (xy === "??" ? "untracked" : "added") : "modified"; files.push({ path, oldPath, kind, staged: xy[0] !== " " && xy !== "??", workingTree: xy[1] !== " ", binary: false, submodule: xy[0] === "S" || xy[1] === "S" }); } let ahead = 0, behind = 0; try { const b = await this.run(cwd, ["rev-list", "--left-right", "--count", "HEAD...@{upstream}"], options); [behind, ahead] = b.stdout.trim().split(/\s+/).map(Number); } catch {} return { ...d, ahead: ahead || 0, behind: behind || 0, dirty: files.length > 0, conflicted: files.some((f) => f.kind === "conflict"), truncated: r.truncated, files }; }
  async diff(cwd: string, target: "staged" | "working-tree" = "working-tree", options?: Options): Promise<GitDiff[]> { const args = ["diff", "--no-ext-diff", "--no-color", "--unified=3", "--binary", ...(target === "staged" ? ["--cached"] : [])]; const r = await this.run(cwd, args, options); if (r.truncated) return [{ path: "", binary: false, oversized: true, truncated: true, additions: 0, deletions: 0, hunks: [] }]; const result: GitDiff[] = []; let current: GitDiff | undefined; let hunk: DiffHunk | undefined; for (const line of r.stdout.split("\n")) { if (line.startsWith("diff --git ")) { const m = /^diff --git a\/(.*) b\/(.*)$/.exec(line); current = { path: m?.[2] ?? "", oldPath: m?.[1], binary: false, oversized: false, truncated: false, additions: 0, deletions: 0, hunks: [] }; result.push(current); hunk = undefined; } else if (line.startsWith("Binary files") || line.startsWith("GIT binary patch")) { if (current) current.binary = true; } else if (line.startsWith("@@ ") && current) { const m = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@ ?(.*)/.exec(line); if (m) { hunk = { oldStart: +m[1], oldLines: +(m[2] ?? 1), newStart: +m[3], newLines: +(m[4] ?? 1), header: m[5], lines: [] }; current.hunks.push(hunk); } } else if (hunk && /^[ +\-]/.test(line)) { const kind: DiffLine["kind"] = line[0] === "+" ? "added" : line[0] === "-" ? "removed" : "context"; hunk.lines.push({ kind, text: line.slice(1) }); if (current) { if (kind === "added") current.additions++; if (kind === "removed") current.deletions++; } } } return result; }
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
