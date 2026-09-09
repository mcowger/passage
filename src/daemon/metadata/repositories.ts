import type { Database } from "bun:sqlite";

export type Project = { id: string; configuredRootPath: string; canonicalRootPath: string; displayLabel: string; archivedAt: string | null };
export type WorktreeLocation = { id: string; projectId: string | null; scope: "global" | "project"; displayLabel: string; configuredRootPath: string; canonicalRootPath: string; enabled: boolean };
export type Workspace = { id: string; projectId: string; kind: string; cwd: string; checkoutRoot: string | null; mainRepositoryRoot: string | null; branchRef: string | null; displayLabel: string; locationId: string | null; ownershipState: string; markerId?: string | null; markerPath?: string | null; repairDetail?: string | null; archivedAt: string | null };
export type Agent = { id: string; workspaceId: string; piSessionId: string; piSessionPath: string | null; title: string; titleOverridden: boolean; modelPreference: string | null; thinkingPreference: string | null; lastKnownStatus: string; archivedAt: string | null };
export type Layout<T = unknown> = { workspaceId: string; layoutSchemaVersion: number; splitTree: T; modifiedAt: string };
export type WorkspaceSettings<T = unknown> = { workspaceId: string; settingsSchemaVersion: number; preferences: T; modifiedAt: string };
export type MetadataJob<T = unknown> = { id: string; targetType: string; targetId: string; promptFingerprint: string; candidate: T | null; acceptedAt: string | null };
export type SessionIndex = { piSessionPath: string; mtime: number; size: number; indexVersion: number; workspaceId: string | null; agentId: string | null };

const encode = (value: unknown) => JSON.stringify(value);
const decode = <T>(value: string): T => JSON.parse(value) as T;
const integer = (value: boolean) => value ? 1 : 0;

type ProjectRow = { id: string; configured_root_path: string; canonical_root_path: string; display_label: string; archived_at: string | null };
type LocationRow = { id: string; project_id: string | null; scope: "global" | "project"; display_label: string; configured_root_path: string; canonical_root_path: string; enabled: number };
type WorkspaceRow = { id: string; project_id: string; kind: string; cwd: string; checkout_root: string | null; main_repository_root: string | null; branch_ref: string | null; display_label: string; location_id: string | null; ownership_state: string; marker_id: string | null; marker_path: string | null; repair_detail: string | null; archived_at: string | null };
type AgentRow = { id: string; workspace_id: string; pi_session_id: string; pi_session_path: string | null; title: string; title_overridden: number; model_preference: string | null; thinking_preference: string | null; last_known_status: string; archived_at: string | null };
type LayoutRow = { workspace_id: string; layout_schema_version: number; split_tree_json: string; modified_at: string };
type SettingsRow = { workspace_id: string; settings_schema_version: number; preferences_json: string; modified_at: string };
type JobRow = { id: string; target_type: string; target_id: string; prompt_fingerprint: string; candidate_json: string | null; accepted_at: string | null };
type SessionRow = { pi_session_path: string; mtime: number; size: number; index_version: number; workspace_id: string | null; agent_id: string | null };

const projectFromRow = (row: ProjectRow | null | undefined): Project | undefined => row ? { id: row.id, configuredRootPath: row.configured_root_path, canonicalRootPath: row.canonical_root_path, displayLabel: row.display_label, archivedAt: row.archived_at } : undefined;
const locationFromRow = (row: LocationRow | null | undefined): WorktreeLocation | undefined => row ? { id: row.id, projectId: row.project_id, scope: row.scope, displayLabel: row.display_label, configuredRootPath: row.configured_root_path, canonicalRootPath: row.canonical_root_path, enabled: row.enabled === 1 } : undefined;
const workspaceFromRow = (row: WorkspaceRow | null | undefined): Workspace | undefined => row ? { id: row.id, projectId: row.project_id, kind: row.kind, cwd: row.cwd, checkoutRoot: row.checkout_root, mainRepositoryRoot: row.main_repository_root, branchRef: row.branch_ref, displayLabel: row.display_label, locationId: row.location_id, ownershipState: row.ownership_state, markerId: row.marker_id ?? null, markerPath: row.marker_path ?? null, repairDetail: row.repair_detail ?? null, archivedAt: row.archived_at } : undefined;
const agentFromRow = (row: AgentRow | null | undefined): Agent | undefined => row ? { id: row.id, workspaceId: row.workspace_id, piSessionId: row.pi_session_id, piSessionPath: row.pi_session_path, title: row.title, titleOverridden: row.title_overridden === 1, modelPreference: row.model_preference, thinkingPreference: row.thinking_preference, lastKnownStatus: row.last_known_status, archivedAt: row.archived_at } : undefined;
const layoutFromRow = <T>(row: LayoutRow | null | undefined): Layout<T> | undefined => row ? { workspaceId: row.workspace_id, layoutSchemaVersion: row.layout_schema_version, splitTree: decode<T>(row.split_tree_json), modifiedAt: row.modified_at } : undefined;
const settingsFromRow = <T>(row: SettingsRow | null | undefined): WorkspaceSettings<T> | undefined => row ? { workspaceId: row.workspace_id, settingsSchemaVersion: row.settings_schema_version, preferences: decode<T>(row.preferences_json), modifiedAt: row.modified_at } : undefined;
const jobFromRow = <T>(row: JobRow | null | undefined): MetadataJob<T> | undefined => row ? { id: row.id, targetType: row.target_type, targetId: row.target_id, promptFingerprint: row.prompt_fingerprint, candidate: row.candidate_json === null ? null : decode<T>(row.candidate_json), acceptedAt: row.accepted_at } : undefined;
const sessionFromRow = (row: SessionRow | null | undefined): SessionIndex | undefined => row ? { piSessionPath: row.pi_session_path, mtime: row.mtime, size: row.size, indexVersion: row.index_version, workspaceId: row.workspace_id, agentId: row.agent_id } : undefined;

export class ProjectRepository {
  constructor(private readonly db: Database) {}
  save(value: Project): void { this.db.query("INSERT INTO projects VALUES (?, ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET configured_root_path=excluded.configured_root_path, canonical_root_path=excluded.canonical_root_path, display_label=excluded.display_label, archived_at=excluded.archived_at").run(value.id, value.configuredRootPath, value.canonicalRootPath, value.displayLabel, value.archivedAt); }
  get(id: string): Project | undefined { return projectFromRow(this.db.query<ProjectRow, [string]>("SELECT * FROM projects WHERE id=?").get(id)); }
  archive(id: string, archivedAt: string): void { this.db.query("UPDATE projects SET archived_at=? WHERE id=?").run(archivedAt, id); }
  list(limit: number, archived: boolean): Project[] { return this.db.query<ProjectRow, [number]>(`SELECT * FROM projects WHERE archived_at IS ${archived ? "NOT NULL" : "NULL"} ORDER BY id LIMIT ?`).all(limit).map((row) => projectFromRow(row)!); }
}

export class WorktreeLocationRepository {
  constructor(private readonly db: Database) {}
  save(value: WorktreeLocation): void { this.db.query("INSERT INTO worktree_locations VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET project_id=excluded.project_id, scope=excluded.scope, display_label=excluded.display_label, configured_root_path=excluded.configured_root_path, canonical_root_path=excluded.canonical_root_path, enabled=excluded.enabled").run(value.id, value.projectId, value.scope, value.displayLabel, value.configuredRootPath, value.canonicalRootPath, integer(value.enabled)); }
  get(id: string): WorktreeLocation | undefined { return locationFromRow(this.db.query<LocationRow, [string]>("SELECT * FROM worktree_locations WHERE id=?").get(id)); }
  listForProject(projectId: string | null, limit: number): WorktreeLocation[] { return this.db.query<LocationRow, [string | null, number]>("SELECT * FROM worktree_locations WHERE (project_id IS NULL OR project_id=?) AND enabled=1 ORDER BY id LIMIT ?").all(projectId, limit).map((row) => locationFromRow(row)!); }
  listAll(limit: number): WorktreeLocation[] { return this.db.query<LocationRow, [number]>("SELECT * FROM worktree_locations ORDER BY id LIMIT ?").all(limit).map((row) => locationFromRow(row)!); }
  setEnabled(id: string, enabled: boolean): void { this.db.query("UPDATE worktree_locations SET enabled=? WHERE id=?").run(integer(enabled), id); }
}

export class WorkspaceRepository {
  constructor(private readonly db: Database) {}
  save(value: Workspace): void { this.db.query("INSERT INTO workspaces (id,project_id,kind,cwd,checkout_root,main_repository_root,branch_ref,display_label,location_id,ownership_state,archived_at,marker_id,marker_path,repair_detail) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET project_id=excluded.project_id, kind=excluded.kind, cwd=excluded.cwd, checkout_root=excluded.checkout_root, main_repository_root=excluded.main_repository_root, branch_ref=excluded.branch_ref, display_label=excluded.display_label, location_id=excluded.location_id, ownership_state=excluded.ownership_state, archived_at=excluded.archived_at, marker_id=excluded.marker_id, marker_path=excluded.marker_path, repair_detail=excluded.repair_detail").run(value.id, value.projectId, value.kind, value.cwd, value.checkoutRoot, value.mainRepositoryRoot, value.branchRef, value.displayLabel, value.locationId, value.ownershipState, value.archivedAt, value.markerId ?? null, value.markerPath ?? null, value.repairDetail ?? null); }
  get(id: string): Workspace | undefined { return workspaceFromRow(this.db.query<WorkspaceRow, [string]>("SELECT * FROM workspaces WHERE id=?").get(id)); }
  delete(id: string): void { this.db.query("DELETE FROM workspaces WHERE id=?").run(id); }
  archive(id: string, archivedAt: string): void { this.db.query("UPDATE workspaces SET archived_at=? WHERE id=?").run(archivedAt, id); }
  listForProject(projectId: string, limit: number, archived: boolean): Workspace[] { return this.db.query<WorkspaceRow, [string, number]>(`SELECT * FROM workspaces WHERE project_id=? AND archived_at IS ${archived ? "NOT NULL" : "NULL"} ORDER BY id LIMIT ?`).all(projectId, limit).map((row) => workspaceFromRow(row)!); }
}

export class AgentRepository {
  constructor(private readonly db: Database) {}
  save(value: Agent): void { this.db.query("INSERT INTO agents VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET workspace_id=excluded.workspace_id, pi_session_id=excluded.pi_session_id, pi_session_path=excluded.pi_session_path, title=excluded.title, title_overridden=excluded.title_overridden, model_preference=excluded.model_preference, thinking_preference=excluded.thinking_preference, last_known_status=excluded.last_known_status, archived_at=excluded.archived_at").run(value.id, value.workspaceId, value.piSessionId, value.piSessionPath, value.title, integer(value.titleOverridden), value.modelPreference, value.thinkingPreference, value.lastKnownStatus, value.archivedAt); }
  get(id: string): Agent | undefined { return agentFromRow(this.db.query<AgentRow, [string]>("SELECT * FROM agents WHERE id=?").get(id)); }
  listForWorkspace(workspaceId: string, limit: number, archived = false): Agent[] { return this.db.query<AgentRow, [string, number]>(`SELECT * FROM agents WHERE workspace_id=? AND archived_at IS ${archived ? "NOT NULL" : "NULL"} ORDER BY id LIMIT ?`).all(workspaceId, limit).map((row) => agentFromRow(row)!); }
  updateStatus(id: string, status: string): void { this.db.query("UPDATE agents SET last_known_status=? WHERE id=?").run(status, id); }
  updateSessionPath(id: string, path: string): void { this.db.query("UPDATE agents SET pi_session_path=? WHERE id=?").run(path, id); }
  updateModelPreference(id: string, model: string): void { this.db.query("UPDATE agents SET model_preference=? WHERE id=?").run(model, id); }
  updateThinkingPreference(id: string, thinking: string): void { this.db.query("UPDATE agents SET thinking_preference=? WHERE id=?").run(thinking, id); }
  archive(id: string, archivedAt: string): void { this.db.query("UPDATE agents SET archived_at=? WHERE id=?").run(archivedAt, id); }
}

export class LayoutRepository { constructor(private readonly db: Database) {} save<T>(v: Layout<T>): void { this.db.query("INSERT INTO layouts VALUES (?, ?, ?, ?) ON CONFLICT(workspace_id) DO UPDATE SET layout_schema_version=excluded.layout_schema_version, split_tree_json=excluded.split_tree_json, modified_at=excluded.modified_at").run(v.workspaceId, v.layoutSchemaVersion, encode(v.splitTree), v.modifiedAt); } get<T>(id: string): Layout<T> | undefined { return layoutFromRow(this.db.query<LayoutRow, [string]>("SELECT * FROM layouts WHERE workspace_id=?").get(id)); } }
export class WorkspaceSettingsRepository { constructor(private readonly db: Database) {} save<T>(v: WorkspaceSettings<T>): void { this.db.query("INSERT INTO workspace_settings VALUES (?, ?, ?, ?) ON CONFLICT(workspace_id) DO UPDATE SET settings_schema_version=excluded.settings_schema_version, preferences_json=excluded.preferences_json, modified_at=excluded.modified_at").run(v.workspaceId, v.settingsSchemaVersion, encode(v.preferences), v.modifiedAt); } get<T>(id: string): WorkspaceSettings<T> | undefined { return settingsFromRow(this.db.query<SettingsRow, [string]>("SELECT * FROM workspace_settings WHERE workspace_id=?").get(id)); } }
export class MetadataJobRepository { constructor(private readonly db: Database) {} save<T>(v: MetadataJob<T>): void { this.db.query("INSERT INTO metadata_jobs VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET target_type=excluded.target_type, target_id=excluded.target_id, prompt_fingerprint=excluded.prompt_fingerprint, candidate_json=excluded.candidate_json, accepted_at=excluded.accepted_at").run(v.id, v.targetType, v.targetId, v.promptFingerprint, v.candidate === null ? null : encode(v.candidate), v.acceptedAt); } get<T>(id: string): MetadataJob<T> | undefined { return jobFromRow(this.db.query<JobRow, [string]>("SELECT * FROM metadata_jobs WHERE id=?").get(id)); } }
export class SessionIndexRepository { constructor(private readonly db: Database) {} save(v: SessionIndex): void { this.db.query("INSERT INTO session_index VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(pi_session_path) DO UPDATE SET mtime=excluded.mtime, size=excluded.size, index_version=excluded.index_version, workspace_id=excluded.workspace_id, agent_id=excluded.agent_id").run(v.piSessionPath, v.mtime, v.size, v.indexVersion, v.workspaceId, v.agentId); } get(path: string): SessionIndex | undefined { return sessionFromRow(this.db.query<SessionRow, [string]>("SELECT * FROM session_index WHERE pi_session_path=?").get(path)); } }

export class MetadataRepositories {
  readonly projects: ProjectRepository; readonly worktreeLocations: WorktreeLocationRepository; readonly workspaces: WorkspaceRepository; readonly agents: AgentRepository; readonly layouts: LayoutRepository; readonly workspaceSettings: WorkspaceSettingsRepository; readonly metadataJobs: MetadataJobRepository; readonly sessionIndex: SessionIndexRepository;
  constructor(db: Database) { this.projects = new ProjectRepository(db); this.worktreeLocations = new WorktreeLocationRepository(db); this.workspaces = new WorkspaceRepository(db); this.agents = new AgentRepository(db); this.layouts = new LayoutRepository(db); this.workspaceSettings = new WorkspaceSettingsRepository(db); this.metadataJobs = new MetadataJobRepository(db); this.sessionIndex = new SessionIndexRepository(db); }
}
