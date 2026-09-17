import { describe, expect, test } from "bun:test";
import React from "react";
import ReactDOMServer from "react-dom/server";
import { isMobileComposerViewport, renderComposerDraft, shouldSubmitOnEnter } from "./ComposerEditor.tsx";

describe("renderComposerDraft", () => {
  const html = (text: string) =>
    ReactDOMServer.renderToStaticMarkup(React.createElement("div", null, ...renderComposerDraft(text)));

  test("renders file refs as atomic composer mentions", () => {
    const out = html("Review @`src/index.ts` before sending");
    expect(out).toContain("composer-file-mention");
    expect(out).toContain("data-composer-raw=\"@`src/index.ts`\"");
    expect(out).toContain("file-type-icon");
    expect(out).toContain("src/index.ts");
  });

  test("renders skill refs as atomic composer mentions with a cap icon", () => {
    const out = html("Try /skill:gh-cli for this");
    expect(out).toContain("composer-skill-mention");
    expect(out).toContain("data-composer-raw=\"/skill:gh-cli\"");
    expect(out).toContain("<svg");
    expect(out).toContain("/skill:gh-cli");
  });

  test("keeps ordinary draft text ordinary", () => {
    expect(html("hello world")).toBe("<div>hello world</div>");
  });
});

describe("isMobileComposerViewport", () => {
  test("treats narrow viewports as mobile", () => {
    expect(isMobileComposerViewport(767, false)).toBe(true);
    expect(isMobileComposerViewport(768, false)).toBe(false);
  });

  test("treats coarse pointers as mobile even on wide viewports", () => {
    expect(isMobileComposerViewport(1280, true)).toBe(true);
    expect(isMobileComposerViewport(1280, false)).toBe(false);
  });
});

describe("shouldSubmitOnEnter", () => {
  test("desktop plain Enter submits", () => {
    expect(shouldSubmitOnEnter({ shiftKey: false }, false)).toBe(true);
  });

  test("Shift+Enter never submits", () => {
    expect(shouldSubmitOnEnter({ shiftKey: true }, false)).toBe(false);
    expect(shouldSubmitOnEnter({ shiftKey: true }, true)).toBe(false);
  });

  test("mobile plain Enter does not submit", () => {
    expect(shouldSubmitOnEnter({ shiftKey: false }, true)).toBe(false);
  });

  test("mobile Cmd/Ctrl+Enter still submits for hardware keyboards", () => {
    expect(shouldSubmitOnEnter({ shiftKey: false, metaKey: true }, true)).toBe(true);
    expect(shouldSubmitOnEnter({ shiftKey: false, ctrlKey: true }, true)).toBe(true);
  });
});
