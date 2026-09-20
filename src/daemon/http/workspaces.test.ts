import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { MetadataRepositories, MetadataStore } from "../metadata/index.ts";
import { WorkspaceService } from "../workspaces/service.ts";
import { WorkspaceEventHub } from "../workspaces/events.ts";
import { WORKSPACES_SNAPSHOT_SUBJECT } from "../../shared/protocol/index.ts";
import { createWorkspaceRoutes } from "./workspaces.ts";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });
async function fixture() { const root = await mkdtemp(join(tmpdir(), "passage-http-")); roots.push(root); const store = new MetadataStore(join(root, "metadata.sqlite")); return { root, store, app: createWorkspaceRoutes(new WorkspaceService(new MetadataRepositories(store.db))) }; }
const request = (path: string, init?: RequestInit) => new Request(`http://localhost${path}`, init);

describe("workspace HTTP API", () => {
  test("creates and persists bounded snapshot resources", async () => { const f = await fixture(); const projectResponse = await f.app.fetch(request("/api/projects", { method: "POST", body: JSON.stringify({ configuredRootPath: f.root, displayLabel: "Project" }) })); expect(projectResponse.status).toBe(201); const project = await projectResponse.json(); const workspaceResponse = await f.app.fetch(request(`/api/projects/${project.id}/workspaces`, { method: "POST", body: JSON.stringify({ displayLabel: "Workspace" }) })); expect(workspaceResponse.status).toBe(201); const snapshot = await (await f.app.fetch(request("/api/workspaces/snapshot"))).json(); expect(Object.keys(snapshot)).toEqual(["projects", "workspaces", "locations"]); expect(snapshot.workspaces).toHaveLength(2); expect(new Set(snapshot.workspaces.map((w: { displayLabel: string }) => w.displayLabel))).toEqual(new Set(["Default", "Workspace"])); expect((await f.app.fetch(request("/api/workspaces/snapshot"))).headers.get("cache-control")).toBe("no-store"); f.store.close(); });
  test("rejects malformed, oversized, and invalid input", async () => { const f = await fixture(); expect((await f.app.fetch(request("/api/projects", { method: "POST", body: "{" }))).status).toBe(400); const oversized = await f.app.fetch(request("/api/projects", { method: "POST", body: "x".repeat(16 * 1024 + 1) })); expect(oversized.status).toBe(413); expect(await oversized.json()).toEqual({ error: "body-too-large" }); expect((await f.app.fetch(request("/api/projects", { method: "POST", body: JSON.stringify({ configuredRootPath: f.root, displayLabel: "" }) }))).status).toBe(400); f.store.close(); });
  test("maps not-found, archived, and outside-root failures", async () => { const f = await fixture(); expect((await f.app.fetch(request("/api/projects/missing/archive", { method: "POST" }))).status).toBe(404); const p = await (await f.app.fetch(request("/api/projects", { method: "POST", body: JSON.stringify({ configuredRootPath: f.root, displayLabel: "P" }) }))).json(); await mkdir(join(f.root, "inside")); expect((await f.app.fetch(request(`/api/projects/${p.id}/workspaces`, { method: "POST", body: JSON.stringify({ cwd: "../", displayLabel: "bad" }) }))).status).toBe(400); expect((await f.app.fetch(request(`/api/projects/${p.id}/archive`, { method: "POST" }))).status).toBe(200); expect((await f.app.fetch(request(`/api/projects/${p.id}/workspaces`, { method: "POST", body: JSON.stringify({ displayLabel: "bad" }) }))).status).toBe(409); f.store.close(); });
  test("emits workspaces-changed after snapshot mutations and nothing on failure", async () => {
    const root = await mkdtemp(join(tmpdir(), "passage-http-")); roots.push(root);
    const store = new MetadataStore(join(root, "metadata.sqlite"));
    const hub = new WorkspaceEventHub();
    const app = createWorkspaceRoutes(new WorkspaceService(new MetadataRepositories(store.db)), undefined, hub);
    const sequence = () => hub.currentSequence(WORKSPACES_SNAPSHOT_SUBJECT);
    expect(sequence()).toBe(0);
    const project = await (await app.fetch(request("/api/projects", { method: "POST", body: JSON.stringify({ configuredRootPath: root, displayLabel: "P" }) }))).json();
    expect(sequence()).toBe(1);
    // Failed mutations emit nothing.
    expect((await app.fetch(request("/api/projects/missing/archive", { method: "POST" }))).status).toBe(404);
    expect(sequence()).toBe(1);
    const snapshot = await (await app.fetch(request("/api/workspaces/snapshot"))).json();
    const workspace = snapshot.workspaces.find((w: { displayLabel: string }) => w.displayLabel === "Default");
    expect((await app.fetch(request("/api/workspaces/wsp_missing/archive", { method: "POST" }))).status).toBe(404);
    expect(sequence()).toBe(1);
    expect((await app.fetch(request(`/api/workspaces/${workspace.id}/archive`, { method: "POST" }))).status).toBe(200);
    expect(sequence()).toBe(2);
    const replay = hub.subscribe(WORKSPACES_SNAPSHOT_SUBJECT, 0, () => {}).replay;
    expect(replay.kind).toBe("replay");
    if (replay.kind !== "replay") throw new Error("expected replay");
    expect(replay.events.map((e) => e.type)).toEqual(["workspaces-changed", "workspaces-changed"]);
    store.close();
  });
  test("registers and updates project icon and color", async () => {
    const f = await fixture();
    const created = await (await f.app.fetch(request("/api/projects", { method: "POST", body: JSON.stringify({ configuredRootPath: f.root, displayLabel: "P", iconName: "Rocket", iconColor: "#3b82f6" }) }))).json();
    expect(created.iconName).toBe("Rocket");
    expect(created.iconColor).toBe("#3b82f6");
    const updated = await (await f.app.fetch(request(`/api/projects/${created.id}`, { method: "PATCH", body: JSON.stringify({ iconName: "Bot", iconColor: "#ef4444" }) }))).json();
    expect(updated.iconName).toBe("Bot");
    expect(updated.iconColor).toBe("#ef4444");
    // Invalid icon/color rejected; empty patch rejected.
    expect((await f.app.fetch(request(`/api/projects/${created.id}`, { method: "PATCH", body: JSON.stringify({ iconName: "NotAnIcon" }) }))).status).toBe(400);
    expect((await f.app.fetch(request(`/api/projects/${created.id}`, { method: "PATCH", body: JSON.stringify({ iconColor: "red" }) }))).status).toBe(400);
    expect((await f.app.fetch(request(`/api/projects/${created.id}`, { method: "PATCH", body: JSON.stringify({}) }))).status).toBe(400);
    const snapshot = await (await f.app.fetch(request("/api/workspaces/snapshot"))).json();
    expect(snapshot.projects.find((p: { id: string }) => p.id === created.id).iconName).toBe("Bot");
    f.store.close();
  });
});
