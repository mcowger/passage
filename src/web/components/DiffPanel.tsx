import { useCallback, useEffect, useState } from "react";
import type { DiffHunk, GitDiff } from "../../shared/domain/git.ts";
import type { WorkspaceApi } from "../api.ts";
import { FileTypeIcon } from "./FileTypeIcon.tsx";
import { Alert, AlertDescription } from "./ui/alert.tsx";
import { Spinner } from "./ui/spinner.tsx";
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from "./ui/empty.tsx";

type DiffProps = {
  workspaceId: string;
  initialPath?: string;
  api: WorkspaceApi;
  onOpenFile: (path: string) => void;
  onClose?: () => void;
};

export function DiffPanel({ workspaceId, initialPath, api, onOpenFile, onClose }: DiffProps) {
  const [target, setTarget] = useState<"working-tree" | "staged">("working-tree");
  const [viewMode, setViewMode] = useState<"unified" | "split">("unified");
  const [diffs, setDiffs] = useState<GitDiff[]>([]);
  const [selectedFile, setSelectedFile] = useState<string>(initialPath ?? "");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  const loadDiffs = useCallback(async () => {
    setLoading(true);
    try {
      const data = await api.gitDiff(workspaceId, target);
      setDiffs(data);
      setError("");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load diffs");
    } finally {
      setLoading(false);
    }
  }, [workspaceId, target, api]);

  useEffect(() => {
    void loadDiffs();
  }, [loadDiffs]);

  useEffect(() => {
    if (initialPath) setSelectedFile(initialPath);
  }, [initialPath]);

  const displayedDiffs = selectedFile
    ? diffs.filter((d) => d.path === selectedFile || d.oldPath === selectedFile)
    : diffs;

  const totalAdditions = diffs.reduce((acc, d) => acc + d.additions, 0);
  const totalDeletions = diffs.reduce((acc, d) => acc + d.deletions, 0);

  return (
    <div className="diff-panel" aria-label="Git Diff Viewer">
      <div className="panel-header">
        <div className="panel-title">
          <span className="panel-icon" aria-hidden="true">🔍</span>
          <h2>Diffs</h2>
          <span className="diff-stat-badge">
            <span className="add-count">+{totalAdditions}</span>
            <span className="del-count">-{totalDeletions}</span>
          </span>
        </div>

        <div className="panel-actions">
          <div className="diff-mode-toggles">
            <div className="button-group">
              <button
                className={`secondary small ${target === "working-tree" ? "selected" : ""}`}
                onClick={() => setTarget("working-tree")}
              >
                Working Tree
              </button>
              <button
                className={`secondary small ${target === "staged" ? "selected" : ""}`}
                onClick={() => setTarget("staged")}
              >
                Staged
              </button>
            </div>

            <div className="button-group">
              <button
                className={`secondary small ${viewMode === "unified" ? "selected" : ""}`}
                onClick={() => setViewMode("unified")}
                title="Inline unified diff"
              >
                Unified
              </button>
              <button
                className={`secondary small ${viewMode === "split" ? "selected" : ""}`}
                onClick={() => setViewMode("split")}
                title="Side-by-side split diff"
              >
                Side-by-Side
              </button>
            </div>
          </div>

          <button className="icon-button" onClick={loadDiffs} title="Refresh diff" aria-label="Refresh">
            ↻
          </button>
          {onClose && (
            <button className="icon-button" onClick={onClose} title="Close diff panel" aria-label="Close">
              ×
            </button>
          )}
        </div>
      </div>

      {diffs.length > 0 && (
        <div className="diff-file-selector">
          <button
            className={`file-chip ${selectedFile === "" ? "active" : ""}`}
            onClick={() => setSelectedFile("")}
          >
            All Files ({diffs.length})
          </button>
          {diffs.map((d) => (
            <button
              key={d.path}
              className={`file-chip ${selectedFile === d.path ? "active" : ""}`}
              onClick={() => setSelectedFile(d.path)}
            >
              <span className="chip-name">{d.path}</span>
              <span className="chip-counts">
                <span className="add-count">+{d.additions}</span>
                <span className="del-count">-{d.deletions}</span>
              </span>
            </button>
          ))}
        </div>
      )}

      {error && <Alert variant="destructive" className="panel-alert"><AlertDescription>{error}</AlertDescription></Alert>}

      <div className="diff-content-list">
        {loading && diffs.length === 0 && (
          <div className="muted empty-inline flex items-center gap-2">
            <Spinner className="size-3.5" />
            Computing diff...
          </div>
        )}

        {!loading && displayedDiffs.length === 0 && (
          <Empty className="border-none p-6">
            <EmptyHeader>
              <EmptyTitle>No changes found</EmptyTitle>
              <EmptyDescription>
                No changes found in {target === "staged" ? "staged index" : "working tree"}.
              </EmptyDescription>
            </EmptyHeader>
          </Empty>
        )}

        {displayedDiffs.map((diffItem) => (
          <DiffFileItem
            key={diffItem.path || diffItem.oldPath || "unknown"}
            diff={diffItem}
            viewMode={viewMode}
            onOpenFile={onOpenFile}
          />
        ))}
        {diffs.length > 0 && (
          <div className="diff-total-footer" aria-label={`${diffs.length} changed files, ${totalAdditions} additions, ${totalDeletions} deletions`}>
            <span>{diffs.length} changed file{diffs.length === 1 ? "" : "s"}</span>
            <span className="add-count">+{totalAdditions}</span>
            <span className="del-count">-{totalDeletions}</span>
          </div>
        )}
      </div>
    </div>
  );
}

function DiffFileItem({
  diff,
  viewMode,
  onOpenFile,
}: {
  diff: GitDiff;
  viewMode: "unified" | "split";
  onOpenFile: (path: string) => void;
}) {
  return (
    <article className="diff-file-card">
      <header className="diff-file-header">
        <div className="diff-file-name">
          <FileTypeIcon path={diff.path} size={15} />
          <strong>{diff.oldPath && diff.oldPath !== diff.path ? `${diff.oldPath} → ${diff.path}` : diff.path}</strong>
          <span className="diff-stat-counts">
            <span className="add-count">+{diff.additions}</span>
            <span className="del-count">-{diff.deletions}</span>
          </span>
        </div>
        <button
          className="secondary small"
          onClick={() => onOpenFile(diff.path)}
          title="Open in editor"
        >
          Open in Editor ↗
        </button>
      </header>

      {diff.binary && (
        <div className="diff-notice muted">
          Binary file changed. Visual diff not available.
        </div>
      )}

      {diff.oversized && (
        <div className="diff-notice muted">
          Diff exceeds maximum size limit and was truncated.
        </div>
      )}

      {!diff.binary && !diff.oversized && diff.hunks.length === 0 && (
        <div className="diff-notice muted">No text differences found.</div>
      )}

      {!diff.binary && !diff.oversized && diff.hunks.map((hunk, idx) => (
        <DiffHunkBlock key={idx} hunk={hunk} viewMode={viewMode} />
      ))}
    </article>
  );
}

function DiffHunkBlock({ hunk, viewMode }: { hunk: DiffHunk; viewMode: "unified" | "split" }) {
  if (viewMode === "split") {
    return <SplitHunkView hunk={hunk} />;
  }

  let oldLine = hunk.oldStart;
  let newLine = hunk.newStart;

  return (
    <div className="diff-hunk-unified">
      <div className="diff-hunk-header">
        <code>{`@@ -${hunk.oldStart},${hunk.oldLines} +${hunk.newStart},${hunk.newLines} @@ ${hunk.header ?? ""}`}</code>
      </div>
      <table className="diff-table unified">
        <tbody>
          {hunk.lines.map((line, idx) => {
            const isAdd = line.kind === "added";
            const isDel = line.kind === "removed";
            const curOld = isAdd ? "" : String(oldLine++);
            const curNew = isDel ? "" : String(newLine++);

            return (
              <tr key={idx} className={`diff-line ${line.kind}`}>
                <td className="line-num old-num">{curOld}</td>
                <td className="line-num new-num">{curNew}</td>
                <td className="line-marker">{isAdd ? "+" : isDel ? "-" : " "}</td>
                <td className="line-text">
                  <pre>{line.text}</pre>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function SplitHunkView({ hunk }: { hunk: DiffHunk }) {
  // Pair old lines and new lines side-by-side
  type SplitRow = {
    leftNum?: number;
    leftText?: string;
    leftKind?: "removed" | "context";
    rightNum?: number;
    rightText?: string;
    rightKind?: "added" | "context";
  };

  const rows: SplitRow[] = [];
  let oldLine = hunk.oldStart;
  let newLine = hunk.newStart;

  let i = 0;
  while (i < hunk.lines.length) {
    const cur = hunk.lines[i];
    if (cur.kind === "context") {
      rows.push({
        leftNum: oldLine++,
        leftText: cur.text,
        leftKind: "context",
        rightNum: newLine++,
        rightText: cur.text,
        rightKind: "context",
      });
      i++;
    } else if (cur.kind === "removed") {
      // Check if followed by added
      const removedLines: Array<{ num: number; text: string }> = [];
      while (i < hunk.lines.length && hunk.lines[i].kind === "removed") {
        removedLines.push({ num: oldLine++, text: hunk.lines[i].text });
        i++;
      }
      const addedLines: Array<{ num: number; text: string }> = [];
      while (i < hunk.lines.length && hunk.lines[i].kind === "added") {
        addedLines.push({ num: newLine++, text: hunk.lines[i].text });
        i++;
      }

      const maxLen = Math.max(removedLines.length, addedLines.length);
      for (let r = 0; r < maxLen; r++) {
        rows.push({
          leftNum: removedLines[r]?.num,
          leftText: removedLines[r]?.text,
          leftKind: removedLines[r] ? "removed" : undefined,
          rightNum: addedLines[r]?.num,
          rightText: addedLines[r]?.text,
          rightKind: addedLines[r] ? "added" : undefined,
        });
      }
    } else if (cur.kind === "added") {
      rows.push({
        rightNum: newLine++,
        rightText: cur.text,
        rightKind: "added",
      });
      i++;
    }
  }

  return (
    <div className="diff-hunk-split">
      <div className="diff-hunk-header">
        <code>{`@@ -${hunk.oldStart},${hunk.oldLines} +${hunk.newStart},${hunk.newLines} @@ ${hunk.header ?? ""}`}</code>
      </div>
      <table className="diff-table split">
        <tbody>
          {rows.map((row, idx) => (
            <tr key={idx} className="diff-split-row">
              <td className={`line-num old-num ${row.leftKind ?? ""}`}>{row.leftNum ?? ""}</td>
              <td className={`line-text split-side left ${row.leftKind ?? ""}`}>
                {row.leftText !== undefined && <pre>{row.leftText}</pre>}
              </td>
              <td className={`line-num new-num ${row.rightKind ?? ""}`}>{row.rightNum ?? ""}</td>
              <td className={`line-text split-side right ${row.rightKind ?? ""}`}>
                {row.rightText !== undefined && <pre>{row.rightText}</pre>}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
