import type { Database } from "bun:sqlite";

export type Project = { id: string; configuredRootPath: string; canonicalRootPath: string; displayLabel: string; archivedAt: string | null };
export type WorktreeLocation = { id: string; projectId: string | null; scope: "global" | "project"; displayLabel: string; configuredRootPath: string; canonicalRootPath: string; enabled: boolean };
export type Workspace = { id: string; projectId: string; kind: string; cwd: string; checkoutRoot: string | null; mainRepositoryRoot: string | null; branchRef: string | null; displayLabel: string; locationId: string | null; ownershipState: string; markerId?: string | null; markerPath?: string | null; repairDetail?: string | null; archivedAt: string | null };
export type Agent = { id: string; workspaceId: string; piSessionId: string; piSessionPath: string | null; title: string; titleOverridden: boolean; modelPreference: string | null; thinkingPreference: string | null; lastKnownStatus: string; archivedAt: string | null };
export type WebPreviewRow = { id: string; workspaceId: string; displayLabel: string; targetUrl: string; viewport: unknown; createdAt: string; updatedAt: string };

const encode = (value: unknown) => JSON.stringify(value);
const decode = <T>(value: string): T => JSON.parse(value) as T;
const integer = (value: boolean) => value ? 1 : 0;

type ProjectRow = { id: string; configured_root_path: string; canonical_root_path: string; display_label: string; archived_at: string | null };
type LocationRow = { id: string; project_id: string | null; scope: "global" | "project"; display_label: string; configured_root_path: string; canonical_root_path: string; enabled: number };
type WorkspaceRow = { id: string; project_id: string; kind: string; cwd: string; checkout_root: string | null; main_repository_root: string | null; branch_ref: string | null; display_label: string; location_id: string | null; ownership_state: string; marker_id: string | null; marker_path: string | null; repair_detail: string | null; archived_at: string | null; layout_json: string | null; preferences_json: string | null };
type AgentRow = { id: string; workspace_id: string; pi_session_id: string; pi_session_path: string | null; title: string; title_overridden: number; model_preference: string | null; thinking_preference: string | null; last_known_status: string; archived_at: string | null };

const projectFromRow = (row: ProjectRow | null | undefined): Project | undefined => row ? { id: row.id, configuredRootPath: row.configured_root_path, canonicalRootPath: row.canonical_root_path, displayLabel: row.display_label, archivedAt: row.archived_at } : undefined;
const locationFromRow = (row: LocationRow | null | undefined): WorktreeLocation | undefined => row ? { id: row.id, projectId: row.project_id, scope: row.scope, displayLabel: row.display_label, configuredRootPath: row.configured_root_path, canonicalRootPath: row.canonical_root_path, enabled: row.enabled === 1 } : undefined;
const workspaceFromRow = (row: WorkspaceRow | null | undefined): Workspace | undefined => row ? { id: row.id, projectId: row.project_id, kind: row.kind, cwd: row.cwd, checkoutRoot: row.checkout_root, mainRepositoryRoot: row.main_repository_root, branchRef: row.branch_ref, displayLabel: row.display_label, locationId: row.location_id, ownershipState: row.ownership_state, markerId: row.marker_id ?? null, markerPath: row.marker_path ?? null, repairDetail: row.repair_detail ?? null, archivedAt: row.archived_at } : undefined;
const agentFromRow = (row: AgentRow | null | undefined): Agent | undefined => row ? { id: row.id, workspaceId: row.workspace_id, piSessionId: row.pi_session_id, piSessionPath: row.pi_session_path, title: row.title, titleOverridden: row.title_overridden === 1, modelPreference: row.model_preference, thinkingPreference: row.thinking_preference, lastKnownStatus: row.last_known_status, archivedAt: row.archived_at } : undefined;

export class ProjectRepository {
  constructor(private readonly db: Database) {}
  save(value: Project): void { this.db.query("INSERT INTO projects VALUES (?, ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET configured_root_path=excluded.configured_root_path, canonical_root_path=excluded.canonical_root_path, display_label=excluded.display_label, archived_at=excluded.archived_at").run(value.id, value.configuredRootPath, value.canonicalRootPath, value.displayLabel, value.archivedAt); }
  get(id: string): Project | undefined { return projectFromRow(this.db.query<ProjectRow, [string]>("SELECT * FROM projects WHERE id=?").get(id)); }
  archive(id: string, archivedAt: string): void { this.db.query("UPDATE projects SET archived_at=? WHERE id=?").run(archivedAt, id); }
  list(limit: number, archived: boolean): Project[] { return this.db.query<ProjectRow, [number]>(`SELECT * FROM projects WHERE archived_at IS ${archived ? "NOT NULL" : "NULL"} ORDER BY id LIMIT ?`).all(limit).map((row) => projectFromRow(row)!); }
  listAll(limit: number): Project[] { return this.db.query<ProjectRow, [number]>("SELECT * FROM projects ORDER BY archived_at IS NOT NULL, id LIMIT ?").all(limit).map((row) => projectFromRow(row)!); }
}

export class WorktreeLocationRepository {
  constructor(private readonly db: Database) {}
  save(value: WorktreeLocation): void { this.db.query("INSERT INTO worktree_locations VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET project_id=excluded.project_id, scope=excluded.scope, display_label=excluded.display_label, configured_root_path=excluded.configured_root_path, canonical_root_path=excluded.canonical_root_path, enabled=excluded.enabled").run(value.id, value.projectId, value.scope, value.displayLabel, value.configuredRootPath, value.canonicalRootPath, integer(value.enabled)); }
  get(id: string): WorktreeLocation | undefined { return locationFromRow(this.db.query<LocationRow, [string]>("SELECT * FROM worktree_locations WHERE id=?").get(id)); }
  listAll(limit: number): WorktreeLocation[] { return this.db.query<LocationRow, [number]>("SELECT * FROM worktree_locations ORDER BY id LIMIT ?").all(limit).map((row) => locationFromRow(row)!); }
  listEnabled(limit: number): WorktreeLocation[] { return this.db.query<LocationRow, [number]>("SELECT * FROM worktree_locations WHERE enabled=1 ORDER BY id LIMIT ?").all(limit).map((row) => locationFromRow(row)!); }
  setEnabled(id: string, enabled: boolean): void { this.db.query("UPDATE worktree_locations SET enabled=? WHERE id=?").run(integer(enabled), id); }
}

export class WorkspaceRepository {
  constructor(private readonly db: Database) {}
  save(value: Workspace): void { this.db.query("INSERT INTO workspaces (id,project_id,kind,cwd,checkout_root,main_repository_root,branch_ref,display_label,location_id,ownership_state,archived_at,marker_id,marker_path,repair_detail) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET project_id=excluded.project_id, kind=excluded.kind, cwd=excluded.cwd, checkout_root=excluded.checkout_root, main_repository_root=excluded.main_repository_root, branch_ref=excluded.branch_ref, display_label=excluded.display_label, location_id=excluded.location_id, ownership_state=excluded.ownership_state, archived_at=excluded.archived_at, marker_id=excluded.marker_id, marker_path=excluded.marker_path, repair_detail=excluded.repair_detail").run(value.id, value.projectId, value.kind, value.cwd, value.checkoutRoot, value.mainRepositoryRoot, value.branchRef, value.displayLabel, value.locationId, value.ownershipState, value.archivedAt, value.markerId ?? null, value.markerPath ?? null, value.repairDetail ?? null); }
  get(id: string): Workspace | undefined { return workspaceFromRow(this.db.query<WorkspaceRow, [string]>("SELECT * FROM workspaces WHERE id=?").get(id)); }
  delete(id: string): void { this.db.query("DELETE FROM workspaces WHERE id=?").run(id); }
  archive(id: string, archivedAt: string): void { this.db.query("UPDATE workspaces SET archived_at=? WHERE id=?").run(archivedAt, id); }
  listForProject(projectId: string, limit: number, archived: boolean): Workspace[] { return this.db.query<WorkspaceRow, [string, number]>(`SELECT * FROM workspaces WHERE project_id=? AND archived_at IS ${archived ? "NOT NULL" : "NULL"} ORDER BY id LIMIT ?`).all(projectId, limit).map((row) => workspaceFromRow(row)!); }
  listAll(limit: number): Workspace[] { return this.db.query<WorkspaceRow, [number]>("SELECT * FROM workspaces ORDER BY archived_at IS NOT NULL, id LIMIT ?").all(limit).map((row) => workspaceFromRow(row)!); }
  saveLayout<T>(id: string, layout: T): void { this.db.query("UPDATE workspaces SET layout_json=? WHERE id=?").run(encode(layout), id); }
  getLayout<T>(id: string): T | undefined { const row = this.db.query<{ layout_json: string | null }, [string]>("SELECT layout_json FROM workspaces WHERE id=?").get(id); return row?.layout_json ? decode<T>(row.layout_json) : undefined; }
  savePreferences<T>(id: string, preferences: T): void { this.db.query("UPDATE workspaces SET preferences_json=? WHERE id=?").run(encode(preferences), id); }
  getPreferences<T>(id: string): T | undefined { const row = this.db.query<{ preferences_json: string | null }, [string]>("SELECT preferences_json FROM workspaces WHERE id=?").get(id); return row?.preferences_json ? decode<T>(row.preferences_json) : undefined; }
}

export class AgentRepository {
  constructor(private readonly db: Database) {}
  save(value: Agent): void { this.db.query("INSERT INTO agents VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET workspace_id=excluded.workspace_id, pi_session_id=excluded.pi_session_id, pi_session_path=excluded.pi_session_path, title=excluded.title, title_overridden=excluded.title_overridden, model_preference=excluded.model_preference, thinking_preference=excluded.thinking_preference, last_known_status=excluded.last_known_status, archived_at=excluded.archived_at").run(value.id, value.workspaceId, value.piSessionId, value.piSessionPath, value.title, integer(value.titleOverridden), value.modelPreference, value.thinkingPreference, value.lastKnownStatus, value.archivedAt); }
  get(id: string): Agent | undefined { return agentFromRow(this.db.query<AgentRow, [string]>("SELECT * FROM agents WHERE id=?").get(id)); }
  listForWorkspace(workspaceId: string, limit: number, archived = false): Agent[] { return this.db.query<AgentRow, [string, number]>(`SELECT * FROM agents WHERE workspace_id=? AND archived_at IS ${archived ? "NOT NULL" : "NULL"} ORDER BY id LIMIT ?`).all(workspaceId, limit).map((row) => agentFromRow(row)!); }
  /** Non-archived agents whose persisted status implies live work (used once
   * at daemon boot to find runtime state a restart could not have settled
   * honestly -- see reconcileAfterRestart). */
  listActiveRuntime(limit: number): Agent[] { return this.db.query<AgentRow, [number]>("SELECT * FROM agents WHERE archived_at IS NULL AND last_known_status IN ('initializing','running','stopping','needs-attention') ORDER BY id LIMIT ?").all(limit).map((row) => agentFromRow(row)!); }
  updateStatus(id: string, status: string): void { this.db.query("UPDATE agents SET last_known_status=? WHERE id=?").run(status, id); }
  updateSessionPath(id: string, path: string): void { this.db.query("UPDATE agents SET pi_session_path=? WHERE id=?").run(path, id); }
  updateModelPreference(id: string, model: string): void { this.db.query("UPDATE agents SET model_preference=? WHERE id=?").run(model, id); }
  updateThinkingPreference(id: string, thinking: string): void { this.db.query("UPDATE agents SET thinking_preference=? WHERE id=?").run(thinking, id); }
  archive(id: string, archivedAt: string): void { this.db.query("UPDATE agents SET archived_at=? WHERE id=?").run(archivedAt, id); }
}

export class WebPreviewRepository {
  constructor(private readonly db: Database) {}
  save(value: WebPreviewRow): void {
    this.db.query("INSERT INTO web_previews VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET workspace_id=excluded.workspace_id, display_label=excluded.display_label, target_url=excluded.target_url, viewport_json=excluded.viewport_json, created_at=excluded.created_at, updated_at=excluded.updated_at").run(value.id, value.workspaceId, value.displayLabel, value.targetUrl, JSON.stringify(value.viewport), value.createdAt, value.updatedAt);
  }
  get(id: string): WebPreviewRow | undefined {
    const row = this.db.query<{ id: string; workspace_id: string; display_label: string; target_url: string; viewport_json: string; created_at: string; updated_at: string }, [string]>("SELECT * FROM web_previews WHERE id=?").get(id);
    return row ? { id: row.id, workspaceId: row.workspace_id, displayLabel: row.display_label, targetUrl: row.target_url, viewport: JSON.parse(row.viewport_json) as unknown, createdAt: row.created_at, updatedAt: row.updated_at } : undefined;
  }
  listForWorkspace(workspaceId: string, limit: number): WebPreviewRow[] {
    return this.db.query<{ id: string; workspace_id: string; display_label: string; target_url: string; viewport_json: string; created_at: string; updated_at: string }, [string, number]>("SELECT * FROM web_previews WHERE workspace_id=? ORDER BY id LIMIT ?").all(workspaceId, limit).map((row) => ({ id: row.id, workspaceId: row.workspace_id, displayLabel: row.display_label, targetUrl: row.target_url, viewport: JSON.parse(row.viewport_json) as unknown, createdAt: row.created_at, updatedAt: row.updated_at }));
  }
  delete(id: string): void { this.db.query("DELETE FROM web_previews WHERE id=?").run(id); }
}

export class MetadataRepositories {
  readonly projects: ProjectRepository; readonly worktreeLocations: WorktreeLocationRepository; readonly workspaces: WorkspaceRepository; readonly agents: AgentRepository; readonly webPreviews: WebPreviewRepository;
  constructor(db: Database) { this.projects = new ProjectRepository(db); this.worktreeLocations = new WorktreeLocationRepository(db); this.workspaces = new WorkspaceRepository(db); this.agents = new AgentRepository(db); this.webPreviews = new WebPreviewRepository(db); }
}
