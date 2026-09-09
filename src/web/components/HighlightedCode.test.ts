import { beforeAll, describe, expect, test } from "bun:test";
import { ensureHighlighter, getLanguageFromPath, HighlightedCode } from "./HighlightedCode.tsx";
import React from "react";
import ReactDOMServer from "react-dom/server";

describe("getLanguageFromPath", () => {
  test("correctly identifies TypeScript files", () => {
    expect(getLanguageFromPath("/home/matt.cowger/workspace/ybr/src/index.ts")).toBe("typescript");
    expect(getLanguageFromPath("src/components/App.tsx")).toBe("tsx");
    expect(getLanguageFromPath("utils.mts")).toBe("typescript");
  });

  test("correctly identifies shell and bash scripts", () => {
    expect(getLanguageFromPath("deploy.sh")).toBe("bash");
    expect(getLanguageFromPath("setup.bash")).toBe("bash");
    expect(getLanguageFromPath("config.zsh")).toBe("bash");
  });

  test("correctly identifies other common programming languages", () => {
    expect(getLanguageFromPath("index.js")).toBe("javascript");
    expect(getLanguageFromPath("component.jsx")).toBe("jsx");
    expect(getLanguageFromPath("config.json")).toBe("json");
    expect(getLanguageFromPath("styles.css")).toBe("css");
    expect(getLanguageFromPath("script.py")).toBe("python");
    expect(getLanguageFromPath("main.rs")).toBe("rust");
    expect(getLanguageFromPath("server.go")).toBe("go");
    expect(getLanguageFromPath("schema.sql")).toBe("sql");
    expect(getLanguageFromPath("workflow.yml")).toBe("yaml");
    expect(getLanguageFromPath("README.md")).toBe("markdown");
  });

  test("returns undefined for unknown or extensionless paths", () => {
    expect(getLanguageFromPath(undefined)).toBeUndefined();
    expect(getLanguageFromPath("")).toBeUndefined();
    expect(getLanguageFromPath("LICENSE")).toBeUndefined();
    expect(getLanguageFromPath("foo.xyz123")).toBeUndefined();
  });
});

describe("HighlightedCode component", () => {
  beforeAll(async () => {
    await ensureHighlighter();
  });

  test("renders syntax-highlighted tokens for TypeScript code", () => {
    const code = 'import { HStack } from "@earendil-works/pi-tui";';
    const html = ReactDOMServer.renderToStaticMarkup(
      React.createElement(HighlightedCode, {
        code,
        filePath: "/home/matt.cowger/workspace/ybr/src/index.ts",
        className: "tool-output-pre",
      })
    );

    expect(html).toContain("tool-output-pre");
    expect(html).toContain("language-typescript");
    expect(html).toContain("import");
    expect(html).toContain("HStack");
  });

  test("renders syntax-highlighted tokens for bash command", () => {
    const code = 'echo "hello from terminal"';
    const html = ReactDOMServer.renderToStaticMarkup(
      React.createElement(HighlightedCode, {
        code,
        language: "bash",
        className: "tool-command-code",
      })
    );

    expect(html).toContain("tool-command-code");
    expect(html).toContain("language-bash");
    expect(html).toContain("echo");
    expect(html).toContain("hello from terminal");
  });

  test("falls back to plain pre block if language is unknown", () => {
    const code = "Plain text content";
    const html = ReactDOMServer.renderToStaticMarkup(
      React.createElement(HighlightedCode, {
        code,
        filePath: "UNKNOWN_FILE",
        className: "tool-output-pre",
      })
    );

    expect(html).toContain('<pre class="tool-output-pre"><code>Plain text content</code></pre>');
  });
});
