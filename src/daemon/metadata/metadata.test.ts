import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MetadataRepositories, MetadataStore } from "./index.ts";

const directories: string[] = [];

async function open() {
  const directory = await mkdtemp(join(tmpdir(), "passage-metadata-"));
  directories.push(directory);
  const path = join(directory, "metadata.sqlite");
  const store = new MetadataStore(path);
  return { path, store, repositories: new MetadataRepositories(store.db) };
}

function seed(repositories: MetadataRepositories): void {
  repositories.projects.save({
    id: "project-1",
    configuredRootPath: "~/src/app",
    canonicalRootPath: "/home/user/src/app",
    displayLabel: "App",
    iconName: null,
    iconColor: null,
    archivedAt: null,
  });
  repositories.worktreeLocations.save({
    id: "location-1",
    projectId: "project-1",
    scope: "project",
    displayLabel: "Fast disk",
    configuredRootPath: "~/worktrees",
    canonicalRootPath: "/home/user/worktrees",
    enabled: true,
  });
  repositories.workspaces.save({
    id: "workspace-1",
    projectId: "project-1",
    kind: "directory",
    cwd: "/home/user/src/app",
    checkoutRoot: "/home/user/src/app",
    mainRepositoryRoot: "/home/user/src/app",
    branchRef: "main",
    displayLabel: "Main",
    locationId: "location-1",
    ownershipState: "not-owned",
    archivedAt: null,
  });
  repositories.agents.save({
    id: "agent-1",
    workspaceId: "workspace-1",
    piSessionId: "pi-session-1",
    piSessionPath: null,
    title: "Agent",
    titleOverridden: false,
    modelPreference: null,
    thinkingPreference: "medium",
    lastKnownStatus: "idle",
    archivedAt: null,
  });
}

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("metadata persistence", () => {
  test("migrates an empty database and reopens idempotently", async () => {
    const { path, store } = await open();
    expect(store.schemaVersion).toBe(6);
    store.close();
    const reopened = new MetadataStore(path);
    expect(reopened.schemaVersion).toBe(6);
    reopened.close();
  });

  test("round trips every metadata record", async () => {
    const { store, repositories } = await open();
    seed(repositories);
    repositories.workspaces.saveLayout("workspace-1", { version: 1, root: { type: "tabs" } });
    repositories.workspaces.savePreferences("workspace-1", { wrap: true });
    repositories.webPreviews.save({ id: "preview-1", workspaceId: "workspace-1", displayLabel: "Preview", targetUrl: "http://localhost:3000/", viewport: { width: 1280, height: 800, deviceScaleFactor: 1 }, createdAt: "2026-09-16T00:00:00Z", updatedAt: "2026-09-16T00:00:00Z" });
    expect(repositories.webPreviews.get("preview-1")?.targetUrl).toBe("http://localhost:3000/");
    expect(repositories.webPreviews.listForWorkspace("workspace-1", 10).length).toBe(1);

    expect(repositories.projects.get("project-1")?.displayLabel).toBe("App");
    expect(repositories.worktreeLocations.get("location-1")?.enabled).toBe(true);
    expect(repositories.workspaces.get("workspace-1")?.branchRef).toBe("main");
    expect(repositories.agents.get("agent-1")?.piSessionId).toBe("pi-session-1");
    expect(repositories.workspaces.getLayout<{ version: number; root: { type: string } }>("workspace-1")?.root.type).toBe("tabs");
    expect(repositories.workspaces.getPreferences<{ wrap: boolean }>("workspace-1")?.wrap).toBe(true);
    store.close();
  });

  test("updates workspace documents without replacing workspace metadata", async () => {
    const { store, repositories } = await open();
    seed(repositories);
    repositories.workspaces.saveLayout("workspace-1", { version: 1, root: { type: "tabs" } });
    repositories.workspaces.savePreferences("workspace-1", { wrap: true });

    expect(repositories.workspaces.get("workspace-1")?.displayLabel).toBe("Main");
    expect(repositories.workspaces.getLayout<{ version: number }>("workspace-1")?.version).toBe(1);
    expect(repositories.workspaces.getPreferences<{ wrap: boolean }>("workspace-1")?.wrap).toBe(true);
    store.close();
  });

  test("updates and archives parents without deleting children", async () => {
    const { store, repositories } = await open();
    seed(repositories);
    repositories.projects.save({
      ...repositories.projects.get("project-1")!,
      displayLabel: "Renamed",
    });
    repositories.projects.archive("project-1", "2026-08-28T00:00:00Z");
    repositories.workspaces.archive("workspace-1", "2026-08-28T00:00:00Z");
    repositories.agents.archive("agent-1", "2026-08-28T00:00:00Z");

    expect(repositories.projects.get("project-1")?.displayLabel).toBe("Renamed");
    expect(repositories.workspaces.get("workspace-1")?.archivedAt).not.toBeNull();
    expect(repositories.agents.get("agent-1")?.archivedAt).not.toBeNull();
    store.close();
  });

  test("enforces foreign keys and location scope", async () => {
    const { store, repositories } = await open();
    expect(() => repositories.workspaces.save({
      id: "workspace-1", projectId: "missing", kind: "directory", cwd: "/x",
      checkoutRoot: null, mainRepositoryRoot: null, branchRef: null, displayLabel: "Work",
      locationId: null, ownershipState: "not-owned", archivedAt: null,
    })).toThrow();
    expect(() => repositories.worktreeLocations.save({
      id: "location-1", projectId: null, scope: "project", displayLabel: "Invalid",
      configuredRootPath: "/x", canonicalRootPath: "/x", enabled: true,
    })).toThrow();
    store.close();
  });

  test("rejects altered or unknown migration history", async () => {
    const { path, store } = await open();
    store.db.query("UPDATE schema_migrations SET checksum = 'altered' WHERE version = 1").run();
    store.close();
    expect(() => new MetadataStore(path)).toThrow("migration history");
  });
});
