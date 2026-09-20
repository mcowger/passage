import { useEffect, useRef, useState } from "react";
import type { Project } from "../../shared/domain/workspaces.ts";
import type { ProjectBranch } from "../../shared/domain/git.ts";
import { friendlyApiError, WorkspaceApiError, type WorkspaceApi } from "../api.ts";
import { Button } from "./ui/button.tsx";
import { Input } from "./ui/input.tsx";
import { Label } from "./ui/label.tsx";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "./ui/dialog.tsx";
import { Alert, AlertDescription } from "./ui/alert.tsx";
import { ProjectAppearanceField } from "./ProjectAppearanceField.tsx";
import { Progress } from "./ui/progress.tsx";
import { toast } from "sonner";

export function ProjectEditModal({
  project,
  api,
  onClose,
  onSaved,
}: {
  project: Project;
  api: WorkspaceApi;
  onClose: () => void;
  onSaved: () => Promise<void> | void;
}) {
  const [label, setLabel] = useState(project.displayLabel);
  const [icon, setIcon] = useState<string | null>(project.iconName ?? null);
  const [color, setColor] = useState<string | null>(project.iconColor ?? null);
  const [useProjectIcon, setUseProjectIcon] = useState(project.useProjectIcon ?? false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [branches, setBranches] = useState<ProjectBranch[] | null>(null);
  const [branchesLoading, setBranchesLoading] = useState(false);
  const [branchesError, setBranchesError] = useState("");
  const [deleting, setDeleting] = useState<string | null>(null);
  const [forceTarget, setForceTarget] = useState<string | null>(null);
  const [rowError, setRowError] = useState<{ branch: string; message: string } | null>(null);
  const [archiving, setArchiving] = useState<string | null>(null);
  const [cleaning, setCleaning] = useState(false);
  const [confirmCleanup, setConfirmCleanup] = useState(false);
  const [cleanupProgress, setCleanupProgress] = useState<{ done: number; total: number; current: string } | null>(null);
  const cleanupAbortRef = useRef(false);

  useEffect(() => {
    setLabel(project.displayLabel);
    setIcon(project.iconName ?? null);
    setColor(project.iconColor ?? null);
    setUseProjectIcon(project.useProjectIcon ?? false);
    setError("");
    setForceTarget(null);
    setRowError(null);
  }, [project.id, project.displayLabel, project.iconName, project.iconColor, project.useProjectIcon]);

  const loadBranches = async () => {
    setBranchesLoading(true);
    setBranchesError("");
    try {
      setBranches(await api.listProjectBranches(project.id));
    } catch (err) {
      setBranches(null);
      setBranchesError(friendlyApiError(err, "Failed to load branches"));
    } finally {
      setBranchesLoading(false);
    }
  };

  useEffect(() => {
    void loadBranches();
  }, [project.id]);

  const handleDeleteBranch = async (branchName: string, force: boolean) => {
    setDeleting(branchName);
    setRowError(null);
    try {
      const fresh = await api.deleteProjectBranch(project.id, branchName, force);
      setBranches(fresh);
      setForceTarget(null);
      await onSaved();
    } catch (err) {
      if (err instanceof WorkspaceApiError && err.code === "force-required") {
        setForceTarget(branchName);
        setRowError({ branch: branchName, message: err.message || "Branch is not fully merged. Force delete to discard it." });
      } else {
        setRowError({ branch: branchName, message: friendlyApiError(err, "Failed to delete branch") });
      }
    } finally {
      setDeleting(null);
    }
  };

  /** Sequential cleanup with real progress: one safe delete per candidate
   *  branch, publishing the fresh list after each so rows visibly disappear
   *  and the bar/status stay truthful. A single bulk call would only offer
   *  a busy label. Aborting stops before the next branch; the branch
   *  currently deleting always finishes. */
  const handleCleanupBranches = async () => {
    // The confirm action carries no disabled state of its own: refuse to
    // start while a row delete or archive is in flight so two mutations
    // never compete over the branch list.
    if (deleting !== null || archiving !== null || cleaning) return;
    const targets = (branches ?? [])
      .filter((b) => !b.isMain && !b.isCheckedOut && b.mergedIntoMain === true)
      .map((b) => b.name);
    if (targets.length === 0) {
      setConfirmCleanup(false);
      return;
    }
    cleanupAbortRef.current = false;
    setCleaning(true);
    setBranchesError("");
    setRowError(null);
    const deleted: string[] = [];
    const skipped: Array<{ branch: string; reason: string }> = [];
    for (let i = 0; i < targets.length; i++) {
      if (cleanupAbortRef.current) break;
      const name = targets[i];
      setCleanupProgress({ done: i, total: targets.length, current: name });
      try {
        setBranches(await api.deleteProjectBranch(project.id, name, false));
        deleted.push(name);
      } catch (err) {
        skipped.push({
          branch: name,
          reason: err instanceof WorkspaceApiError ? err.message || err.code : friendlyApiError(err, "Delete failed"),
        });
      }
    }
    // `stop` during the final branch leaves nothing unprocessed, so only
    // report a stop when at least one target never ran.
    const stopped = cleanupAbortRef.current && deleted.length + skipped.length < targets.length;
    setCleanupProgress(null);
    setCleaning(false);
    setConfirmCleanup(false);
    try {
      await onSaved();
    } catch (err) {
      toast.error(friendlyApiError(err, "Branches were cleaned up, but the workspace list could not be refreshed"));
    }
    if (stopped) {
      toast.success(`Cleanup stopped — deleted ${deleted.length} of ${targets.length} branches`);
    } else if (deleted.length > 0) {
      toast.success(
        deleted.length === 1
          ? `Cleaned up 1 branch (${deleted[0]})`
          : `Cleaned up ${deleted.length} branches`,
      );
    }
    if (skipped.length > 0) {
      setBranchesError(
        `Skipped ${skipped.length} branch${skipped.length === 1 ? "" : "es"}: ${skipped.map((s) => `${s.branch}: ${s.reason}`).join("; ")}`,
      );
    }
  };

  const handleArchiveWorkspace = async (workspaceId: string) => {
    setArchiving(workspaceId);
    try {
      await api.archiveWorkspace(workspaceId);
      await loadBranches();
      await onSaved();
    } catch (err) {
      setBranchesError(friendlyApiError(err, "Failed to archive workspace"));
    } finally {
      setArchiving(null);
    }
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!label.trim()) {
      setError("Project name cannot be empty.");
      return;
    }
    setBusy(true);
    setError("");
    try {
      await api.updateProject(project.id, {
        displayLabel: label.trim(),
        iconName: icon,
        iconColor: color,
        useProjectIcon,
      });
      await onSaved();
      onClose();
    } catch (err) {
      setError(friendlyApiError(err, "Failed to update project"));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open onOpenChange={(open) => { if (!open && !cleaning) onClose(); }}>
      <DialogContent className="max-w-[min(480px,calc(100%-2rem))] max-h-[calc(100dvh-2rem)] overflow-x-hidden overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="text-base font-semibold">Edit project</DialogTitle>
        </DialogHeader>
        {error && (
          <Alert variant="destructive" className="my-2">
            <AlertDescription className="text-xs">{error}</AlertDescription>
          </Alert>
        )}
        <form onSubmit={handleSubmit} className="flex min-w-0 flex-col gap-4 pt-1">
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="edit-project-label" className="text-xs">Project name</Label>
            <Input
              id="edit-project-label"
              value={label}
              onChange={(e) => setLabel(e.target.value)}
              placeholder="Payments platform"
              className="h-8 text-xs"
              autoFocus
              required
            />
          </div>
          <ProjectAppearanceField
            icon={icon}
            color={color}
            onIconChange={setIcon}
            onColorChange={setColor}
            idPrefix="edit-project"
            useProjectIcon={useProjectIcon}
            onUseProjectIconChange={setUseProjectIcon}
            detectedIconUrl={api.projectIconUrl(project.id)}
          />
          <p className="text-[11px] text-muted-foreground font-mono break-all">{project.canonicalRootPath}</p>
          <BranchReviewSection
            branches={branches}
            loading={branchesLoading}
            error={branchesError}
            deleting={deleting}
            forceTarget={forceTarget}
            rowError={rowError}
            archiving={archiving}
            cleaning={cleaning}
            confirmCleanup={confirmCleanup}
            cleanupProgress={cleanupProgress}
            onRetry={loadBranches}
            onDelete={handleDeleteBranch}
            onCancelForce={() => { setForceTarget(null); setRowError(null); }}
            onArchive={handleArchiveWorkspace}
            onRequestCleanup={() => setConfirmCleanup(true)}
            onCancelCleanup={() => setConfirmCleanup(false)}
            onAbortCleanup={() => { cleanupAbortRef.current = true; }}
            onConfirmCleanup={handleCleanupBranches}
          />
          <div className="flex justify-end gap-2 pt-2 border-t border-border/40">
            <Button type="button" variant="secondary" size="xs" onClick={onClose} disabled={busy || cleaning}>
              Cancel
            </Button>
            <Button type="submit" size="xs" disabled={busy || cleaning || !label.trim()}>
              {busy ? "Saving..." : "Save changes"}
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}

/** Branch review + cleanup: every live local branch annotated with the
 *  Passage workspace rows tracking it. Safe delete (`git branch -d`) is the
 *  only first step; unmerged work surfaces an explicit second force confirm
 *  instead of a dead-end error. Checked-out and trunk branches cannot be
 *  deleted -- remove the worktree first. Workspace archival is a separate
 *  per-row action that never deletes git state. */
function BranchReviewSection({
  branches,
  loading,
  error,
  deleting,
  forceTarget,
  rowError,
  archiving,
  cleaning,
  confirmCleanup,
  cleanupProgress,
  onRetry,
  onDelete,
  onCancelForce,
  onArchive,
  onRequestCleanup,
  onCancelCleanup,
  onAbortCleanup,
  onConfirmCleanup,
}: {
  branches: ProjectBranch[] | null;
  loading: boolean;
  error: string;
  deleting: string | null;
  forceTarget: string | null;
  rowError: { branch: string; message: string } | null;
  archiving: string | null;
  cleaning: boolean;
  confirmCleanup: boolean;
  cleanupProgress: { done: number; total: number; current: string } | null;
  onRetry: () => void;
  onDelete: (branch: string, force: boolean) => void;
  onCancelForce: () => void;
  onArchive: (workspaceId: string) => void;
  onRequestCleanup: () => void;
  onCancelCleanup: () => void;
  onAbortCleanup: () => void;
  onConfirmCleanup: () => void;
}) {
  const tracked = branches?.filter((b) => b.trackedWorkspaces.length > 0).length ?? 0;
  const merged = branches?.filter((b) => b.mergedIntoMain === true).length ?? 0;
  const cleanupCandidates = branches?.filter((b) => !b.isMain && !b.isCheckedOut && b.mergedIntoMain === true) ?? [];
  let cleanupButtonLabel: string;
  if (cleaning && cleanupProgress) {
    cleanupButtonLabel = `Cleaning ${cleanupProgress.done}/${cleanupProgress.total}`;
  } else if (cleaning) {
    cleanupButtonLabel = "Cleaning…";
  } else if (cleanupCandidates.length > 0) {
    cleanupButtonLabel = `Clean up (${cleanupCandidates.length})`;
  } else {
    cleanupButtonLabel = "Clean up";
  }
  return (
    <div className="flex min-w-0 flex-col gap-2 rounded-md border border-border/60 p-2.5">
      <div className="flex items-center justify-between gap-2">
        <h3 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
          Branches{branches ? ` (${branches.length})` : ""}
        </h3>
        <div className="flex items-center gap-1.5">
          <Button
            type="button"
            variant="outline"
            size="xs"
            onClick={onRequestCleanup}
            disabled={loading || cleaning || deleting !== null || archiving !== null || !branches || cleanupCandidates.length === 0}
            title="Delete all branches merged into the trunk (including branches with no unique commits). Trunk and checked-out branches are kept."
          >
            {cleanupButtonLabel}
          </Button>
          <Button type="button" variant="ghost" size="xs" onClick={onRetry} disabled={loading || cleaning}>
            {loading ? "Loading…" : "Refresh"}
          </Button>
        </div>
      </div>
      {confirmCleanup && (
        <div className="flex flex-col gap-1.5 rounded-md border border-amber-500/30 bg-amber-500/5 p-1.5">
          {cleaning && cleanupProgress ? (
            <>
              <p className="text-[11px] font-medium" aria-live="polite">
                Deleting {cleanupProgress.done + 1} of {cleanupProgress.total}: <span className="font-mono">⎇ {cleanupProgress.current}</span>…
              </p>
              <Progress value={Math.round((cleanupProgress.done / cleanupProgress.total) * 100)} aria-label={`Cleaning branches: ${cleanupProgress.done} of ${cleanupProgress.total} processed`} />
              <div className="flex justify-end gap-1.5">
                <Button type="button" variant="secondary" size="xs" onClick={onAbortCleanup}>
                  Stop after current
                </Button>
              </div>
            </>
          ) : (
            <>
              <p className="text-[11px] font-medium">
                Delete {cleanupCandidates.length} merged {cleanupCandidates.length === 1 ? "branch" : "branches"}? Branches with no unique commits are also removed. Trunk and checked-out branches are kept.
              </p>
              <p className="truncate font-mono text-[10px] text-muted-foreground" title={cleanupCandidates.map((b) => b.name).join(", ")}>
                {cleanupCandidates.map((b) => b.name).join(", ")}
              </p>
              <div className="flex justify-end gap-1.5">
                <Button type="button" variant="secondary" size="xs" onClick={onCancelCleanup}>
                  Cancel
                </Button>
                <Button type="button" variant="destructive" size="xs" onClick={onConfirmCleanup}>
                  {`Delete ${cleanupCandidates.length}`}
                </Button>
              </div>
            </>
          )}
        </div>
      )}
      {branches && branches.length > 0 && (
        <p className="text-[11px] text-muted-foreground">
          {tracked} tracked in Passage · {merged} merged into main · safe delete only; unmerged branches need a second force confirm.
        </p>
      )}
      {loading && !branches && <p className="text-xs text-muted-foreground">Loading branches…</p>}
      {error && (
        <Alert variant="destructive">
          <AlertDescription className="text-xs">{error}</AlertDescription>
        </Alert>
      )}
      {!loading && !error && branches?.length === 0 && (
        <p className="text-xs text-muted-foreground">No local branches found in this repository.</p>
      )}
      {branches && branches.length > 0 && (
        <ul className="flex max-h-72 min-w-0 touch-pan-y flex-col gap-1.5 overflow-x-hidden overflow-y-auto overscroll-contain pr-0.5 [-webkit-overflow-scrolling:touch]">
          {branches.map((branch) => {
            const protected_ = branch.isMain || branch.isCheckedOut;
            const protectReason = branch.isMain
              ? "The trunk branch cannot be deleted"
              : "Checked out in a worktree — remove the worktree first";
            const isForceOpen = forceTarget === branch.name;
            let deleteTitle: string;
            if (cleaning) {
              deleteTitle = "Cleanup is running";
            } else if (protected_) {
              deleteTitle = protectReason;
            } else {
              deleteTitle = `Delete branch ${branch.name} (safe)`;
            }
            return (
              <li key={branch.name} className="min-w-0 rounded-md border border-border/50 px-2 py-1.5">
                <div className="flex items-center justify-between gap-2 min-w-0">
                  <span className="min-w-0 flex-1 truncate font-mono text-xs font-semibold" title={branch.name}>
                    ⎇ {branch.name}
                  </span>
                  <Button
                    type="button"
                    variant="destructive"
                    size="xs"
                    disabled={protected_ || deleting === branch.name || cleaning}
                    title={deleteTitle}
                    onClick={() => onDelete(branch.name, false)}
                  >
                    {deleting === branch.name ? "Deleting…" : "Delete"}
                  </Button>
                </div>
                <div className="mt-1 flex flex-wrap items-center gap-1">
                  {branch.isCurrent && <span className="rounded bg-primary/10 px-1.5 py-px text-[10px] font-medium text-primary">current</span>}
                  {branch.isMain && <span className="rounded bg-muted px-1.5 py-px text-[10px] font-medium text-muted-foreground">trunk</span>}
                  {branch.isCheckedOut && <span className="rounded bg-muted px-1.5 py-px text-[10px] font-medium text-muted-foreground">checked out</span>}
                  {branch.mergedIntoMain === true && <span className="rounded bg-emerald-500/10 px-1.5 py-px text-[10px] font-medium text-emerald-600">merged</span>}
                  {branch.mergedIntoMain === false && <span className="rounded bg-amber-500/10 px-1.5 py-px text-[10px] font-medium text-amber-600">unmerged</span>}
                  {branch.trackedWorkspaces.length > 0
                    ? <span className="rounded bg-sky-500/10 px-1.5 py-px text-[10px] font-medium text-sky-600">tracked</span>
                    : <span className="rounded bg-muted px-1.5 py-px text-[10px] font-medium text-muted-foreground">untracked</span>}
                </div>
                {(branch.subject || branch.upstream || branch.lastCommitAt) && (
                  <p className="mt-1 truncate text-[11px] text-muted-foreground" title={branch.subject || undefined}>
                    {branch.subject || "No message"}
                    {branch.upstream ? ` · ↑ ${branch.upstream}` : ""}
                    {branch.lastCommitAt ? ` · ${branch.lastCommitAt.slice(0, 10)}` : ""}
                    {` · ${branch.head.slice(0, 7)}`}
                  </p>
                )}
                {branch.worktreePath && (
                  <p className="mt-0.5 truncate font-mono text-[10px] text-muted-foreground" title={branch.worktreePath}>
                    {branch.worktreePath}
                  </p>
                )}
                {branch.trackedWorkspaces.length > 0 && (
                  <div className="mt-1 flex flex-col gap-1">
                    {branch.trackedWorkspaces.map((w) => (
                      <div key={w.workspaceId} className="flex items-center justify-between gap-2 min-w-0 rounded bg-muted/40 px-1.5 py-1">
                        <span className="min-w-0 flex-1 truncate text-[11px]" title={`${w.displayLabel} (${w.kind})`}>
                          {w.displayLabel}
                          <span className="text-muted-foreground"> · {w.kind}</span>
                          {w.archivedAt && <span className="text-muted-foreground"> · archived</span>}
                        </span>
                        {!w.archivedAt && (
                          <Button
                            type="button"
                            variant="outline"
                            size="xs"
                            disabled={archiving === w.workspaceId || cleaning}
                            onClick={() => onArchive(w.workspaceId)}
                          >
                            {archiving === w.workspaceId ? "Archiving…" : "Archive"}
                          </Button>
                        )}
                      </div>
                    ))}
                  </div>
                )}
                {rowError?.branch === branch.name && (
                  <div className="mt-1.5 rounded-md border border-destructive/30 bg-destructive/5 p-1.5">
                    <p className="text-[11px] text-destructive">{rowError.message}</p>
                    {isForceOpen && (
                      <div className="mt-1.5 flex flex-col gap-1 rounded border border-amber-500/30 bg-amber-500/5 p-1.5">
                        <p className="text-[11px] font-medium">
                          “{branch.name}” is not fully merged{branch.subject ? `: “${branch.subject}” (${branch.head.slice(0, 7)})` : ""}. Forcing permanently discards its unmerged commits.
                        </p>
                        <div className="flex justify-end gap-1.5">
                          <Button type="button" variant="secondary" size="xs" onClick={onCancelForce}>
                            Cancel
                          </Button>
                          <Button
                            type="button"
                            variant="destructive"
                            size="xs"
                            disabled={deleting === branch.name || cleaning}
                            onClick={() => onDelete(branch.name, true)}
                          >
                            {deleting === branch.name ? "Deleting…" : "Force delete"}
                          </Button>
                        </div>
                      </div>
                    )}
                  </div>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
