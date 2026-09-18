import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
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
  const root = await mkdtemp(join(tmpdir(), "passage-files-http-"));
  roots.push(root);
  const store = new MetadataStore(join(root, "metadata.sqlite"));
  const repos = new MetadataRepositories(store.db);
  const workspaces = new WorkspaceService(repos);
  const files = new FileService(workspaces);
  const events = new WorkspaceEventHub();
  const received: EventEnvelope[] = [];
  const app = createFileRoutes(files, events);

  const project = projectSchema.parse({
    id: "prj_files",
    configuredRootPath: root,
    canonicalRootPath: root,
    displayLabel: "Files Project",
    archivedAt: null,
  });
  repos.projects.save(project);

  const workspace = workspaceSchema.parse({
    id: "wsp_files",
    projectId: project.id,
    kind: "directory",
    cwd: root,
    checkoutRoot: root,
    mainRepositoryRoot: null,
    branchRef: null,
    displayLabel: "Files Workspace",
    locationId: null,
    ownershipState: "not-owned",
    markerId: null,
    markerPath: null,
    repairDetail: null,
    archivedAt: null,
  });
  repos.workspaces.save(workspace);

  const subscription = events.subscribe("wsp_files", 0, (e) => received.push(e));
  subscription.activate();

  return { root, store, repos, app, workspace, events, received };
}

const request = (path: string, init?: RequestInit) => new Request(`http://localhost${path}`, init);

describe("files HTTP API", () => {
  test("lists directory entries and reads files", async () => {
    const f = await fixture();
    await writeFile(join(f.root, "hello.txt"), "Hello, Passage!");
    await mkdir(join(f.root, "src"));
    await writeFile(join(f.root, "src", "index.ts"), "export const x = 1;");

    const listRes = await f.app.fetch(request(`/api/workspaces/${f.workspace.id}/files?path=.`));
    expect(listRes.status).toBe(200);
    const list = await listRes.json() as { entries: Array<{ name: string; kind: string }> };
    expect(list.entries.some((e) => e.name === "hello.txt" && e.kind === "file")).toBe(true);
    expect(list.entries.some((e) => e.name === "src" && e.kind === "directory")).toBe(true);

    const readRes = await f.app.fetch(request(`/api/workspaces/${f.workspace.id}/files/read?path=hello.txt`));
    expect(readRes.status).toBe(200);
    const read = await readRes.json() as { content: string; revision: { hash: string } };
    expect(read.content).toBe("Hello, Passage!");
    expect(read.revision.hash).toBeDefined();

    f.store.close();
  });

  test("writes file with optimistic revision check and detects conflict", async () => {
    const f = await fixture();
    await writeFile(join(f.root, "config.json"), "{}");

    const initialRead = await (await f.app.fetch(request(`/api/workspaces/${f.workspace.id}/files/read?path=config.json`))).json() as {
      content: string;
      revision: { hash: string; modifiedAt: number; size: number };
    };

    // Successful write with matching revision
    const writeRes = await f.app.fetch(
      request(`/api/workspaces/${f.workspace.id}/files`, {
        method: "PUT",
        body: JSON.stringify({
          path: "config.json",
          content: '{"updated": true}',
          expected: initialRead.revision,
        }),
      }),
    );
    expect(writeRes.status).toBe(200);

    // Conflict when using stale revision
    const staleWrite = await f.app.fetch(
      request(`/api/workspaces/${f.workspace.id}/files`, {
        method: "PUT",
        body: JSON.stringify({
          path: "config.json",
          content: '{"stale": true}',
          expected: initialRead.revision,
        }),
      }),
    );
    expect(staleWrite.status).toBe(409);

    f.store.close();
  });

  test("pages directories larger than the entry limit", async () => {
    const f = await fixture();
    await Promise.all(Array.from({ length: 1001 }, (_, index) => writeFile(join(f.root, `file-${index}.txt`), String(index))));

    const firstRes = await f.app.fetch(request(`/api/workspaces/${f.workspace.id}/files?path=.`));
    expect(firstRes.status).toBe(200);
    const first = await firstRes.json() as { entries: Array<{ name: string }>; nextCursor: string | null };
    expect(first.entries).toHaveLength(1000);
    expect(first.nextCursor).toBe("1000");

    const secondRes = await f.app.fetch(request(`/api/workspaces/${f.workspace.id}/files?path=.&cursor=${first.nextCursor}`));
    expect(secondRes.status).toBe(200);
    const second = await secondRes.json() as { entries: Array<{ name: string }>; nextCursor: string | null };
    expect(second.entries).toHaveLength(2);
    expect(second.nextCursor).toBeNull();

    f.store.close();
  });

  test("creates, renames, duplicates, and deletes files and directories", async () => {
    const f = await fixture();
    const post = (suffix: string, body: unknown) => f.app.fetch(
      request(`/api/workspaces/${f.workspace.id}/files/${suffix}`, { method: "POST", body: JSON.stringify(body) }),
    );

    const dirRes = await post("create", { path: "notes", kind: "directory" });
    expect(dirRes.status).toBe(201);

    const fileRes = await post("create", { path: "notes/todo.txt", kind: "file" });
    expect(fileRes.status).toBe(201);

    const conflictRes = await post("create", { path: "notes/todo.txt", kind: "file" });
    expect(conflictRes.status).toBe(409);

    const renameRes = await post("rename", { path: "notes/todo.txt", newPath: "notes/done.txt" });
    expect(renameRes.status).toBe(200);
    expect(((await renameRes.json()) as { path: string }).path).toBe("notes/done.txt");

    await writeFile(join(f.root, "notes", "done.txt"), "hello");
    const dupRes = await post("duplicate", { path: "notes/done.txt" });
    expect(dupRes.status).toBe(201);
    const dupPath = ((await dupRes.json()) as { path: string }).path;
    expect(dupPath).toBe("notes/done copy.txt");

    const deleteRes = await f.app.fetch(request(`/api/workspaces/${f.workspace.id}/files?path=${encodeURIComponent(dupPath)}`, { method: "DELETE" }));
    expect(deleteRes.status).toBe(200);

    const rootDelete = await f.app.fetch(request(`/api/workspaces/${f.workspace.id}/files?path=.`, { method: "DELETE" }));
    expect(rootDelete.status).toBe(400);

    const traversal = await post("create", { path: "../escape.txt", kind: "file" });
    expect(traversal.status).toBe(400);

    f.store.close();
  });

  test("emits files-changed invalidations on every mutation", async () => {
    const f = await fixture();
    const post = (suffix: string, body: unknown) => f.app.fetch(
      request(`/api/workspaces/${f.workspace.id}/files/${suffix}`, { method: "POST", body: JSON.stringify(body) }),
    );
    const reasons = () => f.received.map((e) => (e.payload as { reason: string }).reason);

    await post("create", { path: "a.txt", kind: "file" });
    await writeFile(join(f.root, "a.txt"), "v1");
    const read = await (await f.app.fetch(request(`/api/workspaces/${f.workspace.id}/files/read?path=a.txt`))).json() as {
      revision: { hash: string; modifiedAt: number; size: number };
    };
    await f.app.fetch(request(`/api/workspaces/${f.workspace.id}/files`, {
      method: "PUT",
      body: JSON.stringify({ path: "a.txt", content: "v2", expected: read.revision }),
    }));
    await post("duplicate", { path: "a.txt" });
    await post("rename", { path: "a.txt", newPath: "b.txt" });
    await f.app.fetch(request(`/api/workspaces/${f.workspace.id}/files?path=b.txt`, { method: "DELETE" }));
    // Reads and failed mutations emit nothing.
    await f.app.fetch(request(`/api/workspaces/${f.workspace.id}/files?path=.`));
    await post("create", { path: "../escape.txt", kind: "file" });

    expect(reasons()).toEqual(["create", "write", "duplicate", "rename", "delete"]);
    expect(f.received.every((e) => e.stream === "workspace" && e.subjectId === f.workspace.id && e.type === "files-changed")).toBe(true);
    expect(f.received.map((e) => e.sequence)).toEqual([1, 2, 3, 4, 5]);
    const rename = f.received[3].payload as { path?: string; previousPath?: string };
    expect(rename).toMatchObject({ path: "b.txt", previousPath: "a.txt" });

    f.store.close();
  });

  test("serves raw image bytes for model-read previews and rejects non-images", async () => {
    const f = await fixture();
    const pngBytes = Buffer.from("fake-png-bytes");
    await writeFile(join(f.root, "shot.png"), pngBytes);
    await writeFile(join(f.root, "notes.txt"), "hello");

    const imageRes = await f.app.fetch(request(`/api/workspaces/${f.workspace.id}/files/raw?path=shot.png`));
    expect(imageRes.status).toBe(200);
    expect(imageRes.headers.get("content-type")).toBe("image/png");
    expect(new Uint8Array(await imageRes.arrayBuffer())).toEqual(new Uint8Array(pngBytes));

    const absoluteImageRes = await f.app.fetch(request(`/api/workspaces/${f.workspace.id}/files/raw?path=${encodeURIComponent(join(f.root, "shot.png"))}`));
    expect(absoluteImageRes.status).toBe(200);
    expect(absoluteImageRes.headers.get("content-type")).toBe("image/png");
    expect(new Uint8Array(await absoluteImageRes.arrayBuffer())).toEqual(new Uint8Array(pngBytes));

    const textRes = await f.app.fetch(request(`/api/workspaces/${f.workspace.id}/files/raw?path=notes.txt`));
    expect(textRes.status).toBe(400);

    const missingRes = await f.app.fetch(request(`/api/workspaces/${f.workspace.id}/files/raw?path=missing.png`));
    expect(missingRes.status).toBe(400);

    const traversalRes = await f.app.fetch(request(`/api/workspaces/${f.workspace.id}/files/raw?path=${encodeURIComponent("../escape.png")}`));
    expect(traversalRes.status).toBe(400);

    // Absolute paths outside the workspace (e.g. /tmp screenshots the model
    // read) serve directly — extension + size capped, nothing else.
    const outsideDir = await mkdtemp(join(tmpdir(), "passage-raw-outside-"));
    roots.push(outsideDir);
    const outsidePath = join(outsideDir, "outside.png");
    await writeFile(outsidePath, pngBytes);
    const outsideRes = await f.app.fetch(request(`/api/workspaces/${f.workspace.id}/files/raw?path=${encodeURIComponent(outsidePath)}`));
    expect(outsideRes.status).toBe(200);
    expect(outsideRes.headers.get("content-type")).toBe("image/png");
    expect(new Uint8Array(await outsideRes.arrayBuffer())).toEqual(new Uint8Array(pngBytes));

    f.store.close();
  });
});
