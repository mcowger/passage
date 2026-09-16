import { useCallback, useEffect, useRef, useState } from "react";
import fuzzysort from "fuzzysort";
import { toast } from "sonner";
import type { FileEntry, FileListing } from "../../shared/domain/files.ts";
import type { WorkspaceApi } from "../api.ts";
import { friendlyApiError } from "../api.ts";
import { subscribeWorkspace } from "../workspaceSocket.ts";
import { FileTypeIcon } from "./FileTypeIcon.tsx";
import { Button } from "./ui/button.tsx";
import { Input } from "./ui/input.tsx";
import { Label } from "./ui/label.tsx";
import { Alert, AlertDescription } from "./ui/alert.tsx";
import { Spinner } from "./ui/spinner.tsx";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuLabel,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from "./ui/context-menu.tsx";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "./ui/dropdown-menu.tsx";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "./ui/dialog.tsx";
import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "./ui/alert-dialog.tsx";

type ExplorerProps = {
  workspaceId: string;
  api: WorkspaceApi;
  onOpenFile: (path: string) => void;
  selectedFile?: string;
  workspaceCwd?: string;
  onRenamed?: (oldPath: string, newPath: string) => void;
  onDeleted?: (path: string) => void;
};

type DirectoryState = {
  entries: FileEntry[];
  nextCursor: string | null;
  loading: boolean;
};

type PendingCreate = { parentDir: string; kind: "file" | "directory" };
type PendingRename = { path: string; kind: "file" | "directory" };
type PendingDelete = { path: string; kind: "file" | "directory" };

// Maximum entries rendered per directory before the user explicitly reveals
// more. Server pages can hold up to MAX_DIRECTORY_ENTRIES (1000); rendering
// them all at once freezes the DOM and buries pagination controls.
const DIRECTORY_RENDER_CHUNK = 100;

function parentDirOf(path: string): string {
  const slash = path.lastIndexOf("/");
  return slash <= 0 ? "." : path.slice(0, slash);
}

function baseNameOf(path: string): string {
  const slash = path.lastIndexOf("/");
  return slash < 0 ? path : path.slice(slash + 1);
}

function joinPath(dir: string, name: string): string {
  return dir === "." ? name : `${dir}/${name}`;
}

function displayDir(dir: string): string {
  return dir === "." ? "workspace root" : dir;
}

function validateEntryName(name: string): string | null {
  const trimmed = name.trim();
  if (!trimmed) return "Enter a name.";
  if (trimmed === "." || trimmed === "..") return "That name is reserved.";
  if (trimmed.includes("/") || trimmed.includes("\\") || trimmed.includes("\0")) {
    return "Names cannot contain slashes.";
  }
  if (trimmed.length > 255) return "That name is too long.";
  return null;
}

async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    try {
      const area = document.createElement("textarea");
      area.value = text;
      area.style.position = "fixed";
      area.style.opacity = "0";
      document.body.appendChild(area);
      area.select();
      const ok = document.execCommand("copy");
      area.remove();
      return ok;
    } catch {
      return false;
    }
  }
}

export function ExplorerPanel({
  workspaceId,
  api,
  onOpenFile,
  selectedFile,
  workspaceCwd,
  onRenamed,
  onDeleted,
}: ExplorerProps) {
  const [expanded, setExpanded] = useState<Set<string>>(new Set(["."]));
  const [dirMap, setDirMap] = useState<Map<string, DirectoryState>>(new Map());
  const [visibleCounts, setVisibleCounts] = useState<Record<string, number>>({});
  const [filter, setFilter] = useState("");
  const [error, setError] = useState("");

  const [pendingCreate, setPendingCreate] = useState<PendingCreate | null>(null);
  const [createName, setCreateName] = useState("");
  const [createError, setCreateError] = useState("");
  const [createBusy, setCreateBusy] = useState(false);

  const [pendingRename, setPendingRename] = useState<PendingRename | null>(null);
  const [renameName, setRenameName] = useState("");
  const [renameError, setRenameError] = useState("");
  const [renameBusy, setRenameBusy] = useState(false);

  const [pendingDelete, setPendingDelete] = useState<PendingDelete | null>(null);
  const [deleteBusy, setDeleteBusy] = useState(false);

  const [busyPath, setBusyPath] = useState<string | null>(null);

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
    setVisibleCounts({});
    setExpanded(new Set(["."]));
    setPendingCreate(null);
    setPendingRename(null);
    setPendingDelete(null);
    void loadDirectory(".");
  }, [workspaceId, loadDirectory]);

  // Live invalidation from other clients: the mutating caller already
  // reloaded inline, so WS echoes (own or remote) are debounced into a
  // single refresh of the currently expanded directories. Reconnects,
  // missed sequences, and mobile suspension reconcile immediately.
  const loadDirectoryRef = useRef(loadDirectory);
  loadDirectoryRef.current = loadDirectory;
  const expandedRef = useRef(expanded);
  expandedRef.current = expanded;
  useEffect(() => {
    let invalidateTimer: ReturnType<typeof setTimeout> | undefined;
    const reloadExpanded = () => {
      for (const dir of Array.from(expandedRef.current)) {
        void loadDirectoryRef.current(dir);
      }
    };
    const subscription = subscribeWorkspace(
      workspaceId,
      () => {
        if (invalidateTimer) clearTimeout(invalidateTimer);
        invalidateTimer = setTimeout(() => {
          invalidateTimer = undefined;
          reloadExpanded();
        }, 750);
      },
      async () => {
        reloadExpanded();
      },
    );
    return () => {
      if (invalidateTimer) clearTimeout(invalidateTimer);
      subscription.close();
    };
  }, [workspaceId]);

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

  const reloadParent = useCallback((path: string) => {
    const parent = parentDirOf(path);
    setExpanded((prev) => {
      if (prev.has(parent)) {
        void loadDirectory(parent);
      } else if (parent !== ".") {
        const next = new Set(prev);
        next.add(parent);
        void loadDirectory(parent);
        return next;
      }
      return prev;
    });
    if (parent === ".") void loadDirectory(".");
  }, [loadDirectory]);

  const openCreate = (parentDir: string, kind: "file" | "directory") => {
    setCreateError("");
    setCreateName("");
    setPendingCreate({ parentDir, kind });
    setExpanded((prev) => {
      if (prev.has(parentDir)) return prev;
      const next = new Set(prev);
      next.add(parentDir);
      void loadDirectory(parentDir);
      return next;
    });
  };

  const submitCreate = async () => {
    if (!pendingCreate || createBusy) return;
    const problem = validateEntryName(createName);
    if (problem) {
      setCreateError(problem);
      return;
    }
    const name = createName.trim();
    const target = joinPath(pendingCreate.parentDir, name);
    setCreateBusy(true);
    setCreateError("");
    try {
      await api.createPath(workspaceId, target, pendingCreate.kind);
      setPendingCreate(null);
      setCreateName("");
      toast.success(pendingCreate.kind === "file" ? `Created ${target}` : `Created folder ${target}`);
      await loadDirectory(pendingCreate.parentDir);
      if (pendingCreate.kind === "file") {
        onOpenFile(target);
      } else {
        setExpanded((prev) => new Set(prev).add(target));
        void loadDirectory(target);
      }
    } catch (cause) {
      setCreateError(friendlyApiError(cause, "Could not create. Check the name and try again."));
    } finally {
      setCreateBusy(false);
    }
  };

  const openRename = (path: string, kind: "file" | "directory") => {
    setRenameError("");
    setRenameName(baseNameOf(path));
    setPendingRename({ path, kind });
  };

  const submitRename = async () => {
    if (!pendingRename || renameBusy) return;
    const problem = validateEntryName(renameName);
    if (problem) {
      setRenameError(problem);
      return;
    }
    const nextName = renameName.trim();
    const parent = parentDirOf(pendingRename.path);
    const currentName = baseNameOf(pendingRename.path);
    if (nextName === currentName) {
      setPendingRename(null);
      return;
    }
    const newPath = joinPath(parent, nextName);
    setRenameBusy(true);
    setRenameError("");
    try {
      await api.renamePath(workspaceId, pendingRename.path, newPath);
      const oldPath = pendingRename.path;
      setPendingRename(null);
      setRenameName("");
      toast.success(`Renamed to ${newPath}`);
      await loadDirectory(parent);
      onRenamed?.(oldPath, newPath);
    } catch (cause) {
      setRenameError(friendlyApiError(cause, "Could not rename. Check the name and try again."));
    } finally {
      setRenameBusy(false);
    }
  };

  const submitDelete = async () => {
    if (!pendingDelete || deleteBusy) return;
    setDeleteBusy(true);
    try {
      await api.deletePath(workspaceId, pendingDelete.path);
      const removed = pendingDelete.path;
      const wasDir = pendingDelete.kind === "directory";
      setPendingDelete(null);
      toast.success(wasDir ? `Deleted folder ${removed}` : `Deleted ${removed}`);
      reloadParent(removed);
      onDeleted?.(removed);
    } catch (cause) {
      toast.error(friendlyApiError(cause, "Could not delete. Try again."));
    } finally {
      setDeleteBusy(false);
    }
  };

  const handleDuplicate = async (path: string) => {
    setBusyPath(path);
    try {
      const result = await api.duplicatePath(workspaceId, path);
      toast.success(`Duplicated as ${result.path}`);
      reloadParent(path);
      onOpenFile(result.path);
    } catch (cause) {
      toast.error(friendlyApiError(cause, "Could not duplicate. Try again."));
    } finally {
      setBusyPath(null);
    }
  };

  const handleCopy = async (path: string, absolute: boolean) => {
    const text = absolute && workspaceCwd
      ? `${workspaceCwd.replace(/\/$/, "")}/${path}`
      : path;
    const ok = await copyText(text);
    if (ok) {
      toast.success(absolute ? "Absolute path copied" : "Relative path copied");
    } else {
      toast.error("Copy failed. Select the path manually.");
    }
  };

  const renderRowMenuItems = (entry: FileEntry) => (
    <>
      <ContextMenuLabel className="font-mono text-xs truncate max-w-60">
        {entry.path}
      </ContextMenuLabel>
      {entry.kind === "file" && (
        <ContextMenuItem onSelect={() => onOpenFile(entry.path)}>
          Open
        </ContextMenuItem>
      )}
      {entry.kind === "directory" && (
        <>
          <ContextMenuItem onSelect={() => openCreate(entry.path, "file")}>
            New file here
          </ContextMenuItem>
          <ContextMenuItem onSelect={() => openCreate(entry.path, "directory")}>
            New folder here
          </ContextMenuItem>
          <ContextMenuSeparator />
        </>
      )}
      <ContextMenuItem onSelect={() => openRename(entry.path, entry.kind)}>
        Rename…
      </ContextMenuItem>
      {entry.kind === "file" && (
        <ContextMenuItem
          onSelect={() => void handleDuplicate(entry.path)}
          disabled={busyPath === entry.path}
        >
          Duplicate
        </ContextMenuItem>
      )}
      <ContextMenuSeparator />
      <ContextMenuItem onSelect={() => void handleCopy(entry.path, false)}>
        Copy relative path
      </ContextMenuItem>
      <ContextMenuItem
        onSelect={() => void handleCopy(entry.path, true)}
        disabled={!workspaceCwd}
        title={workspaceCwd ? undefined : "Workspace path is unavailable"}
      >
        Copy absolute path
      </ContextMenuItem>
      <ContextMenuSeparator />
      <ContextMenuItem
        variant="destructive"
        onSelect={() => setPendingDelete({ path: entry.path, kind: entry.kind })}
      >
        Delete…
      </ContextMenuItem>
    </>
  );

  const renderOverflowMenu = (entry: FileEntry) => (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          variant="ghost"
          size="icon-sm"
          className="explorer-overflow shrink-0"
          aria-label={`Actions for ${entry.name}`}
          title={`Actions for ${entry.name}`}
          onClick={(e) => e.stopPropagation()}
          onPointerDown={(e) => e.stopPropagation()}
        >
          <span aria-hidden="true">⋯</span>
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="min-w-52">
        <DropdownMenuLabel className="font-mono text-xs truncate max-w-60">
          {entry.path}
        </DropdownMenuLabel>
        <DropdownMenuSeparator />
        {entry.kind === "file" && (
          <DropdownMenuItem onSelect={() => onOpenFile(entry.path)}>
            Open
          </DropdownMenuItem>
        )}
        {entry.kind === "directory" && (
          <>
            <DropdownMenuItem onSelect={() => openCreate(entry.path, "file")}>
              New file here
            </DropdownMenuItem>
            <DropdownMenuItem onSelect={() => openCreate(entry.path, "directory")}>
              New folder here
            </DropdownMenuItem>
            <DropdownMenuSeparator />
          </>
        )}
        <DropdownMenuItem onSelect={() => openRename(entry.path, entry.kind)}>
          Rename…
        </DropdownMenuItem>
        {entry.kind === "file" && (
          <DropdownMenuItem
            onSelect={() => void handleDuplicate(entry.path)}
            disabled={busyPath === entry.path}
          >
            Duplicate
          </DropdownMenuItem>
        )}
        <DropdownMenuSeparator />
        <DropdownMenuItem onSelect={() => void handleCopy(entry.path, false)}>
          Copy relative path
        </DropdownMenuItem>
        <DropdownMenuItem
          onSelect={() => void handleCopy(entry.path, true)}
          disabled={!workspaceCwd}
        >
          Copy absolute path
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuItem
          variant="destructive"
          onSelect={() => setPendingDelete({ path: entry.path, kind: entry.kind })}
        >
          Delete…
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );

  const renderTree = (dirPath: string, level = 0) => {
    const dirState = dirMap.get(dirPath);
    if (!dirState && expanded.has(dirPath)) {
      return null;
    }
    if (!dirState) return null;

    let entries = dirState.entries;
    const trimmedFilter = filter.trim();
    if (trimmedFilter) {
      entries = fuzzysort.go(trimmedFilter, entries, { key: "name", threshold: -10000 }).map((result) => result.obj);
    }
    const visibleLimit = visibleCounts[dirPath] ?? DIRECTORY_RENDER_CHUNK;
    const visibleEntries = entries.slice(0, visibleLimit);
    const hiddenCount = entries.length - visibleEntries.length;

    return (
      <div className="explorer-subtree" style={{ paddingLeft: level > 0 ? 14 : 0 }}>
        {visibleEntries.map((entry) => {
          const isDir = entry.kind === "directory";
          const isExpanded = expanded.has(entry.path);
          const isSelected = selectedFile === entry.path;
          const isBusy = busyPath === entry.path;

          if (isDir) {
            return (
              <ContextMenu key={entry.path}>
                <ContextMenuTrigger asChild>
                  <div className={`explorer-row group ${isSelected ? "selected" : ""}`}>
                    <button
                      className={`explorer-item dir ${isExpanded ? "open" : ""}`}
                      onClick={() => toggleExpand(entry.path)}
                      aria-expanded={isExpanded}
                      aria-label={`${isExpanded ? "Collapse" : "Expand"} folder ${entry.name}`}
                    >
                      <span className="tree-toggle" aria-hidden="true">{isExpanded ? "▾" : "▸"}</span>
                      <FileTypeIcon path={entry.name} isFolder isExpanded={isExpanded} size={14} />
                      <span className="node-name">{entry.name}</span>
                    </button>
                    {renderOverflowMenu(entry)}
                  </div>
                </ContextMenuTrigger>
                <ContextMenuContent className="min-w-52">
                  {renderRowMenuItems(entry)}
                </ContextMenuContent>
              </ContextMenu>
            );
          }

          return (
            <ContextMenu key={entry.path}>
              <ContextMenuTrigger asChild>
                <div className={`explorer-row group ${isSelected ? "selected" : ""}`}>
                  <button
                    className={`explorer-item file ${isSelected ? "selected" : ""}`}
                    onClick={() => onOpenFile(entry.path)}
                    aria-label={`Open file ${entry.name}`}
                    disabled={isBusy}
                  >
                    <span className="tree-indent" aria-hidden="true"> </span>
                    <FileTypeIcon path={entry.name} size={14} />
                    <span className="node-name">{entry.name}</span>
                    {entry.revision && (
                      <span className="node-size muted">{formatBytes(entry.revision.size)}</span>
                    )}
                    {isBusy && <Spinner className="size-3" />}
                  </button>
                  {renderOverflowMenu(entry)}
                </div>
              </ContextMenuTrigger>
              <ContextMenuContent className="min-w-52">
                {renderRowMenuItems(entry)}
              </ContextMenuContent>
            </ContextMenu>
          );
        })}

        {hiddenCount > 0 && (
          <Button
            variant="ghost"
            size="xs"
            className="w-full mt-1 text-muted-foreground"
            onClick={() => setVisibleCounts((prev) => ({
              ...prev,
              [dirPath]: visibleLimit + DIRECTORY_RENDER_CHUNK,
            }))}
          >
            Show more ({hiddenCount} remaining)...
          </Button>
        )}

        {dirState.nextCursor && (
          <Button
            variant="secondary"
            size="xs"
            className="w-full mt-2"
            onClick={() => void loadDirectory(dirPath, dirState.nextCursor ?? undefined)}
            disabled={dirState.loading}
          >
            {dirState.loading ? (
              <span className="inline-flex items-center gap-1.5">
                <Spinner className="size-3" />
                Loading...
              </span>
            ) : "Load more entries..."}
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
            onClick={() => openCreate(".", "file")}
            title="New file in workspace root"
            aria-label="New file"
          >
            <span aria-hidden="true">📄+</span>
          </Button>
          <Button
            variant="ghost"
            size="icon-xs"
            onClick={() => openCreate(".", "directory")}
            title="New folder in workspace root"
            aria-label="New folder"
          >
            <span aria-hidden="true">📁+</span>
          </Button>
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

      {error && <Alert variant="destructive" className="panel-alert"><AlertDescription>{error}</AlertDescription></Alert>}

      <ContextMenu>
        <ContextMenuTrigger asChild>
          <div className="explorer-tree" aria-label="Workspace files">
            {renderTree(".")}
            {dirMap.get(".")?.loading && dirMap.get(".")?.entries.length === 0 && (
              <div className="muted empty-inline">Loading workspace files...</div>
            )}
            {dirMap.get(".") && dirMap.get(".")?.entries.length === 0 && !dirMap.get(".")?.loading && (
              <div className="muted empty-inline">
                Empty folder. Right-click or use + above to create a file.
              </div>
            )}
          </div>
        </ContextMenuTrigger>
        <ContextMenuContent className="min-w-52">
          <ContextMenuLabel>Workspace root</ContextMenuLabel>
          <ContextMenuItem onSelect={() => openCreate(".", "file")}>
            New file here
          </ContextMenuItem>
          <ContextMenuItem onSelect={() => openCreate(".", "directory")}>
            New folder here
          </ContextMenuItem>
          <ContextMenuSeparator />
          <ContextMenuItem onSelect={handleRefresh}>
            Refresh
          </ContextMenuItem>
        </ContextMenuContent>
      </ContextMenu>

      <Dialog
        open={pendingCreate !== null}
        onOpenChange={(open) => {
          if (!open && !createBusy) {
            setPendingCreate(null);
            setCreateError("");
          }
        }}
      >
        <DialogContent className="max-w-[400px]">
          <DialogHeader>
            <DialogTitle>
              {pendingCreate?.kind === "directory" ? "New folder" : "New file"}
            </DialogTitle>
            <DialogDescription>
              Create in {pendingCreate ? displayDir(pendingCreate.parentDir) : "workspace root"}.
            </DialogDescription>
          </DialogHeader>
          <div className="grid gap-2">
            <Label htmlFor="explorer-create-name">
              {pendingCreate?.kind === "directory" ? "Folder name" : "File name"}
            </Label>
            <Input
              id="explorer-create-name"
              value={createName}
              onChange={(e) => setCreateName(e.target.value)}
              placeholder={pendingCreate?.kind === "directory" ? "components" : "notes.txt"}
              autoFocus
              aria-invalid={createError ? true : undefined}
              onKeyDown={(e) => {
                if (e.key === "Enter") void submitCreate();
              }}
            />
            {createError && (
              <p className="text-xs text-destructive" role="alert">{createError}</p>
            )}
          </div>
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => setPendingCreate(null)}
              disabled={createBusy}
            >
              Cancel
            </Button>
            <Button onClick={() => void submitCreate()} disabled={createBusy || !createName.trim()}>
              {createBusy ? (
                <span className="inline-flex items-center gap-1.5">
                  <Spinner className="size-3" /> Creating…
                </span>
              ) : "Create"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog
        open={pendingRename !== null}
        onOpenChange={(open) => {
          if (!open && !renameBusy) {
            setPendingRename(null);
            setRenameError("");
          }
        }}
      >
        <DialogContent className="max-w-[400px]">
          <DialogHeader>
            <DialogTitle>
              Rename {pendingRename?.kind === "directory" ? "folder" : "file"}
            </DialogTitle>
            <DialogDescription className="font-mono text-xs break-all">
              {pendingRename?.path}
            </DialogDescription>
          </DialogHeader>
          <div className="grid gap-2">
            <Label htmlFor="explorer-rename-name">New name</Label>
            <Input
              id="explorer-rename-name"
              value={renameName}
              onChange={(e) => setRenameName(e.target.value)}
              autoFocus
              aria-invalid={renameError ? true : undefined}
              onKeyDown={(e) => {
                if (e.key === "Enter") void submitRename();
              }}
            />
            {renameError && (
              <p className="text-xs text-destructive" role="alert">{renameError}</p>
            )}
          </div>
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => setPendingRename(null)}
              disabled={renameBusy}
            >
              Cancel
            </Button>
            <Button onClick={() => void submitRename()} disabled={renameBusy || !renameName.trim()}>
              {renameBusy ? (
                <span className="inline-flex items-center gap-1.5">
                  <Spinner className="size-3" /> Renaming…
                </span>
              ) : "Rename"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <AlertDialog
        open={pendingDelete !== null}
        onOpenChange={(open) => {
          if (!open && !deleteBusy) setPendingDelete(null);
        }}
      >
        <AlertDialogContent className="max-w-[440px]">
          <AlertDialogHeader>
            <AlertDialogTitle>
              Delete {pendingDelete?.kind === "directory" ? "folder" : "file"}?
            </AlertDialogTitle>
            <AlertDialogDescription className="font-mono text-xs break-all">
              {pendingDelete?.path}
              {pendingDelete?.kind === "directory" && (
                <span className="block mt-2">
                  The folder and everything inside it will be permanently deleted.
                </span>
              )}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={deleteBusy}>Cancel</AlertDialogCancel>
            <Button
              variant="destructive"
              onClick={() => void submitDelete()}
              disabled={deleteBusy}
            >
              {deleteBusy ? (
                <span className="inline-flex items-center gap-1.5">
                  <Spinner className="size-3" /> Deleting…
                </span>
              ) : "Delete"}
            </Button>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
