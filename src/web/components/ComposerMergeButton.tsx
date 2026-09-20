import { useCallback, useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { friendlyApiError, type WorkspaceApi } from "../api.ts";
import { CommitToastDescription } from "./ui/sonner.tsx";
import { CommitSuccessDialog } from "./CommitSuccessDialog.tsx";
import { subscribeWorkspace } from "../workspaceSocket.ts";
import type { GitStatus, GithubStatus } from "../../shared/domain/git.ts";
import {
  isComposerShipItEnabled,
  isComposerShipItMergeable,
  isWorkspaceDeletable,
  resolveComposerGitOptions,
  resolveGithubMenuState,
  shipPrSteps,
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
import { Input } from "./ui/input.tsx";
import { Label } from "./ui/label.tsx";
import { Textarea } from "./ui/textarea.tsx";
import { Popover, PopoverContent, PopoverTrigger } from "./ui/popover.tsx";
import { Spinner } from "./ui/spinner.tsx";
import { Checkbox } from "./ui/checkbox.tsx";
import { SiGithub } from "@icons-pack/react-simple-icons";
import {
  ArrowDownUp,
  Download,
  ExternalLink,
  GitCommitHorizontal,
  GitMerge,
  GitPullRequest,
  RefreshCw,
  Truck,
  Upload,
} from "lucide-react";

/**
 * The single Git entry point for the bottom composer bar. Exactly one Git
 * button renders in all cases: clicking it always opens Git controls and
 * never mutates the repository directly. Ship It... gets the prominent spot
 * inside the menu; individual commands (Commit..., Push, Fetch, Rebase...,
 * Merge locally...) sit below it, with a GitHub section for PRs (via `gh`).
 */
type BusyOp = ComposerGitOption | "fetch" | "rebase-remote" | "ship-it" | "pr-create";

/** Exported for regression tests (stale git-status sequencing). */
export function ComposerMergeButton({
  workspaceId,
  api,
  disabled,
  settled = true,
  refreshKey,
  onWorkspaceDeleted,
}: {
  workspaceId: string;
  api: WorkspaceApi;
  disabled?: boolean;
  /** True once the owning agent is settled. Drives a status re-check (see below); not a commit gate. */
  settled?: boolean;
  /** Bumped by the owning session on every history load; drives a status re-check (see below). */
  refreshKey?: number;
  onWorkspaceDeleted?: () => void | Promise<void>;
}) {
  const [status, setStatus] = useState<GitStatus | null>(null);
  const [statusState, setStatusState] = useState<"loading" | "ready" | "unavailable">("loading");
  const [busyOp, setBusyOp] = useState<BusyOp | null>(null);
  const [confirmMergeOpen, setConfirmMergeOpen] = useState(false);
  const [rebaseOpen, setRebaseOpen] = useState(false);
  const [shipItOpen, setShipItOpen] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const [deletePrompt, setDeletePrompt] = useState<DeleteWorkspacePrompt | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [deleteError, setDeleteError] = useState("");
  const [deleteBranch, setDeleteBranch] = useState(true);
  // Commit success modal (replaces the old commit-message toast): the full
  // subject + body rendered inside a top-center toast covered the prompt on
  // narrow viewports. The merge-locally flow already shows the commit in an
  // expandable modal box -- do the same for standalone commits.
  const [commitDialog, setCommitDialog] = useState<{ title: string; message: string } | null>(null);
  // GitHub (`gh`) state for the PR section. Loaded when the menu opens and
  // refreshed after mutations; null means the check itself failed.
  const [ghStatus, setGhStatus] = useState<GithubStatus | null>(null);
  const [ghLoading, setGhLoading] = useState(false);
  // Create-PR dialog state.
  const [prOpen, setPrOpen] = useState(false);
  const [prBase, setPrBase] = useState("");
  const [prTitle, setPrTitle] = useState("");
  const [prBody, setPrBody] = useState("");
  const [prDraft, setPrDraft] = useState(false);
  const [prSuggestLoading, setPrSuggestLoading] = useState(false);
  const [prError, setPrError] = useState("");
  const [prGeneratedNote, setPrGeneratedNote] = useState("");
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
  // sticks commit/ship-it onto a clean tree (or a stale clean hides them
  // on a dirty one) until the next invalidation. Only the latest request
  // may write state; older resolutions are dropped on the floor.
  const statusSeqRef = useRef(0);
  const refresh = useCallback(async () => {
    const seq = ++statusSeqRef.current;
    try {
      const next = await api.gitStatus(workspaceId);
      if (statusSeqRef.current === seq) {
        setStatus(next);
        setStatusState("ready");
      }
    } catch {
      // Non-Git workspaces (or transient failures): show the button with an
      // explanatory empty state instead of disappearing.
      if (statusSeqRef.current === seq) {
        setStatus(null);
        setStatusState("unavailable");
      }
    }
  }, [api, workspaceId]);

  // Same sequencing guard for `gh` checks: menu opens and several mutations
  // can trigger overlapping loads across workspace switches. The daemon
  // caches host state, repo identity, and the PR lookup; `refresh` forces a
  // live re-check and `branch` scopes the cached PR to the current branch.
  const ghSeqRef = useRef(0);
  const loadGh = useCallback(async (refresh = false) => {
    const seq = ++ghSeqRef.current;
    setGhLoading(true);
    try {
      const next = await api.gitGithubStatus(workspaceId, { refresh, branch: status?.branchRef ?? undefined });
      if (ghSeqRef.current === seq) setGhStatus(next);
    } catch {
      if (ghSeqRef.current === seq) setGhStatus(null);
    } finally {
      if (ghSeqRef.current === seq) setGhLoading(false);
    }
  }, [api, workspaceId, status?.branchRef]);

  useEffect(() => {
    // Invalidate any in-flight fetch from the previous workspace before the
    // fresh fetch below: its resolution must not overwrite this workspace.
    statusSeqRef.current += 1;
    ghSeqRef.current += 1;
    setStatus(null);
    setStatusState("loading");
    setGhStatus(null);
    setGhLoading(false);
    setConfirmMergeOpen(false);
    setRebaseOpen(false);
    setShipItOpen(false);
    setPrOpen(false);
    setMenuOpen(false);
    setDeletePrompt(null);
    setDeleteError("");
    setCommitDialog(null);
    pendingToastRef.current = null;
    void refresh();
  }, [refresh]);

  const refreshRef = useRef(refresh);
  refreshRef.current = refresh;
  // Commit is only visible when the tree is dirty, so a stale clean snapshot
  // hides it entirely. The `git-status-changed` invalidation can be missed,
  // so also re-check when the owning agent settles (run writes are on disk
  // by then). Skips the initial mount, which already fetches.
  const wasSettledRef = useRef(settled);
  useEffect(() => {
    const wasSettled = wasSettledRef.current;
    wasSettledRef.current = settled;
    if (settled && !wasSettled) void refreshRef.current();
  }, [settled]);
  // History loads also refresh: after a browser refresh the live
  // `git-status-changed` WS invalidations that normally keep this fresh were
  // never received, so the menu sits stale until the next invalidation. The
  // owning session bumps `refreshKey` on every history load. Skips the
  // initial mount value, which the fetch above already covers.
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
  const ghMenu = resolveGithubMenuState(ghStatus, ghLoading);
  const ghReady = ghMenu.kind === "create" || ghMenu.kind === "view";
  const existingPr = ghMenu.kind === "view" ? ghMenu.pr : null;

  const handleConfirmMerge = () => {
    if (busy) return;
    const branchRef = status?.branchRef ?? "branch";
    setConfirmMergeOpen(false);
    setMenuOpen(false);
    setBusyOp("merge");
    void api.gitMergeIntoMain(workspaceId).then(
      (next) => {
        setStatus(next);
        setStatusState("ready");
        showDeletePrompt({ branch: next.branchRef ?? branchRef, merged: true });
        pendingToastRef.current = () => toast.success(`Merged ${next.branchRef ?? branchRef} into main`);
      },
      (err: unknown) => {
        const message = friendlyApiError(err, "Could not merge into main. Resolve any conflicts and try again.");
        toast.error("Merge locally failed", { description: message });
      },
    ).finally(() => setBusyOp(null));
  };

  const handleRebaseLocal = () => {
    if (busy) return;
    const branchRef = status?.branchRef ?? "branch";
    setRebaseOpen(false);
    setMenuOpen(false);
    setBusyOp("rebase");
    void api.gitRebaseOntoMain(workspaceId).then(
      (next) => {
        setStatus(next);
        setStatusState("ready");
        toast.success(`Rebased ${next.branchRef ?? branchRef} onto main`);
      },
      (err: unknown) => {
        const message = friendlyApiError(err, "Could not rebase onto main. Resolve any conflicts and try again.");
        toast.error("Rebase failed", { description: message });
      },
    ).finally(() => setBusyOp(null));
  };

  const handleRebaseRemote = () => {
    if (busy) return;
    const branchRef = status?.branchRef ?? "branch";
    setRebaseOpen(false);
    setMenuOpen(false);
    setBusyOp("rebase-remote");
    void api.gitRebaseRemote(workspaceId).then(
      (result) => {
        setStatus(result.status);
        setStatusState("ready");
        toast.success(`Rebased ${result.status.branchRef ?? branchRef} onto ${result.remote}/${result.base}`);
        void loadGh();
      },
      (err: unknown) => {
        const message = friendlyApiError(err, "Could not rebase onto the remote. Resolve any conflicts and try again.");
        toast.error("Rebase failed", { description: message });
      },
    ).finally(() => setBusyOp(null));
  };

  const handleFetch = () => {
    if (busy) return;
    setBusyOp("fetch");
    void api.gitFetch(workspaceId).then(
      (next) => {
        setStatus(next);
        setStatusState("ready");
        toast.success("Fetched from remote");
        void loadGh();
      },
      (err: unknown) => {
        const message = friendlyApiError(err, "Could not fetch from the remote. Check the remote and try again.");
        toast.error("Fetch failed", { description: message });
      },
    ).finally(() => setBusyOp(null));
  };

  const handlePush = () => {
    if (busy) return;
    const branchRef = status?.branchRef ?? "branch";
    const hadUpstream = status?.hasUpstream ?? true;
    setMenuOpen(false);
    setBusyOp("push");
    void api.gitPush(workspaceId).then(
      (next) => {
        setStatus(next);
        setStatusState("ready");
        toast.success(hadUpstream ? `Pushed ${next.branchRef ?? branchRef}` : `Pushed ${next.branchRef ?? branchRef} (upstream set)`);
        void loadGh();
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
        setStatusState("ready");
        setCommitDialog({ title: "Committed changes", message: result.message });
      },
      (err: unknown) => {
        const message = friendlyApiError(err, "Could not commit changes. Try again.");
        toast.error("Commit failed", { description: message });
      },
    ).finally(() => setBusyOp(null));
  };

  /** Fetch an AI-generated PR title/body for the current branch vs its base.
   *  Falls back to a template when the model is unavailable. */
  const handlePrSuggest = (baseOverride?: string) => {
    if (prSuggestLoading) return;
    setPrSuggestLoading(true);
    setPrError("");
    void api.gitPrSuggest(workspaceId, { base: (baseOverride ?? prBase).trim() || undefined }).then(
      (suggestion) => {
        setPrBase(suggestion.base);
        setPrTitle(suggestion.title);
        setPrBody(suggestion.body);
        setPrGeneratedNote(
          suggestion.generated
            ? "Generated from the branch diff."
            : "Model unavailable — started from a template. Edit before creating.",
        );
      },
      (err: unknown) => {
        setPrError(friendlyApiError(err, "Could not generate a pull request description. Fill it in manually."));
      },
    ).finally(() => setPrSuggestLoading(false));
  };

  const openPrDialog = () => {
    if (!ghReady) return;
    setMenuOpen(false);
    setShipItOpen(false);
    setPrError("");
    setPrGeneratedNote("");
    setPrDraft(false);
    setPrTitle("");
    setPrBody("");
    // Prefill the base from the repo default; the suggestion refines it to
    // the base the diff was actually computed against.
    setPrBase(ghStatus?.repo?.defaultBranch ?? "");
    setPrOpen(true);
    handlePrSuggest(ghStatus?.repo?.defaultBranch ?? "");
  };

  const handlePrCreate = (draft: boolean) => {
    if (busy || prSuggestLoading) return;
    const title = prTitle.trim();
    if (!title) {
      setPrError("Give the pull request a title.");
      return;
    }
    setPrError("");
    setPrDraft(draft);
    setBusyOp("pr-create");
    void api.gitPrCreate(workspaceId, {
      title,
      body: prBody,
      base: prBase.trim() || undefined,
      draft,
    }).then(
      (result) => {
        setStatus(result.status);
        setStatusState("ready");
        setPrOpen(false);
        const pr = result.pr;
        toast.success(pr ? `Created PR #${pr.number}` : "Created pull request", {
          description: pr?.url,
          action: pr ? { label: "View", onClick: () => window.open(pr.url, "_blank", "noopener") } : undefined,
        });
        void loadGh();
      },
      (err: unknown) => {
        setPrError(friendlyApiError(err, "Could not create the pull request. Check `gh` auth and try again."));
      },
    ).finally(() => setBusyOp(null));
  };

  /**
   * Ship It: auto-commit (stage all + generated message), then merge into
   * main (which itself rebases the branch onto main before fast-forwarding).
   * Commit runs first because a rebase refuses a dirty tree; on main or a
   * detached HEAD there is nothing to merge, so it stops after the commit.
   */
  const handleShipItMergeLocally = () => {
    if (busy || !isComposerShipItEnabled(status)) return;
    const branchRef = status?.branchRef ?? "branch";
    const mergeable = isComposerShipItMergeable(status);
    setShipItOpen(false);
    setMenuOpen(false);
    setBusyOp("ship-it");
    void (async () => {
      try {
        const commit = await api.gitCommitAuto(workspaceId);
        setStatus(commit.status);
        setStatusState("ready");
        if (!mergeable) {
          // A commit-only Ship It (main branch or detached HEAD) still
          // leaves a disposable worktree behind, so offer the same delete
          // workspace prompt -- except on the main checkout, which the
          // daemon refuses to remove.
          if (isWorkspaceDeletable(commit.status)) {
            showDeletePrompt({ branch: commit.status.branchRef ?? branchRef, merged: false, commitMessage: commit.message });
          } else {
            setCommitDialog({ title: "Committed changes", message: commit.message });
          }
          return;
        }
        const next = await api.gitMergeIntoMain(workspaceId);
        setStatus(next);
        setStatusState("ready");
        showDeletePrompt({ branch: next.branchRef ?? branchRef, merged: true, commitMessage: commit.message });
      } catch (err: unknown) {
        const message = friendlyApiError(err, "Could not ship changes. Resolve any conflicts and try again.");
        toast.error("Ship It failed", { description: message });
        try {
          const fresh = await api.gitStatus(workspaceId);
          setStatus(fresh);
          setStatusState("ready");
        } catch {
          // Keep the last known status; the toast already surfaced the failure.
        }
      } finally {
        setBusyOp(null);
      }
    })();
  };

  /**
   * Ship It to a PR: commit when dirty, then rebase onto the remote and
   * push the branch before the PR dialog opens. PR creation itself
   * re-pushes as a safety net, but these explicit steps surface
   * commit/rebase/push failures before the dialog.
   */
  const handleShipItToPr = () => {
    if (busy || !ghReady) return;
    setShipItOpen(false);
    setMenuOpen(false);
    const steps = shipPrSteps(isComposerShipItEnabled(status), isComposerShipItMergeable(status));
    if (steps.length === 0) {
      openPrDialog();
      return;
    }
    setBusyOp("ship-it");
    void (async () => {
      try {
        for (const step of steps) {
          if (step === "commit") {
            const commit = await api.gitCommitAuto(workspaceId);
            setStatus(commit.status);
            setStatusState("ready");
          } else if (step === "rebase") {
            const rebased = await api.gitRebaseRemote(workspaceId);
            setStatus(rebased.status);
            setStatusState("ready");
          } else {
            const pushed = await api.gitPush(workspaceId);
            setStatus(pushed);
            setStatusState("ready");
          }
        }
        void loadGh();
        setBusyOp(null);
        openPrDialog();
      } catch (err: unknown) {
        const message = friendlyApiError(err, "Could not ship changes. Resolve any conflicts and try again.");
        toast.error("Ship It failed", { description: message });
        try {
          const fresh = await api.gitStatus(workspaceId);
          setStatus(fresh);
          setStatusState("ready");
        } catch {
          // Keep the last known status; the toast already surfaced the failure.
        }
        setBusyOp(null);
      }
    })();
  };

  const showDeletePrompt = (prompt: DeleteWorkspacePrompt) => {
    setDeleteBranch(true);
    setDeleteError("");
    setDeletePrompt(prompt);
  };

  const canDeletePromptBranch = Boolean(deletePrompt?.branch) && deletePrompt?.branch !== "main" && deletePrompt?.branch !== "master";

  const handleDeleteWorkspace = () => {
    if (deletePrompt === null || deleting) return;
    setDeleting(true);
    setDeleteError("");
    void api.removeWorktree(workspaceId, false, canDeletePromptBranch && deleteBranch).then(
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
  const shipItEnabled = isComposerShipItEnabled(status);
  const shipItBusy = busyOp === "ship-it";
  const showShipIt = status !== null && (shipItEnabled || shipItBusy);
  const dirtyCount = status?.files.length ?? 0;
  const shipItTitle = status?.conflicted
    ? "Resolve merge conflicts before shipping"
    : !shipItEnabled
      ? "No changes to ship"
      : isComposerShipItMergeable(status)
        ? `Auto-commit ${dirtyCount} changed file${dirtyCount === 1 ? "" : "s"} and merge into main`
        : `Auto-commit ${dirtyCount} changed file${dirtyCount === 1 ? "" : "s"} (stage all + generate message)`;
  const branchRef = status?.branchRef ?? deletePrompt?.branch ?? "branch";
  const ahead = status?.aheadOfMain ?? 0;
  const behindMain = status?.behindMain ?? 0;
  const aheadUpstream = status?.ahead ?? 0;
  const hasUpstream = status?.hasUpstream ?? false;
  const remoteBaseLabel = `origin/${ghStatus?.repo?.defaultBranch ?? "default"}`;

  const runOption = (option: ComposerGitOption) => {
    if (option === "commit") handleCommitAuto();
    else if (option === "merge") {
      if (busy) return;
      setMenuOpen(false);
      setConfirmMergeOpen(true);
    }
    else if (option === "rebase") {
      if (busy) return;
      setMenuOpen(false);
      setRebaseOpen(true);
    }
    else handlePush();
  };

  const optionMeta: Record<ComposerGitOption, { label: string; detail: string; title: string; Icon: typeof GitMerge }> = {
    commit: {
      label: "Commit...",
      detail: `${dirtyCount} changed`,
      title: `Auto-commit ${dirtyCount} changed file${dirtyCount === 1 ? "" : "s"} (stage all + generate message)`,
      Icon: GitCommitHorizontal,
    },
    merge: {
      label: "Merge locally...",
      detail: `${ahead} ahead`,
      title: `Merge ${branchRef} into main (${ahead} commit${ahead === 1 ? "" : "s"} ahead)`,
      Icon: GitMerge,
    },
    rebase: {
      label: "Rebase...",
      detail: `${behindMain} behind main`,
      title: `Rebase ${branchRef} onto main or ${remoteBaseLabel} (${behindMain} commit${behindMain === 1 ? "" : "s"} behind)`,
      Icon: ArrowDownUp,
    },
    push: {
      label: "Push",
      detail: hasUpstream ? `${aheadUpstream} ahead` : "Set upstream and push",
      title: hasUpstream
        ? `Push ${branchRef} to remote (${aheadUpstream} commit${aheadUpstream === 1 ? "" : "s"} ahead)`
        : `Push ${branchRef} to origin and set upstream`,
      Icon: Upload,
    },
  };

  const busyLabel = busyOp === "ship-it"
    ? "Shipping changes"
    : busyOp === "commit"
      ? "Committing changes"
      : busyOp === "merge"
        ? "Merging into main"
        : busyOp === "rebase" || busyOp === "rebase-remote"
          ? "Rebasing branch"
          : busyOp === "push"
            ? "Pushing branch"
            : busyOp === "fetch"
              ? "Fetching from remote"
              : busyOp === "pr-create"
                ? "Creating pull request"
                : "Working";
  const triggerLabel = busy
    ? `${busyLabel}...`
    : statusState !== "ready"
      ? "Git options (status unavailable)"
      : status?.branchRef
        ? `Git options for ${status.branchRef}${dirtyCount > 0 ? `, ${dirtyCount} changed` : ""}`
        : "Git options";
  const triggerTitle = status?.conflicted
    ? `Git options for ${branchRef}: resolve merge conflicts`
    : triggerLabel;

  const openShipItDialog = () => {
    if (busy || !shipItEnabled) return;
    setMenuOpen(false);
    setShipItOpen(true);
  };

  const ghSectionTitle = ghStatus?.repo ? `GitHub · ${ghStatus.repo.nameWithOwner}` : "GitHub";
  const ghPrDetail = existingPr
    ? `#${existingPr.number}${existingPr.isDraft ? " · Draft" : ""}`
    : null;

  return (
    <>
      <Popover
        open={menuOpen}
        onOpenChange={(open) => {
          setMenuOpen(open);
          if (open && statusState === "ready") void loadGh();
        }}
      >
        <PopoverTrigger asChild>
          <Button
            variant="secondary"
            size="xs"
            className="composer-action-btn"
            disabled={disabled || busy}
            title={triggerTitle}
            aria-label={triggerLabel}
            aria-haspopup="menu"
            aria-expanded={menuOpen}
          >
            {busy ? <Spinner className="size-3" /> : <SiGithub size={14} aria-hidden="true" />}
            {dirtyCount > 0 && statusState === "ready" && !busy ? (
              <span className="ml-1 rounded-full bg-muted px-1 text-[10px] leading-3" aria-hidden="true">
                {dirtyCount}
              </span>
            ) : null}
          </Button>
        </PopoverTrigger>
        <PopoverContent className="thinking-popover w-[22rem] max-w-[calc(100vw-2rem)] p-1" align="start" side="top" sideOffset={6}>
          <div className="popover-header-title px-2 py-1.5">
            Git{status?.branchRef ? ` · ${status.branchRef}` : ""}
          </div>
          {statusState === "loading" ? (
            <div className="flex items-center gap-2 px-2 py-3 text-sm text-muted-foreground">
              <Spinner className="size-3" />
              Checking Git status...
            </div>
          ) : statusState === "unavailable" || status === null ? (
            <div className="px-2 py-2">
              <p className="text-sm text-muted-foreground">Git status unavailable. This workspace may not be a Git checkout.</p>
              <Button variant="secondary" size="xs" className="mt-2" onClick={() => void refresh()}>
                Retry
              </Button>
            </div>
          ) : (
            <div role="menu" aria-label={triggerLabel}>
              {showShipIt && (
                <div className="px-1 pb-1">
                  <Button
                    variant="default"
                    size="xs"
                    className="w-full justify-start"
                    onClick={openShipItDialog}
                    disabled={disabled || busy || !shipItEnabled}
                    title={shipItTitle}
                    aria-label={shipItTitle}
                  >
                    {shipItBusy ? <Spinner className="size-3" /> : <Truck size={14} aria-hidden="true" />}
                    Ship It...
                  </Button>
                  <div className="px-2 pt-1 text-xs text-muted-foreground">
                    {isComposerShipItMergeable(status) ? "Commit and merge locally, or open a PR" : "Commit changes"}
                  </div>
                </div>
              )}
              {options.length === 0 && !showShipIt ? (
                <div className="px-2 py-1.5 text-sm text-muted-foreground">Working tree clean. Nothing to commit, merge, or push.</div>
              ) : (
                options.map((option) => {
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
                })
              )}
              <div
                role="menuitem"
                className="thinking-option-row"
                title="Fetch from remote (refresh remote branches)"
                aria-label="Fetch from remote"
                aria-disabled={busy}
                tabIndex={busy ? -1 : 0}
                onClick={() => { if (!busy) handleFetch(); }}
                onKeyDown={(e) => {
                  if ((e.key === "Enter" || e.key === " ") && !busy) {
                    e.preventDefault();
                    handleFetch();
                  }
                }}
              >
                {busyOp === "fetch" ? <Spinner className="size-3" /> : <Download size={14} aria-hidden="true" />}
                <span className="thinking-option-name">Fetch</span>
                <span className="ml-auto text-xs text-muted-foreground">Refresh remote</span>
              </div>
              <div className="flex items-center justify-between gap-2 px-2 py-1.5">
                <span className="popover-header-title min-w-0 flex-1 truncate">{ghSectionTitle}</span>
                <Button
                  variant="ghost"
                  size="icon-xs"
                  onClick={() => { if (!ghLoading) void loadGh(true); }}
                  disabled={ghLoading}
                  title="Refresh GitHub status"
                  aria-label="Refresh GitHub status"
                >
                  <RefreshCw size={14} aria-hidden="true" className={ghLoading ? "animate-spin" : undefined} />
                </Button>
              </div>
              {ghMenu.kind === "loading" ? (
                <div className="flex items-center gap-2 px-2 py-1.5 text-sm text-muted-foreground">
                  <Spinner className="size-3" />
                  Checking GitHub...
                </div>
              ) : ghMenu.kind === "unavailable" ? (
                <div
                  role="menuitem"
                  className="thinking-option-row opacity-60"
                  title="Could not reach GitHub. Open the menu again to retry."
                  aria-label="Create pull request (GitHub unavailable)"
                  aria-disabled="true"
                  tabIndex={-1}
                >
                  <GitPullRequest size={14} aria-hidden="true" />
                  <span className="thinking-option-name">Create PR...</span>
                  <span className="ml-auto text-xs text-muted-foreground">Unavailable</span>
                </div>
              ) : ghMenu.kind === "not-installed" ? (
                <div
                  role="menuitem"
                  className="thinking-option-row opacity-60"
                  title="Install and authenticate the gh CLI to create pull requests."
                  aria-label="Create pull request (gh not installed)"
                  aria-disabled="true"
                  tabIndex={-1}
                >
                  <GitPullRequest size={14} aria-hidden="true" />
                  <span className="thinking-option-name">Create PR...</span>
                  <span className="ml-auto text-xs text-muted-foreground">gh not installed</span>
                </div>
              ) : ghMenu.kind === "not-authenticated" ? (
                <div
                  role="menuitem"
                  className="thinking-option-row opacity-60"
                  title="Run `gh auth login` (or `gh auth status`) so Passage can create pull requests."
                  aria-label="Create pull request (gh not authenticated)"
                  aria-disabled="true"
                  tabIndex={-1}
                >
                  <GitPullRequest size={14} aria-hidden="true" />
                  <span className="thinking-option-name">Create PR...</span>
                  <span className="ml-auto text-xs text-muted-foreground">gh not authenticated</span>
                </div>
              ) : ghMenu.kind === "view" ? (
                <div
                  role="menuitem"
                  className="thinking-option-row"
                  title={`View PR #${ghMenu.pr.number}: ${ghMenu.pr.title || ghMenu.pr.url}`}
                  aria-label={`View pull request #${ghMenu.pr.number}`}
                  aria-disabled={busy}
                  tabIndex={busy ? -1 : 0}
                  onClick={() => { if (!busy) window.open(ghMenu.pr.url, "_blank", "noopener"); }}
                  onKeyDown={(e) => {
                    if ((e.key === "Enter" || e.key === " ") && !busy) {
                      e.preventDefault();
                      window.open(ghMenu.pr.url, "_blank", "noopener");
                    }
                  }}
                >
                  <ExternalLink size={14} aria-hidden="true" />
                  <span className="thinking-option-name">View PR</span>
                  <span className="ml-auto text-xs text-muted-foreground">{ghPrDetail}</span>
                </div>
              ) : (
                <div
                  role="menuitem"
                  className="thinking-option-row"
                  title={`Create a pull request for ${branchRef} (generates title and description)`}
                  aria-label="Create pull request"
                  aria-disabled={busy}
                  tabIndex={busy ? -1 : 0}
                  onClick={() => { if (!busy) openPrDialog(); }}
                  onKeyDown={(e) => {
                    if ((e.key === "Enter" || e.key === " ") && !busy) {
                      e.preventDefault();
                      openPrDialog();
                    }
                  }}
                >
                  <GitPullRequest size={14} aria-hidden="true" />
                  <span className="thinking-option-name">Create PR...</span>
                  <span className="ml-auto shrink-0 whitespace-nowrap text-xs text-muted-foreground">Generate description</span>
                </div>
              )}
            </div>
          )}
        </PopoverContent>
      </Popover>
      <AlertDialog open={shipItOpen} onOpenChange={setShipItOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Ship It</AlertDialogTitle>
            <AlertDialogDescription>
              Auto-commit {dirtyCount} changed file{dirtyCount === 1 ? "" : "s"} on{" "}
              <code className="font-mono">{branchRef}</code>, then choose where it goes.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <div className="flex flex-col gap-2">
            <Button
              variant="default"
              size="default"
              className="min-h-11 w-full"
              onClick={handleShipItToPr}
              disabled={busy || !ghReady}
              title={
                ghReady
                  ? "Commit, rebase onto the remote, push, and open a pull request"
                  : "PR creation needs gh installed and authenticated (see the GitHub section)"
              }
            >
              {shipItBusy ? <Spinner className="size-3" /> : null}
              Open PR
            </Button>
            <Button
              variant="secondary"
              size="default"
              className="min-h-11 w-full"
              onClick={handleShipItMergeLocally}
              disabled={busy || !shipItEnabled}
              title={shipItTitle}
            >
              {shipItBusy ? <Spinner className="size-3" /> : null}
              {isComposerShipItMergeable(status) ? "Merge locally" : "Commit"}
            </Button>
            {!ghReady && (
              <p className="text-xs text-muted-foreground">Opening a pull request needs the gh CLI installed and authenticated.</p>
            )}
          </div>
          <AlertDialogFooter className="sm:flex-col sm:justify-stretch">
            <AlertDialogCancel className="min-h-11 w-full">Cancel</AlertDialogCancel>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
      <AlertDialog open={rebaseOpen} onOpenChange={setRebaseOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Rebase {branchRef}</AlertDialogTitle>
            <AlertDialogDescription>
              Replay <code className="font-mono">{branchRef}</code> onto a fresh base. A conflicted rebase is
              aborted, leaving the branch as it was.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <div className="flex flex-col gap-2">
            <Button
              variant="secondary"
              size="default"
              className="min-h-11 w-full"
              onClick={handleRebaseLocal}
              disabled={busy}
              title={`Rebase ${branchRef} onto local main`}
            >
              {busyOp === "rebase" ? <Spinner className="size-3" /> : null}
              Local main
            </Button>
            <Button
              variant="secondary"
              size="default"
              className="min-h-11 w-full"
              onClick={handleRebaseRemote}
              disabled={busy}
              title={`Fetch origin, then rebase ${branchRef} onto ${remoteBaseLabel}`}
            >
              {busyOp === "rebase-remote" ? <Spinner className="size-3" /> : null}
              {remoteBaseLabel}
            </Button>
          </div>
          <AlertDialogFooter className="sm:flex-col sm:justify-stretch">
            <AlertDialogCancel className="min-h-11 w-full">Cancel</AlertDialogCancel>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
      <AlertDialog open={prOpen} onOpenChange={setPrOpen}>
        <AlertDialogContent className="max-h-[85vh] overflow-y-auto">
          <AlertDialogHeader>
            <AlertDialogTitle>Create pull request</AlertDialogTitle>
            <AlertDialogDescription>
              From <code className="font-mono">{branchRef}</code>
              {ghStatus?.repo ? <> in <code className="font-mono">{ghStatus.repo.nameWithOwner}</code></> : null}.
              The branch is pushed first when needed.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <div className="flex flex-col gap-3">
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="pr-base">Base branch</Label>
              <Input
                id="pr-base"
                value={prBase}
                onChange={(e) => setPrBase(e.target.value)}
                placeholder={ghStatus?.repo?.defaultBranch ?? "main"}
                disabled={busy || prSuggestLoading}
              />
            </div>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="pr-title">Title</Label>
              <Input
                id="pr-title"
                value={prTitle}
                onChange={(e) => setPrTitle(e.target.value)}
                placeholder="Short imperative summary"
                disabled={busy || prSuggestLoading}
              />
            </div>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="pr-body">Description</Label>
              <Textarea
                id="pr-body"
                value={prBody}
                onChange={(e) => setPrBody(e.target.value)}
                rows={10}
                placeholder="Summary, changes, testing…"
                disabled={busy || prSuggestLoading}
              />
            </div>
            {prGeneratedNote && (
              <p className="text-xs text-muted-foreground">{prGeneratedNote}</p>
            )}
            {prError && <Alert variant="destructive"><AlertDescription>{prError}</AlertDescription></Alert>}
            <div className="flex flex-wrap gap-2">
              <Button
                variant="secondary"
                size="xs"
                onClick={() => handlePrSuggest()}
                disabled={busy || prSuggestLoading}
                title="Regenerate the title and description from the branch diff"
              >
                {prSuggestLoading ? <Spinner className="size-3" /> : null}
                Regenerate
              </Button>
              <span className="flex-1" />
              <Button
                variant="secondary"
                size="xs"
                onClick={() => handlePrCreate(true)}
                disabled={busy || prSuggestLoading || !prTitle.trim()}
                title="Create as a draft pull request"
              >
                {busyOp === "pr-create" && prDraft ? <Spinner className="size-3" /> : null}
                Create draft
              </Button>
              <Button
                size="xs"
                onClick={() => handlePrCreate(false)}
                disabled={busy || prSuggestLoading || !prTitle.trim()}
                title="Create the pull request"
              >
                {busyOp === "pr-create" && !prDraft ? <Spinner className="size-3" /> : null}
                Create PR
              </Button>
            </div>
          </div>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={busy}>Cancel</AlertDialogCancel>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
      <AlertDialog open={confirmMergeOpen} onOpenChange={setConfirmMergeOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Merge locally?</AlertDialogTitle>
            <AlertDialogDescription>
              Merge <code className="font-mono">{branchRef}</code> ({ahead} commit{ahead === 1 ? "" : "s"} ahead)
              into <code className="font-mono">main</code>? The branch is rebased onto main, then main
              fast-forwards to it.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={handleConfirmMerge}>Merge locally</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
      <CommitSuccessDialog
        title={commitDialog?.title ?? "Committed changes"}
        message={commitDialog?.message ?? ""}
        open={commitDialog !== null}
        onOpenChange={(open) => { if (!open) setCommitDialog(null); }}
      />
      <AlertDialog open={deletePrompt !== null} onOpenChange={(open) => { if (!open) dismissDeletePrompt(); }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{deletePrompt?.merged === false ? "Changes sent" : "Merged into main"}</AlertDialogTitle>
            <AlertDialogDescription>
              {deletePrompt?.merged === false ? (
                <>
                  <code className="font-mono">{deletePrompt?.branch}</code> was committed. Delete this workspace?
                  The worktree directory is removed{canDeletePromptBranch && deleteBranch ? " and the branch is deleted" : ""}.
                </>
              ) : (
                <>
                  <code className="font-mono">{deletePrompt?.branch}</code> was merged into main. Delete this workspace?
                  The worktree directory is removed{canDeletePromptBranch && deleteBranch ? " and the branch is deleted" : ""}.
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
          {canDeletePromptBranch && (
            <label className="flex items-start gap-2 cursor-pointer text-sm min-w-0">
              <Checkbox
                checked={deleteBranch}
                onCheckedChange={(v) => setDeleteBranch(v === true)}
                aria-label="Delete local branch"
                className="mt-0.5"
              />
              <span className="min-w-0 flex-1 [overflow-wrap:anywhere]">
                Delete local branch <code className="font-mono">{deletePrompt?.branch}</code>
              </span>
            </label>
          )}
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
