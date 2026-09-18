import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { MetadataRepositories, MetadataStore } from "../metadata/index.ts";
import { WorkspaceService } from "../workspaces/service.ts";
import { GitService } from "../workspaces/git.ts";
import { WorkspaceEventHub } from "../workspaces/events.ts";
import type { EventEnvelope } from "../../shared/protocol/index.ts";
import { createGitRoutes } from "./git.ts";
import { projectSchema, workspaceSchema } from "../../shared/domain/workspaces.ts";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((r) => rm(r, { recursive: true, force: true })));
});

async function runGit(cwd: string, args: string[]) {
  const p = Bun.spawn(["git", "-C", cwd, ...args], { stdout: "ignore", stderr: "ignore" });
  await p.exited;
}

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "passage-git-http-"));
  roots.push(root);

  await runGit(root, ["init", "-b", "main"]);
  await runGit(root, ["config", "user.email", "test@passage.dev"]);
  await runGit(root, ["config", "user.name", "Passage Test"]);

  await writeFile(join(root, "README.md"), "# Init");
  await runGit(root, ["add", "README.md"]);
  await runGit(root, ["commit", "-m", "Initial commit"]);

  const store = new MetadataStore(join(root, "metadata.sqlite"));
  const repos = new MetadataRepositories(store.db);
  const workspaces = new WorkspaceService(repos);
  const git = new GitService();
  const events = new WorkspaceEventHub();
  const received: EventEnvelope[] = [];
  const subscription = events.subscribe("wsp_git", 0, (e) => received.push(e));
  subscription.activate();
  const app = createGitRoutes(workspaces, git, events);

  const project = projectSchema.parse({
    id: "prj_git",
    configuredRootPath: root,
    canonicalRootPath: root,
    displayLabel: "Git Project",
    archivedAt: null,
  });
  repos.projects.save(project);

  const workspace = workspaceSchema.parse({
    id: "wsp_git",
    projectId: project.id,
    kind: "directory",
    cwd: root,
    checkoutRoot: root,
    mainRepositoryRoot: root,
    branchRef: "main",
    displayLabel: "Git Workspace",
    locationId: null,
    ownershipState: "not-owned",
    markerId: null,
    markerPath: null,
    repairDetail: null,
    archivedAt: null,
  });
  repos.workspaces.save(workspace);

  return { root, store, repos, app, workspace, events, received };
}

const request = (path: string, init?: RequestInit) => new Request(`http://localhost${path}`, init);

describe("git HTTP API", () => {
  test("reports git status and calculates structured diffs", async () => {
    const f = await fixture();

    // Modify README and add a new file
    await writeFile(join(f.root, "README.md"), "# Init\nUpdated line");
    await writeFile(join(f.root, "new-file.txt"), "New file content");

    const statusRes = await f.app.fetch(request(`/api/workspaces/${f.workspace.id}/git/status`));
    expect(statusRes.status).toBe(200);
    const status = await statusRes.json() as { files: Array<{ path: string; kind: string }>; dirty: boolean };
    expect(status.dirty).toBe(true);
    expect(status.files.some((file) => file.path === "README.md" && file.kind === "modified")).toBe(true);
    expect(status.files.some((file) => file.path === "new-file.txt" && file.kind === "untracked")).toBe(true);

    const diffRes = await f.app.fetch(request(`/api/workspaces/${f.workspace.id}/git/diff?target=working-tree`));
    expect(diffRes.status).toBe(200);
    const diffs = await diffRes.json() as Array<{ path: string; additions: number; hunks: Array<{ lines: Array<{ kind: string; text: string }> }> }>;
    expect(diffs.some((d) => d.path === "README.md" && d.additions > 0)).toBe(true);

    f.store.close();
  });

  test("mutates git state and emits git-status-changed invalidations", async () => {
    const f = await fixture();
    const post = (suffix: string, body: unknown) => f.app.fetch(
      request(`/api/workspaces/${f.workspace.id}/git/${suffix}`, { method: "POST", body: JSON.stringify(body) }),
    );
    const reasons = () => f.received.map((e) => (e.payload as { reason: string }).reason);

    await writeFile(join(f.root, "README.md"), "# Init\nUpdated line");
    await writeFile(join(f.root, "new-file.txt"), "New file content");

    const stageRes = await post("stage", { paths: ["README.md"] });
    expect(stageRes.status).toBe(200);
    const staged = await stageRes.json() as { files: Array<{ path: string; staged: boolean }> };
    expect(staged.files.find((file) => file.path === "README.md")?.staged).toBe(true);

    const unstageRes = await post("unstage", { paths: ["README.md"] });
    expect(unstageRes.status).toBe(200);
    expect(((await unstageRes.json()) as typeof staged).files.find((file) => file.path === "README.md")?.staged).toBe(false);

    expect((await post("stage-all", {})).status).toBe(200);
    const commitRes = await post("commit", { message: "second" });
    expect(commitRes.status).toBe(200);
    const commit = await commitRes.json() as { head: string; status: { dirty: boolean } };
    expect(commit.head).toMatch(/^[0-9a-f]{40}$/);
    expect(commit.status.dirty).toBe(false);

    await writeFile(join(f.root, "README.md"), "# Init\nAnother line");
    expect((await post("discard", { path: "README.md" })).status).toBe(200);
    await writeFile(join(f.root, "scratch.txt"), "tmp");
    expect((await post("discard", { path: "scratch.txt" })).status).toBe(200);
    expect((await post("unstage-all", {})).status).toBe(200);

    // Reads, invalid bodies, and failed mutations emit nothing.
    await f.app.fetch(request(`/api/workspaces/${f.workspace.id}/git/status`));
    await f.app.fetch(request(`/api/workspaces/${f.workspace.id}/git/diff`));
    expect((await post("stage", { paths: [] })).status).toBe(400);
    expect((await post("stage", { paths: ["../escape.txt"] })).status).toBe(400);
    expect((await post("commit", { message: "   " })).status).toBe(400);
    expect((await post("commit", { message: "nothing staged" })).status).toBe(422);
    expect((await post("discard", { path: "missing.txt" })).status).toBe(422);

    expect(reasons()).toEqual(["stage", "unstage", "stage-all", "commit", "discard", "discard", "unstage-all"]);
    expect(f.received.every((e) => e.stream === "workspace" && e.subjectId === f.workspace.id && e.type === "git-status-changed")).toBe(true);
    expect(f.received.map((e) => e.sequence)).toEqual([1, 2, 3, 4, 5, 6, 7]);

    f.store.close();
  });

  test("merges a linked worktree branch into main and publishes an invalidation", async () => {
    const f = await fixture();
    const received: EventEnvelope[] = [];
    const subscription = f.events.subscribe("wsp_feature", 0, (event) => received.push(event));
    subscription.activate();
    const worktree = join(f.root, "feature-worktree");
    await runGit(f.root, ["worktree", "add", "-b", "feature", worktree]);
    await writeFile(join(worktree, "feature.txt"), "feature\n");
    await runGit(worktree, ["add", "."]);
    await runGit(worktree, ["commit", "-m", "feature"]);
    const workspace = workspaceSchema.parse({
      id: "wsp_feature",
      projectId: "prj_git",
      kind: "worktree",
      cwd: worktree,
      checkoutRoot: worktree,
      mainRepositoryRoot: f.root,
      branchRef: "feature",
      displayLabel: "Feature",
      locationId: null,
      ownershipState: "owned",
      markerId: null,
      markerPath: null,
      repairDetail: null,
      archivedAt: null,
    });
    f.repos.workspaces.save(workspace);

    const response = await f.app.fetch(request(`/api/workspaces/${workspace.id}/git/merge`, { method: "POST", body: "{}" }));
    expect(response.status).toBe(200);
    expect((await readFile(join(f.root, "feature.txt"), "utf8"))).toBe("feature\n");
    expect(received.at(-1)?.payload).toEqual({ workspaceId: workspace.id, reason: "merge" });

    subscription.unsubscribe();
    f.store.close();
  });

  test("reports a conflicting merge as a 422 without leaving main mid-merge", async () => {
    const f = await fixture();
    const worktree = join(f.root, "conflict-worktree");
    await runGit(f.root, ["worktree", "add", "-b", "feature", worktree]);
    await writeFile(join(worktree, "README.md"), "# Feature");
    await runGit(worktree, ["commit", "-am", "feature change"]);
    await writeFile(join(f.root, "README.md"), "# Main");
    await runGit(f.root, ["commit", "-am", "main change"]);
    const workspace = workspaceSchema.parse({
      id: "wsp_conflict",
      projectId: "prj_git",
      kind: "worktree",
      cwd: worktree,
      checkoutRoot: worktree,
      mainRepositoryRoot: f.root,
      branchRef: "feature",
      displayLabel: "Feature",
      locationId: null,
      ownershipState: "owned",
      markerId: null,
      markerPath: null,
      repairDetail: null,
      archivedAt: null,
    });
    f.repos.workspaces.save(workspace);

    const response = await f.app.fetch(request(`/api/workspaces/${workspace.id}/git/merge`, { method: "POST", body: "{}" }));
    expect(response.status).toBe(422);
    const body = await response.json() as { error: string; message?: string };
    expect(body.error).toBe("git-failed");
    expect(body.message).toContain("README.md");
    expect(await readFile(join(f.root, "README.md"), "utf8")).toBe("# Main");

    f.store.close();
  });
  test("auto-commits dirty files with a generated message, then reports clean", async () => {
    const root = await mkdtemp(join(tmpdir(), "passage-git-auto-"));
    roots.push(root);
    await runGit(root, ["init", "-b", "main"]);
    await runGit(root, ["config", "user.email", "test@passage.dev"]);
    await runGit(root, ["config", "user.name", "Passage Test"]);
    await writeFile(join(root, "README.md"), "# Init");
    await runGit(root, ["add", "README.md"]);
    await runGit(root, ["commit", "-m", "Initial commit"]);

    const store = new MetadataStore(join(root, "metadata.sqlite"));
    const repos = new MetadataRepositories(store.db);
    const workspaces = new WorkspaceService(repos);
    const git = new GitService();
    const seen: Array<{ files: Array<{ path: string; kind: string }>; diff: string; template: string }> = [];
    const stub = {
      suggestCommit: async (files: Array<{ path: string; kind: string }>, diff: string, _cwd?: string, _model?: string, _thinking?: string, template = "") => {
        seen.push({ files, diff, template });
        return "Update README and add notes";
      },
    };
    const app = createGitRoutes(workspaces, git, undefined, stub);
    repos.projects.save(projectSchema.parse({
      id: "prj_auto",
      configuredRootPath: root,
      canonicalRootPath: root,
      displayLabel: "Auto Project",
      archivedAt: null,
    }));
    const workspace = workspaceSchema.parse({
      id: "wsp_auto",
      projectId: "prj_auto",
      kind: "directory",
      cwd: root,
      checkoutRoot: root,
      mainRepositoryRoot: root,
      branchRef: "main",
      displayLabel: "Auto Workspace",
      locationId: null,
      ownershipState: "not-owned",
      markerId: null,
      markerPath: null,
      repairDetail: null,
      archivedAt: null,
    });
    repos.workspaces.save(workspace);

    await writeFile(join(root, "README.md"), "# Init\nUpdated line");
    await writeFile(join(root, "new-file.txt"), "New file content");

    const res = await app.fetch(request(`/api/workspaces/${workspace.id}/git/commit-auto`, { method: "POST", body: JSON.stringify({}) }));
    expect(res.status).toBe(200);
    const body = await res.json() as { head: string; message: string; status: { dirty: boolean } };
    expect(body.head).toMatch(/^[0-9a-f]{40}$/);
    expect(body.message).toBe("Update README and add notes");
    expect(body.status.dirty).toBe(false);
    // The generator saw both the file list and the overall diff.
    expect(seen.length).toBe(1);
    expect(seen[0].files.some((f) => f.path === "README.md")).toBe(true);
    expect(seen[0].files.some((f) => f.path === "new-file.txt")).toBe(true);
    expect(seen[0].diff).toContain("Updated line");

    const clean = await app.fetch(request(`/api/workspaces/${workspace.id}/git/commit-auto`, { method: "POST", body: JSON.stringify({}) }));
    expect(clean.status).toBe(422);

    store.close();
  });

  test("auto-commit falls back to a deterministic message and honors stored prompt", async () => {
    const root = await mkdtemp(join(tmpdir(), "passage-git-auto-fallback-"));
    roots.push(root);
    await runGit(root, ["init", "-b", "main"]);
    await runGit(root, ["config", "user.email", "test@passage.dev"]);
    await runGit(root, ["config", "user.name", "Passage Test"]);
    await writeFile(join(root, "README.md"), "# Init");
    await runGit(root, ["add", "README.md"]);
    await runGit(root, ["commit", "-m", "Initial commit"]);

    const store = new MetadataStore(join(root, "metadata.sqlite"));
    const repos = new MetadataRepositories(store.db);
    const workspaces = new WorkspaceService(repos);
    const git = new GitService();
    let capturedTemplate: string | undefined;
    const nullStub = {
      suggestCommit: async (_files: Array<{ path: string; kind: string }>, _diff: string, _cwd?: string, _model?: string, _thinking?: string, template = "") => {
        capturedTemplate = template;
        return null;
      },
    };
    const app = createGitRoutes(workspaces, git, undefined, nullStub);
    repos.projects.save(projectSchema.parse({
      id: "prj_fallback",
      configuredRootPath: root,
      canonicalRootPath: root,
      displayLabel: "Fallback Project",
      archivedAt: null,
    }));
    const workspace = workspaceSchema.parse({
      id: "wsp_fallback",
      projectId: "prj_fallback",
      kind: "directory",
      cwd: root,
      checkoutRoot: root,
      mainRepositoryRoot: root,
      branchRef: "main",
      displayLabel: "Fallback Workspace",
      locationId: null,
      ownershipState: "not-owned",
      markerId: null,
      markerPath: null,
      repairDetail: null,
      archivedAt: null,
    });
    repos.workspaces.save(workspace);
    const settings = workspaces.getSettings(workspace.id);
    workspaces.saveSettings(workspace.id, { ...settings, commitPrompt: "CUSTOM {{files}} {{diff}}" });

    await writeFile(join(root, "notes.txt"), "hello");
    const res = await app.fetch(request(`/api/workspaces/${workspace.id}/git/commit-auto`, { method: "POST", body: JSON.stringify({}) }));
    expect(res.status).toBe(200);
    const body = await res.json() as { head: string; message: string; status: { dirty: boolean } };
    expect(body.message).toContain("notes.txt");
    expect(body.status.dirty).toBe(false);
    expect(capturedTemplate).toBe("CUSTOM {{files}} {{diff}}");

    store.close();
  });

  test("reports a conflicted pre-merge rebase as a 422 with a specific message", async () => {
    const f = await fixture();
    const worktree = join(f.root, "rebase-conflict-worktree");
    await runGit(f.root, ["worktree", "add", "-b", "feature", worktree]);
    // Feature edits then reverts the line, so the final merge is clean but
    // replaying its middle commit onto main conflicts.
    await writeFile(join(worktree, "README.md"), "# Feature");
    await runGit(worktree, ["commit", "-am", "feature edit"]);
    await writeFile(join(worktree, "README.md"), "# Init");
    await runGit(worktree, ["commit", "-am", "feature revert"]);
    await writeFile(join(f.root, "README.md"), "# Main");
    await runGit(f.root, ["commit", "-am", "main edit"]);
    const workspace = workspaceSchema.parse({
      id: "wsp_rebase_conflict",
      projectId: "prj_git",
      kind: "worktree",
      cwd: worktree,
      checkoutRoot: worktree,
      mainRepositoryRoot: f.root,
      branchRef: "feature",
      displayLabel: "Rebase Feature",
      locationId: null,
      ownershipState: "owned",
      markerId: null,
      markerPath: null,
      repairDetail: null,
      archivedAt: null,
    });
    f.repos.workspaces.save(workspace);

    const response = await f.app.fetch(request(`/api/workspaces/${workspace.id}/git/merge`, { method: "POST", body: "{}" }));
    expect(response.status).toBe(422);
    const body = await response.json() as { error: string; message?: string };
    expect(body.error).toBe("git-failed");
    expect(body.message).toContain("Could not rebase");
    expect(body.message).toContain("README.md");
    expect(body.message).not.toBe("Request failed. Check your connection and try again.");
    expect(await readFile(join(f.root, "README.md"), "utf8")).toBe("# Main");

    f.store.close();
  });
});
