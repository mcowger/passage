import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { MetadataRepositories, MetadataStore } from "../metadata/index.ts";
import { WorkspaceService } from "../workspaces/service.ts";
import { FileService } from "../workspaces/files.ts";
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
  const app = createFileRoutes(files);

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

  return { root, store, repos, app, workspace };
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
});
