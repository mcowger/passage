import { describe, expect, test } from "bun:test";
import React from "react";
import ReactDOMServer from "react-dom/server";
import { renderComposerDraft } from "./ComposerEditor.tsx";

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

  test("keeps ordinary draft text ordinary", () => {
    expect(html("hello world")).toBe("<div>hello world</div>");
  });
});
