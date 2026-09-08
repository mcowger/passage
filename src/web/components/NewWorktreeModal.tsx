import { useState } from "react";
import type { Project, WorktreeLocation, Workspace } from "../../shared/domain/workspaces.ts";
import type { WorkspaceApi } from "../api.ts";
import { Button } from "./ui/button.tsx";
import { Input } from "./ui/input.tsx";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "./ui/dialog.tsx";

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
    <Dialog open onOpenChange={(open) => { if (!open) onClose(); }}>
      <DialogContent className="max-w-[540px]">
        <DialogHeader>
          <DialogTitle className="text-lg font-semibold">New Git Worktree</DialogTitle>
        </DialogHeader>

        {error && <div className="alert form-alert text-sm text-destructive">{error}</div>}

        <form onSubmit={handleCreate} className="flex flex-col gap-4">
          <label className="flex flex-col gap-1 text-sm font-medium">
            Project
            <select
              className="rounded-md border border-input bg-background px-3 py-2 text-sm shadow-xs focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
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

          <label className="flex flex-col gap-1 text-sm font-medium">
            Worktree Location
            {availableLocations.length > 0 ? (
              <select
                className="rounded-md border border-input bg-background px-3 py-2 text-sm shadow-xs focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
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
              <p className="text-xs text-muted-foreground mt-1">
                No configured locations found. A global or project location must be configured.
              </p>
            )}
          </label>

          <div className="flex flex-col gap-1">
            <label className="flex flex-col gap-1 text-sm font-medium">
              Task Purpose / Goal (Optional)
              <div className="flex gap-2 mt-1">
                <Input
                  type="text"
                  placeholder="e.g. Implement customer webhook retry backoff"
                  value={purpose}
                  onChange={(e) => setPurpose(e.target.value)}
                />
                <Button
                  type="button"
                  variant="secondary"
                  onClick={handleSuggest}
                  disabled={!purpose.trim() || suggesting || !projectId}
                  title="Generate label, branch and folder suggestions using AI"
                  className="shrink-0"
                >
                  {suggesting ? "Thinking..." : "⚡ Suggest"}
                </Button>
              </div>
            </label>
            <p className="text-xs text-muted-foreground">Type your goal and click Suggest to auto-fill metadata.</p>
          </div>

          <label className="flex flex-col gap-1 text-sm font-medium">
            Workspace Label
            <Input
              type="text"
              placeholder="e.g. Webhook retry logic"
              value={label}
              onChange={(e) => setLabel(e.target.value)}
              required
            />
          </label>

          <label className="flex flex-col gap-1 text-sm font-medium">
            Git Branch / Ref
            <Input
              type="text"
              placeholder="e.g. feature/webhook-retries or main"
              value={branch}
              onChange={(e) => setBranch(e.target.value)}
              required
            />
          </label>

          <label className="flex flex-col gap-1 text-sm font-medium">
            Destination Folder Name (Optional)
            <Input
              type="text"
              placeholder="e.g. webhook-retries--wk_7d2a"
              value={folder}
              onChange={(e) => setFolder(e.target.value)}
            />
          </label>

          <div className="flex justify-end gap-2 pt-2">
            <Button type="button" variant="secondary" onClick={onClose}>
              Cancel
            </Button>
            <Button
              type="submit"
              disabled={creating || !locationId || !label.trim() || !branch.trim()}
            >
              {creating ? "Creating Worktree..." : "Create Worktree"}
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}
