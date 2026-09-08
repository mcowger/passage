import React, { useState } from "react";
import type { ThemePack, FontPack } from "../../shared/domain/customization.ts";
import { BUILTIN_THEMES, BUILTIN_FONTS } from "../../shared/domain/customization.ts";
import type { WorkspaceSettings } from "../../shared/domain/settings.ts";
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
}

export function SettingsModal({
  open,
  onClose,
  settings,
  onSaveSettings,
  themes = BUILTIN_THEMES,
  fonts = BUILTIN_FONTS,
}: SettingsModalProps) {
  const [currentSettings, setCurrentSettings] = useState<WorkspaceSettings>(settings);
  const [busy, setBusy] = useState(false);
  const [notificationStatus, setNotificationStatus] = useState<string>(getNotificationPermission());

  React.useEffect(() => {
    setCurrentSettings(settings);
    setNotificationStatus(getNotificationPermission());
  }, [settings, open]);

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
