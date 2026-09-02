import React, { useState } from "react";
import type { ThemePack, FontPack } from "../../shared/domain/customization.ts";
import { BUILTIN_THEMES, BUILTIN_FONTS } from "../../shared/domain/customization.ts";
import type { WorkspaceSettings } from "../../shared/domain/settings.ts";
import { requestNotificationPermission, getNotificationPermission } from "../notifications.ts";

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

  if (!open) return null;

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
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal settings-modal" onClick={(e) => e.stopPropagation()} role="dialog" aria-label="Settings">
        <button className="icon-button close" onClick={onClose} aria-label="Close dialog">
          ×
        </button>
        <h2>Workspace Settings</h2>

        <div className="settings-section">
          <label>
            <span>Color Theme</span>
            <select
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
        </div>

        <div className="settings-section">
          <label>
            <span>Font Family</span>
            <select
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
        </div>

        <div className="settings-section">
          <label>
            <span>Agent Activity Detail</span>
            <select
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
        </div>

        <div className="settings-section">
          <label className="checkbox-label">
            <input
              type="checkbox"
              checked={currentSettings.notificationsEnabled}
              onChange={(e) => void handleToggleNotifications(e.target.checked)}
            />
            <span>Browser Notifications on Agent Completion</span>
          </label>
          <small className="form-help">
            Permission state: <code>{notificationStatus}</code>. Notifications only fire when tab is inactive.
          </small>
        </div>

        <div className="settings-section">
          <label>
            <span>Terminal Font Size</span>
            <input
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

        <div className="form-actions">
          <button className="secondary" onClick={onClose} disabled={busy}>
            Cancel
          </button>
          <button className="primary" onClick={() => void handleSave()} disabled={busy}>
            {busy ? "Saving..." : "Save Settings"}
          </button>
        </div>
      </div>
    </div>
  );
}
