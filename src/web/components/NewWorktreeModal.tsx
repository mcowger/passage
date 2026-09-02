import { useState } from "react";
import type { Project, WorktreeLocation, Workspace } from "../../shared/domain/workspaces.ts";
import type { WorkspaceApi } from "../api.ts";

type Props = {
  projects: Project[];
  locations: WorktreeLocation[];
  defaultProjectId?: string;
  api: WorkspaceApi;
  onClose: () => void;
  onCreated: (workspace: Workspace) => void;
};

export function NewWorktreeModal({
  projects,
  locations,
  defaultProjectId,
  api,
  onClose,
  onCreated,
}: Props) {
  const activeProjects = projects.filter((p) => !p.archivedAt);
  const [projectId, setProjectId] = useState(defaultProjectId ?? activeProjects[0]?.id ?? "");
  
  const availableLocations = locations.filter(
    (loc) => loc.enabled && (!loc.projectId || loc.projectId === projectId)
  );

  const [locationId, setLocationId] = useState(availableLocations[0]?.id ?? "");
  const [purpose, setPurpose] = useState("");
  const [label, setLabel] = useState("");
  const [branch, setBranch] = useState("feature/worktree");
  const [folder, setFolder] = useState("");
  const [suggesting, setSuggesting] = useState(false);
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState("");

  const handleSuggest = async () => {
    if (!purpose.trim() || !projectId) return;
    setSuggesting(true);
    setError("");
    try {
      const suggestion = await api.suggestWorktree(projectId, purpose.trim());
      setLabel(suggestion.label);
      setBranch(suggestion.branch);
      setFolder(suggestion.folder);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unable to generate suggestions");
    } finally {
      setSuggesting(false);
    }
  };

  const handleCreate = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!projectId || !locationId || !label.trim() || !branch.trim()) {
      setError("Please fill in all required fields.");
      return;
    }

    setCreating(true);
    setError("");
    try {
      const created = await api.createWorktree(projectId, {
        locationId,
        ref: branch.trim(),
        label: label.trim(),
        folder: folder.trim() || undefined,
      });
      onCreated(created);
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to create worktree");
    } finally {
      setCreating(false);
    }
  };

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()} style={{ maxWidth: 540 }}>
        <button className="icon-button close" onClick={onClose} aria-label="Close dialog">×</button>
        <h2>New Git Worktree</h2>

        {error && <div className="alert form-alert">{error}</div>}

        <form onSubmit={handleCreate}>
          <label>
            Project
            <select
              value={projectId}
              onChange={(e) => {
                setProjectId(e.target.value);
                const locs = locations.filter(
                  (l) => l.enabled && (!l.projectId || l.projectId === e.target.value)
                );
                if (locs[0]) setLocationId(locs[0].id);
              }}
              required
            >
              {activeProjects.map((p) => (
                <option key={p.id} value={p.id}>{p.displayLabel} ({p.canonicalRootPath})</option>
              ))}
            </select>
          </label>

          <label>
            Worktree Location
            {availableLocations.length > 0 ? (
              <select
                value={locationId}
                onChange={(e) => setLocationId(e.target.value)}
                required
              >
                {availableLocations.map((loc) => (
                  <option key={loc.id} value={loc.id}>
                    {loc.displayLabel} ({loc.configuredRootPath})
                  </option>
                ))}
              </select>
            ) : (
              <p className="muted" style={{ margin: "4px 0", fontSize: 12 }}>
                No configured locations found. A global or project location must be configured.
              </p>
            )}
          </label>

          <div style={{ margin: "14px 0" }}>
            <label>
              Task Purpose / Goal (Optional)
              <div style={{ display: "flex", gap: 8, marginTop: 4 }}>
                <input
                  type="text"
                  placeholder="e.g. Implement customer webhook retry backoff"
                  value={purpose}
                  onChange={(e) => setPurpose(e.target.value)}
                />
                <button
                  type="button"
                  className="secondary"
                  onClick={handleSuggest}
                  disabled={!purpose.trim() || suggesting || !projectId}
                  title="Generate label, branch and folder suggestions using AI"
                  style={{ whiteSpace: "nowrap", flex: "none" }}
                >
                  {suggesting ? "Thinking..." : "⚡ Suggest"}
                </button>
              </div>
            </label>
            <p className="form-help">Type your goal and click Suggest to auto-fill metadata.</p>
          </div>

          <label>
            Workspace Label
            <input
              type="text"
              placeholder="e.g. Webhook retry logic"
              value={label}
              onChange={(e) => setLabel(e.target.value)}
              required
            />
          </label>

          <label>
            Git Branch / Ref
            <input
              type="text"
              placeholder="e.g. feature/webhook-retries or main"
              value={branch}
              onChange={(e) => setBranch(e.target.value)}
              required
            />
          </label>

          <label>
            Destination Folder Name (Optional)
            <input
              type="text"
              placeholder="e.g. webhook-retries--wk_7d2a"
              value={folder}
              onChange={(e) => setFolder(e.target.value)}
            />
          </label>

          <div className="form-actions">
            <button type="button" className="secondary" onClick={onClose}>
              Cancel
            </button>
            <button
              type="submit"
              className="primary"
              disabled={creating || !locationId || !label.trim() || !branch.trim()}
            >
              {creating ? "Creating Worktree..." : "Create Worktree"}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
