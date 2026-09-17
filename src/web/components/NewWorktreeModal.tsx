import { useCallback, useEffect, useState } from "react";
import type { Project, WorktreeLocation, Workspace } from "../../shared/domain/workspaces.ts";
import type { DiscoveredWorktree, WorkspaceApi } from "../api.ts";
import { Button } from "./ui/button.tsx";
import { Input } from "./ui/input.tsx";
import { Badge } from "./ui/badge.tsx";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "./ui/dialog.tsx";
import { Tabs, TabsList, TabsTrigger } from "./ui/tabs.tsx";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "./ui/select.tsx";
import { RadioGroup, RadioGroupItem } from "./ui/radio-group.tsx";
import { Label } from "./ui/label.tsx";
import { Alert, AlertDescription } from "./ui/alert.tsx";
import { GitBranch, RefreshCw, FolderDown, PlusCircle } from "lucide-react";

type Props = {
  projects: Project[];
  locations: WorktreeLocation[];
  defaultProjectId?: string;
  lockedProjectId?: string;
  initialTab?: "create" | "discover";
  suggestModel?: string;
  api: WorkspaceApi;
  onClose: () => void;
  onCreated: (workspace: Workspace) => void;
  onLocationsChanged?: () => Promise<void>;
};

export function NewWorktreeModal({
  projects,
  locations,
  defaultProjectId,
  lockedProjectId,
  initialTab = "create",
  suggestModel,
  api,
  onClose,
  onCreated,
  onLocationsChanged,
}: Props) {
  const activeProjects = projects.filter((p) => !p.archivedAt);
  const lockedProject = lockedProjectId ? activeProjects.find((p) => p.id === lockedProjectId) : undefined;
  const [activeTab, setActiveTab] = useState<"create" | "discover">(initialTab);
  const [projectId, setProjectId] = useState(lockedProjectId ?? defaultProjectId ?? activeProjects[0]?.id ?? "");

  useEffect(() => {
    const next = lockedProjectId ?? defaultProjectId;
    if (next) setProjectId(next);
  }, [lockedProjectId, defaultProjectId]);

  // Create Tab State
  const availableLocations = locations.filter(
    (loc) => loc.enabled && (!loc.projectId || loc.projectId === projectId)
  );
  const [locationId, setLocationId] = useState(availableLocations[0]?.id ?? "");
  useEffect(() => {
    if (!availableLocations.some((loc) => loc.id === locationId) && availableLocations[0]) {
      setLocationId(availableLocations[0].id);
    }
  }, [availableLocations, locationId]);
  const [showLocationForm, setShowLocationForm] = useState(false);
  const [newLocationLabel, setNewLocationLabel] = useState("");
  const [newLocationPath, setNewLocationPath] = useState("");
  const [newLocationScope, setNewLocationScope] = useState<"global" | "project">("global");
  const [savingLocation, setSavingLocation] = useState(false);
  const [purpose, setPurpose] = useState("");
  const [label, setLabel] = useState("");
  const [branch, setBranch] = useState("feature/worktree");
  const [branchMode, setBranchMode] = useState<"existing" | "new">("new");
  const [baseRef, setBaseRef] = useState("main");
  const [folder, setFolder] = useState("");
  const [suggesting, setSuggesting] = useState(false);
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState("");

  // Discover Tab State
  const [discovered, setDiscovered] = useState<DiscoveredWorktree[]>([]);
  const [discovering, setDiscovering] = useState(false);
  const [manualPath, setManualPath] = useState("");
  const [manualLabel, setManualLabel] = useState("");
  const [importingPath, setImportingPath] = useState<string | null>(null);

  const loadDiscovered = useCallback(async (projId: string) => {
    if (!projId) return;
    setDiscovering(true);
    setError("");
    try {
      const items = await api.discoverWorktrees(projId);
      setDiscovered(items);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to discover worktrees");
    } finally {
      setDiscovering(false);
    }
  }, [api]);

  useEffect(() => {
    if (activeTab === "discover" && projectId) {
      void loadDiscovered(projectId);
    }
  }, [activeTab, projectId, loadDiscovered]);

  const handleSuggest = async () => {
    if (!purpose.trim() || !projectId) return;
    setSuggesting(true);
    setError("");
    try {
      const suggestion = await api.suggestWorktree(projectId, purpose.trim(), suggestModel);
      setLabel(suggestion.label);
      setBranch(suggestion.branch);
      setFolder(suggestion.folder);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unable to generate suggestions");
    } finally {
      setSuggesting(false);
    }
  };

  const handleCreate = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!projectId) {
      setError("Choose a project first.");
      return;
    }
    if (!locationId) {
      setError("No worktree location is configured. Add a location below before creating a worktree.");
      return;
    }
    if (!label.trim()) {
      setError("Give the workspace a label.");
      return;
    }
    if (!branch.trim()) {
      setError(branchMode === "new" ? "Enter a name for the new branch." : "Enter an existing branch or ref to check out.");
      return;
    }
    if (branchMode === "new" && !baseRef.trim()) {
      setError("Enter the base branch or ref the new branch starts from (e.g. main).");
      return;
    }

    setCreating(true);
    setError("");
    try {
      const created = await api.createWorktree(projectId, {
        locationId,
        ref: branch.trim(),
        label: label.trim(),
        folder: folder.trim() || undefined,
        ...(branchMode === "new" ? { createBranch: true, baseRef: baseRef.trim() } : {}),
      });
      onCreated(created);
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to create worktree");
    } finally {
      setCreating(false);
    }
  };

  const handleCreateLocation = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!newLocationLabel.trim() || !newLocationPath.trim()) {
      setError("Location needs a name and a directory path.");
      return;
    }
    setSavingLocation(true);
    setError("");
    try {
      await api.configureLocation({
        ...(newLocationScope === "project" && projectId ? { projectId } : {}),
        displayLabel: newLocationLabel.trim(),
        configuredRootPath: newLocationPath.trim(),
      });
      setNewLocationLabel("");
      setNewLocationPath("");
      setShowLocationForm(false);
      if (onLocationsChanged) await onLocationsChanged();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to add location");
    } finally {
      setSavingLocation(false);
    }
  };

  const handleImport = async (targetPath: string, defaultLabel?: string | null) => {
    if (!projectId || !targetPath.trim()) return;
    setImportingPath(targetPath);
    setError("");
    try {
      const imported = await api.importWorktree(projectId, {
        path: targetPath.trim(),
        label: (defaultLabel ?? targetPath.split("/").pop()) || undefined,
      });
      onCreated(imported);
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to import worktree");
    } finally {
      setImportingPath(null);
    }
  };

  return (
    <Dialog open onOpenChange={(open) => { if (!open) onClose(); }}>
      <DialogContent
        className="max-w-[560px] max-h-[calc(100vh-2rem)] overflow-y-auto"
        onInteractOutside={(e) => e.preventDefault()}
      >
        <DialogHeader>
          <DialogTitle className="text-lg font-semibold">Git Worktrees</DialogTitle>
          <Tabs
            value={activeTab}
            onValueChange={(value) => { setActiveTab(value as "create" | "discover"); setError(""); }}
            className="pt-2 pb-2 border-b border-border/50 gap-0"
          >
            <TabsList>
              <TabsTrigger value="create" className="gap-1.5 text-xs">
                <PlusCircle className="w-3.5 h-3.5" /> Create New
              </TabsTrigger>
              <TabsTrigger value="discover" className="gap-1.5 text-xs">
                <FolderDown className="w-3.5 h-3.5" /> Discover &amp; Import
              </TabsTrigger>
            </TabsList>
          </Tabs>
        </DialogHeader>

        {error && <Alert variant="destructive" className="my-1"><AlertDescription className="text-xs">{error}</AlertDescription></Alert>}

        {activeTab === "create" ? (
          <form onSubmit={handleCreate} className="flex flex-col gap-3 pt-1">
            <div className="flex flex-col gap-1 text-xs font-medium">
              <Label htmlFor="worktree-project" className="text-xs">Project</Label>
              {lockedProject ? (
                <p id="worktree-project" className="text-xs text-foreground font-normal truncate" title={lockedProject.canonicalRootPath}>
                  {lockedProject.displayLabel} ({lockedProject.canonicalRootPath})
                </p>
              ) : (
                <Select
                value={projectId}
                onValueChange={(value) => {
                  setProjectId(value);
                  const locs = locations.filter(
                    (l) => l.enabled && (!l.projectId || l.projectId === value)
                  );
                  if (locs[0]) setLocationId(locs[0].id);
                }}
                required
              >
                <SelectTrigger id="worktree-project" className="w-full h-8 text-xs">
                  <SelectValue placeholder="Select project" />
                </SelectTrigger>
                <SelectContent position="popper" align="start" className="w-[var(--radix-select-trigger-width)] max-w-[calc(100vw-2rem)]">
                  {activeProjects.map((p) => (
                    <SelectItem key={p.id} value={p.id}><span className="min-w-0 flex-1 truncate">{p.displayLabel} ({p.canonicalRootPath})</span></SelectItem>
                  ))}
                </SelectContent>
              </Select>
              )}
            </div>

            <div className="flex flex-col gap-1 text-xs font-medium">
              <span>Worktree Location</span>
              {availableLocations.length > 0 ? (
                <Select value={locationId} onValueChange={setLocationId} required>
                  <SelectTrigger className="w-full h-8 text-xs" aria-label="Worktree location">
                    <SelectValue placeholder="Select location" />
                  </SelectTrigger>
                  <SelectContent position="popper" align="start" className="w-[var(--radix-select-trigger-width)] max-w-[calc(100vw-2rem)]">
                    {availableLocations.map((loc) => (
                      <SelectItem key={loc.id} value={loc.id}>
                        <span className="min-w-0 flex-1 truncate">{loc.displayLabel} ({loc.configuredRootPath})</span>
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              ) : (
                <p className="text-xs text-muted-foreground mt-1">
                  No configured locations found. Add a global or project location below to continue.
                </p>
              )}
              {!showLocationForm ? (
                <Button
                  type="button"
                  variant="ghost"
                  size="xs"
                  className="self-start px-1"
                  onClick={() => setShowLocationForm(true)}
                >
                  <PlusCircle className="w-3.5 h-3.5" /> New location
                </Button>
              ) : (
                <div className="flex flex-col gap-1.5 rounded-md border border-border/50 p-2 bg-muted/20">
                  <Input
                    type="text"
                    className="h-8 text-xs"
                    placeholder="Location name, e.g. Fast SSD worktrees"
                    value={newLocationLabel}
                    onChange={(e) => setNewLocationLabel(e.target.value)}
                  />
                  <Input
                    type="text"
                    className="h-8 text-xs font-mono"
                    placeholder="Directory path, e.g. /mnt/fast/worktrees"
                    value={newLocationPath}
                    onChange={(e) => setNewLocationPath(e.target.value)}
                  />
                  <RadioGroup
                    value={newLocationScope}
                    onValueChange={(value) => setNewLocationScope(value as "global" | "project")}
                    className="flex items-center gap-3"
                    aria-label="Location scope"
                  >
                    <div className="flex items-center gap-1.5 text-xs font-normal">
                      <RadioGroupItem id="worktree-scope-global" value="global" />
                      <Label htmlFor="worktree-scope-global" className="text-xs font-normal cursor-pointer">Global</Label>
                    </div>
                    <div className="flex items-center gap-1.5 text-xs font-normal">
                      <RadioGroupItem id="worktree-scope-project" value="project" />
                      <Label htmlFor="worktree-scope-project" className="text-xs font-normal cursor-pointer">This project only</Label>
                    </div>
                  </RadioGroup>
                  <div className="flex gap-2">
                    <Button
                      type="button"
                      size="xs"
                      disabled={savingLocation}
                      onClick={handleCreateLocation}
                    >
                      {savingLocation ? "Adding..." : "Add location"}
                    </Button>
                    <Button
                      type="button"
                      variant="ghost"
                      size="xs"
                      onClick={() => setShowLocationForm(false)}
                    >
                      Cancel
                    </Button>
                  </div>
                </div>
              )}
            </div>

            <div className="flex flex-col gap-1">
              <label className="flex flex-col gap-1 text-xs font-medium">
                Task Purpose / Goal (Optional)
                <div className="flex gap-2 mt-1">
                  <Input
                    type="text"
                    className="h-8 text-xs"
                    placeholder="e.g. Implement customer webhook retry backoff"
                    value={purpose}
                    onChange={(e) => setPurpose(e.target.value)}
                  />
                  <Button
                    type="button"
                    variant="secondary"
                    size="xs"
                    onClick={handleSuggest}
                    disabled={!purpose.trim() || suggesting || !projectId}
                    title="Generate label, branch and folder suggestions using AI"
                    className="shrink-0 h-8 text-xs"
                  >
                    {suggesting ? "Thinking..." : "⚡ Suggest"}
                  </Button>
                </div>
              </label>
              <p className="text-[11px] text-muted-foreground">Type your goal and click Suggest to auto-fill metadata.{suggestModel?.trim() ? ` Uses model ${suggestModel.trim()} (Settings).` : " Uses the default model (change in Settings)."}</p>
            </div>

            <label className="flex flex-col gap-1 text-xs font-medium">
              Workspace Label
              <Input
                type="text"
                className="h-8 text-xs"
                placeholder="e.g. Webhook retry logic"
                value={label}
                onChange={(e) => setLabel(e.target.value)}
                required
              />
            </label>

            <div className="flex flex-col gap-1 text-xs font-medium">
              <span>Git Branch</span>
              <RadioGroup
                value={branchMode}
                onValueChange={(value) => setBranchMode(value as "existing" | "new")}
                className="flex items-center gap-3"
                aria-label="Branch mode"
              >
                <div className="flex items-center gap-1.5 text-xs font-normal">
                  <RadioGroupItem id="branch-mode-new" value="new" />
                  <Label htmlFor="branch-mode-new" className="text-xs font-normal cursor-pointer">Create new branch</Label>
                </div>
                <div className="flex items-center gap-1.5 text-xs font-normal">
                  <RadioGroupItem id="branch-mode-existing" value="existing" />
                  <Label htmlFor="branch-mode-existing" className="text-xs font-normal cursor-pointer">Use existing branch / ref</Label>
                </div>
              </RadioGroup>
              <Input
                type="text"
                className="h-8 text-xs font-mono"
                placeholder={branchMode === "new" ? "e.g. feature/webhook-retries" : "e.g. main or a commit SHA"}
                value={branch}
                onChange={(e) => setBranch(e.target.value)}
                required
                aria-label={branchMode === "new" ? "New branch name" : "Existing branch or ref"}
              />
              {branchMode === "new" && (
                <label className="flex flex-col gap-1 text-xs font-medium mt-1">
                  Based on (base branch or ref)
                  <Input
                    type="text"
                    className="h-8 text-xs font-mono"
                    placeholder="e.g. main"
                    value={baseRef}
                    onChange={(e) => setBaseRef(e.target.value)}
                    required
                  />
                </label>
              )}
              <p className="text-[11px] text-muted-foreground font-normal">
                {branchMode === "new"
                  ? "Creates the branch from the base ref in the new worktree."
                  : "Checks out an existing branch, tag, or commit in the new worktree."}
              </p>
            </div>

            <label className="flex flex-col gap-1 text-xs font-medium">
              Destination Folder Name (Optional)
              <Input
                type="text"
                className="h-8 text-xs font-mono"
                placeholder="e.g. webhook-retries--wk_7d2a"
                value={folder}
                onChange={(e) => setFolder(e.target.value)}
              />
            </label>

            <div className="flex justify-end gap-2 pt-2 border-t border-border/40">
              <Button type="button" variant="secondary" size="xs" onClick={onClose}>
                Cancel
              </Button>
              <Button type="submit" size="xs" disabled={creating}>
                {creating ? "Creating..." : "Create Worktree"}
              </Button>
            </div>
          </form>
        ) : (
          <div className="flex flex-col gap-3 pt-1">
            <div className="flex items-center justify-between gap-2">
              <div className="flex items-center gap-2 text-xs font-medium flex-1">
                <Label htmlFor="discover-project" className="text-xs shrink-0">Project:</Label>
                {lockedProject ? (
                  <span id="discover-project" className="text-xs font-normal truncate" title={lockedProject.canonicalRootPath}>
                    {lockedProject.displayLabel}
                  </span>
                ) : (
                <Select value={projectId} onValueChange={setProjectId}>
                  <SelectTrigger id="discover-project" className="flex-1 h-8 text-xs">
                    <SelectValue placeholder="Select project" />
                  </SelectTrigger>
                  <SelectContent position="popper" align="start" className="w-[var(--radix-select-trigger-width)] max-w-[calc(100vw-2rem)]">
                    {activeProjects.map((p) => (
                      <SelectItem key={p.id} value={p.id}><span className="min-w-0 flex-1 truncate">{p.displayLabel}</span></SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                )}
              </div>
              <Button
                type="button"
                variant="outline"
                size="xs"
                className="gap-1"
                onClick={() => void loadDiscovered(projectId)}
                disabled={discovering}
              >
                <RefreshCw className={`w-3 h-3 ${discovering ? "animate-spin" : ""}`} />
                Rescan
              </Button>
            </div>

            {/* List of Discovered Worktrees */}
            <div className="flex flex-col gap-1.5 max-h-[260px] overflow-y-auto border border-border/50 rounded-md p-2 bg-muted/20">
              {discovering ? (
                <div className="p-4 text-center text-xs text-muted-foreground">Scanning repository worktrees...</div>
              ) : discovered.length === 0 ? (
                <div className="p-4 text-center text-xs text-muted-foreground">No linked git worktrees found for this project repository.</div>
              ) : (
                discovered.map((item) => (
                  <div
                    key={item.path}
                    className="flex items-center justify-between gap-2 p-2 rounded border border-border/40 bg-card hover:bg-surface-hover text-xs transition-colors"
                  >
                    <div className="flex flex-col gap-0.5 min-w-0 flex-1">
                      <div className="flex items-center gap-1.5 flex-wrap">
                        <GitBranch className="w-3.5 h-3.5 text-primary shrink-0" />
                        <span className="font-mono font-medium text-foreground truncate">
                          {item.branchRef ?? "(detached HEAD)"}
                        </span>
                        {item.isMain && (
                          <Badge variant="outline" className="text-[10px] py-0 px-1">main repo</Badge>
                        )}
                        {item.isRegistered && !item.archived && (
                          <Badge variant="secondary" className="text-[10px] py-0 px-1 text-emerald-600 bg-emerald-500/10">registered</Badge>
                        )}
                        {item.archived && (
                          <Badge variant="destructive" className="text-[10px] py-0 px-1">archived</Badge>
                        )}
                      </div>
                      <span className="font-mono text-[11px] text-muted-foreground truncate" title={item.path}>
                        {item.path}
                      </span>
                    </div>

                    <div className="shrink-0">
                      {item.isRegistered && !item.archived ? (
                        <span className="text-[11px] text-muted-foreground">Active</span>
                      ) : item.archived ? (
                        <Button
                          size="xs"
                          variant="secondary"
                          disabled={importingPath === item.path}
                          onClick={() => void handleImport(item.path, item.branchRef)}
                        >
                          Reopen
                        </Button>
                      ) : (
                        <Button
                          size="xs"
                          disabled={importingPath === item.path}
                          onClick={() => void handleImport(item.path, item.branchRef)}
                        >
                          {importingPath === item.path ? "Importing..." : "Import"}
                        </Button>
                      )}
                    </div>
                  </div>
                ))
              )}
            </div>

            {/* Manual Path Import */}
            <div className="pt-2 border-t border-border/50">
              <span className="text-xs font-medium text-muted-foreground block mb-1.5">Or import by directory path:</span>
              <div className="flex gap-2 min-w-0">
                <Input
                  type="text"
                  placeholder="/path/to/existing/worktree"
                  value={manualPath}
                  onChange={(e) => setManualPath(e.target.value)}
                  className="h-8 text-xs font-mono flex-1 min-w-0"
                />
                <Input
                  type="text"
                  placeholder="Label (optional)"
                  value={manualLabel}
                  onChange={(e) => setManualLabel(e.target.value)}
                  className="h-8 text-xs w-32"
                />
                <Button
                  size="xs"
                  variant="secondary"
                  className="h-8 text-xs shrink-0"
                  disabled={!manualPath.trim() || Boolean(importingPath)}
                  onClick={() => void handleImport(manualPath, manualLabel || null)}
                >
                  Import Path
                </Button>
              </div>
            </div>

            <div className="flex justify-end pt-2 border-t border-border/40">
              <Button type="button" variant="secondary" size="xs" onClick={onClose}>
                Close
              </Button>
            </div>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
