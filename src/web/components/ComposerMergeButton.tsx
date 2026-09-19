import { useCallback, useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { friendlyApiError, type WorkspaceApi } from "../api.ts";
import { commitToast, CommitToastDescription } from "./ui/sonner.tsx";
import { subscribeWorkspace } from "../workspaceSocket.ts";
import type { GitStatus } from "../../shared/domain/git.ts";
import {
  isComposerSendItEnabled,
  isComposerSendItMergeable,
  isWorkspaceDeletable,
  resolveComposerGitOptions,
  type ComposerGitOption,
  type DeleteWorkspacePrompt,
} from "./agentPanelState.ts";
import { Button } from "./ui/button.tsx";
import { Alert, AlertDescription } from "./ui/alert.tsx";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "./ui/alert-dialog.tsx";
import { Popover, PopoverContent, PopoverTrigger } from "./ui/popover.tsx";
import { Spinner } from "./ui/spinner.tsx";
import {
  ArrowDownUp,
  FolderGit2,
  GitCommitHorizontal,
  GitMerge,
  Rocket,
  Upload,
} from "lucide-react";

/**
 * Smart Git shortcut for the bottom composer bar. Fetches its own Git status and
 * only renders when at least one action is relevant: commit (dirty tree),
 * merge (ahead of main), rebase (main has diverged), push (remote branch
 * exists and is behind), or send-it (dirty tree: auto-commit, then rebase +
 * merge into main in one go).
 * A single option renders as a direct action button; multiple options collapse
 * into a FolderGit2 icon button with a thinking-selector-style popup menu.
 * The Send-it button only renders when its dirty-tree gate passes (hidden,
 * not disabled, when the tree is clean or conflicted). Merge still runs only
 * after explicit confirmation; send-it runs its merge step without a second prompt.
 */
/** Exported for regression tests (stale git-status sequencing). */
export function ComposerMergeButton({
  workspaceId,
  api,
  disabled,
  settled = true,
  refreshKey,
  onWorkspaceDeleted,
  hideIcons,
}: {
  workspaceId: string;
  api: WorkspaceApi;
  disabled?: boolean;
  /** True once the owning agent is settled. Drives a status re-check (see below); not a commit gate. */
  settled?: boolean;
  /** Bumped by the owning session on every history load; drives a status re-check (see below). */
  refreshKey?: number;
  onWorkspaceDeleted?: () => void | Promise<void>;
  /** Mobile mode: omit the decorative leading icon to save horizontal space. */
  hideIcons?: boolean;
}) {
  const [status, setStatus] = useState<GitStatus | null>(null);
  const [busyOp, setBusyOp] = useState<ComposerGitOption | "send-it" | null>(null);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const [deletePrompt, setDeletePrompt] = useState<DeleteWorkspacePrompt | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [deleteError, setDeleteError] = useState("");
  // The delete-workspace AlertDialog is modal: Radix disables pointer events
  // outside it, so a Sonner toast fired at the same time is visible but
  // dead (Show more / close X can't receive taps). The commit message lives
  // inside the prompt itself (review-before-decide), so no commit toast is
  // fired alongside it. The plain-Merge path has no message to review, so
  // its simple "Merged" toast is queued and fired after the prompt closes.
  const pendingToastRef = useRef<(() => void) | null>(null);
  const flushPendingToast = () => {
    const run = pendingToastRef.current;
    pendingToastRef.current = null;
    // Let the Radix modal teardown restore outside pointer events first.
    if (run) setTimeout(run, 100);
  };
  const dismissDeletePrompt = () => {
    if (deleting) return;
    setDeletePrompt(null);
    flushPendingToast();
  };

  // Git-status fetches from several triggers (mount, history-load refresh,
  // settle re-check, WS invalidations) overlap freely. Without sequencing,
  // the last response to *resolve* wins -- e.g. the previous workspace's
  // fetch landing after the new workspace's -- and a stale dirty snapshot
  // sticks commit/send-it onto a clean tree (or a stale clean hides them
  // on a dirty one) until the next invalidation. Only the latest request
  // may write state; older resolutions are dropped on the floor.
  const statusSeqRef = useRef(0);
  const refresh = useCallback(async () => {
    const seq = ++statusSeqRef.current;
    try {
      const next = await api.gitStatus(workspaceId);
      if (statusSeqRef.current === seq) setStatus(next);
    } catch {
      // Non-Git workspaces (or transient failures): hide the button.
      if (statusSeqRef.current === seq) setStatus(null);
    }
  }, [api, workspaceId]);

  useEffect(() => {
    // Invalidate any in-flight fetch from the previous workspace before the
    // fresh fetch below: its resolution must not overwrite this workspace.
    statusSeqRef.current += 1;
    setStatus(null);
    setConfirmOpen(false);
    setMenuOpen(false);
    setDeletePrompt(null);
    setDeleteError("");
    pendingToastRef.current = null;
    void refresh();
  }, [refresh]);

  const refreshRef = useRef(refresh);
  refreshRef.current = refresh;
  // Commit is the only option when the tree is dirty but the branch is
  // otherwise up to date, so a stale clean snapshot hides this button
  // entirely. The `git-status-changed` invalidation can be missed, so also
  // re-check when the owning agent settles (run writes are on disk by
  // then). Skips the initial mount, which already fetches.
  const wasSettledRef = useRef(settled);
  useEffect(() => {
    const wasSettled = wasSettledRef.current;
    wasSettledRef.current = settled;
    if (settled && !wasSettled) void refreshRef.current();
  }, [settled]);
  // History loads also refresh: after a browser refresh the live
  // `git-status-changed` WS invalidations that normally keep this fresh were
  // never received, so the buttons sit hidden on a stale snapshot until the
  // next invalidation. The owning session bumps `refreshKey` on every history
  // load. Skips the initial mount value, which the fetch above already covers.
  const refreshKeyRef = useRef(refreshKey);
  useEffect(() => {
    if (refreshKeyRef.current === refreshKey) return;
    refreshKeyRef.current = refreshKey;
    void refreshRef.current();
  }, [refreshKey]);
  useEffect(() => {
    let invalidateTimer: ReturnType<typeof setTimeout> | undefined;
    const subscription = subscribeWorkspace(
      workspaceId,
      (event) => {
        if (event.type !== "git-status-changed" && event.type !== "files-changed") return;
        if (invalidateTimer) clearTimeout(invalidateTimer);
        invalidateTimer = setTimeout(() => {
          invalidateTimer = undefined;
          void refreshRef.current();
        }, 750);
      },
      async () => {
        await refreshRef.current();
      },
    );
    return () => {
      if (invalidateTimer) clearTimeout(invalidateTimer);
      subscription.close();
    };
  }, [workspaceId]);

  const busy = busyOp !== null;

  const handleConfirmMerge = () => {
    if (busy) return;
    const branchRef = status?.branchRef ?? "branch";
    setConfirmOpen(false);
    setMenuOpen(false);
    setBusyOp("merge");
    void api.gitMergeIntoMain(workspaceId).then(
      (next) => {
        setStatus(next);
        setDeleteError("");
        setDeletePrompt({ branch: next.branchRef ?? branchRef, merged: true });
        pendingToastRef.current = () => toast.success(`Merged ${next.branchRef ?? branchRef} into main`);
      },
      (err: unknown) => {
        const message = friendlyApiError(err, "Could not merge into main. Resolve any conflicts and try again.");
        toast.error("Merge into main failed", { description: message });
      },
    ).finally(() => setBusyOp(null));
  };

  const handleRebase = () => {
    if (busy) return;
    const branchRef = status?.branchRef ?? "branch";
    setMenuOpen(false);
    setBusyOp("rebase");
    void api.gitRebaseOntoMain(workspaceId).then(
      (next) => {
        setStatus(next);
        toast.success(`Rebased ${next.branchRef ?? branchRef} onto main`);
      },
      (err: unknown) => {
        const message = friendlyApiError(err, "Could not rebase onto main. Resolve any conflicts and try again.");
        toast.error("Rebase onto main failed", { description: message });
      },
    ).finally(() => setBusyOp(null));
  };

  const handlePush = () => {
    if (busy) return;
    const branchRef = status?.branchRef ?? "branch";
    setMenuOpen(false);
    setBusyOp("push");
    void api.gitPush(workspaceId).then(
      (next) => {
        setStatus(next);
        toast.success(`Pushed ${next.branchRef ?? branchRef}`);
      },
      (err: unknown) => {
        const message = friendlyApiError(err, "Could not push the branch. Check the remote and try again.");
        toast.error("Push failed", { description: message });
      },
    ).finally(() => setBusyOp(null));
  };

  const handleCommitAuto = () => {
    if (busy) return;
    setMenuOpen(false);
    setBusyOp("commit");
    void api.gitCommitAuto(workspaceId).then(
      (result) => {
        setStatus(result.status);
        toast.success("Committed changes", { description: result.message });
      },
      (err: unknown) => {
        const message = friendlyApiError(err, "Could not commit changes. Try again.");
        toast.error("Commit failed", { description: message });
      },
    ).finally(() => setBusyOp(null));
  };

  /**
   * Send it: auto-commit (stage all + generated message), then merge into
   * main (which itself rebases the branch onto main before fast-forwarding).
   * Commit runs first because a rebase refuses a dirty tree; on main or a
   * detached HEAD there is nothing to merge, so it stops after the commit.
   */
  const handleSendIt = () => {
    if (busy || !isComposerSendItEnabled(status)) return;
    const branchRef = status?.branchRef ?? "branch";
    const mergeable = isComposerSendItMergeable(status);
    setMenuOpen(false);
    setBusyOp("send-it");
    void (async () => {
      try {
        const commit = await api.gitCommitAuto(workspaceId);
        setStatus(commit.status);
        if (!mergeable) {
          // A commit-only Send It (main branch or detached HEAD) still
          // leaves a disposable worktree behind, so offer the same delete
          // workspace prompt -- except on the main checkout, which the
          // daemon refuses to remove.
          if (isWorkspaceDeletable(commit.status)) {
            setDeleteError("");
            setDeletePrompt({ branch: commit.status.branchRef ?? branchRef, merged: false, commitMessage: commit.message });
          } else {
            commitToast("Committed changes", commit.message);
          }
          return;
        }
        const next = await api.gitMergeIntoMain(workspaceId);
        setStatus(next);
        setDeleteError("");
        setDeletePrompt({ branch: next.branchRef ?? branchRef, merged: true, commitMessage: commit.message });
      } catch (err: unknown) {
        const message = friendlyApiError(err, "Could not send changes. Resolve any conflicts and try again.");
        toast.error("Send It failed", { description: message });
        try {
          setStatus(await api.gitStatus(workspaceId));
        } catch {
          // Keep the last known status; the toast already surfaced the failure.
        }
      } finally {
        setBusyOp(null);
      }
    })();
  };

  const handleDeleteWorkspace = () => {
    if (deletePrompt === null || deleting) return;
    setDeleting(true);
    setDeleteError("");
    void api.removeWorktree(workspaceId).then(
      async () => {
        setDeleting(false);
        setDeletePrompt(null);
        flushPendingToast();
        toast.success("Workspace deleted");
        await onWorkspaceDeleted?.();
      },
      (err: unknown) => {
        setDeleting(false);
        setDeleteError(friendlyApiError(err, "Could not delete the workspace. Remove it from workspace details."));
      },
    );
  };

  const options = resolveComposerGitOptions(status);
  const sendItEnabled = isComposerSendItEnabled(status);
  const sendItBusy = busyOp === "send-it";
  // Send-it is hidden (not disabled) when its dirty-tree gate fails, so the
  // component only stays mounted for send-it while it is enabled or running.
  // Otherwise it mounts for standalone commit/merge/rebase/push options.
  // Non-Git workspaces (no status) render nothing.
  if (status === null && deletePrompt === null) return null;
  // Keep the button mounted mid-run: committing cleans the tree, which
  // would otherwise hide the spinner while the merge step is still going.
  const showSendIt = status !== null && (sendItEnabled || sendItBusy);
  // Mobile: horizontal space is scarce and Send It already occupies a labeled
  // button, so any other git option collapses into the FolderGit2 menu even
  // when it is the only one -- a lone Commit next to Send It crowds the
  // model chip off the single composer row.
  const collapseSingleOption = hideIcons === true && showSendIt && options.length === 1;
  const dirtyCount = status?.files.length ?? 0;
  const sendItTitle = status?.conflicted
    ? "Resolve merge conflicts before sending"
    : !sendItEnabled
      ? "No changes to send"
      : isComposerSendItMergeable(status)
        ? `Auto-commit ${dirtyCount} changed file${dirtyCount === 1 ? "" : "s"}, rebase onto main, and merge into main`
        : `Auto-commit ${dirtyCount} changed file${dirtyCount === 1 ? "" : "s"} (stage all + generate message)`;
  const branchRef = status?.branchRef ?? deletePrompt?.branch ?? "branch";
  const ahead = status?.aheadOfMain ?? 0;
  const behindMain = status?.behindMain ?? 0;
  const aheadUpstream = status?.ahead ?? 0;

  const runOption = (option: ComposerGitOption) => {
    if (option === "commit") handleCommitAuto();
    else if (option === "merge") setConfirmOpen(true);
    else if (option === "rebase") handleRebase();
    else handlePush();
  };

  const optionMeta: Record<ComposerGitOption, { label: string; detail: string; title: string; Icon: typeof GitMerge }> = {
    commit: {
      label: "Commit",
      detail: `${dirtyCount} changed`,
      title: `Auto-commit ${dirtyCount} changed file${dirtyCount === 1 ? "" : "s"} (stage all + generate message)`,
      Icon: GitCommitHorizontal,
    },
    merge: {
      label: "Merge",
      detail: `${ahead} ahead`,
      title: `Merge ${branchRef} into main (${ahead} commit${ahead === 1 ? "" : "s"} ahead)`,
      Icon: GitMerge,
    },
    rebase: {
      label: "Rebase",
      detail: `${behindMain} behind main`,
      title: `Rebase ${branchRef} onto main (${behindMain} commit${behindMain === 1 ? "" : "s"} behind)`,
      Icon: ArrowDownUp,
    },
    push: {
      label: "Push",
      detail: `${aheadUpstream} ahead`,
      title: `Push ${branchRef} to remote (${aheadUpstream} commit${aheadUpstream === 1 ? "" : "s"} ahead)`,
      Icon: Upload,
    },
  };

  return (
    <>
      {showSendIt && (
        <Button
          variant="default"
          size="xs"
          className="composer-action-btn"
          onClick={handleSendIt}
          disabled={disabled || busy}
          title={sendItTitle}
          aria-label={sendItTitle}
        >
          {sendItBusy ? <Spinner className="size-3" /> : hideIcons ? null : <Rocket size={14} aria-hidden="true" />}
          Send It
        </Button>
      )}
      {options.length === 1 && options[0] !== undefined && !collapseSingleOption ? (() => {
        const only = options[0];
        const meta = optionMeta[only];
        const MetaIcon = meta.Icon;
        return (
          <Button
            variant="secondary"
            size="xs"
            className="composer-action-btn"
            onClick={() => runOption(only)}
            disabled={disabled || busy}
            title={meta.title}
            aria-label={meta.title}
          >
            {busy ? <Spinner className="size-3" /> : hideIcons ? null : <MetaIcon size={14} aria-hidden="true" />}
            {meta.label}
          </Button>
        );
      })() : options.length > 1 || collapseSingleOption ? (
        <Popover open={menuOpen} onOpenChange={setMenuOpen}>
          <PopoverTrigger asChild>
            <Button
              variant="secondary"
              size="xs"
              className="composer-action-btn"
              disabled={disabled || busy}
              title={`Git options for ${branchRef}: ${options.map((o) => optionMeta[o].label).join(", ")}`}
              aria-label={`Git options for ${branchRef}`}
              aria-haspopup="menu"
              aria-expanded={menuOpen}
            >
              {busy ? <Spinner className="size-3" /> : <FolderGit2 size={14} aria-hidden="true" />}
            </Button>
          </PopoverTrigger>
          <PopoverContent className="thinking-popover w-56 max-w-[calc(100vw-2rem)] p-1" align="start" side="top" sideOffset={6}>
            <div className="popover-header-title px-2 py-1.5">Git options</div>
            <div role="menu" aria-label={`Git options for ${branchRef}`}>
              {options.map((option) => {
                const meta = optionMeta[option];
                const MetaIcon = meta.Icon;
                const isBusy = busyOp === option;
                return (
                  <div
                    key={option}
                    role="menuitem"
                    className="thinking-option-row"
                    title={meta.title}
                    aria-label={meta.title}
                    aria-disabled={busy}
                    tabIndex={busy ? -1 : 0}
                    onClick={() => { if (!busy) runOption(option); }}
                    onKeyDown={(e) => {
                      if ((e.key === "Enter" || e.key === " ") && !busy) {
                        e.preventDefault();
                        runOption(option);
                      }
                    }}
                  >
                    {isBusy ? <Spinner className="size-3" /> : <MetaIcon size={14} aria-hidden="true" />}
                    <span className="thinking-option-name">{meta.label}</span>
                    <span className="ml-auto text-xs text-muted-foreground">{meta.detail}</span>
                  </div>
                );
              })}
            </div>
          </PopoverContent>
        </Popover>
      ) : null}
      <AlertDialog open={confirmOpen} onOpenChange={setConfirmOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Merge into main?</AlertDialogTitle>
            <AlertDialogDescription>
              Merge <code className="font-mono">{branchRef}</code> ({ahead} commit{ahead === 1 ? "" : "s"} ahead)
              into <code className="font-mono">main</code>? The branch is rebased onto main, then main
              fast-forwards to it.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={handleConfirmMerge}>Merge into main</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
      <AlertDialog open={deletePrompt !== null} onOpenChange={(open) => { if (!open) dismissDeletePrompt(); }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{deletePrompt?.merged === false ? "Changes sent" : "Merged into main"}</AlertDialogTitle>
            <AlertDialogDescription>
              {deletePrompt?.merged === false ? (
                <>
                  <code className="font-mono">{deletePrompt?.branch}</code> was committed. Delete this workspace?
                  The branch is kept; the worktree directory is removed.
                </>
              ) : (
                <>
                  <code className="font-mono">{deletePrompt?.branch}</code> was merged into main. Delete this workspace?
                  The branch is kept; the worktree directory is removed.
                </>
              )}
            </AlertDialogDescription>
          </AlertDialogHeader>
          {deletePrompt?.commitMessage !== undefined ? (
            <div className="rounded-md border bg-muted/50 px-3 py-2 text-sm" data-testid="delete-prompt-commit">
              <div className="mb-0.5 text-xs font-medium text-muted-foreground">Commit</div>
              {deletePrompt.commitMessage.trim() ? (
                <CommitToastDescription
                  key={deletePrompt.commitMessage}
                  message={deletePrompt.commitMessage}
                />
              ) : (
                <span className="text-muted-foreground">Commit message unavailable.</span>
              )}
            </div>
          ) : null}
          {deleteError && <Alert variant="destructive"><AlertDescription>{deleteError}</AlertDescription></Alert>}
          <AlertDialogFooter>
            <AlertDialogCancel disabled={deleting}>Keep workspace</AlertDialogCancel>
            <AlertDialogAction
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
              disabled={deleting}
              onClick={(event) => {
                event.preventDefault();
                handleDeleteWorkspace();
              }}
            >
              {deleting ? <Spinner className="size-3" /> : null}
              Delete workspace
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
