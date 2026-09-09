import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { GitError, GitService } from "./git.ts";

const roots: string[] = [];
const git = async (cwd: string, ...args: string[]) => { const p = Bun.spawn(["git", "-C", cwd, ...args], { stdout: "pipe", stderr: "pipe" }); if (await p.exited !== 0) throw new Error(await new Response(p.stderr).text()); };
const fixture = async () => { const root = await mkdtemp(join(tmpdir(), "passage-git-")); roots.push(root); await git(root, "init", "-b", "main"); await git(root, "config", "user.email", "test@example.com"); await git(root, "config", "user.name", "Test"); return root; };
afterEach(async () => { await Promise.all(roots.splice(0).map((r) => rm(r, { recursive: true, force: true }))); });

describe("GitService", () => {
  test("discovers main checkout and linked worktree", async () => { const root = await fixture(); await writeFile(join(root, "file with spaces"), "one\n"); await git(root, "add", "."); await git(root, "commit", "-m", "initial"); const service = new GitService(); expect((await service.discover(root)).checkoutRoot).toBe(root); const wt = join(root, "linked worktree"); await git(root, "worktree", "add", "-b", "linked", wt); const d = await service.discover(wt); expect(d.checkoutRoot).toBe(wt); expect(d.mainCheckoutRoot).toBe(root); });
  test("normalizes paths, rename, untracked, detached and ahead/behind", async () => { const root = await fixture(); await writeFile(join(root, "old name"), "x\n"); await git(root, "add", "."); await git(root, "commit", "-m", "initial"); await git(root, "mv", "old name", "new name"); await writeFile(join(root, "untracked file"), "u"); const s = await new GitService().status(root); expect(s.files.map((f) => f.kind)).toEqual(expect.arrayContaining(["renamed", "untracked"])); await git(root, "commit", "-am", "rename"); await git(root, "checkout", "--detach", "HEAD"); expect((await new GitService().discover(root)).detached).toBe(true); });
  test("returns structured binary and hunks", async () => { const root = await fixture(); await writeFile(join(root, "a.txt"), "one\ntwo\n"); await git(root, "add", "."); await git(root, "commit", "-m", "initial"); await writeFile(join(root, "a.txt"), "one\nthree\n"); const diffs = await new GitService().diff(root); expect(diffs[0].hunks[0].lines.some((x) => x.kind === "added")).toBe(true); });
  test("lists linked worktrees via porcelain", async () => {
    const root = await fixture();
    await writeFile(join(root, "file.txt"), "hello\n");
    await git(root, "add", ".");
    await git(root, "commit", "-m", "initial");
    const service = new GitService();
    const wt = join(root, "linked-wt");
    await git(root, "worktree", "add", "-b", "feature-x", wt);
    const list = await service.listWorktrees(root);
    expect(list.length).toBe(2);
    expect(list.some((w) => w.branchRef === "main")).toBe(true);
    expect(list.some((w) => w.branchRef === "feature-x")).toBe(true);
  });
  test("honors cancellation, limits, and git failures", async () => { const root = await fixture(); const service = new GitService(); const controller = new AbortController(); controller.abort(); await expect(service.status(root, { signal: controller.signal })).rejects.toBeInstanceOf(GitError); await expect(service.status(join(root, "missing"))).rejects.toBeInstanceOf(GitError); const r = await service.diff(root, "working-tree", { maxOutputBytes: 2 }); expect(r[0]?.oversized ?? true).toBe(true); });
  test("renders untracked files as add-only diffs in the working tree", async () => {
    const root = await fixture();
    await writeFile(join(root, "tracked.txt"), "one\n");
    await git(root, "add", ".");
    await git(root, "commit", "-m", "initial");
    await writeFile(join(root, "new-file.txt"), "alpha\nbeta\n");
    const diffs = await new GitService().diff(root, "working-tree");
    const untracked = diffs.find((d) => d.path === "new-file.txt");
    expect(untracked).toBeDefined();
    expect(untracked?.additions).toBe(2);
    expect(untracked?.deletions).toBe(0);
    expect(untracked?.hunks.length).toBeGreaterThan(0);
    expect(untracked?.hunks[0].lines.every((l) => l.kind === "added")).toBe(true);
  });
  test("omits untracked diffs from the staged target", async () => {
    const root = await fixture();
    await writeFile(join(root, "tracked.txt"), "one\n");
    await git(root, "add", ".");
    await git(root, "commit", "-m", "initial");
    await writeFile(join(root, "new-file.txt"), "alpha\n");
    const diffs = await new GitService().diff(root, "staged");
    expect(diffs.find((d) => d.path === "new-file.txt")).toBeUndefined();
  });
  test("marks binary and oversized untracked files without reading full contents", async () => {
    const root = await fixture();
    await writeFile(join(root, "tracked.txt"), "one\n");
    await git(root, "add", ".");
    await git(root, "commit", "-m", "initial");
    await writeFile(join(root, "blob.bin"), Buffer.from([0x00, 0x01, 0x02]));
    const diffs = await new GitService().diff(root, "working-tree");
    expect(diffs.find((d) => d.path === "blob.bin")?.binary).toBe(true);
  });
});
