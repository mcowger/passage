import { describe, expect, test } from "bun:test";
import React from "react";
import ReactDOMServer from "react-dom/server";
import { OutputExpansionSection } from "./SettingsModal.tsx";
import { DEFAULT_TIMELINE_EXPANSION } from "../../shared/domain/settings.ts";

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
  });
});
