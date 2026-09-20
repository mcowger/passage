import type { TimelineItem } from "../../../shared/domain/agents.ts";
import { identifyExtraTool } from "../../lib/extra-tool-renderers.ts";
import { extractToolResultText } from "../../lib/tool-display.ts";

/** Streaming tool args arrive as `{ rawInput: "<partial JSON>" }` until
 *  `toolcall_end` replaces them with the parsed object. Unwrap that shape so
 *  running rows can still show a path/command instead of nothing. */
export function getEffectiveToolInput(item: Extract<TimelineItem, { kind: "tool" }>): Record<string, unknown> {
  if (typeof item.input === "string") {
    const trimmed = item.input.trim();
    if (!trimmed) return {};
    // Bare-string inputs are almost always a shell command.
    return item.name === "bash" ? { command: item.input } : { text: item.input };
  }
  const input = (item.input ?? {}) as Record<string, unknown>;
  const raw = typeof input.rawInput === "string" ? input.rawInput : undefined;
  const rest = { ...input };
  delete rest.rawInput;
  const hasRealFields = Object.keys(rest).length > 0;
  if (raw === undefined || raw.trim() === "") return hasRealFields ? rest : {};
  const parsed = tryParseRawInput(raw);
  if (parsed && Object.keys(parsed).length > 0) return hasRealFields ? { ...parsed, ...rest } : parsed;
  return hasRealFields ? rest : {};
}

function tryParseRawInput(raw: string): Record<string, unknown> | undefined {
  try {
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
    return undefined;
  } catch {
    // Partial JSON while streaming -- best-effort regex for the fields the
    // summary + pending UI care about.
    const out: Record<string, unknown> = {};
    for (const key of ["path", "filePath", "filename", "command", "pattern", "include"]) {
      // Closing quote is optional so a still-streaming `"key": "partial` value matches.
      const match = new RegExp(`"${key}"\\s*:\\s*"((?:\\\\.|[^"\\\\])*)"?`).exec(raw);
      if (match) {
        try {
          out[key] = JSON.parse(`"${match[1]}"`);
        } catch {
          out[key] = match[1];
        }
      }
    }
    return Object.keys(out).length > 0 ? out : undefined;
  }
}

/** True when the tool's args are still streaming (only a `rawInput` fragment)
 *  or entirely absent -- i.e. there is nothing meaningful to render yet. */
export function isPendingToolInput(item: Extract<TimelineItem, { kind: "tool" }>): boolean {
  return Object.keys(getEffectiveToolInput(item)).length === 0;
}

export function hasRenderableInput(name: string, effective: Record<string, unknown>): boolean {
  if (Object.keys(effective).length === 0) return false;
  const n = name.toLowerCase();
  if (n === "bash" || n === "command") return typeof effective.command === "string" && effective.command.trim() !== "";
  if (n === "grep") return Boolean(effective.pattern ?? effective.path ?? effective.include);
  if (n === "glob" || n === "ls" || n === "list" || n === "list_dir" || n === "find") {
    return Boolean(effective.pattern ?? effective.path);
  }
  if (n === "read" || n === "readfile") return Boolean(effective.path ?? effective.filePath ?? effective.filename);
  if (n.includes("edit") || n.includes("patch") || n.includes("write") || n.includes("create")) {
    return Boolean(
      effective.path ?? effective.filePath ?? effective.filename ??
      effective.oldString ?? effective.oldText ?? effective.newString ?? effective.newText ??
      effective.content ?? effective.text ?? effective.patch ?? effective.edits
    );
  }
  const extra = identifyExtraTool(name, effective);
  if (extra) {
    switch (extra) {
      case "exa-search": return Boolean(effective.query ?? effective.objective);
      case "exa-fetch": return Array.isArray(effective.urls) && effective.urls.length > 0;
      case "exa-agent": return Boolean(effective.query);
      case "github-file": return Boolean(effective.owner && effective.repo && (effective.path !== undefined));
      case "github-code": case "github-repos": return Boolean(effective.query);
      case "gh-actions-get": return Boolean(effective.owner && effective.repo && (effective.resource_id !== undefined || effective.method));
      case "gh-actions-list": return Boolean(effective.owner && effective.repo);
      case "github-pr": return Boolean(effective.pullNumber && effective.method);
      case "gh-actions-trigger": return Boolean(effective.workflow_id && effective.ref);
      case "recall": return Boolean(effective.query ?? effective.mode ?? effective.scope);
      case "process": return Boolean(effective.action);
    }
  }
  return true;
}

export function hasRenderableOutput(result: unknown): boolean {
  if (result === undefined || result === null) return false;
  const text = typeof result === "string" ? result : extractToolResultText(result) ?? "";
  const trimmed = text.trim();
  return trimmed !== "" && trimmed !== "[object Object]";
}

/** Strip the workspace root from an absolute tool path for display.
 *  Returns the workspace-relative path when `path` is inside
 *  `workspaceRoot`, otherwise returns `path` unchanged. */
export function toWorkspaceRelativePath(path: string, workspaceRoot?: string): string {
  if (!path || !workspaceRoot) return path;
  if (!path.startsWith("/")) return path;
  const normalize = (p: string) => (p.length > 1 ? p.replace(/\/+$/, "") : p);
  const root = normalize(workspaceRoot);
  if (!root || !root.startsWith("/")) return path;
  if (path === root) return path;
  if (root === "/") return path.replace(/^\/+/, "");
  if (path.startsWith(`${root}/`)) return path.slice(root.length + 1);
  return path;
}
