import { beforeAll, describe, expect, test } from "bun:test";
import { createTokenCache, ensureHighlighter, getLanguageFromPath, getTokenCacheEntryBytes, HighlightedCode } from "./HighlightedCode.tsx";
import React from "react";
import ReactDOMServer from "react-dom/server";
import type { ThemedToken } from "shiki/core";

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

describe("highlight token cache", () => {
  const tokens = (content: string): ThemedToken[][] => [[{ content, color: "#fff", offset: 0 }]];

  test("evicts the least-recently-used entry to stay within its byte budget", () => {
    const entry = tokens("cache payload");
    const entryBytes = getTokenCacheEntryBytes(entry);
    const cache = createTokenCache(3, entryBytes * 2);

    cache.set("first", entry);
    cache.set("second", entry);
    expect(cache.get("first")).toBe(entry);

    cache.set("third", entry);

    expect(cache.get("first")).toBe(entry);
    expect(cache.get("second")).toBeNull();
    expect(cache.get("third")).toBe(entry);
    expect(cache.stats()).toEqual({ entries: 2, bytes: entryBytes * 2 });
  });

  test("does not retain a token payload larger than the byte budget", () => {
    const entry = tokens("too large to cache");
    const cache = createTokenCache(1, getTokenCacheEntryBytes(entry) - 1);

    cache.set("large", entry);

    expect(cache.get("large")).toBeNull();
    expect(cache.stats()).toEqual({ entries: 0, bytes: 0 });
  });
});
