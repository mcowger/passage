import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { MetadataRepositories, MetadataStore } from "../metadata/index.ts";
import { WorkspaceService } from "../workspaces/service.ts";
import { WorkspaceActionsService } from "../workspaces/actions.ts";
import type { WorkspaceActionRun } from "../../shared/domain/workspace-actions.ts";
import { createWorkspaceActionRoutes } from "./actions.ts";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((r) => rm(r, { recursive: true, force: true })));
});

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "passage-actions-http-"));
  roots.push(root);
  const store = new MetadataStore(join(root, "metadata.sqlite"));
  const repos = new MetadataRepositories(store.db);
  const workspaceService = new WorkspaceService(repos);
  const actions = new WorkspaceActionsService(repos);
  const app = createWorkspaceActionRoutes(actions);
  const project = await workspaceService.registerProject(root, "Test Project");
  return { root, store, repos, workspaceService, app, project };
}

const request = (path: string, init?: RequestInit) =>
  new Request(`http://localhost${path}`, init);

async function waitForSettled(
  app: { fetch: (req: Request) => Response | Promise<Response> },
  workspaceId: string,
  runId: string,
  timeoutMs = 15_000,
): Promise<WorkspaceActionRun> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const res = await app.fetch(request(`/api/workspaces/${workspaceId}/actions/runs/${runId}`));
    expect(res.status).toBe(200);
    const run = (await res.json()) as WorkspaceActionRun;
    if (run.status !== "running") return run;
    if (Date.now() > deadline) throw new Error(`timed out waiting for run ${runId}`);
    await Bun.sleep(25);
  }
}

describe("workspace actions HTTP API", () => {
  test("lists the setup action derived from paseo.json", async () => {
    const f = await fixture();
    const dir = join(f.root, "ws");
    await mkdir(dir);
    await writeFile(join(dir, "paseo.json"), JSON.stringify({ worktree: { setup: ["./init.sh"] } }));
    const workspace = await f.workspaceService.createDirectoryWorkspace(f.project.id, {
      cwd: dir,
      displayLabel: "Actions",
    });

    const res = await f.app.fetch(request(`/api/workspaces/${workspace.id}/actions`));
    expect(res.status).toBe(200);
    const json = (await res.json()) as { actions: unknown[] };
    expect(json.actions).toHaveLength(1);
    expect(json.actions[0]).toMatchObject({ id: "setup", source: "paseo.json" });
    f.store.close();
  });

  test("lists no actions without setup commands", async () => {
    const f = await fixture();
    const workspace = await f.workspaceService.createDirectoryWorkspace(f.project.id, {
      displayLabel: "Plain",
    });

    const res = await f.app.fetch(request(`/api/workspaces/${workspace.id}/actions`));
    expect(res.status).toBe(200);
    expect(((await res.json()) as { actions: unknown[] }).actions).toEqual([]);
    f.store.close();
  });

  test("starts a run asynchronously and reports its terminal status", async () => {
    const f = await fixture();
    const dir = join(f.root, "ws");
    await mkdir(dir);
    await writeFile(join(dir, "paseo.json"), JSON.stringify({ worktree: { setup: ["echo hello"] } }));
    const workspace = await f.workspaceService.createDirectoryWorkspace(f.project.id, {
      cwd: dir,
      displayLabel: "Actions",
    });

    const start = await f.app.fetch(
      request(`/api/workspaces/${workspace.id}/actions/run`, {
        method: "POST",
        body: JSON.stringify({ id: "setup" }),
      }),
    );
    expect(start.status).toBe(202);
    const started = (await start.json()) as WorkspaceActionRun;
    expect(started.status).toBe("running");

    const settled = await waitForSettled(f.app, workspace.id, started.id);
    expect(settled.status).toBe("succeeded");
    expect(settled.results[0].stdout).toContain("hello");
    f.store.close();
  });

  test("rejects a second start while a run is active", async () => {
    const f = await fixture();
    const dir = join(f.root, "ws");
    await mkdir(dir);
    await writeFile(join(dir, "paseo.json"), JSON.stringify({ worktree: { setup: ["sleep 5"] } }));
    const workspace = await f.workspaceService.createDirectoryWorkspace(f.project.id, {
      cwd: dir,
      displayLabel: "Actions",
    });

    const first = await f.app.fetch(
      request(`/api/workspaces/${workspace.id}/actions/run`, {
        method: "POST",
        body: JSON.stringify({ id: "setup" }),
      }),
    );
    expect(first.status).toBe(202);
    const firstRun = (await first.json()) as WorkspaceActionRun;

    const second = await f.app.fetch(
      request(`/api/workspaces/${workspace.id}/actions/run`, {
        method: "POST",
        body: JSON.stringify({ id: "setup" }),
      }),
    );
    expect(second.status).toBe(409);
    expect(((await second.json()) as { error: string; runId: string }).error).toBe("action-running");

    await f.app.fetch(
      request(`/api/workspaces/${workspace.id}/actions/runs/${firstRun.id}/cancel`, { method: "POST" }),
    );
    expect((await waitForSettled(f.app, workspace.id, firstRun.id)).status).toBe("cancelled");
    f.store.close();
  });

  test("cancels a running action", async () => {
    const f = await fixture();
    const dir = join(f.root, "ws");
    await mkdir(dir);
    await writeFile(join(dir, "paseo.json"), JSON.stringify({ worktree: { setup: ["sleep 30"] } }));
    const workspace = await f.workspaceService.createDirectoryWorkspace(f.project.id, {
      cwd: dir,
      displayLabel: "Actions",
    });

    const start = await f.app.fetch(
      request(`/api/workspaces/${workspace.id}/actions/run`, {
        method: "POST",
        body: JSON.stringify({ id: "setup" }),
      }),
    );
    const started = (await start.json()) as WorkspaceActionRun;

    const cancel = await f.app.fetch(
      request(`/api/workspaces/${workspace.id}/actions/runs/${started.id}/cancel`, { method: "POST" }),
    );
    expect(cancel.status).toBe(200);
    expect((await waitForSettled(f.app, workspace.id, started.id)).status).toBe("cancelled");
    f.store.close();
  });

  test("rejects unknown action ids without executing", async () => {
    const f = await fixture();
    const workspace = await f.workspaceService.createDirectoryWorkspace(f.project.id, {
      displayLabel: "Plain",
    });

    const res = await f.app.fetch(
      request(`/api/workspaces/${workspace.id}/actions/run`, {
        method: "POST",
        body: JSON.stringify({ id: "teardown" }),
      }),
    );
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toBe("unknown-action");
    f.store.close();
  });

  test("returns 404 for missing workspaces and runs", async () => {
    const f = await fixture();
    const list = await f.app.fetch(request("/api/workspaces/wsp_missing/actions"));
    expect(list.status).toBe(404);
    const run = await f.app.fetch(
      request("/api/workspaces/wsp_missing/actions/run", {
        method: "POST",
        body: JSON.stringify({ id: "setup" }),
      }),
    );
    expect(run.status).toBe(404);

    const workspace = await f.workspaceService.createDirectoryWorkspace(f.project.id, {
      displayLabel: "Plain",
    });
    const missing = await f.app.fetch(
      request(`/api/workspaces/${workspace.id}/actions/runs/arun_missing`),
    );
    expect(missing.status).toBe(404);
    f.store.close();
  });
});
