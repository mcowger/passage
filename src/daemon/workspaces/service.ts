import { realpath, stat } from "node:fs/promises";
import { relative, resolve } from "node:path";
import { projectSchema, locationSchema, workspaceSchema, projectIconSchema, projectColorSchema, type Project, type WorktreeLocation, type Workspace, type WorkspaceSnapshot } from "../../shared/domain/workspaces.ts";
import { workspaceLayoutSchema, createDefaultLayout, type WorkspaceLayout } from "../../shared/domain/layout.ts";
import { appearanceSettingsSchema, workspaceSettingsSchema, DEFAULT_APPEARANCE_SETTINGS, DEFAULT_WORKSPACE_SETTINGS, type AppearanceSettings, type WorkspaceSettings } from "../../shared/domain/settings.ts";
import { MetadataRepositories } from "../metadata/repositories.ts";
import { sanitizedSubprocessEnv } from "../env.ts";

const MAX_LIST = 100;
const MAX_GIT_OUTPUT = 4096;
const GIT_TIMEOUT_MS = 2000;
const id = (prefix: string) => `${prefix}_${crypto.randomUUID()}`;
const now = () => new Date().toISOString();
/** Key for the global appearance row in app_settings (themeId + fonts). */
const APPEARANCE_SETTINGS_KEY = "appearance";

export class WorkspaceError extends Error { constructor(public readonly code: "not-found" | "invalid-root" | "outside-root" | "archived" | "invalid-location", message: string) { super(message); this.name = "WorkspaceError"; } }

export class WorkspaceService {
  constructor(private readonly repositories: MetadataRepositories, listLimit = MAX_LIST) {
    if (!Number.isInteger(listLimit) || listLimit < 1 || listLimit > MAX_LIST) throw new WorkspaceError("invalid-root", "Invalid list limit");
    this.listLimit = listLimit;
  }
  private readonly listLimit: number;

  async registerProject(configuredRootPath: string, displayLabel: string, appearance?: { iconName?: string | null; iconColor?: string | null }): Promise<Project> {
    const canonical = await this.directory(configuredRootPath, "invalid-root");
    const iconName = appearance?.iconName ?? null;
    const iconColor = appearance?.iconColor ?? null;
    if (iconName !== null) projectIconSchema.parse(iconName);
    if (iconColor !== null) projectColorSchema.parse(iconColor);
    const project = projectSchema.parse({ id: id("prj"), configuredRootPath, canonicalRootPath: canonical, displayLabel, iconName, iconColor, archivedAt: null });
    this.repositories.projects.save(project);
    await this.ensureDefaultWorkspace(project.id);
    return project;
  }

  updateProject(projectId: string, input: { displayLabel?: string; iconName?: string | null; iconColor?: string | null }): Project {
    const existing = this.requireProject(projectId);
    if (existing.archivedAt) throw new WorkspaceError("archived", "Project is archived");
    const next = projectSchema.parse({
      ...existing,
      displayLabel: input.displayLabel ?? existing.displayLabel,
      iconName: input.iconName !== undefined ? input.iconName : (existing.iconName ?? null),
      iconColor: input.iconColor !== undefined ? input.iconColor : (existing.iconColor ?? null),
    });
    this.repositories.projects.save(next);
    return next;
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
    const existing = this.repositories.workspaces.getLayout<WorkspaceLayout>(workspaceId);
    if (!existing) {
      return createDefaultLayout(workspaceId);
    }
    const parsed = workspaceLayoutSchema.safeParse(existing);
    return parsed.success ? parsed.data : createDefaultLayout(workspaceId);
  }

  saveLayout(workspaceId: string, layout: WorkspaceLayout): WorkspaceLayout {
    this.requireWorkspace(workspaceId);
    const parsed = workspaceLayoutSchema.parse(layout);
    this.repositories.workspaces.saveLayout(workspaceId, parsed);
    return parsed;
  }

  /** All settings are global, stored once and shared by every workspace.
   *  Reads adopt a legacy per-workspace row once on upgrade so pre-existing
   *  choices survive the move to global storage. */
  getAppearance(seed?: unknown): AppearanceSettings {
    const stored = this.repositories.appSettings.get(APPEARANCE_SETTINGS_KEY);
    if (stored !== undefined) {
      const parsed = appearanceSettingsSchema.safeParse(stored);
      if (parsed.success) return parsed.data;
    }
    if (seed !== undefined) {
      const fromRow = appearanceSettingsSchema.safeParse(seed);
      if (fromRow.success) {
        this.repositories.appSettings.set(APPEARANCE_SETTINGS_KEY, fromRow.data);
        return fromRow.data;
      }
    }
    return {
      ...DEFAULT_APPEARANCE_SETTINGS,
      fonts: { ...DEFAULT_APPEARANCE_SETTINGS.fonts },
      timelineExpansion: {
        ...DEFAULT_APPEARANCE_SETTINGS.timelineExpansion,
        tools: { ...DEFAULT_APPEARANCE_SETTINGS.timelineExpansion.tools },
      },
    };
  }

  saveAppearance(appearance: AppearanceSettings): AppearanceSettings {
    const parsed = appearanceSettingsSchema.parse(appearance);
    this.repositories.appSettings.set(APPEARANCE_SETTINGS_KEY, parsed);
    return parsed;
  }

  getSettings(workspaceId: string): WorkspaceSettings {
    this.requireWorkspace(workspaceId);
    const existing = this.repositories.workspaces.getPreferences<WorkspaceSettings>(workspaceId);
    const appearance = this.getAppearance(existing);
    if (!existing) {
      return { ...DEFAULT_WORKSPACE_SETTINGS, ...appearance };
    }
    const parsed = workspaceSettingsSchema.safeParse(existing);
    if (!parsed.success) return { ...DEFAULT_WORKSPACE_SETTINGS, ...appearance };
    return { ...parsed.data, ...appearance };
  }

  saveSettings(workspaceId: string, settings: WorkspaceSettings): WorkspaceSettings {
    this.requireWorkspace(workspaceId);
    const parsed = workspaceSettingsSchema.parse(settings);
    this.saveAppearance(parsed);
    this.repositories.workspaces.savePreferences(workspaceId, parsed);
    return this.getSettings(workspaceId);
  }

  /** GitHub repo identity for a workspace checkout, fetched once and kept
   *  in the metadata DB: the remote identity never changes for a workspace.
   *  Returns undefined when never checked, null when checked with no result. */
  getGithubRepo(workspaceId: string): { nameWithOwner: string; defaultBranch: string } | null | undefined {
    this.requireWorkspace(workspaceId);
    const stored = this.repositories.appSettings.get(`github-repo:${workspaceId}`);
    if (stored === undefined) return undefined;
    if (stored === null) return null;
    if (typeof stored === "object" && stored !== null) {
      const record = stored as Record<string, unknown>;
      if (typeof record.nameWithOwner === "string" && typeof record.defaultBranch === "string") {
        return { nameWithOwner: record.nameWithOwner, defaultBranch: record.defaultBranch };
      }
    }
    return undefined;
  }

  saveGithubRepo(workspaceId: string, repo: { nameWithOwner: string; defaultBranch: string } | null): void {
    this.requireWorkspace(workspaceId);
    this.repositories.appSettings.set(`github-repo:${workspaceId}`, repo);
  }

  snapshot(): WorkspaceSnapshot {
    const projects = this.repositories.projects.listAll(this.listLimit).map((project) => projectSchema.parse(project));
    const projectIds = new Set(projects.map((project) => project.id));
    const workspaces = this.repositories.workspaces.listAll(this.listLimit)
      .filter((workspace) => projectIds.has(workspace.projectId))
      .map((workspace) => workspaceSchema.parse(workspace));
    const locations = this.repositories.worktreeLocations.listEnabled(this.listLimit)
      .filter((location) => location.projectId === null || projectIds.has(location.projectId))
      .map((location) => locationSchema.parse(location));
    return { projects, workspaces, locations };
  }

  async resolvePath(workspaceId: string, requestedPath: string): Promise<string> { const workspace = this.requireWorkspace(workspaceId); if (workspace.archivedAt) throw new WorkspaceError("archived", "Workspace is archived"); return this.within(workspace.cwd, requestedPath); }
  private requireProject(id: string): Project { const value = this.repositories.projects.get(id); if (!value) throw new WorkspaceError("not-found", "Project not found"); return projectSchema.parse(value); }
  private requireWorkspace(id: string): Workspace { const value = this.repositories.workspaces.get(id); if (!value) throw new WorkspaceError("not-found", "Workspace not found"); return workspaceSchema.parse(value); }
  private async directory(path: string, code: "invalid-root"): Promise<string> { try { if (!(await stat(path)).isDirectory()) throw new Error(); return await realpath(path); } catch { throw new WorkspaceError(code, "Directory does not exist or is inaccessible"); } }
  private async within(root: string, requested: string): Promise<string> { const candidate = resolve(root, requested); const lexical = relative(root, candidate); if (lexical !== "" && lexical.split(/[\\/]/).some((part) => part === "..")) throw new WorkspaceError("outside-root", "Path is outside the registered workspace root"); let canonical: string; try { canonical = await realpath(candidate); } catch { throw new WorkspaceError("invalid-root", "Path does not exist or is inaccessible"); } const rel = relative(root, canonical); if (rel !== "" && rel.split(/[\\/]/).some((part) => part === "..")) throw new WorkspaceError("outside-root", "Path is outside the registered workspace root"); return canonical; }
  private async discoverGit(cwd: string): Promise<{ checkoutRoot: string; mainRepositoryRoot: string; branchRef: string | null } | null> {
    const process = Bun.spawn(["git", "-C", cwd, "rev-parse", "--show-toplevel", "--git-common-dir", "--abbrev-ref", "HEAD"], { stdout: "pipe", stderr: "ignore", env: sanitizedSubprocessEnv() });
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
