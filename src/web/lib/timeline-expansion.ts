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
    case "ask":
    case "ask_user":
    case "ask_user_question":
      return "ask";
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
 * Resolves whether a row renders expanded.
 *
 * Under `latest`, only the latest row per group is expanded. A previous
 * latest collapses as soon as a newer row arrives -- earlier rows never stick
 * around expanded, otherwise `latest` degrades into `always` as history grows.
 */
export function isItemExpanded(
  item: TimelineItem | ToolActivity,
  settings: TimelineExpansionSettings,
  latestIds: LatestTimelineIds,
  manualToggles: Record<string, boolean> = {}
): boolean {
  if (manualToggles[item.id] !== undefined) {
    return manualToggles[item.id];
  }

  if (item.kind === "tool") {
    if (item.status === "error") return true;
    if (item.status === "running") return true;

    const canonical = resolveCanonicalTool(item.name);
    // Fall back to otherTools when a persisted expansion predates a
    // baseline tool (e.g. ask), so legacy in-memory settings never crash.
    const mode: ExpandMode =
      canonical === "other" ? settings.otherTools : (settings.tools[canonical] ?? settings.otherTools);

    if (mode === "always") return true;
    if (mode === "none") return false;
    if (mode === "latest") return latestIds.latestToolIds[canonical] === item.id;
    return false;
  }

  if (item.kind === "thinking") {
    const mode = settings.thinking;
    if (mode === "always") return true;
    if (mode === "none") return false;
    if (mode === "latest") return latestIds.latestThinkingId === item.id;
    return false;
  }

  return false;
}
