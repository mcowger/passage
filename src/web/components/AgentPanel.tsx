import { Fragment, memo, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { ReactNode } from "react";
import type { AgentCapabilities, AgentHistory, AgentSummary, SlashCommand, TimelineItem, ToolActivity, UserImageRef } from "../../shared/domain/agents.ts";
import type { WorkspaceSettings, TimelineExpansionSettings } from "../../shared/domain/settings.ts";
import { DEFAULT_TIMELINE_EXPANSION } from "../../shared/domain/settings.ts";
import { MAX_AGENT_IMAGES, MAX_AGENT_IMAGE_DATA_BYTES, type AgentImage } from "../../shared/protocol/agents.ts";
import type { WorkspaceApi } from "../api.ts";
import { ModelPicker } from "./ModelPicker.tsx";
import { DisplayOptionsPopover } from "./DisplayOptionsPopover.tsx";
import { collectExpandedIds, computeLatestTimelineIds, isItemExpanded, type LatestTimelineIds } from "../lib/timeline-expansion.ts";
import { Streamdown } from "streamdown";
import { Button } from "./ui/button.tsx";
import { Alert, AlertDescription, AlertTitle } from "./ui/alert.tsx";
import { ToolRow } from "./ToolRow.tsx";
import { FileTypeIcon } from "./FileTypeIcon.tsx";
import { splitSkillRefs } from "./skillRefs.ts";
import { ComposerAutocomplete, COMPOSER_SUGGESTION_LIST_ID } from "./ComposerAutocomplete.tsx";
import { ComposerEditor, currentViewportIsMobileComposer, type ComposerEditorHandle } from "./ComposerEditor.tsx";
import {
  applyFileInsert,
  applySlashInsert,
  filterSlashCommands,
  useComposerTrigger,
} from "./useComposerTrigger.ts";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "./ui/alert-dialog.tsx";
import { QuestionCard, type QuestionRequest, type QuestionOption } from "./QuestionCard.tsx";
import { UserImageStrip } from "./UserImages.tsx";
import { getToolDiff } from "../lib/tool-diff.ts";
import { formatCompactTokens } from "../lib/utils.ts";
import { RECEIVING_ACTIVITY_WINDOW_MS, STREAM_PHASE_LABELS, emptyStreamActivity, formatByteCount, type StreamActivity, type StreamPhase } from "../lib/stream-activity.ts";
import {
  Clock,
  CircleAlert,
  Square,
  ArrowUp,
  Plus,
  Pencil,
  Zap,
  GraduationCap,
} from "lucide-react";

const STREAMING_STATS_INTERVAL_MS = 300;
/** Distance from the bottom that still counts as following the live tail. */
const STICK_TO_BOTTOM_SLACK_PX = 48;
/** Distance from the top that triggers backfilling the previous page of history. */
const LOAD_MORE_HISTORY_SLACK_PX = 120;

export type AgentPanelProps = {
  agent: AgentSummary;
  history?: AgentHistory;
  capabilities?: AgentCapabilities;
  loading: boolean;
  error?: string;
  api: WorkspaceApi;
  onRefresh: () => Promise<void>;
  onModelChanged?: (agent: AgentSummary) => void;
  onArchive: () => Promise<void>;
  onOptimisticMessage?: (message: string, images?: UserImageRef[]) => void;
  /** Offline transcript override for rendering verification (never live state). */
  previewHistory?: AgentHistory;
  settings?: WorkspaceSettings;
  /** Whether an older page of history is available to backfill. */
  hasMoreHistory?: boolean;
  /** Whether a backfill fetch for older history is in flight. */
  loadingMoreHistory?: boolean;
  /** Fetches and prepends the previous page of history. */
  onLoadMoreHistory?: () => void;
  /** Live activity holder written by the socket owner; sampled on the pill's interval. */
  streamActivityRef?: { current: StreamActivity };
};

export function resolveActiveQuestionRequest(agent: AgentSummary): QuestionRequest | null {
  const pending = agent.pendingUiRequest as Record<string, unknown> | undefined;
  if (pending && pending.id) {
    if (pending.method === "select" || (Array.isArray(pending.options) && pending.options.length > 0)) {
      let header = "Select";
      let question = String(pending.title || "Choose an option");
      const titleMatch = question.match(/^\[(.*?)\]\s*(.*)$/);
      if (titleMatch) {
        header = titleMatch[1];
        question = titleMatch[2];
      }

      const rawOptions = Array.isArray(pending.options) ? pending.options : [];
      const allowOther = rawOptions.some((option) =>
        typeof option === "string" && /^\d+\.\s*(Type something\.|Other\b)|^Type something\.$/i.test(option.trim())
      );
      const options: QuestionOption[] = rawOptions.flatMap((opt: unknown) => {
        if (!opt) return [];
        if (typeof opt === "object" && opt !== null && "label" in opt) {
          const o = opt as { label: string; description?: string; preview?: string };
          const label = String(o.label || "").trim();
          if (!label || /^\d+\.\s*(Type something\.|Other\b)/i.test(label) || label === "Type something.") return [];
          return [
            {
              label,
              description: o.description ? String(o.description) : undefined,
              preview: o.preview ? String(o.preview) : undefined,
            },
          ];
        }
        const raw = typeof opt === "string" ? opt.trim() : "";
        if (!raw) return [];
        // Filter out "Type something." sentinel from list because QuestionCard has its own "Other..." row
        if (/^\d+\.\s*(Type something\.|Other\b)/i.test(raw) || raw === "Type something.") {
          return [];
        }
        // Check for "1. Label — Description" (using em-dash, en-dash, or hyphen)
        const matchWithDesc = raw.match(/^\d+\.\s*([^\u2014\u2013-]+?)\s*[\u2014\u2013-]\s*(.*)$/);
        if (matchWithDesc) {
          return [{ label: matchWithDesc[1].trim(), description: matchWithDesc[2].trim() }];
        }
        // Check for "Label — Description" without leading numbers
        const matchNoNumWithDesc = raw.match(/^([^\u2014\u2013-]+?)\s*[\u2014\u2013-]\s*(.*)$/);
        if (matchNoNumWithDesc) {
          return [{ label: matchNoNumWithDesc[1].trim(), description: matchNoNumWithDesc[2].trim() }];
        }
        const matchNum = raw.match(/^\d+\.\s*(.*)$/);
        if (matchNum) {
          return [{ label: matchNum[1].trim() }];
        }
        return [typeof opt === "string" ? { label: opt } : { label: raw, description: (opt as any)?.description }];
      });

      return {
        id: String(pending.id),
        method: "select",
        questions: [
          {
            question,
            header,
            options,
            allowOther,
          },
        ],
      };
    }

    if (pending.method === "confirm") {
      return {
        id: String(pending.id),
        method: "confirm",
        questions: [
          {
            question: String(pending.title || "Confirmation needed"),
            header: "Confirm",
            options: [
              { label: "Yes", description: pending.message ? String(pending.message) : undefined },
              { label: "No" },
            ],
          },
        ],
      };
    }

    if (pending.method === "input" || pending.method === "editor") {
      return {
        id: String(pending.id),
        method: pending.method as "input" | "editor",
        questions: [
          {
            question: String(pending.title || "Input needed"),
            header: pending.method === "editor" ? "Editor" : "Input",
            options: [],
            placeholder: typeof pending.placeholder === "string" ? pending.placeholder : undefined,
            prefill: typeof pending.prefill === "string" ? pending.prefill : undefined,
          },
        ],
      };
    }
  }
  return null;
}

/** A native Pi dialog supersedes its blocking tool invocation while it is open. */
export function timelineWithoutBlockingTool(timeline: TimelineItem[], hasActiveUiRequest: boolean): TimelineItem[] {
  if (!hasActiveUiRequest) return timeline;
  return timeline.filter(
    (item) => item.kind !== "tool" || item.status !== "running" || item.name !== "ask_user_question"
  );
}

export function resolveCurrentModel(
  modelPreference: string | null,
  historyModel: AgentHistory["currentModel"],
  modelOptions: AgentCapabilities["models"],
) {
  const findModel = (provider: string, modelId: string) =>
    modelOptions.find((option) => option.provider === provider && option.id === modelId) ?? {
      name: modelId,
      id: modelId,
      provider,
    };

  if (modelPreference) {
    const separator = modelPreference.indexOf("/");
    if (separator >= 0) {
      return findModel(modelPreference.slice(0, separator), modelPreference.slice(separator + 1));
    }
    const preferred = modelOptions.find((option) => option.id === modelPreference);
    if (preferred) return preferred;
  }

  return historyModel ? findModel(historyModel.provider, historyModel.modelId) : undefined;
}

export function resolveCurrentThinking(
  thinkingPreference: string | null,
  historyThinkingLevel: AgentHistory["currentThinkingLevel"],
) {
  return thinkingPreference ?? historyThinkingLevel ?? "default";
}

export function resolveStreamActive(status: AgentSummary["status"]): boolean {
  return status === "running";
}

/**
 * The elapsed timer anchors to Passage's authoritative run start when the
 * daemon reports one, so reloading the page mid-run does not reset it to the
 * moment the transcript was loaded. It only falls back to first observation
 * when the daemon has no recorded run start (for example, an unpersisted
 * process whose start Passage never saw).
 */
export function resolveStreamStartMs(runStartedAt: number | undefined, observedAt: number): number {
  return typeof runStartedAt === "number" && Number.isSafeInteger(runStartedAt) && runStartedAt > 0
    ? runStartedAt
    : observedAt;
}

export function isComposerLocked(status: AgentSummary["status"]): boolean {
  return status === "stopping";
}

export function AgentPanel({
  agent,
  history,
  capabilities,
  loading,
  error,
  api,
  onRefresh,
  onModelChanged,
  onArchive: _onArchive,
  onOptimisticMessage,
  previewHistory,
  settings,
  hasMoreHistory,
  loadingMoreHistory,
  onLoadMoreHistory,
  streamActivityRef,
}: AgentPanelProps) {
  const effectiveHistory = previewHistory ?? history;
  const conciseKey = `passage:agent:${agent.id}:concise`;
  const [concise, setConcise] = useState(() => localStorage.getItem(conciseKey) === "true");
  const [sessionExpansion, setSessionExpansion] = useState<TimelineExpansionSettings>(
    () => settings?.timelineExpansion ?? DEFAULT_TIMELINE_EXPANSION
  );
  const [sessionExpansionOverridden, setSessionExpansionOverridden] = useState(false);
  const [manualToggles, setManualToggles] = useState<Record<string, boolean>>({});

  useEffect(() => {
    if (!sessionExpansionOverridden) {
      setSessionExpansion(settings?.timelineExpansion ?? DEFAULT_TIMELINE_EXPANSION);
    }
  }, [settings?.timelineExpansion, sessionExpansionOverridden]);

  const handleUpdateSessionExpansion = (next: TimelineExpansionSettings) => {
    setSessionExpansion(next);
    setSessionExpansionOverridden(true);
  };

  const handleResetSessionExpansion = () => {
    setSessionExpansion(settings?.timelineExpansion ?? DEFAULT_TIMELINE_EXPANSION);
    setSessionExpansionOverridden(false);
    setManualToggles({});
  };

  const [busy, setBusy] = useState(false);
  const timelineRef = useRef<HTMLDivElement>(null);
  const running = agent.status === "running";
  const stopping = isComposerLocked(agent.status);
  const timeline = effectiveHistory?.timeline ?? [];
  const streamActive = resolveStreamActive(agent.status);
  const fallbackStreamActivityRef = useRef<StreamActivity>(emptyStreamActivity());
  const activityRef = streamActivityRef ?? fallbackStreamActivityRef;
  const streamingStartedAtRef = useRef<number | null>(null);
  const [streamPhase, setStreamPhase] = useState<StreamPhase | null>(null);
  const [receiving, setReceiving] = useState(false);
  const [elapsedSeconds, setElapsedSeconds] = useState(0);
  const [streamFrames, setStreamFrames] = useState(0);
  const [streamBytes, setStreamBytes] = useState(0);

  // The interval is the pill's only render driver, so the elapsed timer keeps
  // advancing while Pi is silent (waiting for the first token after a prompt
  // or a long tool run). Frame activity lands in a ref, not state, so a frame
  // burst never triggers an extra render -- it is sampled here instead.
  useEffect(() => {
    if (!streamActive) {
      streamingStartedAtRef.current = null;
      setStreamPhase(null);
      setReceiving(false);
      setElapsedSeconds(0);
      setStreamFrames(0);
      setStreamBytes(0);
      return;
    }

    if (streamingStartedAtRef.current === null) {
      streamingStartedAtRef.current = Date.now();
      // Drop the previous run's final phase so a new run does not briefly show
      // it before its first content frame lands.
      activityRef.current = emptyStreamActivity();
    }
    const startedAt = resolveStreamStartMs(agent.runStartedAt, streamingStartedAtRef.current);
    const tick = () => {
      const now = Date.now();
      setElapsedSeconds(Math.max(0, (now - startedAt) / 1000));
      const activity = activityRef.current;
      setStreamPhase(activity.phase);
      setReceiving(activity.lastFrameAt > 0 && now - activity.lastFrameAt < RECEIVING_ACTIVITY_WINDOW_MS);
      setStreamFrames(activity.frames);
      setStreamBytes(activity.bytes);
    };
    tick();
    const interval = setInterval(tick, STREAMING_STATS_INTERVAL_MS);
    return () => clearInterval(interval);
  }, [streamActive, agent.runStartedAt]);

  // Whether the viewport is following the live tail. A manual scroll away
  // unpins it; scrolling back within the slack re-pins it. Row heights can
  // change many times a second while streaming (tool output growing,
  // expansion resolving) -- driving autoscroll off a single post-commit
  // effect let that outpace React and yanked the viewport around. Instead
  // this is re-asserted continuously (every frame while streaming, and
  // synchronously before paint on every other render), so it can only ever
  // sit exactly at the bottom or exactly where the user left it.
  const pinnedRef = useRef(true);
  const scrollToBottomIfPinned = () => {
    const el = timelineRef.current;
    if (!el || !pinnedRef.current) return;
    el.scrollTop = el.scrollHeight;
  };
  const questionRequest = useMemo(
    () => resolveActiveQuestionRequest(agent),
    [agent]
  );
  const pinnedQuestionIdRef = useRef<string | null>(null);

  // Scrolling near the top backfills the previous page of history. Refs
  // (rather than effect deps) keep the mount-only scroll listener below
  // reading the latest values without re-subscribing on every change.
  const hasMoreHistoryRef = useRef(hasMoreHistory);
  hasMoreHistoryRef.current = hasMoreHistory;
  const loadingMoreHistoryRef = useRef(loadingMoreHistory);
  loadingMoreHistoryRef.current = loadingMoreHistory;
  const onLoadMoreHistoryRef = useRef(onLoadMoreHistory);
  onLoadMoreHistoryRef.current = onLoadMoreHistory;
  // Captured right before a backfill fetch starts so the resulting DOM
  // growth above the viewport can be compensated for once it renders,
  // instead of visually yanking the transcript the user is reading.
  const pendingScrollRestoreRef = useRef<{ scrollHeight: number; scrollTop: number } | null>(null);

  useEffect(() => {
    const el = timelineRef.current;
    if (!el) return;
    const onScroll = () => {
      pinnedRef.current = el.scrollHeight - el.scrollTop - el.clientHeight <= STICK_TO_BOTTOM_SLACK_PX;
      if (hasMoreHistoryRef.current && !loadingMoreHistoryRef.current && el.scrollTop <= LOAD_MORE_HISTORY_SLACK_PX) {
        pendingScrollRestoreRef.current = { scrollHeight: el.scrollHeight, scrollTop: el.scrollTop };
        onLoadMoreHistoryRef.current?.();
      }
    };
    el.addEventListener("scroll", onScroll, { passive: true });
    return () => el.removeEventListener("scroll", onScroll);
  }, []);

  useLayoutEffect(() => {
    const pending = pendingScrollRestoreRef.current;
    if (!pending) return;
    pendingScrollRestoreRef.current = null;
    const el = timelineRef.current;
    if (!el) return;
    el.scrollTop = pending.scrollTop + (el.scrollHeight - pending.scrollHeight);
  }, [timeline]);

  useEffect(() => {
    if (!streamActive) return;
    let frame: number;
    const tick = () => {
      scrollToBottomIfPinned();
      frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [streamActive]);

  // A question needing the user's response is always brought into view, even
  // when the user had scrolled away to read earlier output. Forcing the pin
  // here (before scrolling, and only when the question changes) means the card
  // is visible on the commit it mounts rather than one render later.
  useLayoutEffect(() => {
    const questionId = questionRequest?.id ?? null;
    if (questionId !== null && pinnedQuestionIdRef.current !== questionId) {
      pinnedQuestionIdRef.current = questionId;
      pinnedRef.current = true;
    }
    scrollToBottomIfPinned();
  });

  useEffect(() => {
    setConcise(localStorage.getItem(conciseKey) === "true");
  }, [conciseKey]);

  const model = effectiveHistory?.currentModel
    ? `${effectiveHistory.currentModel.provider}/${effectiveHistory.currentModel.modelId}`
    : agent.modelPreference ?? "model unavailable";
  const thinking = resolveCurrentThinking(agent.thinkingPreference, effectiveHistory?.currentThinkingLevel);
  const modelOptions = useMemo(
    () => capabilities?.models.filter((option) => option.authenticated) ?? [],
    [capabilities?.models]
  );
  const currentModel = useMemo(
    () => resolveCurrentModel(agent.modelPreference, effectiveHistory?.currentModel, modelOptions),
    [agent.modelPreference, effectiveHistory?.currentModel, modelOptions]
  );
  const currentModelDisplayName = currentModel?.name ?? (model.includes("/") ? model.split("/")[1] : model);

  const maxTokens = (currentModel && "contextWindow" in currentModel && typeof currentModel.contextWindow === "number")
    ? currentModel.contextWindow
    : 200_000;
  const contextTokens = effectiveHistory?.contextUsage?.tokens ?? null;
  const contextPct = contextTokens !== null && contextTokens > 0 ? Math.min(100, Math.max(1, Math.round((contextTokens / maxTokens) * 100))) : 0;
  const pieColor = contextPct >= 95 ? "var(--danger, #b91c1c)" : contextPct >= 80 ? "var(--warning, #b45309)" : "currentColor";
  const changeSummary = useMemo(() => summarizeChanges(effectiveHistory?.timeline ?? []), [effectiveHistory?.timeline]);
  const latestIds = useMemo(
    () => computeLatestTimelineIds(effectiveHistory?.timeline ?? []),
    [effectiveHistory?.timeline]
  );

  const visibleTimeline = useMemo(
    () => timelineWithoutBlockingTool(timeline, questionRequest !== null),
    [timeline, questionRequest]
  );

  const [stickyExpandedIds, setStickyExpandedIds] = useState<ReadonlySet<string>>(new Set());
  useEffect(() => {
    setStickyExpandedIds((previous) =>
      collectExpandedIds(effectiveHistory?.timeline ?? [], sessionExpansion, latestIds, manualToggles, concise, previous)
    );
  }, [effectiveHistory?.timeline, sessionExpansion, latestIds, manualToggles, concise]);

  const handleRespondUi = async (result: { id: string; value?: string; confirmed?: boolean; cancelled?: true }) => {
    try {
      await api.respondUi(agent.id, result);
      await onRefresh();
    } catch (err) {
      console.error("Failed to respond to UI prompt:", err);
    }
  };

  return (
    <section className="agent-panel" aria-label={`Agent conversation ${agent.title}`}>
      {error && (
        <div className="alert agent-alert" role="alert">
          <span>{error}</span>
          <button className="secondary small" onClick={() => void onRefresh()}>Retry</button>
        </div>
      )}
      <div className="timeline" ref={timelineRef}>
        {loading ? <p className="muted timeline-loading">Loading history…</p>
          : !effectiveHistory?.timeline.length && !questionRequest ? (
            <div className="empty-transcript">
              <span className="empty-transcript-icon">◈</span>
              <h3>What are we working on?</h3>
              <p>Type a prompt below to start an autonomous session.</p>
            </div>
          ) : (
            <>
              {loadingMoreHistory && <p className="muted timeline-loading-more">Loading earlier messages…</p>}
              {visibleTimeline.map((item) => (
                <TimelineRow
                  key={item.id}
                  item={item}
                  agentId={agent.id}
                  api={api}
                  concise={concise}
                  expansion={sessionExpansion}
                  latestIds={latestIds}
                  manualToggles={manualToggles}
                  stickyExpandedIds={stickyExpandedIds}
                  onToggleManual={(id, open) => {
                    setManualToggles((prev) => ({ ...prev, [id]: open }));
                  }}
                />
              ))}
              {questionRequest && (
                <QuestionCard key={questionRequest.id} request={questionRequest} onRespond={handleRespondUi} />
              )}
            </>
          )}
      </div>

      <AgentComposer
        agentId={agent.id}
        workspaceId={agent.workspaceId}
        running={running}
        stopping={stopping}
        streamActive={streamActive}
        streamPhase={streamPhase}
        receiving={receiving}
        elapsedSeconds={elapsedSeconds}
        streamFrames={streamFrames}
        streamBytes={streamBytes}
        capabilities={capabilities}
        api={api}
        busy={busy}
        setBusy={setBusy}
        onRefresh={onRefresh}
        onModelChanged={onModelChanged}
        onOptimisticMessage={(message, images) => {
          // A user sending a new message always wants to see it, even if they
          // had scrolled up to read earlier output.
          pinnedRef.current = true;
          onOptimisticMessage?.(message, images);
        }}
        currentModel={currentModel}
        currentModelDisplayName={currentModelDisplayName}
        thinking={thinking}
        contextTokens={contextTokens}
        maxTokens={maxTokens}
        contextPct={contextPct}
        pieColor={pieColor}
        usage={effectiveHistory?.usage}
        changeSummary={changeSummary}
        sessionExpansion={sessionExpansion}
        onSessionExpansionChange={handleUpdateSessionExpansion}
        onResetSessionExpansion={handleResetSessionExpansion}
        isExpansionOverridden={sessionExpansionOverridden}
      />
    </section>
  );
}

export function formatDuration(seconds: number): string {
  if (seconds < 60) {
    return `${seconds.toFixed(1)}s`;
  }
  const mins = Math.floor(seconds / 60);
  const remSecs = (seconds % 60).toFixed(0).padStart(2, "0");
  return `${mins}m ${remSecs}s`;
}

export function formatThinkingPreview(text: string, maxLength = 70): string {
  return text
    .replace(/^(?:#{1,6}\s+|[-*+]\s+|\d+[.)]\s+)/gm, "")
    .replace(/(\*\*|__|~~)(?=\S)([\s\S]*?\S)\1/g, "$2")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, maxLength);
}

const LiveStreamPhase = memo(function LiveStreamPhase({
  phase,
  receiving,
}: {
  phase: StreamPhase | null;
  receiving: boolean;
}) {
  if (!phase) return null;
  return (
    <span
      className={`live-stream-phase${receiving ? " is-receiving" : ""}`}
      title={receiving ? "Receiving data from Pi" : "Waiting for Pi"}
    >
      <Zap size={11} aria-hidden="true" />
      {STREAM_PHASE_LABELS[phase]}
    </span>
  );
});

const LiveStreamTraffic = memo(function LiveStreamTraffic({
  frames,
  bytes,
}: {
  frames: number;
  bytes: number;
}) {
  const label = `${formatByteCount(bytes)} · ${frames} frame${frames === 1 ? "" : "s"}`;
  return (
    <span
      className="composer-status-traffic"
      aria-hidden="true"
      title={`${bytes.toLocaleString()} bytes across ${frames} frame${frames === 1 ? "" : "s"} this run (live wire traffic)`}
    >
      · {label}
    </span>
  );
});

type AgentComposerProps = {
  agentId: string;
  workspaceId: string;
  running: boolean;
  stopping: boolean;
  streamActive: boolean;
  streamPhase: StreamPhase | null;
  receiving: boolean;
  elapsedSeconds: number;
  streamFrames: number;
  streamBytes: number;
  capabilities?: AgentCapabilities;
  api: WorkspaceApi;
  busy: boolean;
  setBusy: (b: boolean) => void;
  onRefresh: () => Promise<void>;
  onModelChanged?: (agent: AgentSummary) => void;
  onOptimisticMessage?: (message: string, images?: UserImageRef[]) => void;
  currentModel?: AgentCapabilities["models"][number] | { name: string; id: string; provider: string; contextWindow?: number };
  currentModelDisplayName: string;
  thinking: string;
  contextTokens: number | null;
  maxTokens: number;
  contextPct: number;
  pieColor: string;
  usage?: AgentHistory["usage"];
  changeSummary?: { fileCount: number; additions: number; deletions: number };
  sessionExpansion: TimelineExpansionSettings;
  onSessionExpansionChange: (next: TimelineExpansionSettings) => void;
  onResetSessionExpansion: () => void;
  isExpansionOverridden: boolean;
};

/** Middle-out truncation that preserves the filename suffix. */
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

function AgentComposerInner({
  agentId,
  workspaceId,
  running,
  stopping,
  streamActive,
  streamPhase,
  receiving,
  elapsedSeconds,
  streamFrames,
  streamBytes,
  capabilities,
  api,
  busy,
  setBusy,
  onRefresh,
  onModelChanged,
  onOptimisticMessage,
  currentModel,
  currentModelDisplayName,
  thinking,
  contextTokens,
  maxTokens,
  contextPct,
  pieColor,
  usage,
  changeSummary,
  sessionExpansion,
  onSessionExpansionChange,
  onResetSessionExpansion,
  isExpansionOverridden,
}: AgentComposerProps) {
  const draftKey = `passage:agent:${agentId}:draft`;
  const [draft, setDraft] = useState(() => localStorage.getItem(draftKey) ?? "");
  const [composerError, setComposerError] = useState("");
  const [images, setImages] = useState<Array<AgentImage & { name: string }>>([]);
  const [ctxDetailsOpen, setCtxDetailsOpen] = useState(false);
  const ctxDetailsRef = useRef<HTMLDivElement>(null);
  const composerInputRef = useRef<ComposerEditorHandle>(null);
  const reservedImageCount = useRef(0);
  const saveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [caret, setCaret] = useState<number | null>(null);
  const [compactConfirmOpen, setCompactConfirmOpen] = useState(false);
  const [isMobileComposer, setIsMobileComposer] = useState(() => currentViewportIsMobileComposer());
  const autocomplete = useComposerTrigger({ draft, caret, workspaceId, api });
  const slashCommands = useMemo(
    () => capabilities?.slashCommands ?? [],
    [capabilities?.slashCommands],
  );
  const filteredCommands = useMemo(
    () =>
      autocomplete.trigger?.kind === "/"
        ? filterSlashCommands(slashCommands, autocomplete.trigger.query)
        : [],
    [autocomplete.trigger, slashCommands],
  );
  const suggestionOpen = autocomplete.trigger !== null;
  const suggestionCount =
    autocomplete.trigger?.kind === "@" ? autocomplete.files.length : filteredCommands.length;
  const activeValue = (() => {
    if (!autocomplete.trigger) return "";
    if (autocomplete.trigger.kind === "@") {
      const entry = autocomplete.files[autocomplete.activeIndex];
      return entry ? `file:${entry.path}` : "";
    }
    const command = filteredCommands[autocomplete.activeIndex];
    return command ? `cmd:${command.name}` : "";
  })();

  const placeCaret = (position: number) => {
    setCaret(position);
    requestAnimationFrame(() => {
      const input = composerInputRef.current;
      if (!input) return;
      input.focus();
      input.setCaret(position);
    });
  };

  const acceptFile = (path: string) => {
    const trigger = autocomplete.trigger;
    if (!trigger || trigger.kind !== "@") return;
    const next = applyFileInsert(draft, trigger, path);
    updateDraft(next.value);
    placeCaret(next.caret);
  };

  const acceptCommand = (command: SlashCommand) => {
    const trigger = autocomplete.trigger;
    if (!trigger || trigger.kind !== "/") return;
    if (command.kind === "action") {
      // Action kinds never send raw Pi JSON: compact routes through the
      // typed compact endpoint after explicit confirmation.
      if (command.name === "compact") setCompactConfirmOpen(true);
      return;
    }
    const next = applySlashInsert(draft, trigger, `/${command.name}`);
    updateDraft(next.value);
    placeCaret(next.caret);
  };

  const acceptActiveSuggestion = (): boolean => {
    const trigger = autocomplete.trigger;
    if (!trigger) return false;
    if (trigger.kind === "@") {
      const entry = autocomplete.files[autocomplete.activeIndex];
      if (!entry) return false;
      acceptFile(entry.path);
      return true;
    }
    const command = filteredCommands[autocomplete.activeIndex];
    if (!command) return false;
    acceptCommand(command);
    return true;
  };

  useEffect(() => {
    setDraft(localStorage.getItem(draftKey) ?? "");
    setImages([]);
    setCtxDetailsOpen(false);
    reservedImageCount.current = 0;
  }, [draftKey]);

  useEffect(() => {
    composerInputRef.current?.focus();
  }, [agentId]);

  useEffect(() => {
    const update = () => setIsMobileComposer(currentViewportIsMobileComposer());
    window.addEventListener("resize", update);
    const coarseQuery = window.matchMedia?.("(pointer: coarse)");
    coarseQuery?.addEventListener?.("change", update);
    return () => {
      window.removeEventListener("resize", update);
      coarseQuery?.removeEventListener?.("change", update);
    };
  }, []);

  useEffect(() => {
    return () => {
      if (saveTimerRef.current) {
        clearTimeout(saveTimerRef.current);
      }
    };
  }, []);

  useEffect(() => {
    if (!ctxDetailsOpen) return;
    const handleClickOutside = (e: MouseEvent) => {
      if (ctxDetailsRef.current && !ctxDetailsRef.current.contains(e.target as Node)) {
        setCtxDetailsOpen(false);
      }
    };
    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, [ctxDetailsOpen]);

  const updateDraft = (value: string) => {
    setDraft(value);
    if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
    saveTimerRef.current = setTimeout(() => {
      localStorage.setItem(draftKey, value);
    }, 250);
  };

  const run = async (
    action: () => Promise<unknown>,
    clearDraft = false,
    refreshAfter = true,
  ) => {
    setBusy(true);
    setComposerError("");
    try {
      await action();
      if (clearDraft) {
        if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
        setDraft("");
        localStorage.removeItem(draftKey);
      }
      if (refreshAfter) await onRefresh();
    } catch (cause) {
      setComposerError(cause instanceof Error ? cause.message : "Agent command failed");
    } finally {
      setBusy(false);
    }
  };

  const send = (kind: "prompt" | "steer" | "followUp") => {
    const value = draft.trim();
    if (!value && images.length === 0) return;
    const finalMessage = value || (images.length > 0 ? "Attached image" : "");
    const payloadImages: AgentImage[] = images.map(({ type, data, mimeType, name }) => ({
      type,
      data,
      mimeType,
      name,
    }));
    // Instant pre-echo: the daemon hasn't hashed/cached these yet, so the
    // optimistic row carries data URLs and no hashes; the real row_upsert
    // (with cache refs) replaces this row when it arrives.
    const optimisticImages: UserImageRef[] = images.map(({ mimeType, name, data }) => ({
      hash: "",
      mimeType,
      name,
      previewUrl: `data:${mimeType};base64,${data}`,
    }));
    onOptimisticMessage?.(finalMessage, optimisticImages.length > 0 ? optimisticImages : undefined);
    void run(
      async () => {
        await api[kind](agentId, finalMessage, payloadImages.length > 0 ? payloadImages : undefined);
        setImages([]);
        reservedImageCount.current = 0;
      },
      true,
      false,
    );
  };

  const addImages = async (files: FileList | null) => {
    if (!files) return;
    let reserved = 0;
    try {
      const selected = Array.from(files);
      if (selected.length + reservedImageCount.current > MAX_AGENT_IMAGES)
        throw new Error(`Attach at most ${MAX_AGENT_IMAGES} images`);
      reservedImageCount.current += selected.length;
      reserved = selected.length;
      const attachments = await Promise.all(
        selected.map(async (file) => {
          let mimeType = file.type;
          if (mimeType === "image/jpg") mimeType = "image/jpeg";
          if (!mimeType.match(/^image\/(png|jpeg|gif|webp)$/))
            throw new Error(`${file.name} is not a supported image`);
          if (file.size > MAX_AGENT_IMAGE_DATA_BYTES) throw new Error(`${file.name} is too large`);
          const base64 = await new Promise<string>((resolve, reject) => {
            const reader = new FileReader();
            reader.onload = () => {
              const result = String(reader.result ?? "");
              const comma = result.indexOf(",");
              resolve(comma >= 0 ? result.slice(comma + 1) : result);
            };
            reader.onerror = () => reject(new Error(`Failed to read ${file.name}`));
            reader.readAsDataURL(file);
          });
          return {
            type: "image" as const,
            data: base64,
            mimeType: mimeType as AgentImage["mimeType"],
            name: file.name,
          };
        })
      );
      setImages((current) => {
        const available = MAX_AGENT_IMAGES - current.length;
        if (attachments.length > available) {
          reservedImageCount.current -= attachments.length;
          return current;
        }
        return [...current, ...attachments];
      });
      setComposerError("");
    } catch (cause) {
      reservedImageCount.current -= reserved;
      setComposerError(cause instanceof Error ? cause.message : "Unable to attach image");
    }
  };

  return (
    <footer className="composer-container">
      <div
        className="composer-status-line"
        role={streamActive ? "status" : undefined}
        aria-live={streamActive ? "polite" : undefined}
        aria-hidden={!streamActive}
      >
        {streamActive && (
          <div className="composer-status-pill">
            <span className="pulse-dot" />
            <span className="composer-status-duration">{formatDuration(elapsedSeconds)}</span>
            <LiveStreamPhase phase={streamPhase} receiving={receiving} />
            <LiveStreamTraffic frames={streamFrames} bytes={streamBytes} />
          </div>
        )}
      </div>
      {changeSummary && (
        <div
          className="agent-change-summary"
          aria-label={`${changeSummary.fileCount} changed files, ${changeSummary.additions} additions, ${changeSummary.deletions} deletions`}
        >
          <span className="agent-change-files">
            <Pencil size={12} aria-hidden="true" />
            {changeSummary.fileCount} changed file{changeSummary.fileCount === 1 ? "" : "s"}
          </span>
          <span className="add-count">+{changeSummary.additions}</span>
          <span className="del-count">-{changeSummary.deletions}</span>
        </div>
      )}
      <div className="composer-card composer-autocomplete-anchor">
        <ComposerAutocomplete
          open={suggestionOpen}
          kind={autocomplete.trigger?.kind ?? "@"}
          files={autocomplete.files}
          filesLoading={autocomplete.filesLoading}
          filesError={autocomplete.filesError}
          commands={filteredCommands}
          skillsAvailable={capabilities?.skillsAvailable ?? false}
          skillsSupported={capabilities?.skillsSupported ?? false}
          activeIndex={autocomplete.activeIndex}
          activeValue={activeValue}
          onActiveValueChange={(value) => {
            if (autocomplete.trigger?.kind === "@") {
              const index = autocomplete.files.findIndex((entry) => `file:${entry.path}` === value);
              if (index >= 0) autocomplete.setActiveIndex(index);
            } else {
              const index = filteredCommands.findIndex((command) => `cmd:${command.name}` === value);
              if (index >= 0) autocomplete.setActiveIndex(index);
            }
          }}
          onHoverIndex={autocomplete.setActiveIndex}
          onSelectFile={acceptFile}
          onSelectCommand={acceptCommand}
          onEscape={() => autocomplete.dismiss()}
          onInteractOutside={(insideComposer) => {
            if (!insideComposer) autocomplete.dismiss();
          }}
        />
        <ComposerEditor
          ref={composerInputRef}
          value={draft}
          onChange={updateDraft}
          onCaretChange={setCaret}
          ariaExpanded={suggestionOpen}
          ariaControls={suggestionOpen ? COMPOSER_SUGGESTION_LIST_ID : undefined}
          ariaActivedescendant={suggestionOpen && activeValue ? `composer-option-${activeValue}` : undefined}
          onKeyDown={(event) => {
            if (suggestionOpen && autocomplete.trigger) {
              if (event.key === "ArrowDown" || event.key === "ArrowUp") {
                event.preventDefault();
                autocomplete.moveSelection(event.key === "ArrowDown" ? 1 : -1, suggestionCount);
                return;
              }
              if (event.key === "Escape") {
                // Dismiss only: the draft keeps the raw trigger token and the
                // caret stays where it was. Retyping re-opens.
                event.preventDefault();
                event.stopPropagation();
                autocomplete.dismiss();
                return;
              }
              if ((event.key === "Tab" || event.key === "Enter") && suggestionCount > 0 && !event.shiftKey) {
                event.preventDefault();
                acceptActiveSuggestion();
                return;
              }
            }
            if (event.key === "Enter" && !event.shiftKey) {
              // Mobile plain-Enter inserts a newline (handled in
              // ComposerEditor); only Cmd/Ctrl+Enter submits there.
              if (currentViewportIsMobileComposer() && !event.metaKey && !event.ctrlKey) return;
              event.preventDefault();
              if (stopping) return;
              if (running) send("steer");
              else if (!busy) send("prompt");
            }
          }}
          placeholder={
            stopping
              ? "Stopping agent execution…"
              : running
              ? isMobileComposer
                ? "Steer now (⌘+Enter) or queue follow-up…"
                : "Steer now (Enter) or queue follow-up…"
              : "@ for files; / for commands"
          }
          disabled={stopping}
        />
        {composerError && (
          <div className="composer-error-alert" role="alert">
            <span>⚠️ {composerError}</span>
          </div>
        )}
        {images.length > 0 && (
          <div className="attachment-list" aria-label="Attached images">
            {images.map((image) => (
              <div key={`${image.name}:${image.data.length}`} className="attachment-chip">
                <img
                  src={`data:${image.mimeType};base64,${image.data}`}
                  alt={image.name}
                  className="attachment-thumb"
                />
                <span className="attachment-name">{image.name}</span>
                <button
                  type="button"
                  className="attachment-remove"
                  onClick={() => {
                    setImages((current) => current.filter((item) => item !== image));
                    reservedImageCount.current -= 1;
                  }}
                  aria-label={`Remove ${image.name}`}
                >
                  ×
                </button>
              </div>
            ))}
          </div>
        )}
        <div className="composer-toolbar">
          <div className="composer-toolbar-left">
            <label className="composer-attach-btn" title="Attach image" aria-label="Attach image">
              <Plus size={14} aria-hidden="true" />
              <input
                type="file"
                accept="image/png,image/jpeg,image/gif,image/webp"
                multiple
                disabled={stopping}
                onChange={(event) => {
                  void addImages(event.target.files);
                  event.currentTarget.value = "";
                }}
              />
            </label>
            {contextTokens !== null && contextTokens > 0 && (
              <div className="composer-ctx-wrapper" ref={ctxDetailsRef}>
                <button
                  type="button"
                  className="composer-ctx-pill"
                  onClick={() => setCtxDetailsOpen((prev) => !prev)}
                  title={`${formatCompactTokens(contextTokens)} / ${formatCompactTokens(maxTokens)} tokens · ${contextPct}% context · Click for details`}
                  aria-label={`Context used: ${contextPct}%. Click for usage breakdown.`}
                  aria-expanded={ctxDetailsOpen}
                  aria-haspopup="dialog"
                >
                  <span
                    className="context-pie"
                    style={{
                      background: `conic-gradient(${pieColor} ${contextPct}%, var(--chip-blue-track, rgba(3, 105, 161, 0.18)) 0)`,
                    }}
                    aria-hidden="true"
                  />
                  <span>{contextPct}%</span>
                  {usage?.cost !== undefined && usage.cost > 0 && (
                    <span className="composer-ctx-cost">
                      <span className="composer-stat-sep">·</span>
                      <span>${usage.cost.toFixed(2)}</span>
                    </span>
                  )}
                </button>

                {ctxDetailsOpen && (
                  <div className="ctx-details-popover" role="dialog" aria-label="Context and usage breakdown">
                    <div className="popover-header-title">Context &amp; Usage</div>
                    <div className="ctx-details-grid">
                      <div className="ctx-detail-row">
                        <span>Context used</span>
                        <b>
                          {contextPct}% ({formatCompactTokens(contextTokens)} / {formatCompactTokens(maxTokens)})
                        </b>
                      </div>
                      <div className="ctx-detail-row">
                        <span>Input tokens</span>
                        <span>{formatCompactTokens(usage?.input ?? 0)}</span>
                      </div>
                      <div className="ctx-detail-row">
                        <span>Output tokens</span>
                        <span>{formatCompactTokens(usage?.output ?? 0)}</span>
                      </div>
                      <div className="ctx-detail-row">
                        <span>Cache read</span>
                        <span>{formatCompactTokens(usage?.cacheRead ?? 0)}</span>
                      </div>
                      {usage?.cost !== undefined && usage.cost > 0 && (
                        <div className="ctx-detail-row total">
                          <span>Cost</span>
                          <b>${usage.cost.toFixed(4)}</b>
                        </div>
                      )}
                    </div>
                  </div>
                )}
              </div>
            )}
          </div>
          <div className="composer-toolbar-right">
            <DisplayOptionsPopover
              expansion={sessionExpansion}
              onExpansionChange={onSessionExpansionChange}
              onResetDefaults={onResetSessionExpansion}
              isOverridden={isExpansionOverridden}
            />
            <ModelPicker
              currentModelId={currentModel ? `${currentModel.provider}:${currentModel.id}` : undefined}
              currentModelName={currentModelDisplayName}
              currentThinking={thinking}
              capabilities={capabilities}
              onSelectModel={async (provider, modelId) => {
                await run(async () => {
                  const updatedAgent = await api.setModel(agentId, provider, modelId);
                  onModelChanged?.(updatedAgent);
                }, false, false);
              }}
              onSelectThinking={async (level) => {
                await run(() => api.setThinking(agentId, level));
              }}
              disabled={busy || stopping}
            />
            {stopping ? (
              <Button size="xs" className="composer-action-btn" disabled aria-label="Stopping agent execution">
                Stopping…
              </Button>
            ) : running ? (
              <>
                <Button
                  size="xs"
                  className="composer-action-btn"
                  onClick={() => send("steer")}
                  disabled={busy}
                  title={isMobileComposer ? "Steer now (⌘+Enter)" : "Steer now (Enter)"}
                  aria-label="Steer now"
                >
                  <ArrowUp size={14} aria-hidden="true" />
                </Button>
                <Button
                  variant="secondary"
                  size="xs"
                  className="composer-action-btn"
                  onClick={() => send("followUp")}
                  disabled={busy}
                  title="Queue follow-up"
                  aria-label="Queue follow-up"
                >
                  <Clock size={14} aria-hidden="true" />
                </Button>
                <Button
                  variant="destructive"
                  size="xs"
                  className="composer-action-btn"
                  onClick={() => void run(() => api.abort(agentId))}
                  disabled={busy}
                  title="Stop agent execution"
                  aria-label="Stop agent execution"
                >
                  <Square size={13} aria-hidden="true" />
                </Button>
              </>
            ) : (
              <Button
                size="xs"
                className="send-btn"
                onClick={() => send("prompt")}
                disabled={busy || (!draft.trim() && images.length === 0)}
              >
                {isMobileComposer ? "Send" : "Send ↵"}
              </Button>
            )}
          </div>
        </div>
      </div>
      <AlertDialog open={compactConfirmOpen} onOpenChange={setCompactConfirmOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Compact conversation context?</AlertDialogTitle>
            <AlertDialogDescription>
              Pi will summarize the transcript to free context. The summary replaces earlier history in the
              working session. This cannot be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                setCompactConfirmOpen(false);
                void run(() => api.compact(agentId), false, true);
              }}
            >
              Compact
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </footer>
  );
}

const AgentComposer = memo(AgentComposerInner);

function summarizeChanges(timeline: TimelineItem[]): { fileCount: number; additions: number; deletions: number } | undefined {
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
  concise: boolean;
  expansion?: TimelineExpansionSettings;
  latestIds?: LatestTimelineIds;
  manualToggles?: Record<string, boolean>;
  stickyExpandedIds?: ReadonlySet<string>;
  onToggleManual?: (id: string, open: boolean) => void;
}

export const TimelineRow = memo(function TimelineRow({
  item,
  agentId,
  api,
  concise,
  expansion = DEFAULT_TIMELINE_EXPANSION,
  latestIds = { latestToolIds: {} },
  manualToggles = {},
  stickyExpandedIds,
  onToggleManual,
}: TimelineRowProps) {
  if (item.kind === "unknown") return <article className="timeline-row unknown"><strong>Unknown activity</strong><code>{item.entryType}</code></article>;
  if (item.kind === "tool") {
    const isExpanded = isItemExpanded(item, expansion, latestIds, manualToggles, concise, stickyExpandedIds);
    if (concise && !item.significant && item.status !== "error") {
      return (
        <ToolRow
          item={item}
          conciseBadge
          open={isExpanded}
          onOpenChange={(open) => onToggleManual?.(item.id, open)}
        />
      );
    }
    return (
      <ToolRow
        item={item}
        open={isExpanded}
        onOpenChange={(open) => onToggleManual?.(item.id, open)}
      />
    );
  }
  if (item.kind === "thinking") {
    const isExpanded = isItemExpanded(item, expansion, latestIds, manualToggles, concise, stickyExpandedIds);
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
          <span className="thinking-preview">{preview}…</span>
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
    return (
      <article className="timeline-row summary">
        <strong>{item.summaryType === "compaction" ? "Compacted context" : "Branch summary"}</strong>
        <p>{item.text}</p>
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
