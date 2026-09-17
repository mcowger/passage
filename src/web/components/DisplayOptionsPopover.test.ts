import { describe, expect, test } from "bun:test";
import React from "react";
import ReactDOMServer from "react-dom/server";
import { DisplayOptionsPopover } from "./DisplayOptionsPopover.tsx";
import { DEFAULT_TIMELINE_EXPANSION } from "../../shared/domain/settings.ts";

describe("DisplayOptionsPopover", () => {
  test("renders trigger button with aria label", () => {
    const html = ReactDOMServer.renderToStaticMarkup(
      React.createElement(DisplayOptionsPopover, {
        expansion: DEFAULT_TIMELINE_EXPANSION,
        onExpansionChange: () => {},
        onResetDefaults: () => {},
        isOverridden: false,
      }),
    );

    expect(html).toContain("composer-icon-btn");
    expect(html).toContain('aria-label="Display expansion settings (session only)"');
  });

  test("renders override indicator dot when session is overridden", () => {
    const html = ReactDOMServer.renderToStaticMarkup(
      React.createElement(DisplayOptionsPopover, {
        expansion: {
          ...DEFAULT_TIMELINE_EXPANSION,
          thinking: "always",
        },
        onExpansionChange: () => {},
        onResetDefaults: () => {},
        isOverridden: true,
      }),
    );

    expect(html).toContain("rounded-full bg-primary");
  });
});
