import React, { useState } from "react";
import type { ThemePack, FontPack } from "../../shared/domain/customization.ts";
import { BUILTIN_THEMES, BUILTIN_FONTS } from "../../shared/domain/customization.ts";
import type { WorkspaceSettings, BaselineTool, ExpandMode, TimelineExpansionSettings } from "../../shared/domain/settings.ts";
import { baselineTools, DEFAULT_TIMELINE_EXPANSION } from "../../shared/domain/settings.ts";
import type { AgentCapabilities } from "../../shared/domain/agents.ts";
import type { Project, WorktreeLocation } from "../../shared/domain/workspaces.ts";
import type { WorkspaceApi } from "../api.ts";
import { requestNotificationPermission, getNotificationPermission } from "../notifications.ts";
import { Button } from "./ui/button.tsx";
import { Input } from "./ui/input.tsx";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "./ui/dialog.tsx";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "./ui/select.tsx";
import { Switch } from "./ui/switch.tsx";
import { RadioGroup, RadioGroupItem } from "./ui/radio-group.tsx";
import { Label } from "./ui/label.tsx";
import { Alert, AlertDescription } from "./ui/alert.tsx";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "./ui/tabs.tsx";
import { toast } from "sonner";

/** Sentinel Select value for "use pi default" (stored as an empty suggestModel). Radix requires non-empty item values. */
const DEFAULT_SUGGEST_MODEL_VALUE = "__pi_default";

const BASELINE_TOOL_LABELS: Record<BaselineTool, string> = {
  read: "Read (read, readFile)",
  write: "Write (write, writeFile)",
  edit: "Edit (edit, multiedit, patch)",
  bash: "Command (bash)",
  find: "Find Files (find, glob)",
  grep: "Search Files (grep)",
  ls: "List Directory (ls, list)",
};

export interface OutputExpansionSectionProps {
  expansion: TimelineExpansionSettings;
  onExpansionChange: (next: TimelineExpansionSettings) => void;
}

export function OutputExpansionSection({
  expansion,
  onExpansionChange,
}: OutputExpansionSectionProps) {
  const handleSetAllTools = (mode: ExpandMode) => {
    const nextTools = { ...expansion.tools };
    for (const tool of baselineTools) {
      nextTools[tool] = mode;
    }
    onExpansionChange({
      ...expansion,
      tools: nextTools,
      otherTools: mode,
    });
  };

  return (
    <section className="flex flex-col gap-3 border-t border-border/50 pt-3" aria-label="Output and tool expansion">
      <div>
        <h3 className="text-sm font-semibold">Output &amp; Tool Expansion</h3>
        <p className="text-xs text-muted-foreground">
          Configure default expansion behavior for model reasoning and tool executions in transcripts.
        </p>
      </div>

      <div className="flex items-center justify-between gap-2">
        <Label htmlFor="settings-expand-thinking" className="text-sm font-medium">
          Thinking Output
        </Label>
        <Select
          value={expansion.thinking}
          onValueChange={(val) =>
            onExpansionChange({
              ...expansion,
              thinking: val as ExpandMode,
            })
          }
        >
          <SelectTrigger id="settings-expand-thinking" className="w-36">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="always">Always</SelectItem>
            <SelectItem value="latest">Latest</SelectItem>
            <SelectItem value="none">None</SelectItem>
          </SelectContent>
        </Select>
      </div>

      <div className="flex flex-col gap-2 pt-1">
        <div className="flex items-center justify-between">
          <span className="text-xs font-semibold text-foreground">Baseline Tools</span>
          <div className="flex items-center gap-1">
            <span className="text-[11px] text-muted-foreground mr-1">Set all:</span>
            <Button
              type="button"
              variant="outline"
              size="xs"
              className="h-6 px-2 text-[11px]"
              onClick={() => handleSetAllTools("always")}
            >
              Always
            </Button>
            <Button
              type="button"
              variant="outline"
              size="xs"
              className="h-6 px-2 text-[11px]"
              onClick={() => handleSetAllTools("latest")}
            >
              Latest
            </Button>
            <Button
              type="button"
              variant="outline"
              size="xs"
              className="h-6 px-2 text-[11px]"
              onClick={() => handleSetAllTools("none")}
            >
              None
            </Button>
          </div>
        </div>

        <div className="flex flex-col gap-1.5 pl-1">
          {baselineTools.map((tool) => (
            <div key={tool} className="flex items-center justify-between gap-2">
              <Label htmlFor={`settings-tool-${tool}`} className="text-xs text-muted-foreground font-normal">
                {BASELINE_TOOL_LABELS[tool]}
              </Label>
              <Select
                value={expansion.tools[tool]}
                onValueChange={(val) =>
                  onExpansionChange({
                    ...expansion,
                    tools: {
                      ...expansion.tools,
                      [tool]: val as ExpandMode,
                    },
                  })
                }
              >
                <SelectTrigger id={`settings-tool-${tool}`} className="h-7 w-32 text-xs">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="always">Always</SelectItem>
                  <SelectItem value="latest">Latest</SelectItem>
                  <SelectItem value="none">None</SelectItem>
                </SelectContent>
              </Select>
            </div>
          ))}
        </div>
      </div>

      <div className="flex items-center justify-between gap-2 pt-1 border-t border-border/30">
        <Label htmlFor="settings-expand-other-tools" className="text-xs font-medium">
          Other Tools (MCP, extensions)
        </Label>
        <Select
          value={expansion.otherTools}
          onValueChange={(val) =>
            onExpansionChange({
              ...expansion,
              otherTools: val as ExpandMode,
            })
          }
        >
          <SelectTrigger id="settings-expand-other-tools" className="h-7 w-32 text-xs">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="always">Always</SelectItem>
            <SelectItem value="latest">Latest</SelectItem>
            <SelectItem value="none">None</SelectItem>
          </SelectContent>
        </Select>
      </div>
    </section>
  );
}

export interface SettingsModalProps {
  open: boolean;
  onClose: () => void;
  settings: WorkspaceSettings;
  onSaveSettings: (settings: WorkspaceSettings) => Promise<void>;
  themes?: ThemePack[];
  fonts?: FontPack[];
  api?: WorkspaceApi;
  projects?: Project[];
  locations?: WorktreeLocation[];
  onLocationsChanged?: () => Promise<void>;
}

export function SettingsModal({
  open,
  onClose,
  settings,
  onSaveSettings,
  themes = BUILTIN_THEMES,
  fonts = BUILTIN_FONTS,
  api,
  projects = [],
  locations: initialLocations = [],
  onLocationsChanged,
}: SettingsModalProps) {
  const [currentSettings, setCurrentSettings] = useState<WorkspaceSettings>(settings);
  const [busy, setBusy] = useState(false);
  const [notificationStatus, setNotificationStatus] = useState<string>(getNotificationPermission());
  const [locations, setLocations] = useState<WorktreeLocation[]>(initialLocations);
  const [locationError, setLocationError] = useState("");
  const [locationBusy, setLocationBusy] = useState(false);
  const [newLabel, setNewLabel] = useState("");
  const [newPath, setNewPath] = useState("");
  const [newScope, setNewScope] = useState<"global" | "project">("global");
  const [newProjectId, setNewProjectId] = useState("");
  const [suggestModels, setSuggestModels] = useState<AgentCapabilities["models"]>([]);
  const [suggestModelsLoading, setSuggestModelsLoading] = useState(false);
  const [suggestModelsError, setSuggestModelsError] = useState("");
  const [saveError, setSaveError] = useState("");

  React.useEffect(() => {
    setCurrentSettings(settings);
    setNotificationStatus(getNotificationPermission());
    setSaveError("");
  }, [settings, open]);

  React.useEffect(() => {
    if (!open) return;
    setLocations(initialLocations);
    setLocationError("");
    setNewProjectId((current) => current || projects[0]?.id || "");
    if (api) {
      void api.listLocations().then(setLocations).catch((err: unknown) => {
        setLocationError(err instanceof Error ? err.message : "Unable to load worktree locations");
      });
      setSuggestModelsLoading(true);
      setSuggestModelsError("");
      void api.listModels().then((models) => {
        setSuggestModels(models.filter((m) => m.authenticated));
      }).catch((err: unknown) => {
        setSuggestModelsError(err instanceof Error ? err.message : "Unable to load pi models");
      }).finally(() => {
        setSuggestModelsLoading(false);
      });
    }
  }, [open, api, initialLocations, projects]);

  const expansion = currentSettings.timelineExpansion ?? DEFAULT_TIMELINE_EXPANSION;

  const handleUpdateExpansion = (next: TimelineExpansionSettings) => {
    setCurrentSettings((prev) => ({
      ...prev,
      timelineExpansion: next,
    }));
  };

  const handleSetAllTools = (mode: ExpandMode) => {
    const nextTools = { ...expansion.tools };
    for (const tool of baselineTools) {
      nextTools[tool] = mode;
    }
    handleUpdateExpansion({
      ...expansion,
      tools: nextTools,
      otherTools: mode,
    });
  };

  const handleToggleNotifications = async (enabled: boolean) => {
    if (enabled) {
      const granted = await requestNotificationPermission();
      setNotificationStatus(getNotificationPermission());
      setCurrentSettings((prev) => ({ ...prev, notificationsEnabled: granted }));
    } else {
      setCurrentSettings((prev) => ({ ...prev, notificationsEnabled: false }));
    }
  };

  const handleSave = async () => {
    setBusy(true);
    setSaveError("");
    try {
      await onSaveSettings(currentSettings);
      onClose();
    } catch (err) {
      setSaveError(err instanceof Error ? err.message : "Failed to save settings");
    } finally {
      setBusy(false);
    }
  };

  const refreshLocations = async () => {
    if (!api) return;
    const next = await api.listLocations();
    setLocations(next);
    if (onLocationsChanged) await onLocationsChanged();
  };

  const handleAddLocation = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!api) return;
    if (!newLabel.trim() || !newPath.trim()) {
      setLocationError("Location needs a name and a directory path.");
      return;
    }
    if (newScope === "project" && !newProjectId) {
      setLocationError("Choose the project this location belongs to.");
      return;
    }
    setLocationBusy(true);
    setLocationError("");
    try {
      await api.configureLocation({
        ...(newScope === "project" ? { projectId: newProjectId } : {}),
        displayLabel: newLabel.trim(),
        configuredRootPath: newPath.trim(),
      });
      setNewLabel("");
      setNewPath("");
      await refreshLocations();
      toast.success("Worktree location added");
    } catch (err) {
      setLocationError(err instanceof Error ? err.message : "Failed to add location");
    } finally {
      setLocationBusy(false);
    }
  };

  const handleToggleLocation = async (location: WorktreeLocation) => {
    if (!api) return;
    setLocationBusy(true);
    setLocationError("");
    try {
      await api.setLocationEnabled(location.id, !location.enabled);
      await refreshLocations();
    } catch (err) {
      setLocationError(err instanceof Error ? err.message : "Failed to update location");
    } finally {
      setLocationBusy(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={(isOpen) => { if (!isOpen) onClose(); }}>
      <DialogContent className="max-w-[520px] max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="text-lg font-semibold">Workspace Settings</DialogTitle>
        </DialogHeader>

        <Tabs defaultValue="fonts-colors" className="w-full">
          <TabsList className="grid w-full grid-cols-3">
            <TabsTrigger value="fonts-colors">Fonts &amp; Colors</TabsTrigger>
            <TabsTrigger value="suggestion-output">Suggestion &amp; Output</TabsTrigger>
            <TabsTrigger value="worktree-locations">Worktree Locations</TabsTrigger>
          </TabsList>

          <TabsContent value="fonts-colors" className="flex flex-col gap-4 py-2">
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="settings-theme">Color Theme</Label>
            <Select
              value={currentSettings.themeId}
              onValueChange={(value) => setCurrentSettings({ ...currentSettings, themeId: value })}
            >
              <SelectTrigger id="settings-theme" className="w-full">
                <SelectValue placeholder="Select a theme" />
              </SelectTrigger>
              <SelectContent>
                {themes.map((theme) => (
                  <SelectItem key={theme.id} value={theme.id}>
                    {theme.name} ({theme.mode})
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <div className="flex flex-col gap-1.5">
            <Label htmlFor="settings-font">Font Family</Label>
            <Select
              value={currentSettings.fontId}
              onValueChange={(value) => setCurrentSettings({ ...currentSettings, fontId: value })}
            >
              <SelectTrigger id="settings-font" className="w-full">
                <SelectValue placeholder="Select a font" />
              </SelectTrigger>
              <SelectContent>
                {fonts.map((font) => (
                  <SelectItem key={font.id} value={font.id}>
                    {font.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <div className="flex flex-col gap-1">
            <div className="flex items-center justify-between gap-2">
              <Label htmlFor="settings-notifications" className="text-sm font-medium">
                Browser Notifications on Agent Completion
              </Label>
              <Switch
                id="settings-notifications"
                checked={currentSettings.notificationsEnabled}
                onCheckedChange={(checked) => void handleToggleNotifications(checked)}
              />
            </div>
            <small className="text-xs text-muted-foreground">
              Permission state: <code className="font-mono">{notificationStatus}</code>. Notifications only fire when tab is inactive.
            </small>
          </div>

          <label className="flex flex-col gap-1 text-sm font-medium">
            <span>Terminal Font Size</span>
            <Input
              type="number"
              min={9}
              max={32}
              value={currentSettings.terminalFontSize}
              onChange={(e) =>
                setCurrentSettings({
                  ...currentSettings,
                  terminalFontSize: parseInt(e.target.value, 10) || 13,
                })
              }
            />
          </label>
          </TabsContent>

          <TabsContent value="suggestion-output" className="flex flex-col gap-4 py-2">
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="settings-suggest-model">Suggestion Model</Label>
            <Select
              value={(currentSettings.suggestModel?.trim() || DEFAULT_SUGGEST_MODEL_VALUE)}
              onValueChange={(value) =>
                setCurrentSettings({
                  ...currentSettings,
                  suggestModel: value === DEFAULT_SUGGEST_MODEL_VALUE ? "" : value,
                })
              }
              disabled={suggestModelsLoading || !api}
            >
              <SelectTrigger id="settings-suggest-model" className="w-full">
                <SelectValue placeholder={suggestModelsLoading ? "Loading models\u2026" : "Select a model"} />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={DEFAULT_SUGGEST_MODEL_VALUE}>Use pi default</SelectItem>
                {suggestModels.map((m) => {
                  const value = `${m.provider}/${m.id}`;
                  return (
                    <SelectItem key={value} value={value}>
                      {m.name} ({m.provider})
                    </SelectItem>
                  );
                })}
                {(() => {
                  const stored = currentSettings.suggestModel?.trim() ?? "";
                  const known = new Set(suggestModels.map((m) => `${m.provider}/${m.id}`));
                  return stored && !known.has(stored) ? (
                    <SelectItem value={stored}>{stored} (saved)</SelectItem>
                  ) : null;
                })()}
              </SelectContent>
            </Select>
            <small className="text-xs font-normal text-muted-foreground">
              Model passed as <code className="font-mono">pi --model</code> when generating worktree label/branch/folder suggestions.
            </small>
            {suggestModelsError && (
              <small className="text-xs font-normal text-muted-foreground">
                Could not load the pi model list ({suggestModelsError}). Using pi default is still available.
                <button
                  type="button"
                  className="ml-1 underline"
                  onClick={() => {
                    if (!api) return;
                    setSuggestModelsLoading(true);
                    setSuggestModelsError("");
                    void api.listModels().then((models) => {
                      setSuggestModels(models.filter((m) => m.authenticated));
                    }).catch((err: unknown) => {
                      setSuggestModelsError(err instanceof Error ? err.message : "Unable to load pi models");
                    }).finally(() => {
                      setSuggestModelsLoading(false);
                    });
                  }}
                >
                  Retry
                </button>
              </small>
            )}
          </div>

          <OutputExpansionSection
            expansion={expansion}
            onExpansionChange={handleUpdateExpansion}
          />
          </TabsContent>

          <TabsContent value="worktree-locations" className="flex flex-col gap-2 py-2">
          {api ? (
            <section className="flex flex-col gap-2" aria-label="Worktree locations">
              <h3 className="text-sm font-semibold">Worktree Locations</h3>
              <p className="text-xs text-muted-foreground">
                Named directories where new Git worktrees are created. Global locations work for every project.
              </p>
              {locationError && (
                <Alert variant="destructive">
                  <AlertDescription className="text-xs">{locationError}</AlertDescription>
                </Alert>
              )}
              {locations.length === 0 ? (
                <p className="text-xs text-muted-foreground">No locations configured yet.</p>
              ) : (
                <ul className="flex flex-col gap-1.5">
                  {locations.map((location) => (
                    <li
                      key={location.id}
                      className="flex items-center justify-between gap-2 rounded-md border border-border/50 px-2.5 py-1.5 text-xs"
                    >
                      <div className="flex flex-col gap-0.5 min-w-0 flex-1">
                        <span className="font-medium truncate" title={location.displayLabel}>
                          {location.displayLabel}
                          <span className="ml-1.5 font-normal text-muted-foreground">
                            {location.scope === "global" ? "Global" : "Project"}
                          </span>
                        </span>
                        <code className="font-mono text-[11px] text-muted-foreground truncate" title={location.configuredRootPath}>
                          {location.configuredRootPath}
                        </code>
                      </div>
                      <div className="flex items-center gap-1.5 shrink-0 text-muted-foreground">
                        <Switch
                          id={`location-enabled-${location.id}`}
                          checked={location.enabled}
                          disabled={locationBusy}
                          onCheckedChange={() => void handleToggleLocation(location)}
                          aria-label={`${location.enabled ? "Disable" : "Enable"} ${location.displayLabel}`}
                          size="sm"
                        />
                        <Label htmlFor={`location-enabled-${location.id}`} className="text-xs font-normal">
                          Enabled
                        </Label>
                      </div>
                    </li>
                  ))}
                </ul>
              )}
              <form onSubmit={handleAddLocation} className="flex flex-col gap-1.5 rounded-md border border-border/50 p-2 bg-muted/20">
                <Input
                  type="text"
                  className="h-8 text-xs"
                  placeholder="Location name, e.g. Fast SSD worktrees"
                  value={newLabel}
                  onChange={(e) => setNewLabel(e.target.value)}
                />
                <Input
                  type="text"
                  className="h-8 text-xs font-mono"
                  placeholder="Directory path, e.g. /mnt/fast/worktrees"
                  value={newPath}
                  onChange={(e) => setNewPath(e.target.value)}
                />
                <div className="flex items-center gap-3 text-xs">
                  <RadioGroup
                    value={newScope}
                    onValueChange={(value) => setNewScope(value as "global" | "project")}
                    className="flex items-center gap-3"
                    aria-label="Location scope"
                  >
                    <div className="flex items-center gap-1.5">
                      <RadioGroupItem id="settings-scope-global" value="global" />
                      <Label htmlFor="settings-scope-global" className="text-xs font-normal cursor-pointer">Global</Label>
                    </div>
                    <div className="flex items-center gap-1.5">
                      <RadioGroupItem id="settings-scope-project" value="project" />
                      <Label htmlFor="settings-scope-project" className="text-xs font-normal cursor-pointer">Project</Label>
                    </div>
                  </RadioGroup>
                  {newScope === "project" && (
                    <Select value={newProjectId} onValueChange={setNewProjectId}>
                      <SelectTrigger className="flex-1 h-8 text-xs" aria-label="Project for location">
                        <SelectValue placeholder="Select project" />
                      </SelectTrigger>
                      <SelectContent>
                        {projects.filter((p) => !p.archivedAt).map((p) => (
                          <SelectItem key={p.id} value={p.id}>{p.displayLabel}</SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  )}
                </div>
                <Button type="submit" size="xs" className="self-start" disabled={locationBusy}>
                  {locationBusy ? "Adding..." : "Add location"}
                </Button>
              </form>
            </section>
          ) : (
            <p className="text-xs text-muted-foreground py-2">Worktree locations are unavailable without an API connection.</p>
          )}
          </TabsContent>
        </Tabs>

          {saveError && (
            <Alert variant="destructive">
              <AlertDescription className="text-xs">{saveError}</AlertDescription>
            </Alert>
          )}

        <div className="flex justify-end gap-2 pt-2">
          <Button variant="secondary" onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button onClick={() => void handleSave()} disabled={busy}>
            {busy ? "Saving..." : "Save Settings"}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
