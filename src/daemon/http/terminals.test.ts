import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { MetadataRepositories, MetadataStore } from "../metadata/index.ts";
import { WorkspaceService } from "../workspaces/service.ts";
import { TerminalManager } from "../terminals/manager.ts";
import { createTerminalRoutes } from "./terminals.ts";
import type { TerminalSummary } from "../../shared/domain/terminals.ts";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((r) => rm(r, { recursive: true, force: true })));
});

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "passage-term-http-"));
  roots.push(root);
  const store = new MetadataStore(":memory:");
  const repos = new MetadataRepositories(store.db);
  const workspaces = new WorkspaceService(repos);
  const project = await workspaces.registerProject(root, "Test Repo");
  const workspace = await workspaces.createDirectoryWorkspace(project.id, { displayLabel: "Test WS" });
  const manager = new TerminalManager(workspaces);
  const app = createTerminalRoutes(manager);
  return { root, store, workspaces, project, workspace, manager, app };
}

const request = (path: string, init?: RequestInit) => new Request(`http://localhost${path}`, init);

describe("terminals HTTP API", () => {
  test("creates, lists, gets, and deletes terminals", async () => {
    const f = await fixture();

    // Create
    const createRes = await f.app.fetch(
      request(`/api/workspaces/${f.workspace.id}/terminals`, {
        method: "POST",
        body: JSON.stringify({ title: "Custom Shell", columns: 90, rows: 30 }),
      }),
    );
    expect(createRes.status).toBe(201);
    const created = await createRes.json() as TerminalSummary;
    expect(created.title).toBe("Custom Shell");
    expect(created.columns).toBe(90);
    expect(created.rows).toBe(30);

    // List
    const listRes = await f.app.fetch(request(`/api/workspaces/${f.workspace.id}/terminals`));
    expect(listRes.status).toBe(200);
    const list = await listRes.json() as TerminalSummary[];
    expect(list.length).toBe(1);
    expect(list[0].id).toBe(created.id);

    // Get
    const getRes = await f.app.fetch(request(`/api/terminals/${created.id}`));
    expect(getRes.status).toBe(200);
    const got = await getRes.json() as TerminalSummary;
    expect(got.id).toBe(created.id);

    // Delete
    const delRes = await f.app.fetch(request(`/api/terminals/${created.id}`, { method: "DELETE" }));
    expect(delRes.status).toBe(200);

    // Get after delete -> 404
    const notFoundRes = await f.app.fetch(request(`/api/terminals/${created.id}`));
    expect(notFoundRes.status).toBe(404);

    f.store.close();
  });
});
