import { realpath, stat } from "node:fs/promises";
import { relative, resolve } from "node:path";
import { projectSchema, locationSchema, workspaceSchema, type Project, type WorktreeLocation, type Workspace, type WorkspaceSnapshot } from "../../shared/domain/workspaces.ts";
import { CURRENT_LAYOUT_SCHEMA_VERSION, workspaceLayoutSchema, createDefaultLayout, type WorkspaceLayout } from "../../shared/domain/layout.ts";
import { CURRENT_SETTINGS_SCHEMA_VERSION, workspaceSettingsSchema, DEFAULT_WORKSPACE_SETTINGS, type WorkspaceSettings } from "../../shared/domain/settings.ts";
import { MetadataRepositories } from "../metadata/repositories.ts";

const MAX_LIST = 100;
const MAX_GIT_OUTPUT = 4096;
const GIT_TIMEOUT_MS = 2000;
const id = (prefix: string) => `${prefix}_${crypto.randomUUID()}`;
const now = () => new Date().toISOString();

export class WorkspaceError extends Error { constructor(public readonly code: "not-found" | "invalid-root" | "outside-root" | "archived" | "invalid-location", message: string) { super(message); this.name = "WorkspaceError"; } }

export class WorkspaceService {
  constructor(private readonly repositories: MetadataRepositories, listLimit = MAX_LIST) {
    if (!Number.isInteger(listLimit) || listLimit < 1 || listLimit > MAX_LIST) throw new WorkspaceError("invalid-root", "Invalid list limit");
    this.listLimit = listLimit;
  }
  private readonly listLimit: number;

  async registerProject(configuredRootPath: string, displayLabel: string): Promise<Project> {
    const canonical = await this.directory(configuredRootPath, "invalid-root");
    const project = projectSchema.parse({ id: id("prj"), configuredRootPath, canonicalRootPath: canonical, displayLabel, archivedAt: null });
    this.repositories.projects.save(project);
    await this.ensureDefaultWorkspace(project.id);
    return project;
  }

  /** The Default workspace is the virtual worktree for the project root itself:
   *  not a linked git worktree, just the repository directory. Every project
   *  has exactly one active Default workspace; it hosts agents, terminals,
   *  files, and diffs like any other worktree. */
  async ensureDefaultWorkspace(projectId: string): Promise<Workspace> {
    const project = this.requireProject(projectId);
    if (project.archivedAt) throw new WorkspaceError("archived", "Project is archived");
    const active = this.repositories.workspaces.listForProject(projectId, this.listLimit, false);
    const existing = active.find((candidate) => candidate.kind !== "worktree" && candidate.cwd === project.canonicalRootPath);
    if (existing) return workspaceSchema.parse(existing);
    const git = await this.discoverGit(project.canonicalRootPath);
    const workspace = workspaceSchema.parse({
      id: id("wsp"),
      projectId,
      kind: "main-checkout",
      cwd: project.canonicalRootPath,
      checkoutRoot: git?.checkoutRoot ?? project.canonicalRootPath,
      mainRepositoryRoot: git?.mainRepositoryRoot ?? null,
      branchRef: git?.branchRef ?? null,
      displayLabel: "Default",
      locationId: null,
      ownershipState: "main-checkout",
      markerId: null,
      markerPath: null,
      repairDetail: null,
      archivedAt: null,
    });
    this.repositories.workspaces.save(workspace);
    return workspace;
  }

  async ensureAllDefaults(): Promise<void> {
    for (const project of this.repositories.projects.list(this.listLimit, false)) {
      try {
        await this.ensureDefaultWorkspace(project.id);
      } catch {
        // Leave legacy/unreachable project roots alone; snapshot still returns.
      }
    }
  }

  async configureLocation(input: { projectId?: string; displayLabel: string; configuredRootPath: string; enabled?: boolean }): Promise<WorktreeLocation> {
    const projectId = input.projectId ?? null;
    if (projectId) {
      const project = this.repositories.projects.get(projectId);
      if (!project) throw new WorkspaceError("not-found", "Project not found");
      if (project.archivedAt) throw new WorkspaceError("archived", "Project is archived");
    }
    const canonical = await this.directory(input.configuredRootPath, "invalid-root");
    const location = locationSchema.parse({ id: id("loc"), projectId, scope: projectId ? "project" : "global", displayLabel: input.displayLabel, configuredRootPath: input.configuredRootPath, canonicalRootPath: canonical, enabled: input.enabled ?? true });
    this.repositories.worktreeLocations.save(location); return location;
  }

  async createDirectoryWorkspace(projectId: string, input: { cwd?: string; displayLabel: string }): Promise<Workspace> {
    const project = this.requireProject(projectId);
    if (project.archivedAt) throw new WorkspaceError("archived", "Project is archived");
    const cwd = await this.within(project.canonicalRootPath, input.cwd ?? project.canonicalRootPath);
    const git = await this.discoverGit(cwd);
    const workspace = workspaceSchema.parse({ id: id("wsp"), projectId, kind: "directory", cwd, checkoutRoot: git?.checkoutRoot ?? cwd, mainRepositoryRoot: git?.mainRepositoryRoot ?? null, branchRef: git?.branchRef ?? null, displayLabel: input.displayLabel, locationId: null, ownershipState: "not-owned", markerId: null, markerPath: null, repairDetail: null, archivedAt: null });
    this.repositories.workspaces.save(workspace); return workspace;
  }

  labelWorkspace(workspaceId: string, displayLabel: string): Workspace { const workspace = this.requireWorkspace(workspaceId); const updated = workspaceSchema.parse({ ...workspace, displayLabel }); this.repositories.workspaces.save(updated); return updated; }
  async setLocationEnabled(locationId: string, enabled: boolean): Promise<WorktreeLocation> {
    const existing = this.repositories.worktreeLocations.get(locationId);
    if (!existing) throw new WorkspaceError("not-found", "Worktree location not found");
    this.repositories.worktreeLocations.setEnabled(locationId, enabled);
    return locationSchema.parse({ ...existing, enabled });
  }

  listAllLocations(): WorktreeLocation[] {
    return this.repositories.worktreeLocations.listAll(this.listLimit).map((l) => locationSchema.parse(l));
  }
  archiveProject(projectId: string): void { this.requireProject(projectId); this.repositories.projects.archive(projectId, now()); }
  reopenProject(projectId: string): Project { const project = this.requireProject(projectId); const updated = projectSchema.parse({ ...project, archivedAt: null }); this.repositories.projects.save(updated); return updated; }
  archiveWorkspace(workspaceId: string): void { this.requireWorkspace(workspaceId); this.repositories.workspaces.archive(workspaceId, now()); }
  reopenWorkspace(workspaceId: string): Workspace { const workspace = this.requireWorkspace(workspaceId); const updated = workspaceSchema.parse({ ...workspace, archivedAt: null }); this.repositories.workspaces.save(updated); return updated; }

  getLayout(workspaceId: string): WorkspaceLayout {
    this.requireWorkspace(workspaceId);
    const existing = this.repositories.layouts.get<WorkspaceLayout["root"]>(workspaceId);
    if (!existing) {
      return createDefaultLayout(workspaceId);
    }
    const parsed = workspaceLayoutSchema.safeParse({ version: existing.layoutSchemaVersion, root: existing.splitTree });
    return parsed.success ? parsed.data : createDefaultLayout(workspaceId);
  }

  saveLayout(workspaceId: string, layout: WorkspaceLayout): WorkspaceLayout {
    this.requireWorkspace(workspaceId);
    const parsed = workspaceLayoutSchema.parse(layout);
    this.repositories.layouts.save({
      workspaceId,
      layoutSchemaVersion: parsed.version,
      splitTree: parsed.root,
      modifiedAt: now(),
    });
    return parsed;
  }

  getSettings(workspaceId: string): WorkspaceSettings {
    this.requireWorkspace(workspaceId);
    const existing = this.repositories.workspaceSettings.get<WorkspaceSettings>(workspaceId);
    if (!existing) {
      return DEFAULT_WORKSPACE_SETTINGS;
    }
    const parsed = workspaceSettingsSchema.safeParse(existing.preferences);
    return parsed.success ? parsed.data : DEFAULT_WORKSPACE_SETTINGS;
  }

  saveSettings(workspaceId: string, settings: WorkspaceSettings): WorkspaceSettings {
    this.requireWorkspace(workspaceId);
    const parsed = workspaceSettingsSchema.parse(settings);
    this.repositories.workspaceSettings.save({
      workspaceId,
      settingsSchemaVersion: CURRENT_SETTINGS_SCHEMA_VERSION,
      preferences: parsed,
      modifiedAt: now(),
    });
    return parsed;
  }

  snapshot(): WorkspaceSnapshot {
    const active = this.repositories.projects.list(this.listLimit, false).map((p) => projectSchema.parse(p));
    const archived = this.repositories.projects.list(this.listLimit, true).map((p) => projectSchema.parse(p));
    const projects = [...active, ...archived].slice(0, this.listLimit);
    const locations = new Map<string, WorktreeLocation>();
    for (const location of this.repositories.worktreeLocations.listForProject(null, this.listLimit)) locations.set(location.id, locationSchema.parse(location));
    for (const project of projects) for (const location of this.repositories.worktreeLocations.listForProject(project.id, this.listLimit)) locations.set(location.id, locationSchema.parse(location));
    return { projects, workspaces: projects.flatMap((p) => [...this.repositories.workspaces.listForProject(p.id, this.listLimit, false), ...this.repositories.workspaces.listForProject(p.id, this.listLimit, true)]).map((w) => workspaceSchema.parse(w)).slice(0, this.listLimit), locations: [...locations.values()].slice(0, this.listLimit) };
  }

  async resolvePath(workspaceId: string, requestedPath: string): Promise<string> { const workspace = this.requireWorkspace(workspaceId); if (workspace.archivedAt) throw new WorkspaceError("archived", "Workspace is archived"); return this.within(workspace.cwd, requestedPath); }
  private requireProject(id: string): Project { const value = this.repositories.projects.get(id); if (!value) throw new WorkspaceError("not-found", "Project not found"); return projectSchema.parse(value); }
  private requireWorkspace(id: string): Workspace { const value = this.repositories.workspaces.get(id); if (!value) throw new WorkspaceError("not-found", "Workspace not found"); return workspaceSchema.parse(value); }
  private async directory(path: string, code: "invalid-root"): Promise<string> { try { if (!(await stat(path)).isDirectory()) throw new Error(); return await realpath(path); } catch { throw new WorkspaceError(code, "Directory does not exist or is inaccessible"); } }
  private async within(root: string, requested: string): Promise<string> { const candidate = resolve(root, requested); const lexical = relative(root, candidate); if (lexical !== "" && lexical.split(/[\\/]/).some((part) => part === "..")) throw new WorkspaceError("outside-root", "Path is outside the registered workspace root"); let canonical: string; try { canonical = await realpath(candidate); } catch { throw new WorkspaceError("invalid-root", "Path does not exist or is inaccessible"); } const rel = relative(root, canonical); if (rel !== "" && rel.split(/[\\/]/).some((part) => part === "..")) throw new WorkspaceError("outside-root", "Path is outside the registered workspace root"); return canonical; }
  private async discoverGit(cwd: string): Promise<{ checkoutRoot: string; mainRepositoryRoot: string; branchRef: string | null } | null> {
    const process = Bun.spawn(["git", "-C", cwd, "rev-parse", "--show-toplevel", "--git-common-dir", "--abbrev-ref", "HEAD"], { stdout: "pipe", stderr: "ignore" });
    const timeout = setTimeout(() => {
      if (process.exitCode === null) process.kill();
    }, GIT_TIMEOUT_MS);
    try {
      const output = await new Response(process.stdout).text();
      if (output.length > MAX_GIT_OUTPUT || await process.exited !== 0) return null;
      const lines = output.trim().split("\n");
      if (lines.length < 3) return null;
      const checkoutRoot = await this.directory(lines[0], "invalid-root");
      const common = resolve(cwd, lines[1]);
      const mainRepositoryRoot = await this.directory(common.endsWith("/.git") ? common.slice(0, -5) : common, "invalid-root");
      return { checkoutRoot, mainRepositoryRoot, branchRef: lines[2] === "HEAD" ? null : lines[2] };
    } catch {
      return null;
    } finally {
      clearTimeout(timeout);
      if (process.exitCode === null) process.kill();
      await process.exited;
    }
  }
}
