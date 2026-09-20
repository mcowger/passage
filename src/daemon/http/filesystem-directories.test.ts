import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MetadataRepositories, MetadataStore } from "../metadata/index.ts";
import { WorkspaceService } from "../workspaces/service.ts";
import { FileService } from "../workspaces/files.ts";
import { WorkspaceEventHub } from "../workspaces/events.ts";
import { createFileRoutes } from "./files.ts";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((r) => rm(r, { recursive: true, force: true })));
});

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "passage-fs-dirs-http-"));
  roots.push(root);
  await mkdir(join(root, "payments"));
  await mkdir(join(root, "payments-old"));
  await mkdir(join(root, "other"));
  await writeFile(join(root, "notes.txt"), "hi");
  const store = new MetadataStore(":memory:");
  const repos = new MetadataRepositories(store.db);
  const workspaces = new WorkspaceService(repos);
  const files = new FileService(workspaces);
  const events = new WorkspaceEventHub();
  const app = createFileRoutes(files, events);
  return { root, store, app };
}

const request = (path: string, init?: RequestInit) => new Request(`http://localhost${path}`, init);
type Body = { base: string; entries: Array<{ name: string; path: string }>; truncated: boolean };

describe("filesystem/directories HTTP API", () => {
  test("fuzzy-matches the trailing prefix and excludes files", async () => {
    const f = await fixture();
    const res = await f.app.fetch(request(`/api/filesystem/directories?path=${encodeURIComponent(join(f.root, "paym"))}`));
    expect(res.status).toBe(200);
    const body = await res.json() as Body;
    expect(body.base).toBe(f.root);
    expect(body.entries).toEqual([
      { name: "payments", path: join(f.root, "payments") },
      { name: "payments-old", path: join(f.root, "payments-old") },
    ]);
    expect(body.truncated).toBe(false);
    f.store.close();
  });

  test("trailing slash lists every child directory, sorted", async () => {
    const f = await fixture();
    const res = await f.app.fetch(request(`/api/filesystem/directories?path=${encodeURIComponent(`${f.root}/`)}`));
    expect(res.status).toBe(200);
    const body = await res.json() as Body;
    expect(body.entries.map((e) => e.name)).toEqual(["other", "payments", "payments-old"]);
    f.store.close();
  });

  test("unresolvable base yields an empty list, not an error", async () => {
    const f = await fixture();
    const res = await f.app.fetch(request(`/api/filesystem/directories?path=${encodeURIComponent(join(f.root, "missing", "deep"))}`));
    expect(res.status).toBe(200);
    const body = await res.json() as Body;
    expect(body.entries).toEqual([]);
    f.store.close();
  });

  test("enforces path and limit bounds", async () => {
    const f = await fixture();
    expect((await f.app.fetch(request(`/api/filesystem/directories?path=${"a".repeat(5000)}`))).status).toBe(400);
    expect((await f.app.fetch(request(`/api/filesystem/directories?path=${encodeURIComponent(f.root)}&limit=500`))).status).toBe(400);
    f.store.close();
  });

  test("empty path lists the home directory", async () => {
    const f = await fixture();
    const previousHome = process.env.HOME;
    process.env.HOME = f.root;
    try {
      const res = await f.app.fetch(request("/api/filesystem/directories"));
      expect(res.status).toBe(200);
      const body = await res.json() as Body;
      expect(body.base).toBe(f.root);
      expect(body.entries.map((e) => e.name)).toEqual(["other", "payments", "payments-old"]);
    } finally {
      if (previousHome === undefined) delete process.env.HOME;
      else process.env.HOME = previousHome;
    }
    f.store.close();
  });
});
