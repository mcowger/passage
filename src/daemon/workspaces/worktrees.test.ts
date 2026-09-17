import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { MetadataRepositories, MetadataStore } from "../metadata/index.ts";
import { WorkspaceService } from "./service.ts";
import { WorktreeService } from "./worktrees.ts";
import { GitService } from "./git.ts";

const roots: string[] = [];
const git = async (cwd: string, ...args: string[]) => {
  const p = Bun.spawn(["git", "-C", cwd, ...args], { stdout: "pipe", stderr: "pipe" });
  if ((await p.exited) !== 0) throw new Error(await new Response(p.stderr).text());
};

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "passage-wt-test-"));
  roots.push(root);
  const repo = join(root, "repo");
  await mkdir(repo);
  await git(repo, "init", "-b", "main");
  await git(repo, "config", "user.email", "test@example.com");
  await git(repo, "config", "user.name", "Test");
  await writeFile(join(repo, "README.md"), "# Test\n");
  await git(repo, "add", ".");
  await git(repo, "commit", "-m", "initial");

  const store = new MetadataStore(join(root, "metadata.sqlite"));
  const repositories = new MetadataRepositories(store.db);
  const workspaceService = new WorkspaceService(repositories);
  const gitService = new GitService();
  const worktreeService = new WorktreeService(repositories, gitService);

  const project = await workspaceService.registerProject(repo, "Test Project");
  return { root, repo, store, repositories, workspaceService, worktreeService, gitService, project };
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((r) => rm(r, { recursive: true, force: true })));
});

describe("WorktreeService discovery and import", () => {
  test("discovers worktrees and identifies registered vs unregistered", async () => {
    const f = await fixture();
    const wtPath = join(f.root, "wt-feature");
    await git(f.repo, "worktree", "add", "-b", "feature-branch", wtPath);

    const discovered = await f.worktreeService.discover(f.project.id);
    expect(discovered.length).toBe(2);

    const mainEntry = discovered.find((d) => d.isMain);
    expect(mainEntry).toBeDefined();
    expect(mainEntry?.branchRef).toBe("main");

    const featureEntry = discovered.find((d) => d.branchRef === "feature-branch");
    expect(featureEntry).toBeDefined();
    expect(featureEntry?.isRegistered).toBe(false);
    expect(featureEntry?.isMain).toBe(false);
  });

  test("imports an existing worktree into Passage", async () => {
    const f = await fixture();
    const wtPath = join(f.root, "wt-feature");
    await git(f.repo, "worktree", "add", "-b", "feature-branch", wtPath);

    const imported = await f.worktreeService.importWorktree(f.project.id, {
      path: wtPath,
      label: "My Feature",
    });

    expect(imported.id).toBeDefined();
    expect(imported.projectId).toBe(f.project.id);
    expect(imported.displayLabel).toBe("My Feature");
    expect(imported.branchRef).toBe("feature-branch");
    expect(imported.kind).toBe("worktree");
    expect(imported.ownershipState).toBe("unowned");

    // After import, discover should report it as registered
    const discovered = await f.worktreeService.discover(f.project.id);
    const featureEntry = discovered.find((d) => d.branchRef === "feature-branch");
    expect(featureEntry?.isRegistered).toBe(true);
    expect(featureEntry?.workspaceId).toBe(imported.id);
  });

  test("rejects worktrees from a different repository", async () => {
    const f = await fixture();
    const otherRepo = join(f.root, "other");
    await mkdir(otherRepo);
    await git(otherRepo, "init", "-b", "main");
    await git(otherRepo, "config", "user.email", "test@example.com");
    await git(otherRepo, "config", "user.name", "Test");
    await writeFile(join(otherRepo, "README.md"), "# Other\n");
    await git(otherRepo, "add", ".");
    await git(otherRepo, "commit", "-m", "initial");

    await expect(
      f.worktreeService.importWorktree(f.project.id, { path: otherRepo })
    ).rejects.toMatchObject({ code: "wrong-project" });
  });
});

describe("WorktreeService creation", () => {
  test("creates a worktree on an existing ref", async () => {
    const f = await fixture();
    await git(f.repo, "branch", "existing-feature");
    const locations = join(f.root, "locations");
    await mkdir(locations);
    const location = await f.workspaceService.configureLocation({ displayLabel: "Test", configuredRootPath: locations });
    const workspace = await f.worktreeService.create(f.project.id, location.id, "existing-feature", "Feature", "wt-feature");
    expect(workspace.branchRef).toBe("existing-feature");
    expect(workspace.displayLabel).toBe("Feature");
  });

  test("rejects a missing ref with an actionable error", async () => {
    const f = await fixture();
    const locations = join(f.root, "locations");
    await mkdir(locations);
    const location = await f.workspaceService.configureLocation({ displayLabel: "Test", configuredRootPath: locations });
    const failure = await f.worktreeService.create(f.project.id, location.id, "feature/does-not-exist", "Feature").then(
      () => null,
      (error: unknown) => error as { code: string; message: string },
    );
    expect(failure?.code).toBe("ref-not-found");
    expect(failure?.message).toContain("feature/does-not-exist");
  });

  test("creates a new branch from a base ref", async () => {
    const f = await fixture();
    const locations = join(f.root, "locations");
    await mkdir(locations);
    const location = await f.workspaceService.configureLocation({ displayLabel: "Test", configuredRootPath: locations });
    const workspace = await f.worktreeService.create(f.project.id, location.id, "feature/brand-new", "Feature", "wt-new", {
      createBranch: true,
      baseRef: "main",
    });
    expect(workspace.branchRef).toBe("feature/brand-new");
  });

  test("rejects new-branch creation when the branch already exists", async () => {
    const f = await fixture();
    const locations = join(f.root, "locations");
    await mkdir(locations);
    const location = await f.workspaceService.configureLocation({ displayLabel: "Test", configuredRootPath: locations });
    const failure = await f.worktreeService.create(f.project.id, location.id, "main", "Feature", undefined, {
      createBranch: true,
      baseRef: "main",
    }).then(
      () => null,
      (error: unknown) => error as { code: string },
    );
    expect(failure?.code).toBe("branch-exists");
  });
});

describe("WorktreeService removal and reconciliation", () => {
  test("removes an owned worktree without requiring an on-disk marker", async () => {
    const f = await fixture();
    await git(f.repo, "branch", "branch-to-remove");
    const locations = join(f.root, "locations");
    await mkdir(locations);
    const location = await f.workspaceService.configureLocation({ displayLabel: "Test", configuredRootPath: locations });
    const workspace = await f.worktreeService.create(f.project.id, location.id, "branch-to-remove", "To Remove", "wt-remove");

    expect(workspace.ownershipState).toBe("owned");
    expect(workspace.markerId).toBeNull();
    expect(workspace.markerPath).toBeNull();

    // Verify git worktree is clean and no marker file was written
    const markerExists = await Bun.file(join(workspace.cwd, ".passage-worktree.json")).exists();
    expect(markerExists).toBe(false);

    await f.worktreeService.remove(workspace.id);

    expect(f.repositories.workspaces.get(workspace.id)).toBeUndefined();
    const exists = await Bun.file(workspace.cwd).exists().catch(() => false);
    expect(exists).toBe(false);
  });

  test("removes legacy marker file if present during removal", async () => {
    const f = await fixture();
    await git(f.repo, "branch", "legacy-branch");
    const locations = join(f.root, "locations");
    await mkdir(locations);
    const location = await f.workspaceService.configureLocation({ displayLabel: "Test", configuredRootPath: locations });
    const workspace = await f.worktreeService.create(f.project.id, location.id, "legacy-branch", "Legacy", "wt-legacy");

    // Simulate a legacy marker file left on disk
    const legacyMarker = join(workspace.cwd, ".passage-worktree.json");
    await writeFile(legacyMarker, JSON.stringify({ formatVersion: 1, workspaceId: workspace.id }));
    expect(await Bun.file(legacyMarker).exists()).toBe(true);

    await f.worktreeService.remove(workspace.id);
    expect(f.repositories.workspaces.get(workspace.id)).toBeUndefined();
  });

  test("rejects removal of an unowned worktree", async () => {
    const f = await fixture();
    const wtPath = join(f.root, "wt-unowned");
    await git(f.repo, "worktree", "add", "-b", "unowned-branch", wtPath);
    const imported = await f.worktreeService.importWorktree(f.project.id, { path: wtPath });

    await expect(f.worktreeService.remove(imported.id)).rejects.toMatchObject({
      code: "not-owned",
    });
  });

  test("reconciles an owned worktree without an on-disk marker", async () => {
    const f = await fixture();
    await git(f.repo, "branch", "branch-to-reconcile");
    const locations = join(f.root, "locations");
    await mkdir(locations);
    const location = await f.workspaceService.configureLocation({ displayLabel: "Test", configuredRootPath: locations });
    const workspace = await f.worktreeService.create(f.project.id, location.id, "branch-to-reconcile", "Reconcile", "wt-reconcile");

    const reconciled = await f.worktreeService.reconcile(workspace.id);
    expect(reconciled.ownershipState).toBe("owned");
    expect(reconciled.repairDetail).toBeNull();
  });

  test("handles worktree whose directory was already removed from disk", async () => {
    const f = await fixture();
    await git(f.repo, "branch", "branch-deleted-manually");
    const locations = join(f.root, "locations");
    await mkdir(locations);
    const location = await f.workspaceService.configureLocation({ displayLabel: "Test", configuredRootPath: locations });
    const workspace = await f.worktreeService.create(f.project.id, location.id, "branch-deleted-manually", "Deleted", "wt-deleted");

    // Delete directory manually from disk
    await rm(workspace.cwd, { recursive: true, force: true });

    // Should gracefully clean up without throwing
    await f.worktreeService.remove(workspace.id);
    expect(f.repositories.workspaces.get(workspace.id)).toBeUndefined();
  });
});
