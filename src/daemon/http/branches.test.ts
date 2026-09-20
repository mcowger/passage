import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { MetadataRepositories, MetadataStore } from "../metadata/index.ts";
import { BranchService } from "../workspaces/branches.ts";
import { WorkspaceEventHub } from "../workspaces/events.ts";
import { createBranchRoutes } from "./branches.ts";
import { projectSchema } from "../../shared/domain/workspaces.ts";
import { WORKSPACES_SNAPSHOT_SUBJECT } from "../../shared/protocol/index.ts";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((r) => rm(r, { recursive: true, force: true })));
});

const git = async (cwd: string, ...args: string[]) => {
  const p = Bun.spawn(["git", "-C", cwd, ...args], { stdout: "pipe", stderr: "pipe" });
  if ((await p.exited) !== 0) throw new Error(await new Response(p.stderr).text());
};
const request = (path: string, init?: RequestInit) => new Request(`http://localhost${path}`, init);

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "passage-branches-http-"));
  roots.push(root);
  await git(root, "init", "-b", "main");
  await git(root, "config", "user.email", "test@example.com");
  await git(root, "config", "user.name", "Test");
  await writeFile(join(root, "base.txt"), "base\n");
  await git(root, "add", ".");
  await git(root, "commit", "-m", "base");
  await git(root, "checkout", "-b", "feature/gone");
  await writeFile(join(root, "gone.txt"), "gone\n");
  await git(root, "add", ".");
  await git(root, "commit", "-m", "gone work");
  await git(root, "checkout", "main");
  await git(root, "merge", "--no-ff", "feature/gone", "-m", "merge gone");
  const store = new MetadataStore(":memory:");
  const repos = new MetadataRepositories(store.db);
  const project = projectSchema.parse({
    id: "prj_branches_http",
    configuredRootPath: root,
    canonicalRootPath: root,
    displayLabel: "Branches HTTP",
    archivedAt: null,
  });
  repos.projects.save(project);
  const service = new BranchService(repos);
  const hub = new WorkspaceEventHub();
  const app = createBranchRoutes(service, hub);
  return { root, store, repos, project, app, hub };
}

describe("branches HTTP API", () => {
  test("lists branches and emits nothing on reads or failures", async () => {
    const f = await fixture();
    const sequence = () => f.hub.currentSequence(WORKSPACES_SNAPSHOT_SUBJECT);
    const res = await f.app.fetch(request(`/api/projects/${f.project.id}/branches`));
    expect(res.status).toBe(200);
    const json = (await res.json()) as Array<{ name: string }>;
    expect(json.map((b) => b.name)).toEqual(["feature/gone", "main"]);
    expect(sequence()).toBe(0);
    const missing = await f.app.fetch(request("/api/projects/prj_missing/branches"));
    expect(missing.status).toBe(409);
    expect(sequence()).toBe(0);
    f.store.close();
  });

  test("deletes a branch, returns the fresh list, and emits once", async () => {
    const f = await fixture();
    const res = await f.app.fetch(
      request(`/api/projects/${f.project.id}/branches/delete`, {
        method: "POST",
        body: JSON.stringify({ branch: "feature/gone" }),
      }),
    );
    expect(res.status).toBe(200);
    const json = (await res.json()) as Array<{ name: string }>;
    expect(json.map((b) => b.name)).toEqual(["main"]);
    expect(f.hub.currentSequence(WORKSPACES_SNAPSHOT_SUBJECT)).toBe(1);
    const replay = f.hub.subscribe(WORKSPACES_SNAPSHOT_SUBJECT, 0, () => {}).replay;
    expect(replay.kind).toBe("replay");
    if (replay.kind !== "replay") throw new Error("expected replay");
    expect(replay.events[0].payload).toMatchObject({ reason: "update", projectId: f.project.id });
    f.store.close();
  });

  test("rejects invalid bodies and failed deletes without emitting", async () => {
    const f = await fixture();
    const bad = await f.app.fetch(
      request(`/api/projects/${f.project.id}/branches/delete`, {
        method: "POST",
        body: JSON.stringify({ unexpectedKey: 1 }),
      }),
    );
    expect(bad.status).toBe(400);
    // Trunk deletion fails at the git layer and emits nothing.
    const trunk = await f.app.fetch(
      request(`/api/projects/${f.project.id}/branches/delete`, {
        method: "POST",
        body: JSON.stringify({ branch: "main" }),
      }),
    );
    expect(trunk.status).toBe(422);
    expect(f.hub.currentSequence(WORKSPACES_SNAPSHOT_SUBJECT)).toBe(0);
    f.store.close();
  });
});
