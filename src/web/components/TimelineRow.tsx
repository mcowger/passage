import { memo } from "react";
import type { ReactNode } from "react";
import { Streamdown } from "streamdown";
import type { TimelineExpansionSettings } from "../../shared/domain/settings.ts";
import { DEFAULT_TIMELINE_EXPANSION } from "../../shared/domain/settings.ts";
import type { TimelineItem, ToolActivity } from "../../shared/domain/agents.ts";
import type { WorkspaceApi } from "../api.ts";
import { ToolRow } from "./ToolRow.tsx";
import { FileTypeIcon } from "./FileTypeIcon.tsx";
import { splitSkillRefs } from "./skillRefs.ts";
import { getToolDiff } from "../lib/tool-diff.ts";
import { isItemExpanded, type LatestTimelineIds } from "../lib/timeline-expansion.ts";
import { STREAM_PHASE_LABELS, formatByteCount, type StreamPhase } from "../lib/stream-activity.ts";
import { Alert, AlertDescription, AlertTitle } from "./ui/alert.tsx";
import { UserImageStrip, UserFileStrip } from "./UserImages.tsx";
import {
  Brain,
  CircleAlert,
  FilePenLine,
  GraduationCap,
  MessageSquareMore,
  PencilSparkles,
  RotateCwFadingClock,
  Scissors,
  Wrench,
} from "lucide-react";

export function formatDuration(seconds: number): string {
  if (seconds < 60) {
    return `${seconds.toFixed(1)}s`;
  }
  const mins = Math.floor(seconds / 60);
  const remSecs = (seconds % 60).toFixed(0).padStart(2, "0");
  return `${mins}m ${remSecs}s`;
}

export function formatIdleSinceLastFrame(idleSeconds: number | null): string {
  if (idleSeconds == null || !Number.isFinite(idleSeconds) || idleSeconds < 0) return "\u2014";
  if (idleSeconds < 60) return `${idleSeconds.toFixed(1)}s`;
  return formatDuration(idleSeconds);
}

/** Latest full-line bold heading (e.g. `**Thinking Summary 2**`) in thinking
 *  text, if any. Models that structure thinking with bold summary lines get a
 *  live status in the collapsed row: as new summaries stream in, the preview
 *  follows the most recent one instead of showing the start of the text.
 *  Lines with inline bold mid-sentence do not count -- the whole trimmed line
 *  must be a single bold span. A missing closing marker is tolerated so a
 *  summary still shows while it is streaming in. */
export function extractLatestThinkingSummary(text: string): string | undefined {
  let latest: string | undefined;
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (!line) continue;
    for (const marker of ["**", "__"]) {
      if (!line.startsWith(marker)) continue;
      let inner = line.slice(marker.length);
      if (inner.endsWith(marker)) inner = inner.slice(0, -marker.length);
      // Inline bold elsewhere on the line means this is prose, not a heading.
      if (!inner || inner.includes(marker)) break;
      const cleaned = inner.replace(/`([^`]+)`/g, "$1").replace(/\s+/g, " ").trim();
      if (cleaned) latest = cleaned;
      break;
    }
  }
  return latest;
}

export function formatThinkingPreview(text: string, maxLength = 70): string {
  const summary = extractLatestThinkingSummary(text);
  if (summary) return summary.slice(0, maxLength);
  return text
    .replace(/^(?:#{1,6}\s+|[-*+]\s+|\d+[.)]\s+)/gm, "")
    .replace(/(\*\*|__|~~)(?=\S)([\s\S]*?\S)\1/g, "$2")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, maxLength);
}

const STREAM_PHASE_ICONS = {
  thinking: Brain,
  responding: MessageSquareMore,
  "composing-tool-call": FilePenLine,
  "running-tool": Wrench,
  "receiving-tool-result": PencilSparkles,
} as const satisfies Record<StreamPhase, typeof Brain>;

export const LiveStreamPhase = memo(function LiveStreamPhase({
  phase,
  receiving,
}: {
  phase: StreamPhase | null;
  receiving: boolean;
}) {
  if (!phase) return <span className="live-stream-phase" aria-hidden="true" />;
  const Icon = STREAM_PHASE_ICONS[phase];
  const label = STREAM_PHASE_LABELS[phase];
  return (
    <span
      className={`live-stream-phase${receiving ? " is-receiving" : ""}`}
      title={label}
      role="img"
      aria-label={label}
    >
      <Icon size={11} aria-hidden="true" />
    </span>
  );
});

export const LiveStreamTraffic = memo(function LiveStreamTraffic({
  bytes,
  idleSeconds,
}: {
  bytes: number;
  idleSeconds: number | null;
}) {
  const idleText = formatIdleSinceLastFrame(idleSeconds);
  const title =
    idleSeconds == null
      ? `${bytes.toLocaleString()} bytes this run (live wire traffic), waiting for first frame`
      : `${bytes.toLocaleString()} bytes this run (live wire traffic), last frame ${idleText} ago`;
  return (
    <span className="composer-status-traffic" aria-hidden="true" title={title}>
      <span aria-hidden="true">·</span>
      <span className="composer-status-bytes">{formatByteCount(bytes)}</span>
      <span aria-hidden="true">·</span>
      <span className="composer-status-idle">
        <RotateCwFadingClock size={11} aria-hidden="true" />
        <span className="composer-status-idle-text">{idleText}</span>
      </span>
    </span>
  );
});

export function truncateFileRefPath(path: string, maxLength = 64): string {
  if (path.length <= maxLength) return path;
  const slash = path.lastIndexOf("/");
  const name = slash >= 0 ? path.slice(slash + 1) : path;
  if (name.length >= maxLength - 1) {
    const keep = Math.max(8, maxLength - 2);
    const head = Math.ceil(keep / 2);
    return `${name.slice(0, head)}\u2026${name.slice(name.length - (keep - head))}`;
  }
  const dir = slash >= 0 ? path.slice(0, slash) : "";
  const keepDir = Math.max(0, maxLength - name.length - 2);
  return `\u2026${dir.slice(dir.length - keepDir)}/${name}`;
}

const FILE_REF_PATTERN = /@`([^`\n]{1,4096})`/g;

/** Render backticked `@`path`` refs as inline file chips and `/skill:name`
 *  refs as skill chips (graduation cap) at display time. */
export function renderFileRefs(text: string): ReactNode[] {
  const nodes: ReactNode[] = [];
  let key = 0;
  const pushText = (part: string) => {
    for (const segment of splitSkillRefs(part)) {
      if (typeof segment === "string") {
        nodes.push(segment);
      } else {
        nodes.push(
          <span key={`skill-ref-${key++}`} className="skill-ref-chip" title={segment.skill}>
            <GraduationCap size={12} />
            <code className="skill-ref-name">{segment.skill}</code>
          </span>,
        );
      }
    }
  };
  let last = 0;
  let match: RegExpExecArray | null;
  FILE_REF_PATTERN.lastIndex = 0;
  while ((match = FILE_REF_PATTERN.exec(text)) !== null) {
    if (match.index > last) pushText(text.slice(last, match.index));
    const refPath = match[1]!;
    nodes.push(
      <span key={`file-ref-${key++}`} className="file-ref-chip" title={refPath}>
        <FileTypeIcon path={refPath} size={12} />
        <code className="file-ref-path">{truncateFileRefPath(refPath)}</code>
      </span>,
    );
    last = match.index + match[0].length;
  }
  if (last < text.length) pushText(text.slice(last));
  if (nodes.length === 0) nodes.push(text);
  return nodes;
}

export function summarizeChanges(timeline: TimelineItem[]): { fileCount: number; additions: number; deletions: number } | undefined {
  const files = new Set<string>();
  let additions = 0;
  let deletions = 0;
  const activities = timeline.filter((item): item is ToolActivity => item.kind === "tool");
  for (const activity of activities) {
    const diff = getToolDiff(activity);
    if (!diff || !diff.path || (diff.additions === 0 && diff.deletions === 0)) continue;
    files.add(diff.path);
    additions += diff.additions;
    deletions += diff.deletions;
  }
  return files.size > 0 ? { fileCount: files.size, additions, deletions } : undefined;
}

export interface TimelineRowProps {
  item: TimelineItem;
  agentId: string;
  api: WorkspaceApi;
  workspaceId?: string;
  workspaceRoot?: string;
  expansion?: TimelineExpansionSettings;
  latestIds?: LatestTimelineIds;
  manualToggles?: Record<string, boolean>;
  onToggleManual?: (id: string, open: boolean) => void;
}

export const TimelineRow = memo(function TimelineRow({
  item,
  agentId,
  api,
  workspaceId,
  workspaceRoot,
  expansion = DEFAULT_TIMELINE_EXPANSION,
  latestIds = { latestToolIds: {} },
  manualToggles = {},
  onToggleManual,
}: TimelineRowProps) {
  if (item.kind === "unknown") return <article className="timeline-row unknown"><strong>Unknown activity</strong><code>{item.entryType}</code></article>;
  if (item.kind === "tool") {
    const isExpanded = isItemExpanded(item, expansion, latestIds, manualToggles);
    return (
      <ToolRow
        item={item}
        open={isExpanded}
        onOpenChange={(open) => onToggleManual?.(item.id, open)}
        workspaceId={workspaceId}
        workspaceRoot={workspaceRoot}
        api={api}
        shellOutputMode={expansion.shellOutput ?? "preview"}
      />
    );
  }
  if (item.kind === "thinking") {
    const isExpanded = isItemExpanded(item, expansion, latestIds, manualToggles);
    const preview = formatThinkingPreview(item.text);
    return (
      <details
        className="thinking-row"
        open={isExpanded}
        onToggle={(e) => onToggleManual?.(item.id, e.currentTarget.open)}
      >
        <summary className="thinking-summary">
          <span className="thinking-icon">⚙</span>
          <span className="thinking-label">Thinking</span>
          {!isExpanded && <span className="thinking-preview">{preview}…</span>}
        </summary>
        <div className="thinking-body">
          <Streamdown className="text-[12.5px] leading-relaxed text-muted-foreground italic">
            {item.text}
          </Streamdown>
        </div>
      </details>
    );
  }
  if (item.kind === "summary") {
    if (item.summaryType === "branch") {
      return (
        <article className="timeline-row summary">
          <strong>Branch summary</strong>
          <p>{item.text}</p>
        </article>
      );
    }
    const label = item.compactionReason === "manual"
      ? "Context manually compacted"
      : item.compactionReason === "auto"
        ? "Context auto-compacted"
        : "Context compacted";
    return (
      <article className="timeline-row compaction-divider" aria-label={label}>
        <div className="compaction-divider-rule">
          <span className="compaction-divider-line" aria-hidden="true" />
          <span className="compaction-divider-label">
            <Scissors size={13} aria-hidden="true" />
            <span>{label}</span>
          </span>
          <span className="compaction-divider-line" aria-hidden="true" />
        </div>
        {item.tokensBefore !== undefined && (
          <p className="compaction-divider-subtext">Compacted from {item.tokensBefore.toLocaleString("en-US")} tokens</p>
        )}
        {item.text && (
          <details className="compaction-divider-details">
            <summary>Show summary</summary>
            <p>{item.text}</p>
          </details>
        )}
      </article>
    );
  }
  if (item.kind === "error") {
    return (
      <Alert variant="destructive" className="assistant-error-alert px-3 py-2 border-destructive/40 bg-destructive/5">
        <CircleAlert aria-hidden="true" />
        <AlertTitle>Agent error</AlertTitle>
        <AlertDescription>{item.text}</AlertDescription>
      </Alert>
    );
  }
  if (item.kind === "user") {
    return (
      <div className="user-message-container">
        <div className="user-message-card">
          <p>{renderFileRefs(item.text)}</p>
          {item.images && item.images.length > 0 && (
            <UserImageStrip agentId={agentId} api={api} images={item.images} />
          )}
          {item.files && item.files.length > 0 && (
            <UserFileStrip agentId={agentId} api={api} files={item.files} />
          )}
        </div>
      </div>
    );
  }
  if (item.error) {
    const wasAborted = item.error === "Request was aborted";
    return (
      <Alert
        variant={wasAborted ? "default" : "destructive"}
        className={`assistant-error-alert px-3 py-2${wasAborted ? " assistant-abort-alert" : " border-destructive/40 bg-destructive/5"}`}
      >
        <CircleAlert aria-hidden="true" />
        <AlertTitle>{wasAborted ? "Agent run stopped" : "Pi error"}</AlertTitle>
        <AlertDescription>{wasAborted ? "Pi notice" : "Pi reported"}: {item.error}</AlertDescription>
      </Alert>
    );
  }
  return (
    <article className="assistant-message-row">
      <div className="assistant-prose">
        <Streamdown>{item.text}</Streamdown>
      </div>
    </article>
  );
});
