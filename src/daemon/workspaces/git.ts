import { realpath, stat, readFile } from "node:fs/promises";
import { dirname, isAbsolute, join, resolve } from "node:path";
import type { DiffHunk, DiffLine, GitChangeKind, GitDiff, GitDiscovery, GitFileStatus, GitStatus } from "../../shared/domain/git.ts";
import { errorFields, logger } from "../logging.ts";
import { sanitizedSubprocessEnv } from "../env.ts";

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

export type GitBranchEntry = { name: string; head: string; upstream: string | null; lastCommitAt: string | null; subject: string };

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
    try { p = Bun.spawn(["git", "-C", cwd, ...args], { cwd, env: sanitizedSubprocessEnv({ LC_ALL: "C" }), stdout: "pipe", stderr: "pipe" }); } catch (error) {
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
  async status(cwd: string, options?: Options): Promise<GitStatus> {
    const d = await this.discover(cwd, options);
    const r = await this.run(cwd, ["status", "--porcelain=v1", "-z", "--untracked-files=all"], options);
    const files: GitFileStatus[] = [];
    const parts = r.stdout.split("\0");
    for (let i = 0; i < parts.length; i++) { const s = parts[i]; if (!s) continue; const xy = s.slice(0, 2); let path = s.slice(3), oldPath: string | undefined; if (xy[0] === "R" || xy[1] === "R") { oldPath = parts[++i]; } const conflict = xy === "UU" || xy.includes("U") || xy === "AA" || xy === "DD"; const kind: GitChangeKind = conflict ? "conflict" : xy.includes("R") ? "renamed" : xy.includes("D") ? "deleted" : xy.includes("A") || xy === "??" ? (xy === "??" ? "untracked" : "added") : "modified"; files.push({ path, oldPath, kind, staged: xy[0] !== " " && xy !== "??", workingTree: xy[1] !== " ", binary: false, submodule: xy[0] === "S" || xy[1] === "S" }); }
    let ahead = 0, behind = 0, hasUpstream = false;
    try {
      await this.run(cwd, ["rev-parse", "--verify", "--symbolic-full-name", "@{upstream}"], options);
      hasUpstream = true;
      try {
        const b = await this.run(cwd, ["rev-list", "--left-right", "--count", "HEAD...@{upstream}"], options);
        [ahead, behind] = b.stdout.trim().split(/\s+/).map(Number);
      } catch {}
    } catch {
      hasUpstream = false;
    }
    let aheadOfMain = 0, behindMain = 0;
    if (d.mainCheckoutRoot && d.checkoutRoot !== d.mainCheckoutRoot && d.branchRef) {
      try { aheadOfMain = Number((await this.run(cwd, ["rev-list", "--count", "main..HEAD"], options)).stdout.trim()) || 0; } catch {}
      try { behindMain = Number((await this.run(cwd, ["rev-list", "--count", "HEAD..main"], options)).stdout.trim()) || 0; } catch {}
    }
    return { ...d, ahead: ahead || 0, behind: behind || 0, aheadOfMain, behindMain, hasUpstream, dirty: files.length > 0, conflicted: files.some((f) => f.kind === "conflict"), truncated: r.truncated, files };
  }
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
  /** Replay the branch onto main without merging, so a diverged main can be
   *  picked up before merging. Same guards as merge: never on main itself. */
  async rebase(cwd: string, options?: Options): Promise<void> {
    const source = await this.discover(cwd, options);
    if (!source.branchRef) throw new GitError("Cannot rebase a detached HEAD onto main");
    if (!source.mainCheckoutRoot || source.checkoutRoot === source.mainCheckoutRoot || source.branchRef === "main") {
      throw new GitError("The main worktree or branch cannot be rebased onto itself");
    }
    const main = await this.discover(source.mainCheckoutRoot, options);
    if (main.branchRef !== "main") throw new GitError("The main checkout must be on the main branch before rebasing");
    await this.rebaseOnto(source.checkoutRoot, main.branchRef, source.branchRef, options);
  }

  /** Default branch of a remote (e.g. `origin` -> `main`), from the remote
   *  HEAD symref. Falls back to `main` when the remote or symref is unknown. */
  async remoteDefaultBranch(cwd: string, remote = "origin", options?: Options): Promise<string> {
    const name = remote.trim() || "origin";
    try {
      const out = await this.run(cwd, ["symbolic-ref", `refs/remotes/${name}/HEAD`], options);
      const ref = out.stdout.trim();
      const prefix = `refs/remotes/${name}/`;
      if (ref.startsWith(prefix) && ref.length > prefix.length) return ref.slice(prefix.length);
    } catch {}
    return "main";
  }

  /** Fetch the remote, then replay the branch onto `<remote>/<base>`.
   *  Same worktree guards as the local rebase; conflicts abort cleanly and
   *  are reported with the conflicting files, leaving the branch as it was. */
  async rebaseOntoRemote(cwd: string, remote = "origin", base?: string, options?: Options): Promise<{ remote: string; base: string }> {
    const source = await this.discover(cwd, options);
    if (!source.branchRef) throw new GitError("Cannot rebase a detached HEAD");
    if (!source.mainCheckoutRoot || source.checkoutRoot === source.mainCheckoutRoot || source.branchRef === "main") {
      throw new GitError("The main worktree or branch cannot be rebased onto itself");
    }
    const resolvedRemote = remote.trim() || "origin";
    await this.run(cwd, ["fetch", "--prune", resolvedRemote], { timeoutMs: 30_000, ...options });
    const resolvedBase = base?.trim() || (await this.remoteDefaultBranch(cwd, resolvedRemote, options));
    const ontoRef = `${resolvedRemote}/${resolvedBase}`;
    try {
      await this.run(cwd, ["rev-parse", "--verify", ontoRef], options);
    } catch {
      throw new GitError(`Remote branch "${ontoRef}" was not found after fetching. Check the remote and base name.`);
    }
    await this.rebaseOnto(source.checkoutRoot, ontoRef, source.branchRef, options);
    return { remote: resolvedRemote, base: resolvedBase };
  }

  /** Committed branch diff against a base, for PR titles/descriptions.
   *  Resolves the base to the first ref that exists (`origin/<default>`,
   *  then local `main`/`master`), diffs from the merge-base to HEAD, and
   *  truncates the raw diff to 100KB so prompts stay bounded. */
  async branchDiffForPr(cwd: string, base?: string, options?: Options): Promise<{ base: string; mergeBase: string; files: Array<{ path: string; kind: string }>; diff: string; truncated: boolean }> {
    const source = await this.discover(cwd, options);
    if (!source.branchRef) throw new GitError("Cannot describe a detached HEAD as a pull request");
    const candidates = base?.trim()
      ? [base.trim()]
      : [`origin/${await this.remoteDefaultBranch(cwd, "origin", options)}`, "main", "master"];
    let resolved: string | undefined;
    for (const candidate of candidates) {
      try {
        await this.run(cwd, ["rev-parse", "--verify", candidate], options);
        resolved = candidate;
        break;
      } catch {}
    }
    if (!resolved) throw new GitError("No base branch was found to compare against. Fetch the remote and try again.");
    const mergeBase = (await this.run(cwd, ["merge-base", resolved, "HEAD"], options)).stdout.trim();
    if (!mergeBase) throw new GitError(`Could not find a merge-base with "${resolved}"`);
    const names = await this.run(cwd, ["diff", "--name-status", "-z", mergeBase, "HEAD"], { timeoutMs: 30_000, ...options });
    const files: Array<{ path: string; kind: string }> = [];
    // With -z, status and paths are separate NUL-terminated fields:
    // `A\0path\0`, renames as `R100\0old\0new\0`.
    const parts = names.stdout.split("\0");
    for (let i = 0; i < parts.length; i++) {
      const token = parts[i].trim();
      if (!token || !/^[A-Z][0-9]*$/.test(token)) continue;
      const code = token.slice(0, 1);
      const kind = code === "A" ? "added" : code === "D" ? "deleted" : code === "R" ? "renamed" : code === "U" ? "conflict" : "modified";
      if (code === "R" || code === "C") {
        const from = (parts[++i] ?? "").trim();
        const to = (parts[++i] ?? "").trim();
        if (from && to) files.push({ path: `${from} -> ${to}`, kind });
        else if (to) files.push({ path: to, kind });
      } else {
        const path = (parts[++i] ?? "").trim();
        if (path) files.push({ path, kind });
      }
    }
    const raw = await this.run(cwd, ["diff", "--no-ext-diff", "--no-color", "--unified=3", mergeBase, "HEAD", "--"], { timeoutMs: 30_000, maxOutputBytes: 100 * 1024, ...options });
    return { base: resolved, mergeBase, files, diff: raw.stdout, truncated: raw.truncated };
  }
  /** Push the current branch. When no upstream exists yet (first push),
   *  the branch is published with `push -u origin <branch>` so Push and
   *  "publish" stay one action; otherwise a plain `push` is used. */
  async push(cwd: string, options?: Options): Promise<void> {
    const source = await this.discover(cwd, options);
    if (!source.branchRef) throw new GitError("Cannot push a detached HEAD");
    let hasUpstream = true;
    try {
      await this.run(cwd, ["rev-parse", "--verify", "--symbolic-full-name", "@{upstream}"], options);
    } catch {
      hasUpstream = false;
    }
    if (hasUpstream) {
      await this.run(cwd, ["push"], { timeoutMs: 30_000, ...options });
      return;
    }
    try {
      await this.run(cwd, ["push", "-u", "origin", source.branchRef], { timeoutMs: 30_000, ...options });
    } catch (cause) {
      const detail = gitDetail(cause);
      throw new GitError(`Could not push "${source.branchRef}" to origin${detail ? `: ${detail}` : ""}. Check the remote and try again.`);
    }
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
    await this.rebaseOnto(source.checkoutRoot, main.branchRef, source.branchRef, options);
    try {
      await this.run(source.mainCheckoutRoot, ["merge", "--ff-only", source.branchRef], { timeoutMs: 30_000, ...options });
    } catch (cause) {
      const detail = gitDetail(cause);
      throw new GitError(`Could not fast-forward "${main.branchRef}" to "${source.branchRef}"${detail ? `: ${detail}` : ""}`);
    }
  }

  /** Replay the source branch onto a target ref before merging so main only
   *  ever fast-forwards. A conflicted or blocked rebase is aborted and
   *  reported, leaving the branch exactly as it was. */
  private async rebaseOnto(cwd: string, ontoRef: string, branchRef: string, options?: Options): Promise<void> {
    try {
      await this.run(cwd, ["rebase", ontoRef], { timeoutMs: 30_000, ...options });
    } catch (cause) {
      const paths = await this.unmergedPaths(cwd, options).catch(() => []);
      await this.run(cwd, ["rebase", "--abort"], { timeoutMs: 30_000, ...options }).catch(() => {});
      const detail = paths.length > 0 ? `conflicting files: ${paths.join(", ")}` : gitDetail(cause);
      throw new GitError(`Could not rebase "${branchRef}" onto "${ontoRef}"${detail ? `: ${detail}` : ""}. Resolve the branch and try again.`);
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

  /** Every local branch with last-commit metadata, for project branch review.
   *  Bounded to 500 branches; subjects are truncated to 500 chars so one
   *  pathological commit message cannot bloat the snapshot. */
  async listBranches(cwd: string, options?: Options): Promise<GitBranchEntry[]> {
    const r = await this.run(
      cwd,
      ["for-each-ref", "--format=%(refname:short)%1f%(objectname)%1f%(upstream:short)%1f%(committerdate:iso-strict)%1f%(subject)", "refs/heads"],
      { maxOutputBytes: 1024 * 1024, ...options },
    );
    const entries: GitBranchEntry[] = [];
    for (const line of r.stdout.split("\n")) {
      if (!line.trim()) continue;
      const parts = line.split("\x1f");
      const name = (parts[0] ?? "").trim();
      if (!name) continue;
      entries.push({
        name,
        head: (parts[1] ?? "").trim(),
        upstream: (parts[2] ?? "").trim() || null,
        lastCommitAt: (parts[3] ?? "").trim() || null,
        subject: (parts[4] ?? "").trim().slice(0, 500),
      });
      if (entries.length >= 500) break;
    }
    return entries;
  }

  /** Names fully merged into `base` (e.g. `main`), for the merged badge.
   *  Returns an empty set when the base ref does not exist. */
  async mergedBranches(cwd: string, base: string, options?: Options): Promise<Set<string>> {
    try {
      await this.run(cwd, ["rev-parse", "--verify", base], options);
    } catch {
      return new Set();
    }
    const r = await this.run(cwd, ["branch", "--format=%(refname:short)", "--merged", base], options);
    return new Set(r.stdout.split("\n").map((l) => l.trim().replace(/^[*+]\s*/, "")).filter(Boolean));
  }

  /** Delete one local branch. Safe by default (`-d` refuses unmerged work);
   *  `force` escalates to `-D` and must only follow an explicit second
   *  confirm. Refuses branches checked out in any linked worktree and the
   *  `main`/`master` trunk itself; arg injection is closed by the `--`
   *  separator plus a leading-dash/empty-path rejection. */
  async deleteBranch(cwd: string, branch: string, force = false, options?: Options): Promise<void> {
    const name = branch.trim();
    if (!name || name === "HEAD" || name.startsWith("-") || name.includes("\0") || name.includes("..")) {
      throw new GitError(`Invalid branch name: "${branch}"`);
    }
    if (name === "main" || name === "master") {
      throw new GitError(`The "${name}" branch cannot be deleted`);
    }
    const worktrees = await this.listWorktrees(cwd, options).catch(() => []);
    const checkedOut = worktrees.find((w) => w.branchRef === name);
    if (checkedOut) {
      throw new GitError(`Branch "${name}" is checked out in ${checkedOut.path}. Remove the worktree first.`);
    }
    try {
      await this.run(cwd, ["branch", force ? "-D" : "-d", "--", name], { timeoutMs: 30_000, ...options });
    } catch (cause) {
      const detail = gitDetail(cause);
      if (!force && /not fully merged/i.test(detail)) {
        throw new GitError(`Branch "${name}" is not fully merged`, `Not fully merged. Force delete to discard it${detail ? `: ${detail}` : ""}.`);
      }
      throw new GitError(detail ? `Could not delete branch "${name}": ${detail}` : `Could not delete branch "${name}"`);
    }
  }
}
