import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { MetadataRepositories, MetadataStore } from "../metadata/index.ts";
import { WorktreeService } from "../workspaces/worktrees.ts";
import { WorkspaceEventHub } from "../workspaces/events.ts";
import { MetadataGenerator } from "../workspaces/metadata-generator.ts";
import { createWorktreeRoutes } from "./worktrees.ts";
import { projectSchema, workspaceSchema } from "../../shared/domain/workspaces.ts";
import { WORKSPACES_SNAPSHOT_SUBJECT } from "../../shared/protocol/index.ts";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((r) => rm(r, { recursive: true, force: true })));
});

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "passage-worktree-http-"));
  roots.push(root);
  const store = new MetadataStore(join(root, "metadata.sqlite"));
  const repos = new MetadataRepositories(store.db);
  const service = new WorktreeService(repos, undefined, new MetadataGenerator(50, { executable: "/does/not/exist" }));
  const app = createWorktreeRoutes(service);
  return { root, store, repos, app };
}

const request = (path: string, init?: RequestInit) => new Request(`http://localhost${path}`, init);

describe("worktrees HTTP API", () => {
  test("generates worktree metadata suggestions for a project", async () => {
    const f = await fixture();
    const project = projectSchema.parse({
      id: "prj_test1",
      configuredRootPath: f.root,
      canonicalRootPath: f.root,
      displayLabel: "Test Project",
      archivedAt: null,
    });
    f.repos.projects.save(project);

    const res = await f.app.fetch(
      request(`/api/projects/${project.id}/worktrees/suggest`, {
        method: "POST",
        body: JSON.stringify({ purpose: "Add retry queue to stripe webhooks", model: "test/model", thinkingLevel: "high" }),
      }),
    );
    expect(res.status).toBe(200);
    const json = await res.json() as { label: string; branch: string; folder: string };
    expect(json.label).toBeDefined();
    expect(json.branch).toMatch(/^feature\//);
    expect(json.folder.startsWith("test-project-")).toBe(true);
    expect(json.folder).toMatch(/--wk_[a-z0-9]{4}$/);
    f.store.close();
  }, 15_000);

  test("rejects suggestion on missing project", async () => {
    const f = await fixture();
    const res = await f.app.fetch(
      request("/api/projects/prj_missing/worktrees/suggest", {
        method: "POST",
        body: JSON.stringify({ purpose: "Some purpose" }),
      }),
    );
    expect(res.status).toBe(409);
    f.store.close();
  });

  test("rejects remove on missing workspace with 404 not-found", async () => {
    const f = await fixture();
    const res = await f.app.fetch(
      request("/api/workspaces/wsp_nonexistent/worktree/remove", {
        method: "POST",
        body: JSON.stringify({}),
      }),
    );
    expect(res.status).toBe(404);
    const json = await res.json() as { error: string };
    expect(json.error).toBe("not-found");
    f.store.close();
  });

  test("emits workspaces-changed on worktree remove and nothing on failure", async () => {
    const f = await fixture();
    const hub = new WorkspaceEventHub();
    const service = new WorktreeService(f.repos, undefined, new MetadataGenerator(50, { executable: "/does/not/exist" }));
    const app = createWorktreeRoutes(service, undefined, hub);
    const sequence = () => hub.currentSequence(WORKSPACES_SNAPSHOT_SUBJECT);
    // Failed removes (missing workspace, invalid body) emit nothing.
    expect((await app.fetch(request("/api/workspaces/wsp_nonexistent/worktree/remove", { method: "POST", body: JSON.stringify({}) }))).status).toBe(404);
    expect(sequence()).toBe(0);
    const project = projectSchema.parse({
      id: "prj_remove_emit",
      configuredRootPath: f.root,
      canonicalRootPath: f.root,
      displayLabel: "Remove Emit",
      archivedAt: null,
    });
    f.repos.projects.save(project);
    // A worktree whose directory is already gone removes straight from the DB.
    const workspace = workspaceSchema.parse({
      id: "wsp_remove_emit",
      projectId: project.id,
      kind: "worktree",
      cwd: join(f.root, "gone-worktree"),
      checkoutRoot: join(f.root, "gone-worktree"),
      mainRepositoryRoot: f.root,
      branchRef: "feature/gone",
      displayLabel: "Gone",
      locationId: null,
      ownershipState: "owned",
      markerId: null,
      markerPath: null,
      repairDetail: null,
      archivedAt: null,
    });
    f.repos.workspaces.save(workspace);
    const res = await app.fetch(request(`/api/workspaces/${workspace.id}/worktree/remove`, { method: "POST", body: JSON.stringify({}) }));
    expect(res.status).toBe(200);
    expect(sequence()).toBe(1);
    const replay = hub.subscribe(WORKSPACES_SNAPSHOT_SUBJECT, 0, () => {}).replay;
    expect(replay.kind).toBe("replay");
    if (replay.kind !== "replay") throw new Error("expected replay");
    expect(replay.events).toHaveLength(1);
    expect(replay.events[0]).toMatchObject({ type: "workspaces-changed", subjectId: WORKSPACES_SNAPSHOT_SUBJECT });
    expect(replay.events[0].payload).toMatchObject({ reason: "remove", workspaceId: workspace.id });
    expect(f.repos.workspaces.get(workspace.id)).toBeUndefined();
    f.store.close();
  });
  test("invokes onRemoveWorkspace teardown hook before removal", async () => {
    const f = await fixture();
    const project = projectSchema.parse({
      id: "prj_teardown_hook",
      configuredRootPath: f.root,
      canonicalRootPath: f.root,
      displayLabel: "Teardown Hook",
      archivedAt: null,
    });
    f.repos.projects.save(project);
    const workspace = workspaceSchema.parse({
      id: "wsp_teardown_hook",
      projectId: project.id,
      kind: "worktree",
      cwd: join(f.root, "gone-teardown"),
      checkoutRoot: join(f.root, "gone-teardown"),
      mainRepositoryRoot: f.root,
      branchRef: "feature/gone",
      displayLabel: "Gone",
      locationId: null,
      ownershipState: "owned",
      markerId: null,
      markerPath: null,
      repairDetail: null,
      archivedAt: null,
    });
    f.repos.workspaces.save(workspace);
    const tornDown: string[] = [];
    const hub = new WorkspaceEventHub();
    const service = new WorktreeService(f.repos, undefined, new MetadataGenerator(50, { executable: "/does/not/exist" }));
    const app = createWorktreeRoutes(service, { onRemoveWorkspace: async (id) => { tornDown.push(id); } }, hub);
    const res = await app.fetch(request(`/api/workspaces/${workspace.id}/worktree/remove`, { method: "POST", body: JSON.stringify({}) }));
    expect(res.status).toBe(200);
    expect(tornDown).toEqual([workspace.id]);
    expect(f.repos.workspaces.get(workspace.id)).toBeUndefined();
    f.store.close();
  });
  test("rejects remove with invalid body with 400 invalid-request", async () => {
    const f = await fixture();
    const res = await f.app.fetch(
      request("/api/workspaces/wsp_nonexistent/worktree/remove", {
        method: "POST",
        body: JSON.stringify({ unexpectedKey: 123 }),
      }),
    );
    expect(res.status).toBe(400);
    const json = await res.json() as { error: string };
    expect(json.error).toBe("invalid-request");
    f.store.close();
  });
});
