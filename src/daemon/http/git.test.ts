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

  test("auto-commit forwards conversation excerpts and the selected agent", async () => {
    const root = await mkdtemp(join(tmpdir(), "passage-git-auto-conv-"));
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
    let capturedConversation: unknown;
    let seenAgent: string | undefined;
    const stub = {
      suggestCommit: async (_files: Array<{ path: string; kind: string }>, _diff: string, _cwd?: string, _model?: string, _thinking?: string, _template = "", conversation: unknown = {}) => {
        capturedConversation = conversation;
        return "Update README";
      },
    };
    const app = createGitRoutes(workspaces, git, undefined, stub, async (workspaceId, agentId) => {
      seenAgent = agentId;
      expect(workspaceId).toBe("wsp_conv");
      return { userMessages: ["Add retries"], finalAssistantMessages: ["Wrapped up"] };
    });
    repos.projects.save(projectSchema.parse({
      id: "prj_conv",
      configuredRootPath: root,
      canonicalRootPath: root,
      displayLabel: "Conv Project",
      archivedAt: null,
    }));
    repos.workspaces.save(workspaceSchema.parse({
      id: "wsp_conv",
      projectId: "prj_conv",
      kind: "directory",
      cwd: root,
      checkoutRoot: root,
      mainRepositoryRoot: root,
      branchRef: "main",
      displayLabel: "Conv Workspace",
      locationId: null,
      ownershipState: "not-owned",
      markerId: null,
      markerPath: null,
      repairDetail: null,
      archivedAt: null,
    }));

    await writeFile(join(root, "README.md"), "# Init\nUpdated line");
    const res = await app.fetch(request(`/api/workspaces/wsp_conv/git/commit-auto`, { method: "POST", body: JSON.stringify({ agentId: "agt_123" }) }));
    expect(res.status).toBe(200);
    expect(seenAgent).toBe("agt_123");
    const convo = capturedConversation as { userMessages: string; finalAssistantMessages: string };
    expect(convo.userMessages).toContain("Add retries");
    expect(convo.finalAssistantMessages).toContain("Wrapped up");

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

describe("git GitHub HTTP API", () => {
  const stubCommits = {
    suggestCommit: async () => null as string | null,
  };
  const stubGh = (overrides: Record<string, unknown> = {}) => ({
    installed: async () => true,
    available: async () => true,
    repoInfo: async () => ({ nameWithOwner: "o/r", defaultBranch: "main" }),
    prForBranch: async () => null,
    createPr: async () => ({
      number: 7,
      url: "https://github.com/o/r/pull/7",
      title: "Feature work",
      state: "OPEN",
      base: "main",
      head: "feature",
      isDraft: false,
    }),
    ...overrides,
  });

  async function mkRepo(ghOverrides: Record<string, unknown> = {}) {
    const root = await mkdtemp(join(tmpdir(), "passage-git-gh-"));
    roots.push(root);
    await runGit(root, ["init", "-b", "main"]);
    await runGit(root, ["config", "user.email", "test@passage.dev"]);
    await runGit(root, ["config", "user.name", "Passage Test"]);
    await writeFile(join(root, ".gitignore"), "metadata.sqlite\n");
    await writeFile(join(root, "README.md"), "# Init");
    await runGit(root, ["add", ".gitignore", "README.md"]);
    await runGit(root, ["commit", "-m", "Initial commit"]);
    const store = new MetadataStore(join(root, "metadata.sqlite"));
    const repos = new MetadataRepositories(store.db);
    const workspaces = new WorkspaceService(repos);
    const git = new GitService();
    const events = new WorkspaceEventHub();
    const received: EventEnvelope[] = [];
    const app = createGitRoutes(workspaces, git, events, stubCommits, undefined, stubGh(ghOverrides) as never);
    repos.projects.save(projectSchema.parse({
      id: "prj_gh",
      configuredRootPath: root,
      canonicalRootPath: root,
      displayLabel: "GH Project",
      archivedAt: null,
    }));
    const workspace = workspaceSchema.parse({
      id: "wsp_gh",
      projectId: "prj_gh",
      kind: "directory",
      cwd: root,
      checkoutRoot: root,
      mainRepositoryRoot: root,
      branchRef: "main",
      displayLabel: "GH Workspace",
      locationId: null,
      ownershipState: "not-owned",
      markerId: null,
      markerPath: null,
      repairDetail: null,
      archivedAt: null,
    });
    repos.workspaces.save(workspace);
    const subscription = events.subscribe(workspace.id, 0, (e) => received.push(e));
    subscription.activate();
    return { root, store, repos, app, workspace, events, received };
  }

  async function mkFeatureRepo(ghOverrides: Record<string, unknown> = {}) {
    const f = await mkRepo(ghOverrides);
    await runGit(f.root, ["checkout", "-b", "feature"]);
    await writeFile(join(f.root, "feature.txt"), "feature\n");
    await runGit(f.root, ["add", "feature.txt"]);
    await runGit(f.root, ["commit", "-m", "Feature work"]);
    return f;
  }

  test("github-status reports availability and no PR", async () => {
    const f = await mkRepo();
    const response = await f.app.fetch(request(`/api/workspaces/${f.workspace.id}/git/github-status`));
    expect(response.status).toBe(200);
    const body = await response.json() as { installed: boolean; available: boolean; repo: { nameWithOwner: string; defaultBranch: string } | null; pr: null };
    expect(body).toEqual({ installed: true, available: true, repo: { nameWithOwner: "o/r", defaultBranch: "main" }, pr: null });
    f.store.close();
  });

  test("github-status degrades when gh is missing", async () => {
    const f = await mkRepo({ installed: async () => false, available: async () => false });
    const response = await f.app.fetch(request(`/api/workspaces/${f.workspace.id}/git/github-status`));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ installed: false, available: false, repo: null, pr: null });
    f.store.close();
  });

  test("github-status reports an existing PR", async () => {
    const existing = { number: 9, url: "https://github.com/o/r/pull/9", title: "T", state: "OPEN", base: "main", head: "feature", isDraft: true };
    const f = await mkRepo({ prForBranch: async () => existing });
    const response = await f.app.fetch(request(`/api/workspaces/${f.workspace.id}/git/github-status`));
    expect(response.status).toBe(200);
    const body = await response.json() as { pr: typeof existing };
    expect(body.pr).toEqual(existing);
    f.store.close();
  });

  test("github-status checks host once and caches repo + PR", async () => {
    const calls = { installed: 0, available: 0, repoInfo: 0, prForBranch: 0 };
    const f = await mkRepo({
      installed: async () => { calls.installed++; return true; },
      available: async () => { calls.available++; return true; },
      repoInfo: async () => { calls.repoInfo++; return { nameWithOwner: "o/r", defaultBranch: "main" }; },
      prForBranch: async () => { calls.prForBranch++; return null; },
    });
    const url = `/api/workspaces/${f.workspace.id}/git/github-status?branch=main`;
    const first = await f.app.fetch(request(url));
    expect(first.status).toBe(200);
    const second = await f.app.fetch(request(url));
    expect(second.status).toBe(200);
    expect(await second.json()).toEqual(await first.json());
    expect(calls).toEqual({ installed: 1, available: 1, repoInfo: 1, prForBranch: 1 });
    f.store.close();
  });

  test("github-status refresh forces a live PR re-check", async () => {
    let prCalls = 0;
    const f = await mkRepo({ prForBranch: async () => { prCalls++; return null; } });
    const base = `/api/workspaces/${f.workspace.id}/git/github-status?branch=main`;
    await f.app.fetch(request(base));
    expect(prCalls).toBe(1);
    await f.app.fetch(request(base));
    expect(prCalls).toBe(1);
    const refreshed = await f.app.fetch(request(`${base}&refresh=1`));
    expect(refreshed.status).toBe(200);
    expect(prCalls).toBe(2);
    f.store.close();
  });

  test("github-status scopes the cached PR by branch", async () => {
    let prCalls = 0;
    const f = await mkRepo({ prForBranch: async () => { prCalls++; return null; } });
    const base = `/api/workspaces/${f.workspace.id}/git/github-status`;
    await f.app.fetch(request(`${base}?branch=main`));
    await f.app.fetch(request(`${base}?branch=feature`));
    expect(prCalls).toBe(2);
    await f.app.fetch(request(`${base}?branch=main`));
    expect(prCalls).toBe(2);
    f.store.close();
  });

  test("github-status shares one in-flight PR lookup", async () => {
    let resolvePr!: (value: null) => void;
    let prCalls = 0;
    const gate = new Promise<null>((resolve) => { resolvePr = resolve; });
    const f = await mkRepo({ prForBranch: async () => { prCalls++; return gate; } });
    const url = `/api/workspaces/${f.workspace.id}/git/github-status?branch=main`;
    const pending = [f.app.fetch(request(url)), f.app.fetch(request(url))];
    resolvePr(null);
    const [a, b] = await Promise.all(pending);
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    expect(prCalls).toBe(1);
    f.store.close();
  });

  test("pr-create stores the new PR in the status cache", async () => {
    let prCalls = 0;
    const f = await mkFeatureRepo({ prForBranch: async () => { prCalls++; return null; } });
    const statusUrl = `/api/workspaces/${f.workspace.id}/git/github-status?branch=feature`;
    const before = await f.app.fetch(request(statusUrl));
    expect(before.status).toBe(200);
    expect((await before.json() as { pr: unknown }).pr).toBeNull();
    expect(prCalls).toBe(1);
    const origin = await mkdtemp(join(tmpdir(), "passage-git-gh-cache-origin-"));
    roots.push(origin);
    await runGit(origin, ["init", "--bare"]);
    await runGit(f.root, ["remote", "add", "origin", origin]);
    const created = await f.app.fetch(request(`/api/workspaces/${f.workspace.id}/git/pr-create`, {
      method: "POST",
      body: JSON.stringify({ title: "Feature work", body: "Details", draft: true }),
    }));
    expect(created.status).toBe(200);
    const after = await f.app.fetch(request(statusUrl));
    expect(after.status).toBe(200);
    expect((await after.json() as { pr: { number: number } }).pr.number).toBe(7);
    expect(prCalls).toBe(1);
    f.store.close();
  });

  test("pr-suggest falls back to a template when the model is unavailable", async () => {
    const f = await mkFeatureRepo();
    const response = await f.app.fetch(request(`/api/workspaces/${f.workspace.id}/git/pr-suggest`, { method: "POST", body: JSON.stringify({}) }));
    expect(response.status).toBe(200);
    const body = await response.json() as { base: string; title: string; body: string; generated: boolean };
    expect(body.base).toBe("main");
    expect(body.generated).toBe(false);
    expect(body.title.length).toBeGreaterThan(0);
    expect(body.body).toContain("Not run.");
    f.store.close();
  });

  test("pr-suggest rejects a branch with nothing beyond its base", async () => {
    const f = await mkRepo();
    const response = await f.app.fetch(request(`/api/workspaces/${f.workspace.id}/git/pr-suggest`, { method: "POST", body: JSON.stringify({}) }));
    expect(response.status).toBe(422);
    const body = await response.json() as { error: string; message?: string };
    expect(body.error).toBe("git-failed");
    expect(body.message).toContain("Nothing to describe");
    f.store.close();
  });

  test("pr-create refuses a dirty tree", async () => {
    const f = await mkFeatureRepo();
    await writeFile(join(f.root, "dirty.txt"), "dirty\n");
    const response = await f.app.fetch(request(`/api/workspaces/${f.workspace.id}/git/pr-create`, {
      method: "POST",
      body: JSON.stringify({ title: "Feature work", body: "Details" }),
    }));
    expect(response.status).toBe(422);
    const body = await response.json() as { error: string; message?: string };
    expect(body.error).toBe("git-failed");
    expect(body.message).toContain("Commit or stash");
    f.store.close();
  });

  test("pr-create validates its input", async () => {
    const f = await mkFeatureRepo();
    const response = await f.app.fetch(request(`/api/workspaces/${f.workspace.id}/git/pr-create`, {
      method: "POST",
      body: JSON.stringify({ title: "  " }),
    }));
    expect(response.status).toBe(400);
    f.store.close();
  });

  test("pr-create pushes the branch and creates the PR", async () => {
    const f = await mkFeatureRepo();
    const origin = await mkdtemp(join(tmpdir(), "passage-git-gh-origin-"));
    roots.push(origin);
    await runGit(origin, ["init", "--bare"]);
    await runGit(f.root, ["remote", "add", "origin", origin]);
    const response = await f.app.fetch(request(`/api/workspaces/${f.workspace.id}/git/pr-create`, {
      method: "POST",
      body: JSON.stringify({ title: "Feature work", body: "Details", draft: true }),
    }));
    expect(response.status).toBe(200);
    const body = await response.json() as { pr: { number: number }; status: { branchRef: string; hasUpstream: boolean } };
    expect(body.pr.number).toBe(7);
    expect(body.status.branchRef).toBe("feature");
    expect(body.status.hasUpstream).toBe(true);
    expect(f.received.map((e) => (e.payload as { reason: string }).reason)).toContain("pr-create");
    f.store.close();
  });

  test("rebase-remote refuses the main checkout", async () => {
    const f = await mkRepo();
    const response = await f.app.fetch(request(`/api/workspaces/${f.workspace.id}/git/rebase-remote`, { method: "POST", body: JSON.stringify({}) }));
    expect(response.status).toBe(422);
    const body = await response.json() as { error: string };
    expect(body.error).toBe("git-failed");
    f.store.close();
  });

  test("rebase-remote validates its input", async () => {
    const f = await mkRepo();
    const response = await f.app.fetch(request(`/api/workspaces/${f.workspace.id}/git/rebase-remote`, { method: "POST", body: JSON.stringify({ remote: 123 }) }));
    expect(response.status).toBe(400);
    f.store.close();
  });
});
