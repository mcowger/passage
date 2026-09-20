import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { MetadataRepositories, MetadataStore } from "../metadata/index.ts";
import { WorkspaceService } from "../workspaces/service.ts";
import { TerminalManager } from "../terminals/manager.ts";
import { WorkspaceScriptsService } from "../workspaces/scripts.ts";
import type { WorkspaceScriptRuntime } from "../../shared/domain/workspace-actions.ts";
import { createWorkspaceScriptRoutes } from "./scripts.ts";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((r) => rm(r, { recursive: true, force: true })));
});

async function fixture(paseoJson: unknown) {
  const root = await mkdtemp(join(tmpdir(), "passage-scripts-http-"));
  roots.push(root);
  const store = new MetadataStore(join(root, "metadata.sqlite"));
  const repos = new MetadataRepositories(store.db);
  const workspaceService = new WorkspaceService(repos);
  const terminals = new TerminalManager(workspaceService);
  const scripts = new WorkspaceScriptsService(repos, terminals);
  const app = createWorkspaceScriptRoutes(scripts);
  const project = await workspaceService.registerProject(root, "Test Project");
  const dir = join(root, "ws");
  await mkdir(dir);
  await writeFile(join(dir, "paseo.json"), JSON.stringify(paseoJson));
  const workspace = await workspaceService.createDirectoryWorkspace(project.id, {
    cwd: dir,
    displayLabel: "Scripts",
  });
  return { root, store, app, workspace };
}

const request = (path: string, init?: RequestInit) =>
  new Request(`http://localhost${path}`, init);

describe("workspace scripts HTTP API", () => {
  const manifest = {
    scripts: {
      dev: { type: "service", command: "sleep 30" },
      test: { command: "echo ok" },
    },
  };

  test("lists stopped runtimes derived from paseo.json", async () => {
    const f = await fixture(manifest);
    const res = await f.app.fetch(request(`/api/workspaces/${f.workspace.id}/scripts`));
    expect(res.status).toBe(200);
    const json = (await res.json()) as { scripts: WorkspaceScriptRuntime[] };
    expect(json.scripts.map((s) => s.name)).toEqual(["dev", "test"]);
    expect(json.scripts[0]).toMatchObject({ type: "service", lifecycle: "stopped" });
    f.store.close();
  });

  test("lists no scripts without entries", async () => {
    const f = await fixture({ worktree: { setup: ["echo hi"] } });
    const res = await f.app.fetch(request(`/api/workspaces/${f.workspace.id}/scripts`));
    expect(res.status).toBe(200);
    expect(((await res.json()) as { scripts: unknown[] }).scripts).toEqual([]);
    f.store.close();
  });

  test("starts and stops a service with a backing terminal", async () => {
    const f = await fixture(manifest);
    const start = await f.app.fetch(
      request(`/api/workspaces/${f.workspace.id}/scripts/dev/start`, { method: "POST" }),
    );
    expect(start.status).toBe(202);
    const started = (await start.json()) as WorkspaceScriptRuntime;
    expect(started.lifecycle).toBe("running");
    expect(started.terminalId).toMatch(/^trm_/);
    expect(started.port).toBeGreaterThan(0);
    expect(started.url).toContain("127.0.0.1");

    const conflict = await f.app.fetch(
      request(`/api/workspaces/${f.workspace.id}/scripts/dev/start`, { method: "POST" }),
    );
    expect(conflict.status).toBe(409);
    expect(((await conflict.json()) as { error: string }).error).toBe("script-running");

    const stop = await f.app.fetch(
      request(`/api/workspaces/${f.workspace.id}/scripts/dev/stop`, { method: "POST" }),
    );
    expect(stop.status).toBe(200);
    expect(((await stop.json()) as WorkspaceScriptRuntime).lifecycle).toBe("stopped");
    f.store.close();
  });

  test("restarts retaining the allocated port", async () => {
    const f = await fixture(manifest);
    const first = (await (
      await f.app.fetch(request(`/api/workspaces/${f.workspace.id}/scripts/dev/start`, { method: "POST" }))
    ).json()) as WorkspaceScriptRuntime;
    const restarted = (await (
      await f.app.fetch(request(`/api/workspaces/${f.workspace.id}/scripts/dev/restart`, { method: "POST" }))
    ).json()) as WorkspaceScriptRuntime;
    expect(restarted.lifecycle).toBe("running");
    expect(restarted.port).toBe(first.port);
    expect(restarted.terminalId).not.toBe(first.terminalId);
    await f.app.fetch(request(`/api/workspaces/${f.workspace.id}/scripts/dev/stop`, { method: "POST" }));
    f.store.close();
  });

  test("rejects unknown scripts and workspaces", async () => {
    const f = await fixture(manifest);
    const unknown = await f.app.fetch(
      request(`/api/workspaces/${f.workspace.id}/scripts/nope/start`, { method: "POST" }),
    );
    expect(unknown.status).toBe(400);
    expect(((await unknown.json()) as { error: string }).error).toBe("unknown-script");
    const missing = await f.app.fetch(request("/api/workspaces/wsp_missing/scripts"));
    expect(missing.status).toBe(404);
    f.store.close();
  });
});
