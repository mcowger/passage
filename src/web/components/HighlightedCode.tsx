import { useEffect, useState, type CSSProperties } from "react";
import { Highlight, themes } from "prism-react-renderer";

export type HighlightedCodeProps = {
  code: string;
  language?: string;
  filePath?: string;
  className?: string;
  style?: CSSProperties;
};

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
      return "markup";
    case "md":
    case "markdown":
    case "mdx":
      return "markdown";
    case "py":
    case "python":
      return "python";
    case "rs":
    case "rust":
      return "rust";
    case "go":
      return "go";
    case "c":
    case "h":
      return "c";
    case "cpp":
    case "hpp":
    case "cc":
    case "cxx":
      return "cpp";
    case "yaml":
    case "yml":
      return "yaml";
    case "sql":
      return "sql";
    case "graphql":
    case "gql":
      return "graphql";
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
  const resolvedLang = language || getLanguageFromPath(filePath);
  const isDark = useIsDarkMode();
  const theme = isDark ? themes.vsDark : themes.vsLight;

  if (!resolvedLang || code.length > 250000) {
    return (
      <pre className={className} style={style}>
        <code>{code}</code>
      </pre>
    );
  }

  return (
    <Highlight theme={theme} code={code.trimEnd()} language={resolvedLang}>
      {({ className: highlightClass, style: highlightStyle, tokens, getLineProps, getTokenProps }) => (
        <pre
          className={`${className ?? ""} ${highlightClass}`.trim()}
          style={{
            ...style,
            ...highlightStyle,
            backgroundColor: undefined,
          }}
        >
          <code>
            {tokens.map((line, i) => {
              const isEmpty =
                line.length === 0 ||
                (line.length === 1 && (!line[0].content || line[0].content === "\n"));
              return (
                <div key={i} {...getLineProps({ line })}>
                  {isEmpty ? (
                    <span>{"\n"}</span>
                  ) : (
                    line.map((token, key) => <span key={key} {...getTokenProps({ token })} />)
                  )}
                </div>
              );
            })}
          </code>
        </pre>
      )}
    </Highlight>
  );
}
