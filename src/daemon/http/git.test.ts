import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { MetadataRepositories, MetadataStore } from "../metadata/index.ts";
import { WorkspaceService } from "../workspaces/service.ts";
import { GitService } from "../workspaces/git.ts";
import { createGitRoutes } from "./git.ts";
import { projectSchema, workspaceSchema } from "../../shared/domain/workspaces.ts";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((r) => rm(r, { recursive: true, force: true })));
});

async function runGit(cwd: string, args: string[]) {
  const p = Bun.spawn(["git", "-C", cwd, ...args], { stdout: "ignore", stderr: "ignore" });
  await p.exited;
}

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "passage-git-http-"));
  roots.push(root);

  await runGit(root, ["init", "-b", "main"]);
  await runGit(root, ["config", "user.email", "test@passage.dev"]);
  await runGit(root, ["config", "user.name", "Passage Test"]);

  await writeFile(join(root, "README.md"), "# Init");
  await runGit(root, ["add", "README.md"]);
  await runGit(root, ["commit", "-m", "Initial commit"]);

  const store = new MetadataStore(join(root, "metadata.sqlite"));
  const repos = new MetadataRepositories(store.db);
  const workspaces = new WorkspaceService(repos);
  const git = new GitService();
  const app = createGitRoutes(workspaces, git);

  const project = projectSchema.parse({
    id: "prj_git",
    configuredRootPath: root,
    canonicalRootPath: root,
    displayLabel: "Git Project",
    archivedAt: null,
  });
  repos.projects.save(project);

  const workspace = workspaceSchema.parse({
    id: "wsp_git",
    projectId: project.id,
    kind: "directory",
    cwd: root,
    checkoutRoot: root,
    mainRepositoryRoot: root,
    branchRef: "main",
    displayLabel: "Git Workspace",
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

describe("git HTTP API", () => {
  test("reports git status and calculates structured diffs", async () => {
    const f = await fixture();

    // Modify README and add a new file
    await writeFile(join(f.root, "README.md"), "# Init\nUpdated line");
    await writeFile(join(f.root, "new-file.txt"), "New file content");

    const statusRes = await f.app.fetch(request(`/api/workspaces/${f.workspace.id}/git/status`));
    expect(statusRes.status).toBe(200);
    const status = await statusRes.json() as { files: Array<{ path: string; kind: string }>; dirty: boolean };
    expect(status.dirty).toBe(true);
    expect(status.files.some((file) => file.path === "README.md" && file.kind === "modified")).toBe(true);
    expect(status.files.some((file) => file.path === "new-file.txt" && file.kind === "untracked")).toBe(true);

    const diffRes = await f.app.fetch(request(`/api/workspaces/${f.workspace.id}/git/diff?target=working-tree`));
    expect(diffRes.status).toBe(200);
    const diffs = await diffRes.json() as Array<{ path: string; additions: number; hunks: Array<{ lines: Array<{ kind: string; text: string }> }> }>;
    expect(diffs.some((d) => d.path === "README.md" && d.additions > 0)).toBe(true);

    f.store.close();
  });
});
