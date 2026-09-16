import type { Extension } from "@codemirror/state";
import { StreamLanguage } from "@codemirror/language";
import { javascript } from "@codemirror/lang-javascript";
import { json } from "@codemirror/lang-json";
import { markdown } from "@codemirror/lang-markdown";
import { python } from "@codemirror/lang-python";
import { go } from "@codemirror/lang-go";
import { rust } from "@codemirror/lang-rust";
import { cpp } from "@codemirror/lang-cpp";
import { html } from "@codemirror/lang-html";
import { css } from "@codemirror/lang-css";
import { sql } from "@codemirror/lang-sql";
import { yaml } from "@codemirror/lang-yaml";
import { shell } from "@codemirror/legacy-modes/mode/shell";
import { toml } from "@codemirror/legacy-modes/mode/toml";
import { dockerFile } from "@codemirror/legacy-modes/mode/dockerfile";

const shellSupport = StreamLanguage.define(shell);
const tomlSupport = StreamLanguage.define(toml);
const dockerfileSupport = StreamLanguage.define(dockerFile);

function basenameOf(path: string): string {
  return path.split(/[\\/]/).pop()?.toLowerCase() ?? "";
}

function isDockerfileName(basename: string): boolean {
  return (
    basename === "dockerfile" ||
    basename === "containerfile" ||
    basename.startsWith("dockerfile.") ||
    basename.startsWith("containerfile.") ||
    basename.endsWith(".dockerfile")
  );
}

function isShellDotfile(basename: string): boolean {
  return (
    basename === ".bashrc" ||
    basename === ".bash_profile" ||
    basename === ".bash_history" ||
    basename === ".zshrc" ||
    basename === ".profile"
  );
}

/**
 * Return the CodeMirror language extension for a file path.
 * Uses first-party CodeMirror language packages (Lezer-based where
 * available, `StreamLanguage` wrappers around `@codemirror/legacy-modes`
 * for shell/TOML/Dockerfile). Unknown files fall back to `[]` (plain text).
 */
export function getLanguageExtensionForPath(path: string): Extension {
  const basename = basenameOf(path.trim());
  if (!basename) return [];
  if (isDockerfileName(basename)) return dockerfileSupport;
  if (isShellDotfile(basename)) return shellSupport;

  const ext = basename.includes(".") ? basename.split(".").pop() ?? "" : "";
  switch (ext) {
    case "ts":
    case "tsx":
    case "mts":
    case "cts":
      return javascript({ typescript: true, jsx: true });
    case "js":
    case "jsx":
    case "mjs":
    case "cjs":
      return javascript({ jsx: true });
    case "json":
    case "jsonc":
      return json();
    case "md":
    case "markdown":
    case "mdx":
      return markdown();
    case "py":
    case "pyw":
    case "pyi":
      return python();
    case "go":
      return go();
    case "rs":
      return rust();
    case "c":
    case "h":
    case "hh":
    case "hpp":
    case "hxx":
    case "cpp":
    case "cc":
    case "cxx":
      return cpp();
    case "html":
    case "htm":
    case "xhtml":
    case "xml":
    case "svg":
      return html();
    case "css":
    case "scss":
    case "less":
      return css();
    case "sh":
    case "bash":
    case "zsh":
    case "ksh":
    case "dash":
      return shellSupport;
    case "yaml":
    case "yml":
      return yaml();
    case "toml":
      return tomlSupport;
    case "sql":
      return sql();
    case "dockerfile":
      return dockerfileSupport;
    default:
      return [];
  }
}
