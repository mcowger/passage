import { Database } from "bun:sqlite";

type Migration = { version: number; name: string; sql: string };

export const MIGRATIONS: readonly Migration[] = [
  {
    version: 1,
    name: "initial_metadata",
    sql: `
      CREATE TABLE projects (
        id TEXT PRIMARY KEY, configured_root_path TEXT NOT NULL, canonical_root_path TEXT NOT NULL,
        display_label TEXT NOT NULL, archived_at TEXT
      );
      CREATE TABLE worktree_locations (
        id TEXT PRIMARY KEY, project_id TEXT, scope TEXT NOT NULL CHECK (scope IN ('global','project')),
        display_label TEXT NOT NULL, configured_root_path TEXT NOT NULL, canonical_root_path TEXT NOT NULL,
        enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0,1)),
        CHECK ((scope = 'global' AND project_id IS NULL) OR (scope = 'project' AND project_id IS NOT NULL)),
        FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE
      );
      CREATE TABLE workspaces (
        id TEXT PRIMARY KEY, project_id TEXT NOT NULL, kind TEXT NOT NULL,
        cwd TEXT NOT NULL, checkout_root TEXT, main_repository_root TEXT, branch_ref TEXT,
        display_label TEXT NOT NULL, location_id TEXT, ownership_state TEXT NOT NULL,
        archived_at TEXT,
        FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE,
        FOREIGN KEY (location_id) REFERENCES worktree_locations(id) ON DELETE SET NULL
      );
      CREATE TABLE agents (
        id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL, pi_session_id TEXT NOT NULL,
        pi_session_path TEXT, title TEXT NOT NULL, title_overridden INTEGER NOT NULL DEFAULT 0,
        model_preference TEXT, thinking_preference TEXT, last_known_status TEXT NOT NULL,
        archived_at TEXT, FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE
      );
      CREATE TABLE layouts (
        workspace_id TEXT PRIMARY KEY, layout_schema_version INTEGER NOT NULL,
        split_tree_json TEXT NOT NULL, modified_at TEXT NOT NULL,
        FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE
      );
      CREATE TABLE workspace_settings (
        workspace_id TEXT PRIMARY KEY, settings_schema_version INTEGER NOT NULL,
        preferences_json TEXT NOT NULL, modified_at TEXT NOT NULL,
        FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE
      );
      CREATE TABLE metadata_jobs (
        id TEXT PRIMARY KEY, target_type TEXT NOT NULL, target_id TEXT NOT NULL,
        prompt_fingerprint TEXT NOT NULL, candidate_json TEXT, accepted_at TEXT
      );
      CREATE TABLE session_index (
        pi_session_path TEXT PRIMARY KEY, mtime INTEGER NOT NULL, size INTEGER NOT NULL,
        index_version INTEGER NOT NULL, workspace_id TEXT, agent_id TEXT,
        FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE SET NULL,
        FOREIGN KEY (agent_id) REFERENCES agents(id) ON DELETE SET NULL
      );
    `,
  },
  {
    version: 2,
    name: "worktree_ownership_repair",
    sql: `
      ALTER TABLE workspaces ADD COLUMN marker_id TEXT;
      ALTER TABLE workspaces ADD COLUMN marker_path TEXT;
      ALTER TABLE workspaces ADD COLUMN repair_detail TEXT;
    `,
  },
  {
    version: 3,
    name: "web_previews",
    sql: `
      CREATE TABLE web_previews (
        id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL, display_label TEXT NOT NULL,
        target_url TEXT NOT NULL, viewport_json TEXT NOT NULL,
        created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
        FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE
      );
    `,
  },
];

export class MetadataStore {
  readonly db: Database;

  constructor(path: string) {
    this.db = new Database(path);
    try {
      this.db.exec("PRAGMA foreign_keys = ON");
      this.migrate();
    } catch (error) {
      this.db.close();
      throw error;
    }
  }

  migrate(): void {
    for (let index = 0; index < MIGRATIONS.length; index += 1) {
      const migration = MIGRATIONS[index];
      if (migration.version !== index + 1 || (index > 0 && migration.version <= MIGRATIONS[index - 1].version)) {
        throw new Error("Metadata migrations must have unique, ordered versions");
      }
    }
    this.db.exec("CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, name TEXT NOT NULL, checksum TEXT NOT NULL, applied_at TEXT NOT NULL)");
    const applied = this.db.query<{ version: number; name: string; checksum: string }, []>("SELECT version, name, checksum FROM schema_migrations ORDER BY version").all();
    for (let index = 0; index < applied.length; index += 1) {
      const record = applied[index];
      const migration = MIGRATIONS[index];
      if (!migration || record.version !== migration.version || record.name !== migration.name || record.checksum !== checksum(migration.sql)) {
        throw new Error(`Metadata migration history is invalid at version ${record.version}`);
      }
    }
    const current = applied.at(-1)?.version ?? 0;
    const pending = MIGRATIONS.filter((migration) => migration.version > current);
    if (pending.length === 0) return;
    const transaction = this.db.transaction(() => {
      for (const migration of pending) {
        this.db.exec(migration.sql);
        this.db.query("INSERT INTO schema_migrations (version, name, checksum, applied_at) VALUES (?, ?, ?, ?)").run(migration.version, migration.name, checksum(migration.sql), new Date().toISOString());
      }
    });
    transaction();
  }

  get schemaVersion(): number {
    return this.db.query<{ version: number }, []>("SELECT COALESCE(MAX(version), 0) AS version FROM schema_migrations").get()?.version ?? 0;
  }

  close(): void { this.db.close(); }
}

function checksum(sql: string): string {
  return new Bun.CryptoHasher("sha256").update(sql).digest("hex");
}
