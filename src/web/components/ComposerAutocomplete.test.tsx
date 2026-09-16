import { describe, expect, test } from "bun:test";
import React from "react";
import ReactDOMServer from "react-dom/server";
import { renderFileRefs, truncateFileRefPath, TimelineRow } from "./AgentPanel.tsx";

describe("truncateFileRefPath", () => {
  test("keeps short paths intact", () => {
    expect(truncateFileRefPath("src/index.ts")).toBe("src/index.ts");
  });

  test("truncates middle-out preserving the filename suffix", () => {
    const long = `src/${"a".repeat(80)}/index.ts`;
    const truncated = truncateFileRefPath(long);
    expect(truncated.length).toBeLessThanOrEqual(64);
    expect(truncated.endsWith("index.ts")).toBe(true);
    expect(truncated).toContain("…");
  });

  test("truncates very long filenames in the middle", () => {
    const name = `${"b".repeat(100)}.ts`;
    const truncated = truncateFileRefPath(name);
    expect(truncated.length).toBeLessThanOrEqual(64);
    expect(truncated.endsWith(".ts")).toBe(true);
    expect(truncated).toContain("…");
  });
});

describe("renderFileRefs", () => {
  const html = (text: string) =>
    ReactDOMServer.renderToStaticMarkup(React.createElement("p", null, ...renderFileRefs(text)));

  test("renders backticked refs as file chips", () => {
    const out = html("see @`src/index.ts` now");
    expect(out).toContain("file-ref-chip");
    expect(out).toContain("src/index.ts");
    expect(out).toContain("see ");
    expect(out).toContain(" now");
  });

  test("leaves plain text without refs untouched", () => {
    expect(html("hello world")).toBe("<p>hello world</p>");
  });

  test("renders multiple refs and keeps surrounding text", () => {
    const out = html("a @`x.ts` b @`y.ts` c");
    expect(out.match(/file-ref-chip/g)).toHaveLength(2);
    expect(out).toContain("x.ts");
    expect(out).toContain("y.ts");
  });

  test("unknown slash input stays plain prompt text", () => {
    expect(html("please run /unknown-command now")).toBe("<p>please run /unknown-command now</p>");
  });
});

describe("TimelineRow user card", () => {
  test("renders file refs as chips inside the user message card", () => {
    const out = ReactDOMServer.renderToStaticMarkup(
      React.createElement(TimelineRow, {
        concise: false,
        item: { kind: "user", id: "u1", text: "review @`src/index.ts` please" },
      }),
    );
    expect(out).toContain("user-message-card");
    expect(out).toContain("file-ref-chip");
    expect(out).toContain("src/index.ts");
  });
});
