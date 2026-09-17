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
});
