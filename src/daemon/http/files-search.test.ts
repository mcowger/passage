import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MetadataRepositories, MetadataStore } from "../metadata/index.ts";
import { WorkspaceService } from "../workspaces/service.ts";
import { FileService } from "../workspaces/files.ts";
import { WorkspaceEventHub } from "../workspaces/events.ts";
import type { EventEnvelope } from "../../shared/protocol/index.ts";
import { createFileRoutes } from "./files.ts";
import { projectSchema, workspaceSchema } from "../../shared/domain/workspaces.ts";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((r) => rm(r, { recursive: true, force: true })));
});

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "passage-files-search-http-"));
  roots.push(root);
  const store = new MetadataStore(":memory:");
  const repos = new MetadataRepositories(store.db);
  const workspaces = new WorkspaceService(repos);
  const files = new FileService(workspaces);
  const events = new WorkspaceEventHub();
  const received: EventEnvelope[] = [];
  const app = createFileRoutes(files, events);
  const project = projectSchema.parse({
    id: "prj_search_http",
    configuredRootPath: root,
    canonicalRootPath: root,
    displayLabel: "Search HTTP Project",
    archivedAt: null,
  });
  repos.projects.save(project);
  const workspace = workspaceSchema.parse({
    id: "wsp_search_http",
    projectId: project.id,
    kind: "directory",
    cwd: root,
    checkoutRoot: root,
    mainRepositoryRoot: null,
    branchRef: null,
    displayLabel: "Search HTTP Workspace",
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
  return { root, store, app, workspace, received };
}

const request = (path: string, init?: RequestInit) => new Request(`http://localhost${path}`, init);

describe("files/search HTTP API", () => {
  test("returns bounded matches and emits no WS events", async () => {
    const f = await fixture();
    await writeFile(join(f.root, "hello.txt"), "hi");
    await writeFile(join(f.root, "other.md"), "hi");

    const res = await f.app.fetch(request(`/api/workspaces/${f.workspace.id}/files/search?q=hello&limit=20`));
    expect(res.status).toBe(200);
    const body = await res.json() as { query: string; entries: Array<{ path: string; kind: string }>; truncated: boolean };
    expect(body.query).toBe("hello");
    expect(body.entries).toEqual([{ path: "hello.txt", kind: "file" }]);
    expect(body.truncated).toBe(false);
    // Reads emit nothing: no files-changed invalidations on the wire.
    expect(f.received).toHaveLength(0);
    f.store.close();
  });

  test("empty query returns the unfiltered bounded list", async () => {
    const f = await fixture();
    await writeFile(join(f.root, "a.txt"), "a");
    const res = await f.app.fetch(request(`/api/workspaces/${f.workspace.id}/files/search`));
    expect(res.status).toBe(200);
    const body = await res.json() as { entries: unknown[] };
    expect(body.entries.length).toBeGreaterThan(0);
    f.store.close();
  });

  test("enforces query and limit bounds", async () => {
    const f = await fixture();
    expect((await f.app.fetch(request(`/api/workspaces/${f.workspace.id}/files/search?q=${"a".repeat(65)}`))).status).toBe(400);
    expect((await f.app.fetch(request(`/api/workspaces/${f.workspace.id}/files/search?q=x&limit=500`))).status).toBe(400);
    expect((await f.app.fetch(request(`/api/workspaces/missing/files/search?q=x`))).status).toBe(404);
    f.store.close();
  });

  test("rejects traversal attempts", async () => {
    const f = await fixture();
    const res = await f.app.fetch(request(`/api/workspaces/${f.workspace.id}/files/search?q=${encodeURIComponent("../escape")}`));
    expect(res.status).toBe(200);
    const body = await res.json() as { entries: unknown[] };
    expect(body.entries).toHaveLength(0);
    f.store.close();
  });
});
