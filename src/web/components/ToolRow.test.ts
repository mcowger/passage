import { describe, expect, test } from "bun:test";
import React from "react";
import ReactDOMServer from "react-dom/server";
import { ToolRow, getExtraToolSummary, getReadToolImagePath, getShellOutputPreview, getToolSummary, toWorkspaceRelativePath } from "./ToolRow.tsx";
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

describe("toWorkspaceRelativePath", () => {
    test("strips the workspace root from absolute paths", () => {
      expect(toWorkspaceRelativePath("/work/wt/packages/backend/src/routes/mcp/plexus/index.ts", "/work/wt")).toBe(
        "packages/backend/src/routes/mcp/plexus/index.ts"
      );
    });

    test("leaves paths outside the workspace unchanged", () => {
      expect(toWorkspaceRelativePath("/tmp/test.ts", "/work/wt")).toBe("/tmp/test.ts");
    });

    test("leaves relative paths unchanged", () => {
      expect(toWorkspaceRelativePath("src/a.ts", "/work/wt")).toBe("src/a.ts");
    });

    test("ignores a prefix that is not a path segment boundary", () => {
      expect(toWorkspaceRelativePath("/work/wt-other/a.ts", "/work/wt")).toBe("/work/wt-other/a.ts");
    });

    test("tolerates a trailing slash on the workspace root", () => {
      expect(toWorkspaceRelativePath("/work/wt/a.ts", "/work/wt/")).toBe("a.ts");
    });
  });

describe("getToolSummary with workspaceRoot", () => {
    test("relativizes absolute read/edit/write paths inside the workspace", () => {
      const root = "/work/wt";
      for (const name of ["read", "edit", "write"] as const) {
        const item: Extract<TimelineItem, { kind: "tool" }> = {
          id: `tool-${name}`,
          kind: "tool",
          name,
          input: { path: `${root}/packages/backend/src/index.ts` },
          status: "complete",
        };
        expect(getToolSummary(item, root).subtitle).toBe("packages/backend/src/index.ts");
      }
    });

    test("keeps absolute paths outside the workspace", () => {
      const item: Extract<TimelineItem, { kind: "tool" }> = {
        id: "tool-outside",
        kind: "tool",
        name: "read",
        input: { path: "/tmp/test.ts" },
        status: "complete",
      };
      expect(getToolSummary(item, "/work/wt").subtitle).toBe("/tmp/test.ts");
    });
  });

describe("ToolRow with workspaceRoot", () => {
    const root = "/work/wt";
    const abs = `${root}/packages/backend/src/index.ts`;

    test("row shows the relative path with the absolute path as tooltip", () => {
      const item: Extract<TimelineItem, { kind: "tool" }> = {
        id: "tool-row-rel",
        kind: "tool",
        name: "read",
        input: { path: abs },
        result: "1: hello\n",
        status: "complete",
      };
      const html = ReactDOMServer.renderToStaticMarkup(
        React.createElement(ToolRow, { item, workspaceRoot: root })
      );
      expect(html).toContain("packages/backend/src/index.ts");
      expect(html).toContain(`title="${abs}"`);
      expect(html).toContain('class="tool-path-dir">packages/backend/src/');
    });

    test("edit diff preview shows the relative path", () => {
      const item: Extract<TimelineItem, { kind: "tool" }> = {
        id: "tool-diff-rel",
        kind: "tool",
        name: "edit",
        input: { filePath: abs, oldString: "a", newString: "b" },
        status: "complete",
      };
      const html = ReactDOMServer.renderToStaticMarkup(
        React.createElement(ToolRow, { item, workspaceRoot: root, open: true })
      );
      expect(html).toContain("tool-diff-card");
      expect(html).toContain("packages/backend/src/index.ts");
    });

    test("read output card shows the relative path", () => {
      const item: Extract<TimelineItem, { kind: "tool" }> = {
        id: "tool-read-rel",
        kind: "tool",
        name: "read",
        input: { path: abs },
        result: "1: hello\n",
        status: "complete",
      };
      const html = ReactDOMServer.renderToStaticMarkup(
        React.createElement(ToolRow, { item, workspaceRoot: root, open: true })
      );
      expect(html).toContain("tool-read-card");
      expect(html).toContain("packages/backend/src/index.ts");
    });

    test("row shows the relative path while args are still streaming", () => {
      const streaming: Extract<TimelineItem, { kind: "tool" }> = {
        id: "tool-pending-rel",
        kind: "tool",
        name: "edit",
        input: { rawInput: `{"path":"${abs}"` },
        status: "running",
      } as any;
      const html = ReactDOMServer.renderToStaticMarkup(
        React.createElement(ToolRow, { item: streaming, workspaceRoot: root, open: true })
      );
      expect(html).toContain("packages/backend/src/index.ts");
      expect(html).toContain('class="tool-path-dir">packages/backend/src/');
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

describe("extra tool summaries match on substring + shape", () => {
  test("exa search uses the query", () => {
    const item: Extract<TimelineItem, { kind: "tool" }> = {
      id: "t1", kind: "tool", name: "exa_web_search_exa",
      input: { query: "Bun allowedHosts", objective: "Find docs" },
      status: "complete",
    };
    const s = getToolSummary(item);
    expect(s.title).toBe("Web search");
    expect(s.subtitle).toBe("Bun allowedHosts");
    expect(s.icon).toBe("web");
  });

  test("prefixed names still match when the shape confirms", () => {
    const item: Extract<TimelineItem, { kind: "tool" }> = {
      id: "t2", kind: "tool", name: "mcp_exa_web_search_exa",
      input: { query: "frp docs" },
      status: "complete",
    };
    expect(getToolSummary(item).title).toBe("Web search");
    const file: Extract<TimelineItem, { kind: "tool" }> = {
      id: "t3", kind: "tool", name: "ns_github_get_file_contents",
      input: { owner: "fatedier", repo: "frp", path: "/" },
      status: "complete",
    };
    expect(getToolSummary(file).title).toBe("GitHub file");
  });

  test("wrong shape falls back to generic", () => {
    const item: Extract<TimelineItem, { kind: "tool" }> = {
      id: "t4", kind: "tool", name: "exa_web_search_exa",
      input: { urls: ["https://a"] },
      status: "complete",
    };
    // urls shape does not confirm a search-named tool -- stays generic.
    expect(getToolSummary(item).title).toBe("exa_web_search_exa");
  });

  test("github actions get vs list vs trigger", () => {
    const get = getExtraToolSummary("gh-actions-get", { owner: "mcowger", repo: "olive", resource_id: "35358512186" });
    expect(get.title).toBe("Actions run");
    const list = getExtraToolSummary("gh-actions-list", { owner: "mcowger", repo: "olive" });
    expect(list.title).toBe("Actions runs");
    const trig = getExtraToolSummary("gh-actions-trigger", { workflow_id: "docker-publish.yml", ref: "main" });
    expect(trig.subtitle).toBe("docker-publish.yml @ main");
  });

  test("process summary combines action and target", () => {
    const item: Extract<TimelineItem, { kind: "tool" }> = {
      id: "t5", kind: "tool", name: "process",
      input: { action: "start", name: "llama-persist" },
      status: "complete",
    };
    const s = getToolSummary(item);
    expect(s.title).toBe("Process");
    expect(s.subtitle).toBe("start llama-persist");
    expect(s.icon).toBe("system");
  });

  test("every extra family has a distinct icon", () => {
    expect(getExtraToolSummary("exa-fetch", { urls: ["https://a"] }).icon).toBe("download");
    expect(getExtraToolSummary("exa-agent", { query: "q" }).icon).toBe("agent");
    expect(getExtraToolSummary("github-file", { owner: "o", repo: "r", path: "/" }).icon).toBe("filecode");
    expect(getExtraToolSummary("github-code", { query: "q" }).icon).toBe("codesearch");
    expect(getExtraToolSummary("github-repos", { query: "q" }).icon).toBe("package");
    expect(getExtraToolSummary("gh-actions-get", { owner: "o", repo: "r", resource_id: "1" }).icon).toBe("activity");
    expect(getExtraToolSummary("gh-actions-list", { owner: "o", repo: "r" }).icon).toBe("list");
    expect(getExtraToolSummary("github-pr", { owner: "o", repo: "r", pullNumber: 1, method: "get" }).icon).toBe("pr");
    expect(getExtraToolSummary("gh-actions-trigger", { workflow_id: "ci.yml", ref: "main" }).icon).toBe("trigger");
    expect(getExtraToolSummary("recall", { query: "q" }).icon).toBe("recall");
  });

  test("recall summary uses query or touched mode", () => {
    expect(getExtraToolSummary("recall", { query: "nilskluewer", scope: "all" }).subtitle).toBe("nilskluewer");
    expect(getExtraToolSummary("recall", { mode: "touched" }).subtitle).toBe("touched");
  });
});

describe("extra tool output views", () => {
  function render(item: Extract<TimelineItem, { kind: "tool" }>): string {
    return ReactDOMServer.renderToStaticMarkup(React.createElement(ToolRow, { item, open: true }));
  }

  test("exa search renders result titles", () => {
    const html = render({
      id: "x1", kind: "tool", name: "exa_web_search_exa",
      input: { query: "frp", objective: "Find docs" },
      result: "Title: fatedier/frp | URL: https://github.com/fatedier/frp | Published: N/A | Author: N/A | Highlights:\nbody\n---\nTitle: Other | URL: https://example.com | Published: 2026-01-01 | Author: Jane | Highlights:\nmore",
      status: "complete",
    });
    expect(html).toContain("Results · 2");
    expect(html).toContain("fatedier/frp");
    expect(html).toContain("https://github.com/fatedier/frp");
  });

  test("github dir listing renders entries", () => {
    const html = render({
      id: "x2", kind: "tool", name: "github_get_file_contents",
      input: { owner: "fatedier", repo: "frp", path: "/" },
      result: JSON.stringify([
        { type: "dir", size: 0, name: ".github", path: ".github" },
        { type: "file", size: 324, name: ".gitignore", path: ".gitignore" },
      ]),
      status: "complete",
    });
    expect(html).toContain("Contents · 1 files, 1 dirs");
    expect(html).toContain(".gitignore");
  });

  test("code search renders matches", () => {
    const html = render({
      id: "x3", kind: "tool", name: "github_search_code",
      input: { query: "RegisterProxyFlags", perPage: 10 },
      result: JSON.stringify({ total_count: 1, items: [{ name: "flags.go", path: "pkg/config/flags.go", repository: "fatedier/frp", text_matches: [{ fragment: "func RegisterProxyFlags(cmd", matches: [] }] }] }),
      status: "complete",
    });
    expect(html).toContain("Matches · 1");
    expect(html).toContain("RegisterProxyFlags");
  });

  test("repo search renders stars", () => {
    const html = render({
      id: "x4", kind: "tool", name: "github_search_repositories",
      input: { query: "paseo" },
      result: JSON.stringify({ total_count: 1, items: [{ full_name: "getpaseo/paseo", description: "Orchestrate", language: "TypeScript", stargazers_count: 17147 }] }),
      status: "complete",
    });
    expect(html).toContain("getpaseo/paseo");
    expect(html).toContain("17147");
  });

  test("actions run renders status card", () => {
    const html = render({
      id: "x5", kind: "tool", name: "github_actions_get",
      input: { method: "get_workflow_run", owner: "mcowger", repo: "olive", resource_id: "35358512186" },
      result: JSON.stringify({ id: 1, name: "CI", display_title: "fix(plaud)", status: "completed", conclusion: "success", head_branch: "main", run_number: 40, event: "push" }),
      status: "complete",
    });
    expect(html).toContain("Run #40");
    expect(html).toContain("fix(plaud)");
  });

  test("PR get renders number and title", () => {
    const html = render({
      id: "x6", kind: "tool", name: "github_pull_request_read",
      input: { method: "get", owner: "openai", repo: "codex", pullNumber: 29602 },
      result: JSON.stringify({ number: 29602, title: "Flatten namespace tools" }),
      status: "complete",
    });
    expect(html).toContain("PR #29602");
    expect(html).toContain("Flatten namespace tools");
  });

  test("recall renders entries", () => {
    const html = render({
      id: "x7", kind: "tool", name: "vcc_recall",
      input: { query: "nilskluewer", scope: "all", page: 1 },
      result: 'Page 1/8 (40 total matches (scope: all)) for "q":\n\n#393 [tool_result] some preview',
      status: "complete",
    });
    expect(html).toContain("40 matches");
    expect(html).toContain("#393");
  });

  test("process renders status", () => {
    const html = render({
      id: "x8", kind: "tool", name: "process",
      input: { action: "start", name: "llama-persist" },
      result: 'Started process llama-persist (proc_000f) with pid 1333879.',
      status: "complete",
    });
    expect(html).toContain("Status");
    expect(html).toContain("llama-persist");
  });
});

describe("getShellOutputPreview", () => {
  test("returns full text when output fits in the preview", () => {
    const preview = getShellOutputPreview("a\nb\nc");
    expect(preview.totalLines).toBe(3);
    expect(preview.truncatedLines).toBe(0);
    expect(preview.previewText).toBe("a\nb\nc");
  });

  test("slices long output down to its last lines", () => {
    const text = ["l1", "l2", "l3", "l4", "l5", "l6", "l7"].join("\n");
    const preview = getShellOutputPreview(text);
    expect(preview.totalLines).toBe(7);
    expect(preview.truncatedLines).toBe(2);
    expect(preview.previewText).toBe(["l3", "l4", "l5", "l6", "l7"].join("\n"));
  });

  test("trailing newline does not count as an extra line", () => {
    const preview = getShellOutputPreview("a\nb\n");
    expect(preview.totalLines).toBe(2);
    expect(preview.truncatedLines).toBe(0);
  });
});

describe("ToolRow shell output preview", () => {
  test("long bash output previews the tail with a show-all toggle", () => {
    const item: Extract<TimelineItem, { kind: "tool" }> = {
      id: "tool-long-bash",
      kind: "tool",
      name: "bash",
      input: { command: "npm test" },
      result: ["line1", "line2", "line3", "line4", "line5", "line6", "line7"].join("\n"),
      status: "complete",
    };

    const html = ReactDOMServer.renderToStaticMarkup(
      React.createElement(ToolRow, { item })
    );

    expect(html).toContain("shell-output-block");
    expect(html).toContain("Showing last 5 of 7 lines");
    expect(html).toContain("Show all 7 lines");
    // Tail is visible; the head is truncated away.
    expect(html).toContain("line7");
    expect(html).not.toContain("line1");
  });

  test("short bash output renders without a toggle", () => {
    const item: Extract<TimelineItem, { kind: "tool" }> = {
      id: "tool-short-bash",
      kind: "tool",
      name: "bash",
      input: { command: "echo hi" },
      result: "hi",
      status: "complete",
    };

    const html = ReactDOMServer.renderToStaticMarkup(
      React.createElement(ToolRow, { item })
    );

    expect(html).toContain("shell-output-block");
    expect(html).not.toContain("Show all");
  });

  test("shellOutputMode full renders the complete output", () => {
    const item: Extract<TimelineItem, { kind: "tool" }> = {
      id: "tool-full-bash",
      kind: "tool",
      name: "bash",
      input: { command: "npm test" },
      result: ["line1", "line2", "line3", "line4", "line5", "line6", "line7"].join("\n"),
      status: "complete",
    };

    const html = ReactDOMServer.renderToStaticMarkup(
      React.createElement(ToolRow, { item, shellOutputMode: "full" })
    );

    expect(html).toContain("line1");
    expect(html).toContain("line7");
    expect(html).toContain("Show less");
    expect(html).not.toContain("Showing last");
  });
});
