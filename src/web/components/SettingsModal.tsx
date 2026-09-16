import React, { useState } from "react";
import type { ThemePack, FontPack } from "../../shared/domain/customization.ts";
import { BUILTIN_THEMES, BUILTIN_FONTS } from "../../shared/domain/customization.ts";
import type { WorkspaceSettings } from "../../shared/domain/settings.ts";
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
import { toast } from "sonner";

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

  React.useEffect(() => {
    setCurrentSettings(settings);
    setNotificationStatus(getNotificationPermission());
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
    }
  }, [open, api, initialLocations, projects]);

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
    try {
      await onSaveSettings(currentSettings);
      onClose();
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
      <DialogContent className="max-w-[500px]">
        <DialogHeader>
          <DialogTitle className="text-lg font-semibold">Workspace Settings</DialogTitle>
        </DialogHeader>

        <div className="flex flex-col gap-4 py-2">
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

          <div className="flex flex-col gap-1.5">
            <Label htmlFor="settings-activity">Agent Activity Detail</Label>
            <Select
              value={currentSettings.agentActivityDetail}
              onValueChange={(value) =>
                setCurrentSettings({
                  ...currentSettings,
                  agentActivityDetail: value as "concise" | "detailed",
                })
              }
            >
              <SelectTrigger id="settings-activity" className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="concise">Concise (Compact activity badges)</SelectItem>
                <SelectItem value="detailed">Detailed (Full tool inputs and outputs)</SelectItem>
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

          {api && (
            <section className="flex flex-col gap-2 border-t border-border/50 pt-3" aria-label="Worktree locations">
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
          )}
        </div>

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
