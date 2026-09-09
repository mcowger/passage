import { useCallback, useEffect, useState } from "react";
import type { GitChangeKind, GitFileStatus, GitStatus } from "../../shared/domain/git.ts";
import type { WorkspaceApi } from "../api.ts";
import { FileTypeIcon } from "./FileTypeIcon.tsx";
import { Button } from "./ui/button.tsx";
import { Badge } from "./ui/badge.tsx";

type ChangesProps = {
  workspaceId: string;
  api: WorkspaceApi;
  onOpenFile: (path: string) => void;
  onOpenDiff: (path: string, staged?: boolean) => void;
};

export function ChangesPanel({ workspaceId, api, onOpenFile, onOpenDiff }: ChangesProps) {
  const [status, setStatus] = useState<GitStatus | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [viewScope, setViewScope] = useState<"all" | "staged" | "unstaged">("all");

  const refreshStatus = useCallback(async () => {
    setLoading(true);
    try {
      const s = await api.gitStatus(workspaceId);
      setStatus(s);
      setError("");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load Git status");
    } finally {
      setLoading(false);
    }
  }, [workspaceId, api]);

  useEffect(() => {
    void refreshStatus();
  }, [refreshStatus]);

  const files = status?.files ?? [];
  const stagedFiles = files.filter((f) => f.staged);
  const unstagedFiles = files.filter((f) => f.workingTree || f.kind === "untracked");

  const displayedFiles = viewScope === "staged"
    ? stagedFiles
    : viewScope === "unstaged"
    ? unstagedFiles
    : files;

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
            onClick={() => onOpenDiff("")}
            title="Open unified workspace diff"
          >
            Review All Diffs ↗
          </Button>
          <Button
            variant="ghost"
            size="icon-xs"
            onClick={refreshStatus}
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

      <div className="changes-tabs">
        <button
          className={`tab-btn ${viewScope === "all" ? "active" : ""}`}
          onClick={() => setViewScope("all")}
        >
          All ({files.length})
        </button>
        <button
          className={`tab-btn ${viewScope === "unstaged" ? "active" : ""}`}
          onClick={() => setViewScope("unstaged")}
        >
          Working Tree ({unstagedFiles.length})
        </button>
        <button
          className={`tab-btn ${viewScope === "staged" ? "active" : ""}`}
          onClick={() => setViewScope("staged")}
        >
          Staged ({stagedFiles.length})
        </button>
      </div>

      {error && <div className="alert panel-alert">{error}</div>}

      <div className="changes-list">
        {loading && !status && <div className="muted empty-inline">Checking status...</div>}

        {!loading && files.length === 0 && (
          <div className="empty-inline muted">
            <span style={{ fontSize: 24, display: "block", marginBottom: 6 }}>✓</span>
            Working tree is clean. No uncommitted changes.
          </div>
        )}

        {displayedFiles.map((file) => (
          <ChangeRow
            key={`${file.path}-${file.staged ? "staged" : "wt"}`}
            file={file}
            onOpenFile={onOpenFile}
            onOpenDiff={onOpenDiff}
          />
        ))}
      </div>
    </div>
  );
}

function ChangeRow({
  file,
  onOpenFile,
  onOpenDiff,
}: {
  file: GitFileStatus;
  onOpenFile: (path: string) => void;
  onOpenDiff: (path: string, staged?: boolean) => void;
}) {
  const badge = changeBadge(file.kind);

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
