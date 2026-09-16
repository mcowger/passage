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
          <label className="flex flex-col gap-1 text-sm font-medium">
            <span>Color Theme</span>
            <select
              className="rounded-md border border-input bg-background px-3 py-2 text-sm shadow-xs focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
              value={currentSettings.themeId}
              onChange={(e) => setCurrentSettings({ ...currentSettings, themeId: e.target.value })}
            >
              {themes.map((theme) => (
                <option key={theme.id} value={theme.id}>
                  {theme.name} ({theme.mode})
                </option>
              ))}
            </select>
          </label>

          <label className="flex flex-col gap-1 text-sm font-medium">
            <span>Font Family</span>
            <select
              className="rounded-md border border-input bg-background px-3 py-2 text-sm shadow-xs focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
              value={currentSettings.fontId}
              onChange={(e) => setCurrentSettings({ ...currentSettings, fontId: e.target.value })}
            >
              {fonts.map((font) => (
                <option key={font.id} value={font.id}>
                  {font.name}
                </option>
              ))}
            </select>
          </label>

          <label className="flex flex-col gap-1 text-sm font-medium">
            <span>Agent Activity Detail</span>
            <select
              className="rounded-md border border-input bg-background px-3 py-2 text-sm shadow-xs focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
              value={currentSettings.agentActivityDetail}
              onChange={(e) =>
                setCurrentSettings({
                  ...currentSettings,
                  agentActivityDetail: e.target.value as "concise" | "detailed",
                })
              }
            >
              <option value="concise">Concise (Compact activity badges)</option>
              <option value="detailed">Detailed (Full tool inputs and outputs)</option>
            </select>
          </label>

          <div className="flex flex-col gap-1">
            <label className="flex items-center gap-2 text-sm font-medium cursor-pointer">
              <input
                type="checkbox"
                className="rounded border-input text-primary focus:ring-ring"
                checked={currentSettings.notificationsEnabled}
                onChange={(e) => void handleToggleNotifications(e.target.checked)}
              />
              <span>Browser Notifications on Agent Completion</span>
            </label>
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
                <div className="p-2 text-xs bg-destructive/10 border border-destructive/20 text-destructive rounded" role="alert">
                  {locationError}
                </div>
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
                      <label className="flex items-center gap-1.5 shrink-0 cursor-pointer text-muted-foreground">
                        <input
                          type="checkbox"
                          checked={location.enabled}
                          disabled={locationBusy}
                          onChange={() => void handleToggleLocation(location)}
                          aria-label={`${location.enabled ? "Disable" : "Enable"} ${location.displayLabel}`}
                        />
                        Enabled
                      </label>
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
                  <label className="flex items-center gap-1 cursor-pointer">
                    <input type="radio" name="settings-location-scope" checked={newScope === "global"} onChange={() => setNewScope("global")} />
                    Global
                  </label>
                  <label className="flex items-center gap-1 cursor-pointer">
                    <input type="radio" name="settings-location-scope" checked={newScope === "project"} onChange={() => setNewScope("project")} />
                    Project
                  </label>
                  {newScope === "project" && (
                    <select
                      className="rounded-md border border-input bg-background px-2 py-1 text-xs flex-1"
                      value={newProjectId}
                      onChange={(e) => setNewProjectId(e.target.value)}
                      aria-label="Project for location"
                    >
                      {projects.filter((p) => !p.archivedAt).map((p) => (
                        <option key={p.id} value={p.id}>{p.displayLabel}</option>
                      ))}
                    </select>
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
