import { useState } from "react";
import type { Project, Workspace } from "../../shared/domain/workspaces.ts";
import type { GitFileStatus, GitStatus } from "../../shared/domain/git.ts";
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
  const [removeStatus, setRemoveStatus] = useState<GitStatus | null>(null);
  const [removeStatusLoading, setRemoveStatusLoading] = useState(false);

  const resetRemoveDialog = () => {
    setRemoveError("");
    setForceAvailable(false);
    setRemoveStatus(null);
    setRemoveStatusLoading(false);
  };

  const loadRemoveStatus = async () => {
    setRemoveStatusLoading(true);
    try {
      setRemoveStatus(await api.gitStatus(workspace.id));
    } catch {
      setRemoveStatus(null);
    } finally {
      setRemoveStatusLoading(false);
    }
  };

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
      resetRemoveDialog();
      await onRefresh();
      onClose();
    } catch (err) {
      setRemoveError(friendlyApiError(err, "Failed to remove worktree"));
      setForceAvailable(true);
      void loadRemoveStatus();
    } finally {
      setBusy(false);
    }
  };

  const isWorktree = workspace.kind === "worktree";

  return (
    <>
      <Dialog open={open} onOpenChange={(isOpen) => { if (!isOpen) onClose(); }}>
        <DialogContent className="max-w-[min(560px,calc(100%-2rem))] text-sm max-h-[calc(100dvh-2rem)] overflow-y-auto overflow-x-hidden">
          <DialogHeader className="min-w-0 pr-6">
            <div className="flex items-center gap-2 mb-1 min-w-0 flex-wrap">
              <span className="text-xs text-muted-foreground font-mono shrink-0">{project.displayLabel}</span>
              <span className="text-muted-foreground shrink-0">/</span>
              <DialogTitle className="text-base font-semibold min-w-0 [overflow-wrap:anywhere]">{workspace.displayLabel}</DialogTitle>
            </div>
            <div className="flex items-center gap-2 pt-1 flex-wrap min-w-0">
              <Badge variant="outline" className="text-xs font-mono">
                {workspace.kind}
              </Badge>
              {workspace.branchRef && (
                <Badge variant="secondary" className="text-xs font-mono max-w-full min-w-0 shrink whitespace-normal text-left leading-snug [overflow-wrap:anywhere]">
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
              <div className="flex items-center justify-between gap-3 min-w-0">
                <span className="text-xs text-muted-foreground min-w-0 flex-1 [overflow-wrap:anywhere]">
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
                onClick={() => { resetRemoveDialog(); setConfirmRemove(true); }}
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
            <dl className="grid grid-cols-[110px_1fr] sm:grid-cols-[140px_1fr] gap-x-3 gap-y-2 text-xs min-w-0">
              <dt className="text-muted-foreground">Project root</dt>
              <dd className="font-mono min-w-0 flex items-start gap-1"><span className="min-w-0 flex-1 [overflow-wrap:anywhere]">{project.canonicalRootPath}</span><span className="shrink-0"><CopyValueButton value={project.canonicalRootPath} label="project root path" /></span></dd>

              <dt className="text-muted-foreground">Working directory</dt>
              <dd className="font-mono min-w-0 flex items-start gap-1"><span className="min-w-0 flex-1 [overflow-wrap:anywhere]">{workspace.cwd}</span><span className="shrink-0"><CopyValueButton value={workspace.cwd} label="working directory path" /></span></dd>

              <dt className="text-muted-foreground">Checkout root</dt>
              <dd className="font-mono min-w-0 flex items-start gap-1"><span className="min-w-0 flex-1 [overflow-wrap:anywhere]">{workspace.checkoutRoot ?? "Not applicable"}</span>{workspace.checkoutRoot && <span className="shrink-0"><CopyValueButton value={workspace.checkoutRoot} label="checkout root path" /></span>}</dd>

              <dt className="text-muted-foreground">Main repository</dt>
              <dd className="font-mono min-w-0 flex items-start gap-1"><span className="min-w-0 flex-1 [overflow-wrap:anywhere]">{workspace.mainRepositoryRoot ?? "Not applicable"}</span>{workspace.mainRepositoryRoot && <span className="shrink-0"><CopyValueButton value={workspace.mainRepositoryRoot} label="main repository path" /></span>}</dd>

              <dt className="text-muted-foreground">Branch ref</dt>
              <dd className="font-mono min-w-0 flex items-start gap-1"><span className="min-w-0 flex-1 [overflow-wrap:anywhere]">{workspace.branchRef ?? "None (directory)"}</span>{workspace.branchRef && <span className="shrink-0"><CopyValueButton value={workspace.branchRef} label="branch ref" /></span>}</dd>

              <dt className="text-muted-foreground">Ownership</dt>
              <dd className="min-w-0 [overflow-wrap:anywhere]">{workspace.ownershipState}</dd>

              {workspace.markerPath && (
                <>
                  <dt className="text-muted-foreground">Marker path</dt>
                  <dd className="font-mono min-w-0 [overflow-wrap:anywhere]">{workspace.markerPath}</dd>
                </>
              )}
            </dl>
          </div>
        </DialogContent>
      </Dialog>

      {/* Confirmation Dialog for Worktree Deletion */}
      {confirmRemove && (
        <Dialog open onOpenChange={(open) => { if (!open) { setConfirmRemove(false); resetRemoveDialog(); } }}>
          <DialogContent className="max-w-[min(440px,calc(100%-2rem))] overflow-x-hidden">
            <DialogHeader className="min-w-0 pr-6">
              <DialogTitle className="text-base font-semibold [overflow-wrap:anywhere]">Delete Git Worktree</DialogTitle>
            </DialogHeader>
            <p className="text-xs text-muted-foreground my-2 min-w-0 [overflow-wrap:anywhere]">
              Are you sure you want to permanently delete the worktree at <code className="font-mono text-xs [overflow-wrap:anywhere]">{workspace.cwd}</code> from disk?
            </p>
            {removeError && (
              <Alert variant="destructive" className="my-2">
                <AlertDescription className="text-xs">{removeError}</AlertDescription>
              </Alert>
            )}
            {forceAvailable && <RemoveDirtyFiles status={removeStatus} loading={removeStatusLoading} />}
            <div className="flex justify-end gap-2 pt-2 flex-wrap">
              <Button size="xs" variant="secondary" onClick={() => { setConfirmRemove(false); resetRemoveDialog(); }}>Cancel</Button>
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

const MAX_DIRTY_FILES_SHOWN = 30;

function RemoveDirtyFiles({ status, loading }: { status: GitStatus | null; loading: boolean }) {
  if (loading) {
    return <p className="text-xs text-muted-foreground my-2">Checking for uncommitted changes…</p>;
  }
  if (!status) return null;
  if (status.files.length === 0) {
    return (
      <p className="text-xs text-muted-foreground my-2">
        The working tree reports no uncommitted changes — Git refused for another reason (unmerged history or a lock). Forcing still permanently deletes the worktree.
      </p>
    );
  }
  const shown = status.files.slice(0, MAX_DIRTY_FILES_SHOWN);
  const hidden = status.files.length - shown.length;
  return (
    <div className="my-2 rounded-md border border-destructive/30 bg-destructive/5 p-2">
      <p className="text-xs font-semibold mb-1">
        Uncommitted changes that forcing would discard ({status.files.length}):
      </p>
      <ul className="max-h-40 overflow-y-auto text-xs font-mono space-y-0.5 min-w-0">
        {shown.map((file) => (
          <li key={`${file.path}-${file.staged ? "staged" : "wt"}`} className="flex items-baseline gap-1.5 min-w-0">
            <span className="shrink-0 text-muted-foreground" title={describeDirtyFile(file)}>{dirtyKindLabel(file)}</span>
            <span className="min-w-0 flex-1 [overflow-wrap:anywhere]" title={file.path}>
              {file.oldPath ? `${file.oldPath} → ${file.path}` : file.path}
            </span>
          </li>
        ))}
      </ul>
      {hidden > 0 && <p className="text-xs text-muted-foreground mt-1">…and {hidden} more.</p>}
    </div>
  );
}

function dirtyKindLabel(file: GitFileStatus): string {
  switch (file.kind) {
    case "modified":
      return "M";
    case "added":
      return "A";
    case "deleted":
      return "D";
    case "renamed":
      return "R";
    case "untracked":
      return "?";
    case "conflict":
      return "C";
    default:
      return "•";
  }
}

function describeDirtyFile(file: GitFileStatus): string {
  const scope = file.staged ? "staged" : "working tree";
  return `${file.kind} (${scope})`;
}
