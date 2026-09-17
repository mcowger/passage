import { useState } from "react";
import type { Project, Workspace } from "../../shared/domain/workspaces.ts";
import { friendlyApiError, type WorkspaceApi } from "../api.ts";
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
import { Alert, AlertDescription } from "./ui/alert.tsx";

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
  const [removeError, setRemoveError] = useState("");
  const [forceAvailable, setForceAvailable] = useState(false);

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
      setError(friendlyApiError(err, "Failed to update workspace"));
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
      setError(friendlyApiError(err, "Failed to repair worktree"));
    } finally {
      setBusy(false);
    }
  };

  const handleRemoveWorktree = async (force: boolean) => {
    try {
      setBusy(true);
      setRemoveError("");
      await api.removeWorktree(workspace.id, force);
      setConfirmRemove(false);
      await onRefresh();
      onClose();
    } catch (err) {
      setRemoveError(friendlyApiError(err, "Failed to remove worktree"));
      setForceAvailable(true);
    } finally {
      setBusy(false);
    }
  };

  const isWorktree = workspace.kind === "worktree";

  return (
    <>
      <Dialog open={open} onOpenChange={(isOpen) => { if (!isOpen) onClose(); }}>
        <DialogContent className="max-w-[560px] text-sm max-h-[calc(100dvh-2rem)] overflow-y-auto">
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
            <Alert variant="destructive" className="my-2">
              <AlertDescription className="text-xs">{error}</AlertDescription>
            </Alert>
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
                <Button size="xs" type="submit" disabled={busy || !label.trim()}>
                  Save
                </Button>
                <Button size="xs" variant="ghost" type="button" onClick={() => setEditing(false)}>
                  Cancel
                </Button>
              </form>
            ) : (
              <div className="flex items-center justify-between gap-3">
                <span className="text-xs text-muted-foreground min-w-0 break-words">
                  {isWorktree ? "Worktree" : "Workspace"} label: <b>{workspace.displayLabel}</b>
                </span>
                <Button size="xs" variant="outline" className="shrink-0" onClick={() => setEditing(true)}>
                  Rename
                </Button>
              </div>
            )}
          </div>

          {/* Quick Actions */}
          <div className="flex items-center gap-2 py-1 flex-wrap">
            {workspace.archivedAt ? (
              <Button size="xs" variant="default" onClick={handleToggleArchive} disabled={busy}>
                {isWorktree ? "Reopen Worktree" : "Reopen Workspace"}
              </Button>
            ) : (
              <Button size="xs" variant="secondary" onClick={handleToggleArchive} disabled={busy}>
                {isWorktree ? "Archive Worktree" : "Archive Workspace"}
              </Button>
            )}

            {workspace.ownershipState === "repair" && (
              <Button size="xs" variant="outline" onClick={handleRepair} disabled={busy}>
                Repair Worktree
              </Button>
            )}

            {isWorktree && (
              <Button
                size="xs"
                variant="destructive"
                onClick={() => { setRemoveError(""); setForceAvailable(false); setConfirmRemove(true); }}
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
              <dd className="font-mono break-words flex items-start gap-1">{project.canonicalRootPath}<CopyValueButton value={project.canonicalRootPath} label="project root path" /></dd>

              <dt className="text-muted-foreground">Working directory</dt>
              <dd className="font-mono break-words flex items-start gap-1">{workspace.cwd}<CopyValueButton value={workspace.cwd} label="working directory path" /></dd>

              <dt className="text-muted-foreground">Checkout root</dt>
              <dd className="font-mono break-words flex items-start gap-1">{workspace.checkoutRoot ?? "Not applicable"}{workspace.checkoutRoot && <CopyValueButton value={workspace.checkoutRoot} label="checkout root path" />}</dd>

              <dt className="text-muted-foreground">Main repository</dt>
              <dd className="font-mono break-words flex items-start gap-1">{workspace.mainRepositoryRoot ?? "Not applicable"}{workspace.mainRepositoryRoot && <CopyValueButton value={workspace.mainRepositoryRoot} label="main repository path" />}</dd>

              <dt className="text-muted-foreground">Branch ref</dt>
              <dd className="font-mono break-words flex items-start gap-1">{workspace.branchRef ?? "None (directory)"}{workspace.branchRef && <CopyValueButton value={workspace.branchRef} label="branch ref" />}</dd>

              <dt className="text-muted-foreground">Ownership</dt>
              <dd>{workspace.ownershipState}</dd>

              {workspace.markerPath && (
                <>
                  <dt className="text-muted-foreground">Marker path</dt>
                  <dd className="font-mono break-words">{workspace.markerPath}</dd>
                </>
              )}
            </dl>
          </div>
        </DialogContent>
      </Dialog>

      {/* Confirmation Dialog for Worktree Deletion */}
      {confirmRemove && (
        <Dialog open onOpenChange={(open) => { if (!open) { setConfirmRemove(false); setForceAvailable(false); } }}>
          <DialogContent className="max-w-[440px]">
            <DialogHeader>
              <DialogTitle className="text-base font-semibold">Delete Git Worktree</DialogTitle>
            </DialogHeader>
            <p className="text-xs text-muted-foreground my-2">
              Are you sure you want to permanently delete the worktree at <code className="font-mono text-xs">{workspace.cwd}</code> from disk?
            </p>
            {removeError && (
              <Alert variant="destructive" className="my-2">
                <AlertDescription className="text-xs">{removeError}</AlertDescription>
              </Alert>
            )}
            <div className="flex justify-end gap-2 pt-2">
              <Button size="xs" variant="secondary" onClick={() => { setConfirmRemove(false); setForceAvailable(false); }}>Cancel</Button>
              {forceAvailable && (
                <Button size="xs" variant="destructive" onClick={() => handleRemoveWorktree(true)} disabled={busy}>
                  {busy ? "Deleting..." : "Force"}
                </Button>
              )}
              <Button size="xs" variant="destructive" onClick={() => handleRemoveWorktree(false)} disabled={busy}>
                {busy ? "Deleting..." : "Delete Worktree"}
              </Button>
            </div>
          </DialogContent>
        </Dialog>
      )}
    </>
  );
}
