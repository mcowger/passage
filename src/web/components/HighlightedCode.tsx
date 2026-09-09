import { useEffect, useState, type CSSProperties } from "react";
import { createHighlighterCore, type HighlighterCore, type ThemedToken } from "shiki/core";
import { createJavaScriptRegexEngine } from "shiki/engine/javascript";

import bashLang from "shiki/langs/bash.mjs";
import jsonLang from "shiki/langs/json.mjs";
import tsLang from "shiki/langs/typescript.mjs";
import jsLang from "shiki/langs/javascript.mjs";
import tsxLang from "shiki/langs/tsx.mjs";
import jsxLang from "shiki/langs/jsx.mjs";
import diffLang from "shiki/langs/diff.mjs";
import mdLang from "shiki/langs/markdown.mjs";
import pyLang from "shiki/langs/python.mjs";
import rustLang from "shiki/langs/rust.mjs";
import goLang from "shiki/langs/go.mjs";
import htmlLang from "shiki/langs/html.mjs";
import cssLang from "shiki/langs/css.mjs";
import yamlLang from "shiki/langs/yaml.mjs";
import sqlLang from "shiki/langs/sql.mjs";

import vitesseDark from "shiki/themes/vitesse-dark.mjs";
import vitesseLight from "shiki/themes/vitesse-light.mjs";

export type HighlightedCodeProps = {
  code: string;
  language?: string;
  filePath?: string;
  className?: string;
  style?: CSSProperties;
};

let cachedHighlighter: HighlighterCore | null = null;
let highlighterPromise: Promise<HighlighterCore> | null = null;

export async function ensureHighlighter(): Promise<HighlighterCore> {
  if (cachedHighlighter) return cachedHighlighter;
  if (!highlighterPromise) {
    highlighterPromise = createHighlighterCore({
      themes: [vitesseDark, vitesseLight],
      langs: [
        bashLang,
        jsonLang,
        tsLang,
        jsLang,
        tsxLang,
        jsxLang,
        diffLang,
        mdLang,
        pyLang,
        rustLang,
        goLang,
        htmlLang,
        cssLang,
        yamlLang,
        sqlLang,
      ],
      engine: createJavaScriptRegexEngine(),
    })
      .then((hl) => {
        cachedHighlighter = hl;
        return hl;
      })
      .catch((err) => {
        console.error("Failed to initialize Shiki highlighter:", err);
        throw err;
      });
  }
  return highlighterPromise;
}

// Start warming up the highlighter eagerly
void ensureHighlighter();

export function normalizeLanguage(lang?: string): string | undefined {
  if (!lang) return undefined;
  const lower = lang.trim().toLowerCase();
  switch (lower) {
    case "bash":
    case "sh":
    case "shell":
    case "zsh":
      return "bash";
    case "typescript":
    case "ts":
    case "mts":
    case "cts":
      return "typescript";
    case "tsx":
      return "tsx";
    case "javascript":
    case "js":
    case "mjs":
    case "cjs":
      return "javascript";
    case "jsx":
      return "jsx";
    case "json":
    case "jsonc":
    case "json5":
      return "json";
    case "diff":
    case "patch":
      return "diff";
    case "markdown":
    case "md":
    case "mdx":
      return "markdown";
    case "python":
    case "py":
      return "python";
    case "rust":
    case "rs":
      return "rust";
    case "go":
      return "go";
    case "html":
    case "htm":
    case "svg":
    case "xml":
    case "markup":
      return "html";
    case "css":
    case "scss":
    case "less":
      return "css";
    case "yaml":
    case "yml":
      return "yaml";
    case "sql":
      return "sql";
    default:
      return lower;
  }
}

export function getLanguageFromPath(path?: string): string | undefined {
  if (!path) return undefined;
  const cleaned = path.trim().split(/[?#]/)[0];
  const filename = cleaned.split(/[\\/]/).pop()?.toLowerCase();
  if (!filename) return undefined;

  const ext = filename.includes(".") ? filename.split(".").pop() : undefined;
  if (!ext) return undefined;

  switch (ext) {
    case "ts":
    case "mts":
    case "cts":
      return "typescript";
    case "tsx":
      return "tsx";
    case "js":
    case "mjs":
    case "cjs":
      return "javascript";
    case "jsx":
      return "jsx";
    case "json":
    case "jsonc":
    case "json5":
      return "json";
    case "css":
    case "scss":
    case "less":
      return "css";
    case "html":
    case "htm":
    case "svg":
    case "xml":
      return "html";
    case "md":
    case "markdown":
    case "mdx":
      return "markdown";
    case "py":
    case "python":
      return "python";
    case "rs":
      return "rust";
    case "go":
      return "go";
    case "yaml":
    case "yml":
      return "yaml";
    case "sql":
      return "sql";
    case "sh":
    case "bash":
    case "zsh":
      return "bash";
    case "diff":
    case "patch":
      return "diff";
    default:
      return undefined;
  }
}

function useIsDarkMode(): boolean {
  const [isDark, setIsDark] = useState(() => {
    if (typeof document === "undefined") return false;
    return (
      document.documentElement.dataset.themeMode === "dark" ||
      document.documentElement.classList.contains("dark")
    );
  });

  useEffect(() => {
    if (typeof document === "undefined" || typeof MutationObserver === "undefined") return;
    const observer = new MutationObserver(() => {
      const dark =
        document.documentElement.dataset.themeMode === "dark" ||
        document.documentElement.classList.contains("dark");
      setIsDark(dark);
    });
    observer.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ["data-theme-mode", "class"],
    });
    return () => observer.disconnect();
  }, []);

  return isDark;
}

export function HighlightedCode({
  code,
  language,
  filePath,
  className,
  style,
}: HighlightedCodeProps) {
  const resolvedLang = normalizeLanguage(language) || getLanguageFromPath(filePath);
  const isDark = useIsDarkMode();
  const [highlighter, setHighlighter] = useState<HighlighterCore | null>(cachedHighlighter);

  useEffect(() => {
    if (!cachedHighlighter) {
      void ensureHighlighter().then((hl) => setHighlighter(hl));
    }
  }, []);

  if (!resolvedLang || code.length > 250000) {
    return (
      <pre className={className} style={style}>
        <code>{code}</code>
      </pre>
    );
  }

  const activeHighlighter = highlighter || cachedHighlighter;
  let tokens: ThemedToken[][] | null = null;

  if (activeHighlighter) {
    const loadedLangs = activeHighlighter.getLoadedLanguages();
    const targetLang = loadedLangs.includes(resolvedLang) ? resolvedLang : "text";
    try {
      const result = activeHighlighter.codeToTokens(code.trimEnd(), {
        lang: targetLang,
        theme: isDark ? "vitesse-dark" : "vitesse-light",
      });
      tokens = result.tokens;
    } catch {
      tokens = null;
    }
  }

  const langClass = `language-${resolvedLang}`;
  const preClass = `${className ?? ""} ${langClass}`.trim();

  if (!tokens) {
    return (
      <pre className={preClass} style={style}>
        <code>{code}</code>
      </pre>
    );
  }

  return (
    <pre className={preClass} style={{ ...style, backgroundColor: undefined }}>
      <code>
        {tokens.map((line, i) => {
          const isEmpty =
            line.length === 0 ||
            (line.length === 1 && (!line[0].content || line[0].content === "\n"));
          return (
            <div key={i} className="line">
              {isEmpty ? (
                <span>{"\n"}</span>
              ) : (
                line.map((token, key) => (
                  <span
                    key={key}
                    style={{
                      color: token.color,
                      fontStyle: token.fontStyle && token.fontStyle & 1 ? "italic" : undefined,
                      fontWeight: token.fontStyle && token.fontStyle & 2 ? "bold" : undefined,
                      textDecoration:
                        token.fontStyle && token.fontStyle & 4 ? "underline" : undefined,
                    }}
                  >
                    {token.content}
                  </span>
                ))
              )}
            </div>
          );
        })}
      </code>
    </pre>
  );
}
