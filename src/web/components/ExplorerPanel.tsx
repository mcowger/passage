import { useCallback, useEffect, useState } from "react";
import type { FileEntry, FileListing } from "../../shared/domain/files.ts";
import type { WorkspaceApi } from "../api.ts";
import { Button } from "./ui/button.tsx";
import { Input } from "./ui/input.tsx";

type ExplorerProps = {
  workspaceId: string;
  api: WorkspaceApi;
  onOpenFile: (path: string) => void;
  selectedFile?: string;
};

type DirectoryState = {
  entries: FileEntry[];
  nextCursor: string | null;
  loading: boolean;
};

export function ExplorerPanel({ workspaceId, api, onOpenFile, selectedFile }: ExplorerProps) {
  const [expanded, setExpanded] = useState<Set<string>>(new Set(["."]));
  const [dirMap, setDirMap] = useState<Map<string, DirectoryState>>(new Map());
  const [filter, setFilter] = useState("");
  const [error, setError] = useState("");

  const loadDirectory = useCallback(async (dirPath: string, cursor?: string) => {
    setDirMap((prev) => {
      const next = new Map(prev);
      const current = next.get(dirPath) ?? { entries: [], nextCursor: null, loading: false };
      next.set(dirPath, { ...current, loading: true });
      return next;
    });

    try {
      const result: FileListing = await api.listFiles(workspaceId, dirPath, cursor);
      setDirMap((prev) => {
        const next = new Map(prev);
        const current = prev.get(dirPath);
        const entries = cursor && current ? [...current.entries, ...result.entries] : result.entries;
        next.set(dirPath, {
          entries,
          nextCursor: result.nextCursor,
          loading: false,
        });
        return next;
      });
      setError("");
    } catch (err) {
      setDirMap((prev) => {
        const next = new Map(prev);
        const current = next.get(dirPath) ?? { entries: [], nextCursor: null, loading: false };
        next.set(dirPath, { ...current, loading: false });
        return next;
      });
      setError(err instanceof Error ? err.message : "Failed to load directory");
    }
  }, [workspaceId, api]);

  useEffect(() => {
    setDirMap(new Map());
    setExpanded(new Set(["."]));
    void loadDirectory(".");
  }, [workspaceId, loadDirectory]);

  const toggleExpand = (dirPath: string) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(dirPath)) {
        next.delete(dirPath);
      } else {
        next.add(dirPath);
        if (!dirMap.has(dirPath)) {
          void loadDirectory(dirPath);
        }
      }
      return next;
    });
  };

  const handleRefresh = () => {
    const toReload = Array.from(expanded);
    for (const dir of toReload) {
      void loadDirectory(dir);
    }
  };

  const renderTree = (dirPath: string, level = 0) => {
    const dirState = dirMap.get(dirPath);
    if (!dirState && expanded.has(dirPath)) {
      return null;
    }
    if (!dirState) return null;

    let entries = dirState.entries;
    if (filter) {
      const query = filter.toLowerCase();
      entries = entries.filter((e) => e.name.toLowerCase().includes(query));
    }

    return (
      <div className="explorer-subtree" style={{ paddingLeft: level > 0 ? 14 : 0 }}>
        {entries.map((entry) => {
          const isDir = entry.kind === "directory";
          const isExpanded = expanded.has(entry.path);
          const isSelected = selectedFile === entry.path;

          if (isDir) {
            return (
              <div key={entry.path} className="explorer-node">
                <button
                  className={`explorer-item dir ${isExpanded ? "open" : ""}`}
                  onClick={() => toggleExpand(entry.path)}
                  aria-expanded={isExpanded}
                >
                  <span className="tree-toggle" aria-hidden="true">{isExpanded ? "▾" : "▸"}</span>
                  <span className="node-icon" aria-hidden="true">{isExpanded ? "📂" : "📁"}</span>
                  <span className="node-name">{entry.name}</span>
                </button>
                {isExpanded && renderTree(entry.path, level + 1)}
              </div>
            );
          }

          return (
            <button
              key={entry.path}
              className={`explorer-item file ${isSelected ? "selected" : ""}`}
              onClick={() => onOpenFile(entry.path)}
              aria-label={`Open file ${entry.name}`}
            >
              <span className="tree-indent" aria-hidden="true"> </span>
              <span className="node-icon" aria-hidden="true">📄</span>
              <span className="node-name">{entry.name}</span>
              {entry.revision && (
                <span className="node-size muted">{formatBytes(entry.revision.size)}</span>
              )}
            </button>
          );
        })}

        {dirState.nextCursor && (
          <Button
            variant="secondary"
            size="sm"
            className="w-full mt-2"
            onClick={() => void loadDirectory(dirPath, dirState.nextCursor ?? undefined)}
            disabled={dirState.loading}
          >
            {dirState.loading ? "Loading..." : "Load more entries..."}
          </Button>
        )}
      </div>
    );
  };

  return (
    <div className="explorer-panel" aria-label="File Explorer">
      <div className="panel-header">
        <div className="panel-title">
          <span className="panel-icon" aria-hidden="true">📁</span>
          <h2>Files</h2>
        </div>
        <div className="panel-actions">
          <Button
            variant="ghost"
            size="icon-xs"
            onClick={handleRefresh}
            title="Refresh file tree"
            aria-label="Refresh"
          >
            ↻
          </Button>
        </div>
      </div>

      <div className="explorer-filter relative">
        <Input
          type="text"
          placeholder="Filter files..."
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          aria-label="Filter files"
        />
        {filter && (
          <Button
            variant="ghost"
            size="icon-xs"
            className="absolute right-1 top-1/2 -translate-y-1/2 h-6 w-6"
            onClick={() => setFilter("")}
            aria-label="Clear filter"
          >
            ×
          </Button>
        )}
      </div>

      {error && <div className="alert panel-alert">{error}</div>}

      <div className="explorer-tree">
        {renderTree(".")}
        {dirMap.get(".")?.loading && dirMap.get(".")?.entries.length === 0 && (
          <div className="muted empty-inline">Loading workspace files...</div>
        )}
      </div>
    </div>
  );
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
