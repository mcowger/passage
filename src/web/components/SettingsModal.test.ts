import { describe, expect, test } from "bun:test";
import React from "react";
import ReactDOMServer from "react-dom/server";
import { FontMappingSection, OutputExpansionSection } from "./SettingsModal.tsx";
import { DEFAULT_FONT_MAPPING } from "../../shared/domain/customization.ts";
import { AVAILABLE_FONTS } from "../../shared/domain/customization.ts";
import { DEFAULT_TIMELINE_EXPANSION } from "../../shared/domain/settings.ts";

describe("FontMappingSection", () => {
  test("renders a selector per font role with a live preview", () => {
    const html = ReactDOMServer.renderToStaticMarkup(
      React.createElement(FontMappingSection, {
        mapping: { ...DEFAULT_FONT_MAPPING, mono: "jetbrains-mono", xterm: "fira-code" },
        options: AVAILABLE_FONTS,
        onMappingChange: () => {},
      }),
    );

    expect(html).toContain("settings-font-ui");
    expect(html).toContain("settings-font-mono");
    expect(html).toContain("settings-font-editor");
    expect(html).toContain("settings-font-xterm");
    expect(html).toContain("Font preview");
    // The preview renders the selected families inline.
    expect(html).toContain("JetBrains Mono");
    expect(html).toContain("Fira Code");
  });
});

describe("OutputExpansionSection", () => {
  test("renders Output & Tool Expansion section with all baseline tools and thinking", () => {
    const html = ReactDOMServer.renderToStaticMarkup(
      React.createElement(OutputExpansionSection, {
        expansion: DEFAULT_TIMELINE_EXPANSION,
        onExpansionChange: () => {},
      }),
    );

    expect(html).toContain("Output &amp; Tool Expansion");
    expect(html).toContain("Thinking Output");
    expect(html).toContain("Baseline Tools");
    expect(html).toContain("Other Tools (MCP, extensions)");
    expect(html).toContain("settings-expand-thinking");
    expect(html).toContain("settings-tool-read");
    expect(html).toContain("settings-tool-write");
    expect(html).toContain("settings-tool-edit");
    expect(html).toContain("settings-tool-bash");
    expect(html).toContain("settings-tool-find");
    expect(html).toContain("settings-tool-grep");
    expect(html).toContain("settings-tool-ls");
    expect(html).toContain("settings-tool-ask");
    expect(html).toContain("settings-shell-output");
    expect(html).toContain("Shell output (bash)");
  });
});

describe("suggestThinkingOptions", () => {
  test("lists only the chosen model's supported levels", async () => {
    const { suggestThinkingOptions } = await import("./SettingsModal.tsx");
    const models = [
      { provider: "p", id: "a", name: "A", api: "t", input: ["text"], authenticated: true, supportedThinkingLevels: ["low", "high"] },
      { provider: "p", id: "b", name: "B", api: "t", input: ["text"], authenticated: true, supportedThinkingLevels: ["medium", "high", "xhigh"] },
    ];
    expect(suggestThinkingOptions(models, "p/a")).toEqual(["low", "high"]);
    expect(suggestThinkingOptions(models, "p/b")).toEqual(["medium", "high", "xhigh"]);
    expect(suggestThinkingOptions(models, "p/unknown", ["low"])).toEqual(["low"]);
  });

  test("falls back to global levels for models without an explicit list", async () => {
    const { suggestThinkingOptions } = await import("./SettingsModal.tsx");
    const models = [
      { provider: "plexus", id: "nemotron-3-nano-30b-a3b", name: "Nemotron", api: "t", input: ["text"], authenticated: true, supportedThinkingLevels: [] },
    ];
    const fallback = ["off", "minimal", "low", "medium", "high"];
    expect(suggestThinkingOptions(models, "plexus/nemotron-3-nano-30b-a3b", fallback)).toEqual(fallback);
  });

  test("prefers global levels when pi default is selected", async () => {
    const { suggestThinkingOptions } = await import("./SettingsModal.tsx");
    const models = [
      { provider: "p", id: "a", name: "A", api: "t", input: ["text"], authenticated: true, supportedThinkingLevels: ["low", "high"] },
      { provider: "p", id: "b", name: "B", api: "t", input: ["text"], authenticated: true, supportedThinkingLevels: ["medium", "high"] },
    ];
    expect(suggestThinkingOptions(models, "", ["off", "minimal", "low", "medium", "high"])).toEqual(["off", "minimal", "low", "medium", "high"]);
  });

  test("unions every known level when pi default is selected without a fallback", async () => {
    const { suggestThinkingOptions } = await import("./SettingsModal.tsx");
    const models = [
      { provider: "p", id: "a", name: "A", api: "t", input: ["text"], authenticated: true, supportedThinkingLevels: ["low", "high"] },
      { provider: "p", id: "b", name: "B", api: "t", input: ["text"], authenticated: true, supportedThinkingLevels: ["medium", "high"] },
    ];
    expect(suggestThinkingOptions(models, "")).toEqual(["low", "high", "medium"]);
  });
});
