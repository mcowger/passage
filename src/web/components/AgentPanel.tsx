import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { DragEvent } from "react";
import type { AgentCapabilities, AgentHistory, AgentSummary, UserFileRef, UserImageRef } from "../../shared/domain/agents.ts";
import type { WorkspaceSettings, TimelineExpansionSettings } from "../../shared/domain/settings.ts";
import { DEFAULT_TIMELINE_EXPANSION } from "../../shared/domain/settings.ts";
import type { WorkspaceApi } from "../api.ts";
import type { GitStatus } from "../../shared/domain/git.ts";
import { computeLatestTimelineIds } from "../lib/timeline-expansion.ts";
import { hasFileDrag } from "../lib/image-drop.ts";
import { QuestionCard } from "./QuestionCard.tsx";
import { RECEIVING_ACTIVITY_WINDOW_MS, emptyStreamActivity, type StreamActivity, type StreamPhase } from "../lib/stream-activity.ts";

import {
  REPIN_SLACK_PX,
  UNPIN_SLACK_PX,
  isComposerLocked,
  resolveActiveQuestionRequest,
  resolveCurrentModel,
  resolveCurrentThinking,
  resolvePinned,
  resolveStreamActive,
  resolveStreamStartMs,
  timelineWithoutBlockingTool,
} from "./agentPanelState.ts";
import type {
  ComposerGitOption,
  DeleteWorkspacePrompt,
  QueuedFollowUp,
} from "./agentPanelState.ts";
// Re-exported for existing importers (tests, session panels); new code
// should import from ./agentPanelState.ts directly.
export {
  COMPOSER_TOUCH_SEND_SUPPRESS_MS,
  REPIN_SLACK_PX,
  UNPIN_SLACK_PX,
  createQueuedFollowUp,
  isComposerLocked,
  isComposerMergeRelevant,
  isComposerSendItEnabled,
  isComposerSendItMergeable,
  isComposerShipItEnabled,
  isComposerShipItMergeable,
  isWorkspaceDeletable,
  removeQueuedFollowUp,
  resolveActiveQuestionRequest,
  resolveComposerGitOptions,
  resolveGithubMenuState,
  shipPrSteps,
  resolveCurrentModel,
  resolveCurrentThinking,
  resolvePinned,
  resolveStreamActive,
  resolveStreamStartMs,
  shouldSuppressComposerClickAfterTouch,
  timelineWithoutBlockingTool,
} from "./agentPanelState.ts";
export type {
  ComposerGitOption,
  DeleteWorkspacePrompt,
  QueuedFollowUp,
} from "./agentPanelState.ts";

const STREAMING_STATS_INTERVAL_MS = 300;
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
  onOptimisticMessage?: (message: string, images?: UserImageRef[], files?: UserFileRef[]) => void;
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
  onWorkspaceDeleted?: () => void | Promise<void>;
  /** Bumped by the owning session on every history load so the composer's git
   *  buttons re-check status even when live WS invalidations were missed
   *  (e.g. after a browser refresh). */
  gitStatusRefreshKey?: number;
};

// Re-exported for existing importers; new code should import from the
// component modules directly.
export { QueuedFollowUpList } from "./QueuedFollowUpList.tsx";
export { ComposerMergeButton } from "./ComposerMergeButton.tsx";

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
  onWorkspaceDeleted,
  gitStatusRefreshKey,
}: AgentPanelProps) {
  const effectiveHistory = previewHistory ?? history;
  // Distinct from `error` (a failed agent/history fetch): this is the agent
  // itself reporting a stopped/errored Pi process (e.g. it never booted, or
  // crashed mid-run). Nothing retries this automatically -- capabilities and
  // model info stay stuck ("model unavailable") until the user retries --
  // so it needs its own visible, actionable banner. `interrupted` is not a
  // Pi failure: Passage lost track of in-flight work (most commonly a
  // daemon restart), so it gets its own, non-blaming wording.
  const statusErrorMessage = agent.status === "error"
    ? "This agent hit an error and stopped responding. Retry to reconnect."
    : agent.status === "interrupted"
      ? "This agent's work was interrupted (for example, by a Passage restart) before it finished. Retry to continue."
      : "";
  const bannerMessage = error || statusErrorMessage;
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
  const [streamIdleSeconds, setStreamIdleSeconds] = useState<number | null>(null);
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
      setStreamIdleSeconds(null);
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
      setStreamBytes(activity.bytes);
      setStreamIdleSeconds(activity.lastFrameAt > 0 ? Math.max(0, (now - activity.lastFrameAt) / 1000) : null);
    };
    tick();
    const interval = setInterval(tick, STREAMING_STATS_INTERVAL_MS);
    return () => clearInterval(interval);
  }, [streamActive, agent.runStartedAt]);

  // Whether the viewport is following the live tail. A small upward motion
  // unpins it (UNPIN_SLACK_PX); scrolling back near the bottom re-pins it
  // (REPIN_SLACK_PX). Autoscroll never runs while a finger is down, so the
  // per-frame re-assert below can't fight an active touch drag -- the
  // scroll listener records the unpin during the gesture and the next
  // frame after touchend honors it. Row heights can
  // change many times a second while streaming (tool output growing,
  // expansion resolving) -- driving autoscroll off a single post-commit
  // effect let that outpace React and yanked the viewport around. Instead
  // this is re-asserted continuously (every frame while streaming, and
  // synchronously before paint on every other render), so it can only ever
  // sit exactly at the bottom or exactly where the user left it.
  const pinnedRef = useRef(true);
  // True while a touch gesture is active on the timeline. Autoscroll stays
  // parked for the whole gesture so it never fights the finger; the scroll
  // listener (which still runs) decides the post-gesture pin state.
  const userTouchingRef = useRef(false);
  // Finger Y + scroll offset at touchstart, so an upward drag unpins
  // immediately even before the scroll event catches up (iOS coalesces
  // scroll events during a drag).
  const touchStartRef = useRef<{ y: number; scrollTop: number } | null>(null);
  const scrollToBottomIfPinned = () => {
    const el = timelineRef.current;
    if (!el || !pinnedRef.current || userTouchingRef.current) return;
    el.scrollTop = el.scrollHeight;
  };
  const questionRequest = useMemo(
    () => resolveActiveQuestionRequest(agent),
    [agent]
  );
  const pinnedQuestionIdRef = useRef<string | null>(null);
  // Image drop zone: files dropped anywhere on the chat window attach to
  // the composer draft via the ref below. The depth counter balances the
  // bubbled dragenter/dragleave pairs from nested children so the overlay
  // only clears once the pointer truly leaves the panel.
  const attachFilesRef = useRef<((files: FileList | File[] | null) => void) | null>(null);
  const [dropActive, setDropActive] = useState(false);
  const dropDepthRef = useRef(0);

  const handlePanelDragEnter = (event: DragEvent) => {
    if (stopping || !hasFileDrag(event.dataTransfer.types)) return;
    event.preventDefault();
    dropDepthRef.current += 1;
    setDropActive(true);
  };
  const handlePanelDragOver = (event: DragEvent) => {
    if (stopping || !hasFileDrag(event.dataTransfer.types)) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = "copy";
  };
  const handlePanelDragLeave = (event: DragEvent) => {
    if (!hasFileDrag(event.dataTransfer.types)) return;
    event.preventDefault();
    dropDepthRef.current = Math.max(0, dropDepthRef.current - 1);
    if (dropDepthRef.current === 0) setDropActive(false);
  };
  const handlePanelDrop = (event: DragEvent) => {
    if (stopping || !hasFileDrag(event.dataTransfer.types)) return;
    event.preventDefault();
    dropDepthRef.current = 0;
    setDropActive(false);
    const files = event.dataTransfer.files;
    if (files && files.length > 0) attachFilesRef.current?.(files);
  };

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
      pinnedRef.current = resolvePinned(el.scrollHeight - el.scrollTop - el.clientHeight, pinnedRef.current);
      if (hasMoreHistoryRef.current && !loadingMoreHistoryRef.current && el.scrollTop <= LOAD_MORE_HISTORY_SLACK_PX) {
        pendingScrollRestoreRef.current = { scrollHeight: el.scrollHeight, scrollTop: el.scrollTop };
        onLoadMoreHistoryRef.current?.();
      }
    };
    const onTouchStart = (event: TouchEvent) => {
      userTouchingRef.current = true;
      const touch = event.touches[0];
      touchStartRef.current = touch ? { y: touch.clientY, scrollTop: el.scrollTop } : null;
    };
    const onTouchMove = (event: TouchEvent) => {
      // Unpin on upward-drag intent right away instead of waiting for the
      // coalesced scroll event: a downward finger move (clientY grows) or
      // a scrollTop that already retreated past the unpin slack means the
      // user is reading earlier output.
      if (!pinnedRef.current) return;
      const start = touchStartRef.current;
      const touch = event.touches[0];
      if (touch && start && touch.clientY - start.y > 10) {
        pinnedRef.current = false;
        return;
      }
      if (start && start.scrollTop - el.scrollTop > UNPIN_SLACK_PX) {
        pinnedRef.current = false;
      }
    };
    const onTouchEnd = () => {
      userTouchingRef.current = false;
      touchStartRef.current = null;
    };
    el.addEventListener("scroll", onScroll, { passive: true });
    el.addEventListener("touchstart", onTouchStart, { passive: true });
    el.addEventListener("touchmove", onTouchMove, { passive: true });
    el.addEventListener("touchend", onTouchEnd, { passive: true });
    el.addEventListener("touchcancel", onTouchEnd, { passive: true });
    return () => {
      el.removeEventListener("scroll", onScroll);
      el.removeEventListener("touchstart", onTouchStart);
      el.removeEventListener("touchmove", onTouchMove);
      el.removeEventListener("touchend", onTouchEnd);
      el.removeEventListener("touchcancel", onTouchEnd);
    };
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

  // Brand-new sessions have no persisted preference and no journaled model
  // yet; fall back to the live Pi defaults carried by capabilities (from
  // `get_state`) so the chip shows the real model instead of
  // "model unavailable" while the background boot settles. While
  // capabilities are still in flight, show a neutral loading label rather
  // than the error-looking unavailable fallback.
  const liveModel = effectiveHistory?.currentModel ?? capabilities?.currentModel;
  const liveThinkingLevel = effectiveHistory?.currentThinkingLevel ?? capabilities?.currentThinkingLevel;
  const model = liveModel
    ? `${liveModel.provider}/${liveModel.modelId}`
    : agent.modelPreference ?? (capabilities ? "model unavailable" : "loading\u2026");
  const thinking = resolveCurrentThinking(agent.thinkingPreference, liveThinkingLevel);
  const modelOptions = useMemo(
    () => capabilities?.models.filter((option) => option.authenticated) ?? [],
    [capabilities?.models]
  );
  const currentModel = useMemo(
    () => resolveCurrentModel(agent.modelPreference, liveModel, modelOptions),
    [agent.modelPreference, liveModel, modelOptions]
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



  const handleRespondUi = async (result: { id: string; value?: string; custom?: boolean; confirmed?: boolean; cancelled?: true }) => {
    try {
      await api.respondUi(agent.id, result);
      await onRefresh();
    } catch (err) {
      console.error("Failed to respond to UI prompt:", err);
    }
  };

  return (
    <section
      className={`agent-panel${dropActive ? " agent-panel-drop-active" : ""}`}
      aria-label={`Agent conversation ${agent.title}`}
      onDragEnter={handlePanelDragEnter}
      onDragOver={handlePanelDragOver}
      onDragLeave={handlePanelDragLeave}
      onDrop={handlePanelDrop}
    >
      {bannerMessage && (
        <div className="alert agent-alert" role="alert">
          <span>{bannerMessage}</span>
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
                  workspaceId={agent.workspaceId}
                  expansion={sessionExpansion}
                  latestIds={latestIds}
                  manualToggles={manualToggles}
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
        loading={loading}
        idle={agent.status === "idle"}
        streamActive={streamActive}
        streamPhase={streamPhase}
        receiving={receiving}
        elapsedSeconds={elapsedSeconds}
        streamIdleSeconds={streamIdleSeconds}
        streamBytes={streamBytes}
        capabilities={capabilities}
        api={api}
        busy={busy}
        setBusy={setBusy}
        onRefresh={onRefresh}
        onModelChanged={onModelChanged}
        onOptimisticMessage={(message, images, files) => {
          // A user sending a new message always wants to see it, even if they
          // had scrolled up to read earlier output.
          pinnedRef.current = true;
          onOptimisticMessage?.(message, images, files);
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
        onWorkspaceDeleted={onWorkspaceDeleted}
        gitStatusRefreshKey={gitStatusRefreshKey}
        attachFilesRef={attachFilesRef}
      />
      {dropActive && (
        <div className="agent-drop-overlay" aria-hidden="true">
          <span className="agent-drop-overlay-label">Drop files to attach</span>
        </div>
      )}
    </section>
  );
}

import { TimelineRow, summarizeChanges } from "./TimelineRow.tsx";
// Re-exported for existing importers (tests); new code should import from
// ./TimelineRow.tsx directly.
export {
  extractLatestThinkingSummary,
  formatDuration,
  formatIdleSinceLastFrame,
  formatThinkingPreview,
  renderFileRefs,
  truncateFileRefPath,
  TimelineRow,
} from "./TimelineRow.tsx";
export type { TimelineRowProps } from "./TimelineRow.tsx";

import { AgentComposer } from "./AgentComposer.tsx";

