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
    } else if (item.kind === "process") {
      for (const activity of item.activities) {
        const canonical = resolveCanonicalTool(activity.name);
        latestToolIds[canonical] = activity.id;
      }
    }
  }

  return { latestThinkingId, latestToolIds };
}

export function isItemExpanded(
  item: TimelineItem | ToolActivity,
  settings: TimelineExpansionSettings,
  latestIds: LatestTimelineIds,
  manualToggles: Record<string, boolean> = {},
  concise = false
): boolean {
  if (manualToggles[item.id] !== undefined) {
    return manualToggles[item.id];
  }

  if (item.kind === "tool") {
    if (item.status === "error") return true;
    if (item.status === "running") return true;
    if (concise) return false;

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
    const mode = settings.thinking;
    if (mode === "always") return true;
    if (mode === "none") return false;
    if (mode === "latest") return latestIds.latestThinkingId === item.id;
    return false;
  }

  return false;
}
