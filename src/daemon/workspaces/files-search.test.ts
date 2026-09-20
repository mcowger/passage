import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MetadataRepositories, MetadataStore } from "../metadata/index.ts";
import { WorkspaceService } from "./service.ts";
import { FileService } from "./files.ts";
import { projectSchema, workspaceSchema } from "../../shared/domain/workspaces.ts";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((r) => rm(r, { recursive: true, force: true })));
});

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "passage-files-search-"));
  roots.push(root);
  const store = new MetadataStore(":memory:");
  const repos = new MetadataRepositories(store.db);
  const workspaces = new WorkspaceService(repos);
  const files = new FileService(workspaces);
  const project = projectSchema.parse({
    id: "prj_search",
    configuredRootPath: root,
    canonicalRootPath: root,
    displayLabel: "Search Project",
    archivedAt: null,
  });
  repos.projects.save(project);
  const workspace = workspaceSchema.parse({
    id: "wsp_search",
    projectId: project.id,
    kind: "directory",
    cwd: root,
    checkoutRoot: root,
    mainRepositoryRoot: null,
    branchRef: null,
    displayLabel: "Search Workspace",
    locationId: null,
    ownershipState: "not-owned",
    markerId: null,
    markerPath: null,
    repairDetail: null,
    archivedAt: null,
  });
  repos.workspaces.save(workspace);
  return { root, store, files, workspace };
}

describe("FileService.search", () => {
  test("matches case-insensitively with prefix results first", async () => {
    const f = await fixture();
    await writeFile(join(f.root, "README.md"), "hi");
    await mkdir(join(f.root, "src"));
    await writeFile(join(f.root, "src", "index.ts"), "x");
    await writeFile(join(f.root, "src", "readme-helper.ts"), "x");

    const { entries } = await f.files.search(f.workspace.id, "readme", 20);
    expect(entries.map((e) => e.path)).toContain("README.md");
    expect(entries.map((e) => e.path)).toContain("src/readme-helper.ts");
    expect(entries[0]!.path).toBe("README.md");
    f.store.close();
  });

  test("handles paths with spaces and matches after renames", async () => {
    const f = await fixture();
    await mkdir(join(f.root, "my docs"));
    await writeFile(join(f.root, "my docs", "notes file.txt"), "v1");
    await f.files.rename(f.workspace.id, "my docs/notes file.txt", "my docs/renamed file.txt");

    const { entries } = await f.files.search(f.workspace.id, "renamed", 20);
    expect(entries).toEqual([{ path: "my docs/renamed file.txt", kind: "file" }]);
    const stale = await f.files.search(f.workspace.id, "notes file", 20);
    expect(stale.entries).toHaveLength(0);
    f.store.close();
  });

  test("never follows symlink escapes", async () => {
    const f = await fixture();
    const outside = await mkdtemp(join(tmpdir(), "passage-search-outside-"));
    roots.push(outside);
    await writeFile(join(outside, "secret.txt"), "secret");
    await symlink(join(outside, "secret.txt"), join(f.root, "link-secret.txt"));
    await symlink(outside, join(f.root, "link-dir"));

    const { entries } = await f.files.search(f.workspace.id, "secret", 20);
    expect(entries).toHaveLength(0);
    f.store.close();
  });

  test("caps results at the requested limit and rejects traversal", async () => {
    const f = await fixture();
    await Promise.all(Array.from({ length: 60 }, (_, i) => writeFile(join(f.root, `file-${i}.txt`), String(i))));

    const small = await f.files.search(f.workspace.id, "file-", 20);
    expect(small.entries).toHaveLength(20);
    expect(small.truncated).toBe(true);
    const capped = await f.files.search(f.workspace.id, "file-", 500);
    expect(capped.entries.length).toBeLessThanOrEqual(50);

    await expect(f.files.search("missing-workspace", "x", 20)).rejects.toThrow();
    f.store.close();
  });

  test("respects gitignore and never surfaces .git internals", async () => {
    const f = await fixture();
    const run = (args: string[]) => Bun.spawn(["git", "-C", f.root, ...args], { stdout: "ignore", stderr: "ignore" }).exited;
    await run(["init", "-q"]);
    await writeFile(join(f.root, ".gitignore"), "node_modules/\ndist/\n*.log\n");
    await mkdir(join(f.root, "src"));
    await writeFile(join(f.root, "src", "index.ts"), "x");
    await writeFile(join(f.root, "src", "debug.log"), "x");
    await mkdir(join(f.root, "node_modules"));
    await writeFile(join(f.root, "node_modules", "dep.js"), "x");
    await mkdir(join(f.root, "dist"));
    await writeFile(join(f.root, "dist", "bundle.js"), "x");

    expect((await f.files.search(f.workspace.id, "dep", 20)).entries).toHaveLength(0);
    expect((await f.files.search(f.workspace.id, "bundle", 20)).entries).toHaveLength(0);
    expect((await f.files.search(f.workspace.id, "debug", 20)).entries).toHaveLength(0);
    const visible = await f.files.search(f.workspace.id, "index", 20);
    expect(visible.entries.map((e) => e.path)).toContain("src/index.ts");
    const unfiltered = await f.files.search(f.workspace.id, "", 50);
    expect(unfiltered.entries.some((e) => e.path.startsWith("node_modules"))).toBe(false);
    expect(unfiltered.entries.some((e) => e.path.startsWith("dist"))).toBe(false);
    expect(unfiltered.entries.some((e) => e.path === ".git" || e.path.startsWith(".git/"))).toBe(false);
    expect((await f.files.search(f.workspace.id, "HEAD", 20)).entries).toHaveLength(0);
    f.store.close();
  });

  test("still surfaces tracked files that match gitignore", async () => {
    const f = await fixture();
    const run = (args: string[]) => Bun.spawn(["git", "-C", f.root, ...args], { stdout: "ignore", stderr: "ignore" }).exited;
    await run(["init", "-q"]);
    await writeFile(join(f.root, ".gitignore"), "node_modules/\n");
    await mkdir(join(f.root, "node_modules"));
    await writeFile(join(f.root, "node_modules", "keep.js"), "x");
    await run(["add", "-f", "node_modules/keep.js"]);

    const { entries } = await f.files.search(f.workspace.id, "keep", 20);
    expect(entries.map((e) => e.path)).toContain("node_modules/keep.js");
    f.store.close();
  });
});
