import { useCallback, useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import type { GitChangeKind, GitFileStatus, GitStatus } from "../../shared/domain/git.ts";
import { friendlyApiError, type WorkspaceApi } from "../api.ts";
import { subscribeWorkspace } from "../workspaceSocket.ts";
import { FileTypeIcon } from "./FileTypeIcon.tsx";
import { Button } from "./ui/button.tsx";
import { Badge } from "./ui/badge.tsx";
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
import { Textarea } from "./ui/textarea.tsx";
import { Label } from "./ui/label.tsx";
import { Kbd } from "./ui/kbd.tsx";
import { Spinner } from "./ui/spinner.tsx";
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "./ui/empty.tsx";

type ChangesProps = {
  workspaceId: string;
  api: WorkspaceApi;
  onOpenFile: (path: string) => void;
  onOpenDiff: (path: string, staged?: boolean) => void;
};

type BulkOp = "stage-all" | "unstage-all" | "commit" | "pull" | "fetch" | "merge";

const draftKey = (workspaceId: string) => `passage:commit-draft:${workspaceId}`;
const loadDraft = (workspaceId: string): string => {
  try {
    return window.localStorage.getItem(draftKey(workspaceId)) ?? "";
  } catch {
    return "";
  }
};

export function ChangesPanel({ workspaceId, api, onOpenFile, onOpenDiff }: ChangesProps) {
  const [status, setStatus] = useState<GitStatus | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [viewScope, setViewScope] = useState<"all" | "staged" | "unstaged">("all");
  const [pendingPaths, setPendingPaths] = useState<ReadonlySet<string>>(new Set());
  const [bulkOp, setBulkOp] = useState<BulkOp | null>(null);
  const [discardTarget, setDiscardTarget] = useState<GitFileStatus | null>(null);
  const [commitMessage, setCommitMessage] = useState(() => loadDraft(workspaceId));

  const refreshStatus = useCallback(async (quiet = false) => {
    if (!quiet) setLoading(true);
    try {
      const s = await api.gitStatus(workspaceId);
      setStatus(s);
      setError("");
    } catch (err) {
      if (!quiet) setError(err instanceof Error ? err.message : "Failed to load Git status");
    } finally {
      if (!quiet) setLoading(false);
    }
  }, [workspaceId, api]);

  useEffect(() => {
    setCommitMessage(loadDraft(workspaceId));
    void refreshStatus();
  }, [workspaceId, refreshStatus]);

  // Live invalidation from other clients: the mutating caller already
  // reloaded inline, so WS echoes (own or remote) are debounced into a
  // quiet refresh. Reconnects, missed sequences, and mobile suspension
  // reconcile immediately.
  const refreshRef = useRef(refreshStatus);
  refreshRef.current = refreshStatus;
  useEffect(() => {
    let invalidateTimer: ReturnType<typeof setTimeout> | undefined;
    const subscription = subscribeWorkspace(
      workspaceId,
      (event) => {
        if (event.type !== "git-status-changed" && event.type !== "files-changed") return;
        if (invalidateTimer) clearTimeout(invalidateTimer);
        invalidateTimer = setTimeout(() => {
          invalidateTimer = undefined;
          void refreshRef.current(true);
        }, 750);
      },
      async () => {
        await refreshRef.current(true);
      },
    );
    return () => {
      if (invalidateTimer) clearTimeout(invalidateTimer);
      subscription.close();
    };
  }, [workspaceId]);

  const files = status?.files ?? [];
  const stagedFiles = files.filter((f) => f.staged);
  const unstagedFiles = files.filter((f) => f.workingTree || f.kind === "untracked");

  const displayedFiles = viewScope === "staged"
    ? stagedFiles
    : viewScope === "unstaged"
    ? unstagedFiles
    : files;

  const anyBusy = bulkOp !== null || pendingPaths.size > 0;
  const isMainWorktree = status?.checkoutRoot === status?.mainCheckoutRoot || status?.branchRef === "main";

  const trackFileOp = (path: string, run: () => Promise<GitStatus>, done?: (s: GitStatus) => void) => {
    setPendingPaths((prev) => new Set(prev).add(path));
    void run().then(
      (s) => {
        setStatus(s);
        setError("");
        done?.(s);
      },
      (err: unknown) => setError(friendlyApiError(err, "Git operation failed. Try again.")),
    ).finally(() => {
      setPendingPaths((prev) => {
        const next = new Set(prev);
        next.delete(path);
        return next;
      });
    });
  };

  const trackBulkOp = (op: BulkOp, run: () => Promise<GitStatus>, done?: (s: GitStatus) => void) => {
    setBulkOp(op);
    void run().then(
      (s) => {
        setStatus(s);
        setError("");
        done?.(s);
      },
      (err: unknown) => setError(friendlyApiError(err, "Git operation failed. Try again.")),
    ).finally(() => setBulkOp(null));
  };

  const handleCommitMessageChange = (value: string) => {
    setCommitMessage(value);
    try {
      if (value === "") window.localStorage.removeItem(draftKey(workspaceId));
      else window.localStorage.setItem(draftKey(workspaceId), value);
    } catch {
      // Draft persistence is best-effort; the composer keeps working.
    }
  };

  const handleCommit = () => {
    const message = commitMessage.trim();
    if (message === "" || bulkOp !== null || stagedFiles.length === 0) return;
    trackBulkOp("commit", () => api.gitCommit(workspaceId, message).then((r) => r.status), () => {
      handleCommitMessageChange("");
      toast.success("Committed staged changes");
    });
  };

  const handlePull = () => {
    if (bulkOp !== null) return;
    if (files.length > 0) {
      setError("Commit or discard your changes before pulling.");
      return;
    }
    trackBulkOp("pull", () => api.gitPull(workspaceId), () => toast.success("Pulled latest changes"));
  };

  const handleFetch = () => {
    if (bulkOp !== null) return;
    trackBulkOp("fetch", () => api.gitFetch(workspaceId), () => toast.success("Fetched from remote"));
  };

  const handleMerge = () => {
    if (bulkOp !== null || isMainWorktree) return;
    setBulkOp("merge");
    void api.gitMergeIntoMain(workspaceId).then(
      (s) => {
        setStatus(s);
        setError("");
        toast.success(`Merged ${status?.branchRef ?? "branch"} into main`);
      },
      (err: unknown) => {
        const message = friendlyApiError(err, "Could not merge into main. Resolve any conflicts and try again.");
        setError(message);
        toast.error("Merge into main failed", { description: message });
      },
    ).finally(() => setBulkOp(null));
  };

  return (
    <div className="changes-panel" aria-label="Git Changes">
      <div className="panel-header">
        <div className="panel-title">
          <span className="panel-icon" aria-hidden="true">±</span>
          <h2>Git Changes</h2>
        </div>
        <div className="panel-actions flex items-center gap-1.5">
          <Button
            variant="secondary"
            size="xs"
            onClick={() => trackBulkOp("stage-all", () => api.gitStageAll(workspaceId), () => toast.success("Staged all changes"))}
            disabled={anyBusy || unstagedFiles.length === 0}
            title="Stage all working-tree changes"
          >
            {bulkOp === "stage-all" ? <Spinner className="size-3" /> : null}
            Stage All
          </Button>
          <Button
            variant="secondary"
            size="xs"
            onClick={() => trackBulkOp("unstage-all", () => api.gitUnstageAll(workspaceId), () => toast.success("Unstaged all changes"))}
            disabled={anyBusy || stagedFiles.length === 0}
            title="Unstage all staged changes"
          >
            {bulkOp === "unstage-all" ? <Spinner className="size-3" /> : null}
            Unstage All
          </Button>
          <Button
            variant="secondary"
            size="xs"
            onClick={() => onOpenDiff("")}
            title="Open unified workspace diff"
          >
            Review All Diffs ↗
          </Button>
          <Button
            variant="secondary"
            size="xs"
            onClick={handleMerge}
            disabled={bulkOp !== null || isMainWorktree}
            title={isMainWorktree ? "The main worktree or branch cannot be merged into itself" : "Merge this branch into main"}
          >
            {bulkOp === "merge" ? <Spinner className="size-3" /> : null}
            Merge
          </Button>
          <Button
            variant="ghost"
            size="icon-xs"
            onClick={() => void refreshStatus()}
            title="Refresh Git status"
            disabled={loading}
            aria-label="Refresh"
          >
            ↻
          </Button>
        </div>
      </div>

      {status && (
        <div className="git-summary-bar">
          <span className="branch-tag" title="Current Git branch">
            🌿 <b>{status.branchRef ?? "(detached)"}</b>
          </span>
          {(status.ahead > 0 || status.behind > 0) && (
            <span className="ahead-behind-tag" title="Commits ahead/behind upstream">
              {status.ahead > 0 && `↑ ${status.ahead} `}
              {status.behind > 0 && `↓ ${status.behind}`}
            </span>
          )}
          <span className="changes-count muted">
            {files.length === 0 ? "Clean" : `${files.length} changed file${files.length === 1 ? "" : "s"}`}
          </span>
          {status.conflicted && <span className="conflict-badge">⚠️ Conflicts</span>}
        </div>
      )}

      <div className="changes-tabs" role="tablist" aria-label="Change scope">
        <button
          role="tab"
          aria-selected={viewScope === "all"}
          className={`tab-btn ${viewScope === "all" ? "active" : ""}`}
          onClick={() => setViewScope("all")}
        >
          All ({files.length})
        </button>
        <button
          role="tab"
          aria-selected={viewScope === "unstaged"}
          className={`tab-btn ${viewScope === "unstaged" ? "active" : ""}`}
          onClick={() => setViewScope("unstaged")}
        >
          Working Tree ({unstagedFiles.length})
        </button>
        <button
          role="tab"
          aria-selected={viewScope === "staged"}
          className={`tab-btn ${viewScope === "staged" ? "active" : ""}`}
          onClick={() => setViewScope("staged")}
        >
          Staged ({stagedFiles.length})
        </button>
      </div>

      {error && <Alert variant="destructive" className="panel-alert"><AlertDescription>{error}</AlertDescription></Alert>}

      <div className="changes-list">
        {loading && !status && (
          <div className="muted empty-inline flex items-center gap-2">
            <Spinner className="size-3.5" />
            Checking status...
          </div>
        )}

        {!loading && files.length === 0 && (
          <Empty className="border-none p-6">
            <EmptyHeader>
              <EmptyMedia variant="icon">✓</EmptyMedia>
              <EmptyTitle>Working tree is clean</EmptyTitle>
              <EmptyDescription>No uncommitted changes.</EmptyDescription>
            </EmptyHeader>
          </Empty>
        )}

        {displayedFiles.map((file) => (
          <ChangeRow
            key={`${file.path}-${file.staged ? "staged" : "wt"}`}
            file={file}
            busy={anyBusy}
            pending={pendingPaths.has(file.path)}
            onOpenFile={onOpenFile}
            onOpenDiff={onOpenDiff}
            onStage={(path) => trackFileOp(path, () => api.gitStage(workspaceId, [path]))}
            onUnstage={(path) => trackFileOp(path, () => api.gitUnstage(workspaceId, [path]))}
            onDiscard={setDiscardTarget}
          />
        ))}
      </div>

      <div className="commit-composer">
        <Label htmlFor="commit-message" className="commit-label">
          Commit staged changes
        </Label>
        <Textarea
          id="commit-message"
          value={commitMessage}
          onChange={(e) => handleCommitMessageChange(e.target.value)}
          onKeyDown={(e) => {
            if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
              e.preventDefault();
              handleCommit();
            }
          }}
          placeholder={stagedFiles.length === 0 ? "Stage files above to commit…" : "Commit message…"}
          rows={2}
          disabled={bulkOp !== null}
          aria-label="Commit message"
        />
        <div className="composer-actions">
          <Button
            variant="default"
            size="xs"
            onClick={handleCommit}
            disabled={bulkOp !== null || stagedFiles.length === 0 || commitMessage.trim() === ""}
            title="Commit staged changes (Cmd+Enter)"
            className="commit-button"
          >
            {bulkOp === "commit" ? <Spinner className="size-3" /> : null}
            {stagedFiles.length === 0 ? "Commit" : `Commit staged (${stagedFiles.length})`}
          </Button>
          <Kbd title="Press Cmd+Enter (or Ctrl+Enter) to commit">⌘↵</Kbd>
          <Button
            variant="secondary"
            size="xs"
            onClick={handlePull}
            disabled={bulkOp !== null}
            title="Pull latest changes (fast-forward only)"
          >
            {bulkOp === "pull" ? <Spinner className="size-3" /> : null}
            Pull
          </Button>
          <Button
            variant="ghost"
            size="xs"
            onClick={handleFetch}
            disabled={bulkOp !== null}
            title="Fetch from remote without merging"
          >
            {bulkOp === "fetch" ? <Spinner className="size-3" /> : null}
            Fetch
          </Button>
        </div>
      </div>

      <AlertDialog open={discardTarget !== null} onOpenChange={(open) => { if (!open) setDiscardTarget(null); }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {discardTarget?.kind === "untracked" ? "Delete untracked file?" : "Discard changes?"}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {discardTarget?.kind === "untracked"
                ? <>This permanently deletes <code className="font-mono">{discardTarget?.path}</code>. This cannot be undone.</>
                : <>This restores <code className="font-mono">{discardTarget?.path}</code> to HEAD, discarding staged and working-tree changes. This cannot be undone.</>}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                const target = discardTarget;
                setDiscardTarget(null);
                if (target) {
                  trackFileOp(target.path, () => api.gitDiscard(workspaceId, target.path), () => {
                    toast.success(target.kind === "untracked" ? `Deleted ${target.path}` : `Discarded ${target.path}`);
                  });
                }
              }}
            >
              {discardTarget?.kind === "untracked" ? "Delete file" : "Discard changes"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

function ChangeRow({
  file,
  busy,
  pending,
  onOpenFile,
  onOpenDiff,
  onStage,
  onUnstage,
  onDiscard,
}: {
  file: GitFileStatus;
  busy: boolean;
  pending: boolean;
  onOpenFile: (path: string) => void;
  onOpenDiff: (path: string, staged?: boolean) => void;
  onStage: (path: string) => void;
  onUnstage: (path: string) => void;
  onDiscard: (file: GitFileStatus) => void;
}) {
  const badge = changeBadge(file.kind);
  const canStage = file.workingTree || file.kind === "untracked";
  const canDiscard = (file.workingTree || file.kind === "untracked") && file.kind !== "conflict";

  return (
    <div className={`change-row kind-${file.kind}`}>
      <Badge variant={badge.variant} className="font-mono text-xs px-1.5 py-0 rounded" title={badge.title}>
        {badge.label}
      </Badge>
      <div className="change-info">
        <span className="change-path" title={file.path}>
          <FileTypeIcon path={file.path} size={14} />
          {file.oldPath ? `${file.oldPath} → ${file.path}` : file.path}
        </span>
        <div className="change-meta">
          <small className="muted">{file.staged ? "Staged" : "Working tree"}</small>
          {file.binary && <small className="muted">· Binary</small>}
          {file.submodule && <small className="muted">· Submodule</small>}
        </div>
      </div>
      <div className="change-actions flex items-center gap-1">
        {pending ? (
          <Spinner className="size-3.5" aria-label="Git operation in progress" />
        ) : (
          <>
            {canStage && (
              <Button
                variant="secondary"
                size="xs"
                onClick={() => onStage(file.path)}
                disabled={busy}
                title={`Stage ${file.path}`}
                aria-label={`Stage ${file.path}`}
              >
                [+] Stage
              </Button>
            )}
            {file.staged && (
              <Button
                variant="secondary"
                size="xs"
                onClick={() => onUnstage(file.path)}
                disabled={busy}
                title={`Unstage ${file.path}`}
                aria-label={`Unstage ${file.path}`}
              >
                [-] Unstage
              </Button>
            )}
            {canDiscard && (
              <Button
                variant="ghost"
                size="xs"
                onClick={() => onDiscard(file)}
                disabled={busy}
                title={file.kind === "untracked" ? `Delete ${file.path}` : `Discard changes to ${file.path}`}
                aria-label={file.kind === "untracked" ? `Delete ${file.path}` : `Discard changes to ${file.path}`}
              >
                Discard
              </Button>
            )}
          </>
        )}
        <Button
          variant="secondary"
          size="xs"
          onClick={() => onOpenDiff(file.path, file.staged)}
          title="Inspect diff"
        >
          Diff ↗
        </Button>
        {file.kind !== "deleted" && (
          <Button
            variant="secondary"
            size="xs"
            onClick={() => onOpenFile(file.path)}
            title="Open file in editor"
          >
            Edit
          </Button>
        )}
      </div>
    </div>
  );
}

function changeBadge(kind: GitChangeKind): { label: string; variant: "default" | "secondary" | "destructive" | "outline"; title: string } {
  switch (kind) {
    case "modified":
      return { label: "M", variant: "secondary", title: "Modified" };
    case "added":
      return { label: "A", variant: "default", title: "Added" };
    case "deleted":
      return { label: "D", variant: "destructive", title: "Deleted" };
    case "renamed":
      return { label: "R", variant: "secondary", title: "Renamed" };
    case "conflict":
      return { label: "C", variant: "destructive", title: "Merge conflict" };
    case "untracked":
      return { label: "?", variant: "outline", title: "Untracked" };
    default:
      return { label: "•", variant: "outline", title: kind };
  }
}
