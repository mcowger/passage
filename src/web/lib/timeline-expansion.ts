import type { TimelineItem, ToolActivity } from "../../shared/domain/agents.ts";
import type {
  BaselineTool,
  ExpandMode,
  TimelineExpansionSettings,
} from "../../shared/domain/settings.ts";

export interface LatestTimelineIds {
  latestThinkingId?: string;
  latestToolIds: Partial<Record<BaselineTool | "other", string>>;
}

export function resolveCanonicalTool(name: string): BaselineTool | "other" {
  const normalized = name.toLowerCase().trim();
  switch (normalized) {
    case "read":
    case "readfile":
      return "read";
    case "write":
    case "writefile":
      return "write";
    case "edit":
    case "editfile":
    case "multiedit":
    case "apply_patch":
      return "edit";
    case "bash":
    case "command":
      return "bash";
    case "find":
    case "glob":
      return "find";
    case "grep":
      return "grep";
    case "ls":
    case "list":
    case "list_dir":
      return "ls";
    default:
      return "other";
  }
}

export function computeLatestTimelineIds(timeline: TimelineItem[]): LatestTimelineIds {
  let latestThinkingId: string | undefined;
  const latestToolIds: Partial<Record<BaselineTool | "other", string>> = {};

  for (const item of timeline) {
    if (item.kind === "thinking") {
      latestThinkingId = item.id;
    } else if (item.kind === "tool") {
      const canonical = resolveCanonicalTool(item.name);
      latestToolIds[canonical] = item.id;
    }
  }

  return { latestThinkingId, latestToolIds };
}

/**
 * Adds every row that currently renders expanded to `previous`, returning
 * `previous` itself when nothing changed so memoized rows keep their identity.
 */
export function collectExpandedIds(
  timeline: TimelineItem[],
  settings: TimelineExpansionSettings,
  latestIds: LatestTimelineIds,
  manualToggles: Record<string, boolean>,
  concise: boolean,
  previous: ReadonlySet<string>
): ReadonlySet<string> {
  let next: Set<string> | undefined;
  const add = (item: TimelineItem | ToolActivity) => {
    if (previous.has(item.id)) return;
    if (!isItemExpanded(item, settings, latestIds, manualToggles, concise, previous)) return;
    next ??= new Set(previous);
    next.add(item.id);
  };
  for (const item of timeline) {
    if (item.kind === "tool" || item.kind === "thinking") add(item);
  }
  return next ?? previous;
}

/**
 * Resolves whether a row renders expanded.
 *
 * `stickyExpandedIds` holds rows this client has already shown expanded. An
 * auto-expansion is never taken back: under `latest` a finishing tool would
 * otherwise collapse the previous one, and collapsing a multi-thousand-pixel
 * block above the viewport shifts everything below it while new output is still
 * streaming in. Only an explicit toggle (or concise mode) collapses a row.
 */
export function isItemExpanded(
  item: TimelineItem | ToolActivity,
  settings: TimelineExpansionSettings,
  latestIds: LatestTimelineIds,
  manualToggles: Record<string, boolean> = {},
  concise = false,
  stickyExpandedIds?: ReadonlySet<string>
): boolean {
  if (manualToggles[item.id] !== undefined) {
    return manualToggles[item.id];
  }

  if (item.kind === "tool") {
    if (item.status === "error") return true;
    if (item.status === "running") return true;
    if (concise) return false;
    if (stickyExpandedIds?.has(item.id)) return true;

    const canonical = resolveCanonicalTool(item.name);
    const mode: ExpandMode =
      canonical === "other" ? settings.otherTools : settings.tools[canonical];

    if (mode === "always") return true;
    if (mode === "none") return false;
    if (mode === "latest") return latestIds.latestToolIds[canonical] === item.id;
    return false;
  }

  if (item.kind === "thinking") {
    if (concise) return false;
    if (stickyExpandedIds?.has(item.id)) return true;
    const mode = settings.thinking;
    if (mode === "always") return true;
    if (mode === "none") return false;
    if (mode === "latest") return latestIds.latestThinkingId === item.id;
    return false;
  }

  return false;
}
