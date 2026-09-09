import { describe, expect, test } from "bun:test";
import React from "react";
import ReactDOMServer from "react-dom/server";
import { ToolRow, getToolSummary } from "./ToolRow.tsx";
import type { TimelineItem } from "../../shared/domain/agents.ts";

describe("getToolSummary", () => {
  test("identifies bash tool summary", () => {
    const item: Extract<TimelineItem, { kind: "tool" }> = {
      id: "tool-1",
      kind: "tool",
      name: "bash",
      input: { command: "bun test" },
      status: "complete",
      significant: true,
    };
    const summary = getToolSummary(item);
    expect(summary.icon).toBe("command");
    expect(summary.title).toBe("Shell Command");
    expect(summary.subtitle).toBe("bun test");
  });

  test("identifies grep tool summary", () => {
    const item: Extract<TimelineItem, { kind: "tool" }> = {
      id: "tool-2",
      kind: "tool",
      name: "grep",
      input: { pattern: "const foo" },
      status: "complete",
      significant: true,
    };
    const summary = getToolSummary(item);
    expect(summary.icon).toBe("search");
    expect(summary.title).toBe("Search Files");
    expect(summary.subtitle).toBe("const foo");
  });

  test("identifies read tool summary", () => {
    const item: Extract<TimelineItem, { kind: "tool" }> = {
      id: "tool-3",
      kind: "tool",
      name: "read",
      input: { filePath: "/tmp/test.ts" },
      status: "complete",
      significant: true,
    };
    const summary = getToolSummary(item);
    expect(summary.icon).toBe("read");
    expect(summary.title).toBe("Read File");
    expect(summary.subtitle).toBe("/tmp/test.ts");
  });

  test("identifies edit tool summary with path", () => {
    const item: Extract<TimelineItem, { kind: "tool" }> = {
      id: "tool-4",
      kind: "tool",
      name: "edit",
      input: { filePath: "src/web/App.tsx", oldString: "a", newString: "b" },
      status: "complete",
      significant: true,
    };
    const summary = getToolSummary(item);
    expect(summary.icon).toBe("edit");
    expect(summary.title).toBe("Edit File");
    expect(summary.subtitle).toBe("src/web/App.tsx");
    expect(summary.isPath).toBe(true);
  });
});

describe("ToolRow component", () => {
  test("renders bash command input block and output", () => {
    const item: Extract<TimelineItem, { kind: "tool" }> = {
      id: "tool-1",
      kind: "tool",
      name: "bash",
      input: { command: "agent-browser eval '1 + 1'" },
      result: "2",
      status: "complete",
      significant: true,
    };

    const html = ReactDOMServer.renderToStaticMarkup(
      React.createElement(ToolRow, { item })
    );

    expect(html).toContain("tool-command-block");
    expect(html).toContain("agent-browser eval &#x27;1 + 1&#x27;");
    expect(html).toContain("language-bash");
    expect(html).toContain("tool-floating-copy");
  });

  test("renders Edit File with visual diff card", () => {
    const item: Extract<TimelineItem, { kind: "tool" }> = {
      id: "tool-edit",
      kind: "tool",
      name: "edit",
      input: {
        filePath: "src/index.ts",
        oldString: "const greeting = 'hello';",
        newString: "const greeting = 'world';",
      },
      status: "complete",
      significant: true,
    };

    const html = ReactDOMServer.renderToStaticMarkup(
      React.createElement(ToolRow, { item })
    );

    expect(html).toContain("tool-diff-card");
    expect(html).toContain("tool-diff-stat-add");
    expect(html).toContain("+1");
    expect(html).toContain("tool-diff-stat-del");
    expect(html).toContain("-1");
    expect(html).toContain("const greeting = &#x27;hello&#x27;;");
    expect(html).toContain("const greeting = &#x27;world&#x27;;");
    expect(html).toContain("tool-diff-line added");
    expect(html).toContain("tool-diff-line removed");
  });

  test("renders Read File with line gutter and syntax highlighted body", () => {
    const item: Extract<TimelineItem, { kind: "tool" }> = {
      id: "tool-read",
      kind: "tool",
      name: "read",
      input: { filePath: "src/types.ts" },
      result: "1: export type ID = string;\n2: export interface User {\n3:   id: ID;\n4: }",
      status: "complete",
      significant: true,
    };

    const html = ReactDOMServer.renderToStaticMarkup(
      React.createElement(ToolRow, { item })
    );

    expect(html).toContain("tool-read-card");
    expect(html).toContain("tool-read-gutter");
    expect(html).toContain("tool-read-lang-badge");
    expect(html).toContain("typescript");
    expect(html).toContain("4 lines");
    expect(html).toContain("export");
    expect(html).toContain("User");
  });

  test("renders ls/glob results grouped by directory with file icons", () => {
    const item: Extract<TimelineItem, { kind: "tool" }> = {
      id: "tool-glob",
      kind: "tool",
      name: "glob",
      input: { pattern: "src/**/*.ts" },
      result: "src/daemon/index.ts\nsrc/daemon/http.ts\nsrc/web/main.tsx",
      status: "complete",
      significant: true,
    };

    const html = ReactDOMServer.renderToStaticMarkup(
      React.createElement(ToolRow, { item })
    );

    expect(html).toContain("tool-glob-results");
    expect(html).toContain("Found 3 files across 2 directories");
    expect(html).toContain("src/daemon/");
    expect(html).toContain("src/web/");
    expect(html).toContain("index.ts");
    expect(html).toContain("http.ts");
    expect(html).toContain("main.tsx");
  });

  test("renders structured grep matches", () => {
    const item: Extract<TimelineItem, { kind: "tool" }> = {
      id: "tool-2",
      kind: "tool",
      name: "grep",
      input: { pattern: "myFunction", path: "src" },
      result: "src/index.ts:12:export function myFunction() {}\nsrc/utils.ts:50:myFunction();",
      status: "complete",
      significant: true,
    };

    const html = ReactDOMServer.renderToStaticMarkup(
      React.createElement(ToolRow, { item })
    );

    expect(html).toContain("tool-grep-results");
    expect(html).toContain("Found 2 matches across 2 files");
    expect(html).toContain("Line 12:");
    expect(html).toContain("export function myFunction() {}");
    expect(html).toContain("Line 50:");
  });

  test("renders JSON output with toggle button", () => {
    const item: Extract<TimelineItem, { kind: "tool" }> = {
      id: "tool-3",
      kind: "tool",
      name: "bash",
      input: { command: "cat package.json" },
      result: '{"name": "passage", "private": true}',
      status: "complete",
      significant: true,
    };

    const html = ReactDOMServer.renderToStaticMarkup(
      React.createElement(ToolRow, { item })
    );

    expect(html).toContain("Output (JSON)");
    expect(html).toContain("tool-view-toggle-btn");
    expect(html).toContain("Formatted");
    expect(html).toContain("Raw");
    expect(html).toContain("language-json");
  });
});
