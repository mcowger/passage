import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { MetadataRepositories, MetadataStore } from "../metadata/index.ts";
import { BranchService } from "./branches.ts";
import { GitService } from "./git.ts";
import { projectSchema, workspaceSchema } from "../../shared/domain/workspaces.ts";

const roots: string[] = [];
const stores: MetadataStore[] = [];
afterEach(async () => {
  for (const s of stores.splice(0)) {
    try {
      s.close();
    } catch {}
  }
  await Promise.all(roots.splice(0).map((r) => rm(r, { recursive: true, force: true })));
});

const git = async (cwd: string, ...args: string[]) => {
  const p = Bun.spawn(["git", "-C", cwd, ...args], { stdout: "pipe", stderr: "pipe" });
  if ((await p.exited) !== 0) throw new Error(await new Response(p.stderr).text());
};

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "passage-branches-"));
  roots.push(root);
  await git(root, "init", "-b", "main");
  await git(root, "config", "user.email", "test@example.com");
  await git(root, "config", "user.name", "Test");
  await writeFile(join(root, "base.txt"), "base\n");
  await git(root, "add", ".");
  await git(root, "commit", "-m", "base");
  // Merged branch: branched, committed, merged back into main.
  await git(root, "checkout", "-b", "feature/merged");
  await writeFile(join(root, "merged.txt"), "merged\n");
  await git(root, "add", ".");
  await git(root, "commit", "-m", "merged work");
  await git(root, "checkout", "main");
  await git(root, "merge", "--no-ff", "feature/merged", "-m", "merge merged");
  // Unmerged branch with unique work.
  await git(root, "checkout", "-b", "feature/unmerged");
  await writeFile(join(root, "unmerged.txt"), "unmerged\n");
  await git(root, "add", ".");
  await git(root, "commit", "-m", "unmerged work");
  await git(root, "checkout", "main");

  const store = new MetadataStore(join(root, "metadata.sqlite"));
  stores.push(store);
  const repos = new MetadataRepositories(store.db);
  const project = projectSchema.parse({
    id: "prj_branches",
    configuredRootPath: root,
    canonicalRootPath: root,
    displayLabel: "Branches",
    archivedAt: null,
  });
  repos.projects.save(project);
  const tracked = workspaceSchema.parse({
    id: "wsp_tracked",
    projectId: project.id,
    kind: "worktree",
    cwd: join(root, "wt-merged"),
    checkoutRoot: join(root, "wt-merged"),
    mainRepositoryRoot: root,
    branchRef: "feature/merged",
    displayLabel: "Merged work",
    locationId: null,
    ownershipState: "owned",
    markerId: null,
    markerPath: null,
    repairDetail: null,
    archivedAt: null,
  });
  repos.workspaces.save(tracked);
  const service = new BranchService(repos, new GitService());
  return { root, repos, store, project, tracked, service };
}

describe("BranchService", () => {
  test("lists live branches annotated with DB tracking and merge state", async () => {
    const f = await fixture();
    const branches = await f.service.list(f.project.id);
    const names = branches.map((b) => b.name);
    expect(names).toEqual(["feature/merged", "feature/unmerged", "main"]);
    const merged = branches.find((b) => b.name === "feature/merged")!;
    expect(merged.mergedIntoMain).toBe(true);
    expect(merged.trackedWorkspaces).toHaveLength(1);
    expect(merged.trackedWorkspaces[0]).toMatchObject({ workspaceId: "wsp_tracked", displayLabel: "Merged work" });
    expect(merged.subject).toContain("merged work");
    expect(merged.head).toMatch(/^[0-9a-f]{40}$/);
    const unmerged = branches.find((b) => b.name === "feature/unmerged")!;
    expect(unmerged.mergedIntoMain).toBe(false);
    expect(unmerged.trackedWorkspaces).toHaveLength(0);
    const main = branches.find((b) => b.name === "main")!;
    expect(main.isMain).toBe(true);
    expect(main.mergedIntoMain).toBeNull();
    f.store.close();
  });

  test("safe-deletes a merged branch and force-guards an unmerged one", async () => {
    const f = await fixture();
    const afterSafe = await f.service.remove(f.project.id, "feature/merged");
    expect(afterSafe.some((b) => b.name === "feature/merged")).toBe(false);
    const err = await f.service.remove(f.project.id, "feature/unmerged").then(
      () => undefined,
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(Error);
    expect((err as { code?: string }).code).toBe("force-required");
    // The branch is still there after the refused safe delete.
    expect((await f.service.list(f.project.id)).some((b) => b.name === "feature/unmerged")).toBe(true);
    const afterForce = await f.service.remove(f.project.id, "feature/unmerged", true);
    expect(afterForce.some((b) => b.name === "feature/unmerged")).toBe(false);
    f.store.close();
  });

  test("refuses trunk, checked-out, and unknown branches", async () => {
    const f = await fixture();
    await expect(f.service.remove(f.project.id, "main")).rejects.toMatchObject({ code: "git-failed" });
    // Check the unmerged branch out in a linked worktree: deletion must refuse.
    const wt = join(f.root, "wt-unmerged");
    await git(f.root, "worktree", "add", wt, "feature/unmerged");
    await expect(f.service.remove(f.project.id, "feature/unmerged", true)).rejects.toMatchObject({ code: "git-failed" });
    await expect(f.service.remove(f.project.id, "does/not-exist")).rejects.toBeInstanceOf(Error);
    await expect(f.service.list("prj_missing")).rejects.toMatchObject({ code: "invalid-project" });
    f.store.close();
  });
});
