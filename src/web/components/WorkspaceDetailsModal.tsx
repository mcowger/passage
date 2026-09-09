import { useState } from "react";
import type { Project, Workspace } from "../../shared/domain/workspaces.ts";
import type { WorkspaceApi } from "../api.ts";
import { CopyValueButton } from "./CopyValueButton.tsx";
import { Button } from "./ui/button.tsx";
import { Input } from "./ui/input.tsx";
import { Badge } from "./ui/badge.tsx";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "./ui/dialog.tsx";

export interface WorkspaceDetailsModalProps {
  open: boolean;
  onClose: () => void;
  workspace: Workspace;
  project: Project;
  api: WorkspaceApi;
  onRefresh: () => Promise<void>;
}

export function WorkspaceDetailsModal({
  open,
  onClose,
  workspace,
  project,
  api,
  onRefresh,
}: WorkspaceDetailsModalProps) {
  const [editing, setEditing] = useState(false);
  const [label, setLabel] = useState(workspace.displayLabel);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [confirmRemove, setConfirmRemove] = useState(false);
  const [forceRemove, setForceRemove] = useState(false);

  const handleRename = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!label.trim()) return;
    try {
      setBusy(true);
      setError("");
      await api.labelWorkspace(workspace.id, label.trim());
      await onRefresh();
      setEditing(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to rename workspace");
    } finally {
      setBusy(false);
    }
  };

  const handleToggleArchive = async () => {
    try {
      setBusy(true);
      setError("");
      if (workspace.archivedAt) {
        await api.reopenWorkspace(workspace.id);
        await onRefresh();
      } else {
        await api.archiveWorkspace(workspace.id);
        await onRefresh();
        onClose();
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to update workspace");
    } finally {
      setBusy(false);
    }
  };

  const handleRepair = async () => {
    try {
      setBusy(true);
      setError("");
      await api.repairWorktree(workspace.id);
      await onRefresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to repair worktree");
    } finally {
      setBusy(false);
    }
  };

  const handleRemoveWorktree = async () => {
    try {
      setBusy(true);
      setError("");
      await api.removeWorktree(workspace.id, forceRemove);
      setConfirmRemove(false);
      await onRefresh();
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to remove worktree");
    } finally {
      setBusy(false);
    }
  };

  const isWorktree = workspace.kind === "worktree";

  return (
    <>
      <Dialog open={open} onOpenChange={(isOpen) => { if (!isOpen) onClose(); }}>
        <DialogContent className="max-w-[560px] text-sm">
          <DialogHeader>
            <div className="flex items-center gap-2 mb-1">
              <span className="text-xs text-muted-foreground font-mono">{project.displayLabel}</span>
              <span className="text-muted-foreground">/</span>
              <DialogTitle className="text-base font-semibold">{workspace.displayLabel}</DialogTitle>
            </div>
            <div className="flex items-center gap-2 pt-1 flex-wrap">
              <Badge variant="outline" className="text-xs font-mono">
                {workspace.kind}
              </Badge>
              {workspace.branchRef && (
                <Badge variant="secondary" className="text-xs font-mono">
                  ⎇ {workspace.branchRef}
                </Badge>
              )}
              {workspace.archivedAt ? (
                <Badge variant="destructive" className="text-xs">Archived</Badge>
              ) : (
                <Badge variant="outline" className="text-xs text-emerald-600 border-emerald-500/30">Ready</Badge>
              )}
              {workspace.ownershipState === "repair" && (
                <Badge variant="destructive" className="text-xs">Repair Required</Badge>
              )}
            </div>
          </DialogHeader>

          {error && (
            <div className="p-2 text-xs bg-destructive/10 border border-destructive/20 text-destructive rounded my-2">
              {error}
            </div>
          )}

          {/* Rename section */}
          <div className="py-2 border-y border-border/50">
            {editing ? (
              <form onSubmit={handleRename} className="flex gap-2 items-center">
                <Input
                  value={label}
                  onChange={(e) => setLabel(e.target.value)}
                  placeholder={isWorktree ? "Worktree label" : "Workspace label"}
                  className="h-8 text-xs flex-1"
                  autoFocus
                  required
                />
                <Button size="sm" type="submit" disabled={busy || !label.trim()}>
                  Save
                </Button>
                <Button size="sm" variant="ghost" type="button" onClick={() => setEditing(false)}>
                  Cancel
                </Button>
              </form>
            ) : (
              <div className="flex items-center justify-between">
                <span className="text-xs text-muted-foreground">
                  {isWorktree ? "Worktree" : "Workspace"} label: <b>{workspace.displayLabel}</b>
                </span>
                <Button size="sm" variant="outline" className="h-7 text-xs" onClick={() => setEditing(true)}>
                  Rename
                </Button>
              </div>
            )}
          </div>

          {/* Quick Actions */}
          <div className="flex items-center gap-2 py-1 flex-wrap">
            {workspace.archivedAt ? (
              <Button size="sm" variant="default" onClick={handleToggleArchive} disabled={busy}>
                {isWorktree ? "Reopen Worktree" : "Reopen Workspace"}
              </Button>
            ) : (
              <Button size="sm" variant="secondary" onClick={handleToggleArchive} disabled={busy}>
                {isWorktree ? "Archive Worktree" : "Archive Workspace"}
              </Button>
            )}

            {workspace.ownershipState === "repair" && (
              <Button size="sm" variant="outline" onClick={handleRepair} disabled={busy}>
                Repair Worktree
              </Button>
            )}

            {isWorktree && (
              <Button
                size="sm"
                variant="destructive"
                onClick={() => setConfirmRemove(true)}
                disabled={busy}
              >
                Delete Worktree
              </Button>
            )}
          </div>

          {/* Workspace Path & Metadata Details */}
          <div className="pt-2">
            <h4 className="text-xs font-semibold text-muted-foreground uppercase tracking-wider mb-2">
              Metadata & Paths
            </h4>
            <dl className="grid grid-cols-[140px_1fr] gap-x-3 gap-y-2 text-xs">
              <dt className="text-muted-foreground">Project root</dt>
              <dd className="font-mono break-all flex items-start gap-1">{project.canonicalRootPath}<CopyValueButton value={project.canonicalRootPath} label="project root path" /></dd>

              <dt className="text-muted-foreground">Working directory</dt>
              <dd className="font-mono break-all flex items-start gap-1">{workspace.cwd}<CopyValueButton value={workspace.cwd} label="working directory path" /></dd>

              <dt className="text-muted-foreground">Checkout root</dt>
              <dd className="font-mono break-all flex items-start gap-1">{workspace.checkoutRoot ?? "Not applicable"}{workspace.checkoutRoot && <CopyValueButton value={workspace.checkoutRoot} label="checkout root path" />}</dd>

              <dt className="text-muted-foreground">Main repository</dt>
              <dd className="font-mono break-all flex items-start gap-1">{workspace.mainRepositoryRoot ?? "Not applicable"}{workspace.mainRepositoryRoot && <CopyValueButton value={workspace.mainRepositoryRoot} label="main repository path" />}</dd>

              <dt className="text-muted-foreground">Branch ref</dt>
              <dd className="font-mono">{workspace.branchRef ?? "None (directory)"}</dd>

              <dt className="text-muted-foreground">Ownership</dt>
              <dd>{workspace.ownershipState}</dd>

              {workspace.markerPath && (
                <>
                  <dt className="text-muted-foreground">Marker path</dt>
                  <dd className="font-mono break-all">{workspace.markerPath}</dd>
                </>
              )}
            </dl>
          </div>
        </DialogContent>
      </Dialog>

      {/* Confirmation Dialog for Worktree Deletion */}
      {confirmRemove && (
        <Dialog open onOpenChange={(open) => { if (!open) setConfirmRemove(false); }}>
          <DialogContent className="max-w-[440px]">
            <DialogHeader>
              <DialogTitle className="text-base font-semibold">Delete Git Worktree</DialogTitle>
            </DialogHeader>
            <p className="text-xs text-muted-foreground my-2">
              Are you sure you want to permanently delete the worktree at <code className="font-mono text-xs">{workspace.cwd}</code> from disk?
            </p>
            <label className="flex items-center gap-2 text-xs text-destructive font-medium my-2 cursor-pointer">
              <input
                type="checkbox"
                checked={forceRemove}
                onChange={(e) => setForceRemove(e.target.checked)}
                className="rounded border-input text-destructive focus:ring-destructive"
              />
              Force delete (discard any uncommitted or dirty changes)
            </label>
            <div className="flex justify-end gap-2 pt-2">
              <Button size="sm" variant="secondary" onClick={() => setConfirmRemove(false)}>Cancel</Button>
              <Button size="sm" variant="destructive" onClick={handleRemoveWorktree} disabled={busy}>
                {busy ? "Deleting..." : "Delete Worktree"}
              </Button>
            </div>
          </DialogContent>
        </Dialog>
      )}
    </>
  );
}
