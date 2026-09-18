import { describe, expect, test } from "bun:test";
import React from "react";
import ReactDOMServer from "react-dom/server";
import { ToolRow, getReadToolImagePath, getToolSummary } from "./ToolRow.tsx";
import type { TimelineItem } from "../../shared/domain/agents.ts";

describe("getToolSummary", () => {
  test("identifies bash tool summary", () => {
    const item: Extract<TimelineItem, { kind: "tool" }> = {
      id: "tool-1",
      kind: "tool",
      name: "bash",
      input: { command: "bun test" },
      status: "complete",
    };
    const summary = getToolSummary(item);
    expect(summary.icon).toBe("command");
    expect(summary.title).toBe("Shell");
    expect(summary.subtitle).toBe("bun test");
  });

  test("identifies grep tool summary", () => {
    const item: Extract<TimelineItem, { kind: "tool" }> = {
      id: "tool-2",
      kind: "tool",
      name: "grep",
      input: { pattern: "const foo" },
      status: "complete",
    };
    const summary = getToolSummary(item);
    expect(summary.icon).toBe("search");
    expect(summary.title).toBe("Search");
    expect(summary.subtitle).toBe("const foo");
  });

  test("identifies read tool summary", () => {
    const item: Extract<TimelineItem, { kind: "tool" }> = {
      id: "tool-3",
      kind: "tool",
      name: "read",
      input: { filePath: "/tmp/test.ts" },
      status: "complete",
    };
    const summary = getToolSummary(item);
    expect(summary.icon).toBe("read");
    expect(summary.title).toBe("Read");
    expect(summary.subtitle).toBe("/tmp/test.ts");
  });

  test("identifies edit tool summary with path", () => {
    const item: Extract<TimelineItem, { kind: "tool" }> = {
      id: "tool-4",
      kind: "tool",
      name: "edit",
      input: { filePath: "src/web/App.tsx", oldString: "a", newString: "b" },
      status: "complete",
    };
    const summary = getToolSummary(item);
    expect(summary.icon).toBe("edit");
    expect(summary.title).toBe("Edit");
    expect(summary.subtitle).toBe("src/web/App.tsx");
    expect(summary.isPath).toBe(true);
  });

  test("identifies find tool summary with pattern", () => {
    const item: Extract<TimelineItem, { kind: "tool" }> = {
      id: "tool-find",
      kind: "tool",
      name: "find",
      input: { pattern: "src/web/components/*.tsx" },
      status: "complete",
    };
    const summary = getToolSummary(item);
    expect(summary.icon).toBe("search");
    expect(summary.title).toBe("Find");
    expect(summary.subtitle).toBe("src/web/components/*.tsx");
  });
});

describe("ToolRow component", () => {
  test("recognizes absolute image paths from model reads", () => {
    const item: Extract<TimelineItem, { kind: "tool" }> = {
      id: "tool-read-image",
      kind: "tool",
      name: "read",
      input: { path: "/tmp/test.png" },
      result: "Read image file [image/png]",
      status: "complete",
    };

    expect(getReadToolImagePath(item)).toBe("/tmp/test.png");
  });

  test("rejects traversal paths for model-read image previews", () => {
    const item: Extract<TimelineItem, { kind: "tool" }> = {
      id: "tool-read-image-traversal",
      kind: "tool",
      name: "read",
      input: { path: "../test.png" },
      status: "complete",
    };

    expect(getReadToolImagePath(item)).toBeUndefined();
  });

  test("renders bash command input block and output", () => {
    const item: Extract<TimelineItem, { kind: "tool" }> = {
      id: "tool-1",
      kind: "tool",
      name: "bash",
      input: { command: "agent-browser eval '1 + 1'" },
      result: "2",
      status: "complete",
    };

    const html = ReactDOMServer.renderToStaticMarkup(
      React.createElement(ToolRow, { item })
    );

    expect(html).toContain("tool-command-block");
    expect(html).toContain("agent-browser eval &#x27;1 + 1&#x27;");
    expect(html).toContain("language-bash");
    expect(html).toContain("tool-floating-copy");
  });

  test("renders edit with visual diff card", () => {
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

  test("renders read with line gutter and syntax highlighted body", () => {
    const item: Extract<TimelineItem, { kind: "tool" }> = {
      id: "tool-read",
      kind: "tool",
      name: "read",
      input: { filePath: "src/types.ts" },
      result: "1: export type ID = string;\n2: export interface User {\n3:   id: ID;\n4: }",
      status: "complete",
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

  test("renders find results grouped by directory like list", () => {
    const item: Extract<TimelineItem, { kind: "tool" }> = {
      id: "tool-find",
      kind: "tool",
      name: "find",
      input: { pattern: "src/web/components/*.tsx" },
      result:
        "src/web/components/AgentPanel.tsx\nsrc/web/components/AgentSessionPanel.tsx\nsrc/web/components/ChangesPanel.tsx",
      status: "complete",
    };

    const html = ReactDOMServer.renderToStaticMarkup(
      React.createElement(ToolRow, { item })
    );

    expect(html).toContain("tool-glob-results");
    expect(html).toContain("Found 3 files across 1 directory");
    expect(html).toContain("src/web/components/");
    expect(html).toContain("AgentPanel.tsx");
    expect(html).toContain("AgentSessionPanel.tsx");
    expect(html).toContain("ChangesPanel.tsx");
  });

  test("renders structured grep matches", () => {
    const item: Extract<TimelineItem, { kind: "tool" }> = {
      id: "tool-2",
      kind: "tool",
      name: "grep",
      input: { pattern: "myFunction", path: "src" },
      result: "src/index.ts:12:export function myFunction() {}\nsrc/utils.ts:50:myFunction();",
      status: "complete",
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

  test("does not render [object Object] when result is a Pi RPC result object", () => {
    const item: Extract<TimelineItem, { kind: "tool" }> = {
      id: "tool-obj",
      kind: "tool",
      name: "bash",
      input: { command: "grep -rn 'port' src/" },
      // Simulating if an unextracted object is passed as result
      result: {
        content: [{ type: "text", text: "src/server.ts:47: port: number," }],
      } as any,
      status: "complete",
    };

    const html = ReactDOMServer.renderToStaticMarkup(
      React.createElement(ToolRow, { item })
    );

    expect(html).not.toContain("[object Object]");
    expect(html).toContain("src/server.ts:47:");
    expect(html).toContain("port:");
    expect(html).toContain("number,");
  });

  test("running edit with streaming rawInput shows pending skeleton, not raw JSON", () => {
    const item: Extract<TimelineItem, { kind: "tool" }> = {
      id: "tool-pending-edit",
      kind: "tool",
      name: "edit",
      input: { rawInput: "" },
      status: "running",
    } as any;

    const html = ReactDOMServer.renderToStaticMarkup(
      React.createElement(ToolRow, { item })
    );

    expect(html).not.toContain("rawInput");
    expect(html).toContain("Preparing edit");
    expect(html).toContain("tool-pending-skeleton");
  });

  test("running bash with complete input shows command plus running indicator", () => {
    const item: Extract<TimelineItem, { kind: "tool" }> = {
      id: "tool-running-bash",
      kind: "tool",
      name: "bash",
      input: { command: "sleep 30" },
      status: "running",
    };

    const html = ReactDOMServer.renderToStaticMarkup(
      React.createElement(ToolRow, { item })
    );

    expect(html).toContain("sleep 30");
    expect(html).toContain("Running command");
    expect(html).not.toContain("rawInput");
    // Nothing output yet -- skeleton is correct here.
    expect(html).toContain("tool-pending-skeleton");
  });

  test("running bash with partial output shows output so far, not skeleton", () => {
    const item: Extract<TimelineItem, { kind: "tool" }> = {
      id: "tool-running-bash-partial",
      kind: "tool",
      name: "bash",
      input: { command: "npm test" },
      result: "partial line 1\npartial line 2",
      status: "running",
    };

    const html = ReactDOMServer.renderToStaticMarkup(
      React.createElement(ToolRow, { item })
    );

    expect(html).toContain("npm test");
    // Syntax highlighting splits words into spans, so assert on the
    // output wrapper + individual tokens rather than the raw string.
    expect(html).toContain("tool-output-wrap");
    expect(html).toContain("partial");
    expect(html).toContain("tool-running-footer");
    expect(html).not.toContain("tool-pending-skeleton");
  });

  test("running bash with whitespace-only result still shows skeleton", () => {
    const item: Extract<TimelineItem, { kind: "tool" }> = {
      id: "tool-running-bash-blank",
      kind: "tool",
      name: "bash",
      input: { command: "npm test" },
      result: "   \n  ",
      status: "running",
    };

    const html = ReactDOMServer.renderToStaticMarkup(
      React.createElement(ToolRow, { item })
    );

    expect(html).toContain("tool-pending-skeleton");
    expect(html).not.toContain("tool-running-footer");
  });

  test("partial rawInput still surfaces path/command in the summary", () => {
    const edit: Extract<TimelineItem, { kind: "tool" }> = {
      id: "tool-partial-edit",
      kind: "tool",
      name: "edit",
      input: { rawInput: '{"path":"src/a.ts","oldSt' },
      status: "running",
    } as any;
    expect(getToolSummary(edit).subtitle).toBe("src/a.ts");

    const bash: Extract<TimelineItem, { kind: "tool" }> = {
      id: "tool-partial-bash",
      kind: "tool",
      name: "bash",
      input: { rawInput: '{"command":"sleep' },
      status: "running",
    } as any;
    expect(getToolSummary(bash).subtitle).toBe("sleep");
  });

  test("suppresses display if result is the string [object Object]", () => {
    const item: Extract<TimelineItem, { kind: "tool" }> = {
      id: "tool-literal-obj",
      kind: "tool",
      name: "bash",
      input: { command: "echo test" },
      result: "[object Object]",
      status: "complete",
    };

    const html = ReactDOMServer.renderToStaticMarkup(
      React.createElement(ToolRow, { item })
    );

    expect(html).not.toContain("[object Object]");
  });
});
