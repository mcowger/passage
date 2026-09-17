import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { MetadataRepositories, MetadataStore } from "../metadata/index.ts";
import { WorkspaceService } from "./service.ts";
import { WorktreeService } from "./worktrees.ts";
import {
  WorkspaceActionError,
  WorkspaceActionsService,
  normalizeLifecycleCommands,
  readPaseoSetupCommands,
} from "./actions.ts";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((r) => rm(r, { recursive: true, force: true })));
});

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "passage-actions-test-"));
  roots.push(root);
  const store = new MetadataStore(join(root, "metadata.sqlite"));
  const repositories = new MetadataRepositories(store.db);
  const workspaceService = new WorkspaceService(repositories);
  const actions = new WorkspaceActionsService(repositories);
  return { root, store, repositories, workspaceService, actions };
}

async function workspaceWithCommands(
  f: Awaited<ReturnType<typeof fixture>>,
  commands: unknown,
) {
  const dir = join(f.root, `ws-${crypto.randomUUID()}`);
  await mkdir(dir, { recursive: true });
  const project = await f.workspaceService.registerProject(f.root, "Project");
  if (commands !== undefined) {
    await writeFile(join(dir, "paseo.json"), JSON.stringify({ worktree: { setup: commands } }));
  }
  const workspace = await f.workspaceService.createDirectoryWorkspace(project.id, {
    cwd: dir,
    displayLabel: "Actions",
  });
  return { dir, workspace };
}

describe("normalizeLifecycleCommands", () => {
  test("accepts a single string, an array, and drops blanks", () => {
    expect(normalizeLifecycleCommands("./init.sh")).toEqual(["./init.sh"]);
    expect(normalizeLifecycleCommands("  ")).toEqual([]);
    expect(normalizeLifecycleCommands(["a", " ", 42, "b"])).toEqual(["a", "b"]);
    expect(normalizeLifecycleCommands(undefined)).toEqual([]);
    expect(normalizeLifecycleCommands(42)).toEqual([]);
  });
});

describe("readPaseoSetupCommands", () => {
  test("returns an empty list without a paseo.json file", async () => {
    const dir = await mkdtemp(join(tmpdir(), "passage-actions-empty-"));
    roots.push(dir);
    expect(readPaseoSetupCommands(dir)).toEqual([]);
  });

  test("ignores invalid JSON and non-setup content", async () => {
    const dir = await mkdtemp(join(tmpdir(), "passage-actions-invalid-"));
    roots.push(dir);
    await writeFile(join(dir, "paseo.json"), "{not json");
    expect(readPaseoSetupCommands(dir)).toEqual([]);
    await writeFile(join(dir, "paseo.json"), JSON.stringify({ scripts: { dev: { command: "x" } } }));
    expect(readPaseoSetupCommands(dir)).toEqual([]);
  });
});

describe("WorkspaceActionsService list", () => {
  test("returns no actions without setup commands", async () => {
    const f = await fixture();
    const { workspace } = await workspaceWithCommands(f, undefined);
    expect(f.actions.list(workspace.id)).toEqual([]);
    f.store.close();
  });

  test("derives the setup action from paseo.json", async () => {
    const f = await fixture();
    const { workspace } = await workspaceWithCommands(f, ["./init.sh", "bun install"]);
    expect(f.actions.list(workspace.id)).toEqual([
      { id: "setup", label: "Worktree setup", commands: ["./init.sh", "bun install"], source: "paseo.json" },
    ]);
    f.store.close();
  });

  test("rejects unknown workspaces", async () => {
    const f = await fixture();
    expect(() => f.actions.list("wsp_missing")).toThrow(
      expect.objectContaining({ code: "not-found" }),
    );
    f.store.close();
  });
});

describe("WorkspaceActionsService runs", () => {
  async function waitForSettled(
    f: Awaited<ReturnType<typeof fixture>>,
    workspaceId: string,
    runId: string,
    timeoutMs = 15_000,
  ) {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const run = f.actions.get(workspaceId, runId);
      if (run.status !== "running") return run;
      if (Date.now() > deadline) throw new Error(`timed out waiting for run ${runId}`);
      await Bun.sleep(25);
    }
  }

  test("start returns immediately and runs commands in the background", async () => {
    const f = await fixture();
    const { workspace, dir } = await workspaceWithCommands(f, [
      "echo hello",
      "touch marker.txt",
    ]);
    const started = await f.actions.start(workspace.id, "setup");
    expect(started.status).toBe("running");
    expect(started.results).toEqual([]);
    expect(started.currentCommand).toBe("echo hello");
    expect(started.finishedAt).toBeNull();

    const result = await waitForSettled(f, workspace.id, started.id);
    expect(result.status).toBe("succeeded");
    expect(result.commands).toEqual(["echo hello", "touch marker.txt"]);
    expect(result.results).toHaveLength(2);
    expect(result.results[0].stdout).toContain("hello");
    expect(result.results.every((r) => r.exitCode === 0)).toBe(true);
    expect(result.currentCommand).toBeNull();
    expect(result.finishedAt).not.toBeNull();
    expect(await Bun.file(join(dir, "marker.txt")).exists()).toBe(true);
    f.store.close();
  });

  test("stops at the first failing command", async () => {
    const f = await fixture();
    const { workspace, dir } = await workspaceWithCommands(f, [
      "exit 3",
      "touch should-not-exist.txt",
    ]);
    const started = await f.actions.start(workspace.id, "setup");
    const result = await waitForSettled(f, workspace.id, started.id);
    expect(result.status).toBe("failed");
    expect(result.results).toHaveLength(1);
    expect(result.results[0].exitCode).toBe(3);
    expect(result.error).toContain("exit 3");
    expect(await Bun.file(join(dir, "should-not-exist.txt")).exists()).toBe(false);
    f.store.close();
  });

  test("succeeds trivially without setup commands", async () => {
    const f = await fixture();
    const { workspace } = await workspaceWithCommands(f, undefined);
    const started = await f.actions.start(workspace.id, "setup");
    const result = await waitForSettled(f, workspace.id, started.id);
    expect(result.status).toBe("succeeded");
    expect(result.commands).toEqual([]);
    expect(result.results).toEqual([]);
    f.store.close();
  });

  test("rejects unknown action ids without executing anything", async () => {
    const f = await fixture();
    const { workspace } = await workspaceWithCommands(f, ["touch nope.txt"]);
    const failure = await f.actions.start(workspace.id, "teardown").then(
      () => null,
      (error: unknown) => error,
    );
    expect(failure).toBeInstanceOf(WorkspaceActionError);
    expect(failure).toMatchObject({ code: "unknown-action" });
    f.store.close();
  });

  test("rejects a second start while a run is active", async () => {
    const f = await fixture();
    const { workspace } = await workspaceWithCommands(f, ["sleep 5"]);
    const first = await f.actions.start(workspace.id, "setup");
    const failure = await f.actions.start(workspace.id, "setup").then(
      () => null,
      (error: unknown) => error,
    );
    expect(failure).toBeInstanceOf(WorkspaceActionError);
    expect(failure).toMatchObject({ code: "action-running", runId: first.id });
    f.actions.cancel(workspace.id, first.id);
    const settled = await waitForSettled(f, workspace.id, first.id);
    expect(settled.status).toBe("cancelled");
    f.store.close();
  });

  test("cancel settles a running action as cancelled", async () => {
    const f = await fixture();
    const { workspace } = await workspaceWithCommands(f, ["sleep 30"]);
    const started = await f.actions.start(workspace.id, "setup");
    const cancelled = f.actions.cancel(workspace.id, started.id);
    expect(cancelled.id).toBe(started.id);
    const result = await waitForSettled(f, workspace.id, started.id);
    expect(result.status).toBe("cancelled");
    expect(result.error).toContain("cancelled");
    expect(result.finishedAt).not.toBeNull();
    f.store.close();
  });

  test("cancel is idempotent once a run has settled", async () => {
    const f = await fixture();
    const { workspace } = await workspaceWithCommands(f, ["echo done"]);
    const started = await f.actions.start(workspace.id, "setup");
    const settled = await waitForSettled(f, workspace.id, started.id);
    expect(settled.status).toBe("succeeded");
    expect(f.actions.cancel(workspace.id, started.id).status).toBe("succeeded");
    f.store.close();
  });

  test("get rejects unknown runs and cross-workspace lookups", async () => {
    const f = await fixture();
    const { workspace } = await workspaceWithCommands(f, ["echo done"]);
    const other = await workspaceWithCommands(f, ["echo done"]);
    const started = await f.actions.start(workspace.id, "setup");
    await waitForSettled(f, workspace.id, started.id);
    expect(() => f.actions.get(workspace.id, "arun_missing")).toThrow(
      expect.objectContaining({ code: "not-found" }),
    );
    expect(() => f.actions.get(other.workspace.id, started.id)).toThrow(
      expect.objectContaining({ code: "not-found" }),
    );
    f.store.close();
  });
});

describe("WorktreeService setup auto-run", () => {
  const git = async (cwd: string, ...args: string[]) => {
    const p = Bun.spawn(["git", "-C", cwd, ...args], { stdout: "pipe", stderr: "pipe" });
    if ((await p.exited) !== 0) throw new Error(await new Response(p.stderr).text());
  };

  test("auto-runs paseo.json setup after worktree creation", async () => {
    const f = await fixture();
    const repo = join(f.root, "repo");
    await mkdir(repo);
    await git(repo, "init", "-b", "main");
    await git(repo, "config", "user.email", "test@example.com");
    await git(repo, "config", "user.name", "Test");
    await writeFile(join(repo, "paseo.json"), JSON.stringify({ worktree: { setup: ["touch init-marker.txt"] } }));
    await writeFile(join(repo, "README.md"), "# Test\n");
    await git(repo, "add", ".");
    await git(repo, "commit", "-m", "initial");

    const project = await f.workspaceService.registerProject(repo, "Test Project");
    const locations = join(f.root, "locations");
    await mkdir(locations);
    const location = await f.workspaceService.configureLocation({
      displayLabel: "Test",
      configuredRootPath: locations,
    });
    await git(repo, "branch", "feature-setup");
    const worktrees = new WorktreeService(f.repositories, undefined, undefined, f.actions);
    const result = await worktrees.create(project.id, location.id, "feature-setup", "Setup", "wt-setup");

    expect(result.setup?.status).toBe("running");
    const deadline = Date.now() + 15_000;
    let settled = f.actions.get(result.workspace.id, result.setup?.id ?? "");
    while (settled.status === "running" && Date.now() <= deadline) {
      await Bun.sleep(25);
      settled = f.actions.get(result.workspace.id, result.setup?.id ?? "");
    }
    expect(settled.status).toBe("succeeded");
    expect(settled.commands).toEqual(["touch init-marker.txt"]);
    expect(await Bun.file(join(result.workspace.cwd, "init-marker.txt")).exists()).toBe(true);
    f.store.close();
  });

  test("creation still succeeds when setup fails", async () => {
    const f = await fixture();
    const repo = join(f.root, "repo");
    await mkdir(repo);
    await git(repo, "init", "-b", "main");
    await git(repo, "config", "user.email", "test@example.com");
    await git(repo, "config", "user.name", "Test");
    await writeFile(join(repo, "paseo.json"), JSON.stringify({ worktree: { setup: ["exit 7"] } }));
    await writeFile(join(repo, "README.md"), "# Test\n");
    await git(repo, "add", ".");
    await git(repo, "commit", "-m", "initial");

    const project = await f.workspaceService.registerProject(repo, "Test Project");
    const locations = join(f.root, "locations");
    await mkdir(locations);
    const location = await f.workspaceService.configureLocation({
      displayLabel: "Test",
      configuredRootPath: locations,
    });
    await git(repo, "branch", "feature-setup-fails");
    const worktrees = new WorktreeService(f.repositories, undefined, undefined, f.actions);
    const result = await worktrees.create(project.id, location.id, "feature-setup-fails", "Setup fails", "wt-setup-fails");

    expect(result.workspace.id).toBeDefined();
    expect(result.setup?.status).toBe("running");
    const deadline = Date.now() + 15_000;
    let settled = f.actions.get(result.workspace.id, result.setup?.id ?? "");
    while (settled.status === "running" && Date.now() <= deadline) {
      await Bun.sleep(25);
      settled = f.actions.get(result.workspace.id, result.setup?.id ?? "");
    }
    expect(settled.status).toBe("failed");
    expect(settled.results[0].exitCode).toBe(7);
    expect(f.repositories.workspaces.get(result.workspace.id)).toBeDefined();
    f.store.close();
  });
});
