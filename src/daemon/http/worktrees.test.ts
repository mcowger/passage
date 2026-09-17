import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { MetadataRepositories, MetadataStore } from "../metadata/index.ts";
import { WorktreeService } from "../workspaces/worktrees.ts";
import { createWorktreeRoutes } from "./worktrees.ts";
import { projectSchema } from "../../shared/domain/workspaces.ts";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((r) => rm(r, { recursive: true, force: true })));
});

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "passage-worktree-http-"));
  roots.push(root);
  const store = new MetadataStore(join(root, "metadata.sqlite"));
  const repos = new MetadataRepositories(store.db);
  const service = new WorktreeService(repos);
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
        body: JSON.stringify({ purpose: "Add retry queue to stripe webhooks" }),
      }),
    );
    expect(res.status).toBe(200);
    const json = await res.json() as { label: string; branch: string; folder: string };
    expect(json.label).toBeDefined();
    expect(json.branch).toMatch(/^feature\//);
    expect(json.folder).toMatch(/--wk_/);
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
