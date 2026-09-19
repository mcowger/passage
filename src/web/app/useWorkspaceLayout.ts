import { useCallback, useState } from "react";
import type { WorkspaceLayout } from "../../shared/domain/layout.ts";
import { createDefaultLayout, replaceOverviewTabs } from "../../shared/domain/layout.ts";
import type { WorkspaceSettings } from "../../shared/domain/settings.ts";
import { DEFAULT_WORKSPACE_SETTINGS } from "../../shared/domain/settings.ts";
import type { FontOption, ThemePack } from "../../shared/domain/customization.ts";
import { AVAILABLE_FONTS, BUILTIN_THEMES } from "../../shared/domain/customization.ts";
import type { WorkspaceApi } from "../api.ts";
import { applyFontTokens, applyThemeTokens } from "./appHelpers.tsx";

/**
 * Per-workspace canvas layout, settings, themes, and fonts. Owns loading,
 * persistence, and theme application; App just reads and renders.
 */
export function useWorkspaceLayout(api: WorkspaceApi, workspaceId: string | undefined) {
  const [layout, setLayout] = useState<WorkspaceLayout>();
  const [settings, setSettings] = useState<WorkspaceSettings>(DEFAULT_WORKSPACE_SETTINGS);
  const [themes, setThemes] = useState<ThemePack[]>(BUILTIN_THEMES);
  const [fontOptions, setFontOptions] = useState<FontOption[]>(AVAILABLE_FONTS);
  const loadLayoutAndSettings = useCallback(async (workspaceId: string) => {
    try {
      const [fetchedLayout, fetchedSettings, fetchedThemes, fetchedFontOptions] = await Promise.all([
        api.getLayout(workspaceId)
          .then((l) => ({ ...l, root: replaceOverviewTabs(l.root) }))
          .catch(() => createDefaultLayout(workspaceId)),
        api.getSettings(workspaceId).catch(() => DEFAULT_WORKSPACE_SETTINGS),
        api.getThemes().catch(() => BUILTIN_THEMES),
        api.getFontOptions().catch(() => AVAILABLE_FONTS),
      ]);
      setLayout(fetchedLayout);
      setSettings(fetchedSettings);
      setThemes(fetchedThemes);
      setFontOptions(fetchedFontOptions);

      const activeTheme = fetchedThemes.find((t) => t.id === fetchedSettings.themeId) ?? fetchedThemes[0];
      applyThemeTokens(activeTheme);
      applyFontTokens(fetchedSettings.fonts, fetchedFontOptions);
    } catch {}
  }, [api]);
  const handleLayoutChange = useCallback(
    (nextLayout: WorkspaceLayout) => {
      setLayout(nextLayout);
      if (workspaceId) {
        void api.saveLayout(workspaceId, nextLayout).catch(() => {});
      }
    },
    [api, workspaceId]
  );
  const handleSaveSettings = useCallback(
    async (nextSettings: WorkspaceSettings) => {
      // Shared fields (theme/fonts/prompts/suggestion model/default display
      // options) are stored globally: adopt the server-merged snapshot so
      // local state never diverges from what a restart or another workspace
      // will read back.
      const saved = workspaceId
        ? await api.saveSettings(workspaceId, nextSettings)
        : nextSettings;
      setSettings(saved);
      const activeTheme = themes.find((t) => t.id === saved.themeId) ?? themes[0];
      applyThemeTokens(activeTheme);
      applyFontTokens(saved.fonts, fontOptions);
    },
    [api, workspaceId, themes, fontOptions]
  );
  return {
    layout,
    setLayout,
    settings,
    themes,
    fontOptions,
    loadLayoutAndSettings,
    handleLayoutChange,
    handleSaveSettings,
  };
}
