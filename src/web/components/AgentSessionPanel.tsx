import { useCallback, useEffect, useRef, useState } from "react";
import type { AgentCapabilities, AgentHistory, AgentSummary } from "../../shared/domain/agents.ts";
import { timelineItemPayloadSchema } from "../../shared/domain/agents.ts";
import type { WorkspaceSettings } from "../../shared/domain/settings.ts";
import { subscribeAgent } from "../agentSocket.ts";
import type { WorkspaceApi } from "../api.ts";
import { addOptimisticUserMessage, applyRowUpsert, applyUsageEvent } from "../lib/transcript-apply.ts";
import { deriveStreamPhase, emptyStreamActivity, measureEnvelopeBytes, trackStreamFrame, type StreamActivity } from "../lib/stream-activity.ts";
import { AgentPanel } from "./AgentPanel.tsx";

export type AgentSessionPanelProps = {
  agent: AgentSummary;
  api: WorkspaceApi;
  onAgentChanged?: (agent: AgentSummary) => void;
  previewHistory?: AgentHistory;
  settings?: WorkspaceSettings;
  onWorkspaceDeleted?: () => void | Promise<void>;
};

/** Timeline rows fetched for the initial render and on every full reload.
 *  Kept small (rather than the API's own 100-row default) so a session with
 *  a long history still paints on the first round trip on a slow mobile
 *  connection; older rows are backfilled on demand as the user scrolls up. */
export const HISTORY_PAGE_LIMIT = 20;

export type AgentSessionLoader = {
  agentId: string;
  api: Pick<WorkspaceApi, "agent" | "history" | "capabilities">;
  isCurrent: () => boolean;
  onSummary: (summary: AgentSummary) => void;
  onHistory: (history: AgentHistory | undefined, nextBefore?: number) => void;
  onCapabilities: (capabilities: AgentCapabilities | undefined) => void;
  onError: (message: string) => void;
  onSettled: () => void;
};

/**
 * Loads one agent session view. Agent metadata and history settle the view so
 * the transcript can render; capabilities are fetched afterwards because that
 * RPC can block on Pi process startup. Gating the transcript on capabilities
 * leaves a slow or hung capabilities call stuck on "Loading history…" even
 * though history already arrived.
 */
export type AgentSessionLoadResult = "loaded" | "failed" | "superseded";

export async function loadAgentSession(loader: AgentSessionLoader): Promise<AgentSessionLoadResult> {
  try {
    const [summary, result] = await Promise.all([
      loader.api.agent(loader.agentId),
      loader.api.history(loader.agentId, undefined, HISTORY_PAGE_LIMIT),
    ]);
    if (!loader.isCurrent()) return "superseded";
    loader.onSummary(summary);
    loader.onHistory("unpersisted" in result ? undefined : result.history, "unpersisted" in result ? undefined : result.nextBefore);
    loader.onError("");
    loader.onSettled();
  } catch (cause) {
    if (!loader.isCurrent()) return "superseded";
    loader.onError(cause instanceof Error ? cause.message : "Unable to load agent");
    loader.onSettled();
    return "failed";
  }
  try {
    const capabilities = await loader.api.capabilities(loader.agentId);
    if (!loader.isCurrent()) return "superseded";
    loader.onCapabilities(capabilities);
    // create() returns before its background Pi boot persists the model /
    // thinking defaults, so the summary fetched above can still carry null
    // preferences for a brand-new agent. capabilities() awaits that boot,
    // so a fresh summary read here picks up what reconcile just wrote and
    // the composer stops showing "model unavailable".
    try {
      const freshSummary = await loader.api.agent(loader.agentId);
      if (loader.isCurrent()) loader.onSummary(freshSummary);
    } catch {
      // Keep the earlier summary; model display already falls back to the
      // live defaults carried by capabilities.
    }
  } catch {
    if (!loader.isCurrent()) return "superseded";
    loader.onCapabilities(undefined);
    try {
      const freshSummary = await loader.api.agent(loader.agentId);
      if (loader.isCurrent()) loader.onSummary(freshSummary);
    } catch {
      // Keep the earlier summary on refresh failure too.
    }
  }
  return "loaded";
}

/** Runs a load and retries once after a failure. Initial mount and
 *  reconnect/suspend reconciliation both use this: a phone suspend or a
 *  dropped stream can kill the first fetch before it settles. Superseded
 *  loads are not retried -- a newer load already owns the view. */
export async function loadAgentSessionWithRetry(
  attempt: (isInitial: boolean) => Promise<AgentSessionLoadResult>,
  isInitial: boolean,
): Promise<void> {
  if ((await attempt(isInitial)) !== "failed") return;
  await attempt(false);
}

/**
 * Merges a freshly fetched `AgentHistory` onto the currently rendered one.
 *
 * The daemon's `transcriptEpoch` says whether the in-memory transcript this
 * fetch reflects is the same one the client has been receiving `row_upsert`
 * deltas for. Same epoch: the live row-upsert stream is the sole, complete
 * source of timeline mutations, so only the non-timeline fields (usage,
 * model, context tokens, ...) are refreshed here -- replacing `timeline` too
 * would just reintroduce the reorder/duplicate bug this design exists to
 * avoid. Different epoch (first load, daemon restart, or a compaction reset):
 * the old timeline's row ids may no longer mean anything, so it is replaced.
 */
export function mergeLoadedHistory(current: AgentHistory | undefined, loaded: AgentHistory | undefined): AgentHistory | undefined {
  if (!loaded) return current;
  if (!current || current.transcriptEpoch !== loaded.transcriptEpoch) return loaded;
  // A same-epoch refetch can race a live usage delta the client already
  // applied (the journal lags the stream while a turn is in flight), so
  // keep the higher cost instead of letting a stale zero blink the
  // composer's cost pill out until the next live event re-asserts it.
  return {
    ...loaded,
    timeline: current.timeline,
    usage: { ...loaded.usage, cost: Math.max(current.usage.cost, loaded.usage.cost) },
  };
}

/** True exactly when `mergeLoadedHistory` would discard the currently
 *  rendered timeline wholesale, which is also when a backfilled pagination
 *  cursor (`nextBefore`) stops meaning anything and must be replaced by the
 *  fresh page's own cursor instead of kept as-is. */
export function historyReplaced(current: AgentHistory | undefined, loaded: AgentHistory | undefined): boolean {
  return loaded !== undefined && (!current || current.transcriptEpoch !== loaded.transcriptEpoch);
}

/**
 * Prepends an older page of history (fetched by scrolling up) onto the
 * currently rendered timeline. Ids are deduped defensively in case the page
 * boundary raced a live row-upsert that already delivered one of these rows.
 */
export function prependOlderHistory(current: AgentHistory | undefined, older: AgentHistory | undefined): AgentHistory | undefined {
  if (!older) return current;
  if (!current) return older;
  const existingIds = new Set(current.timeline.map((item) => item.id));
  const olderRows = older.timeline.filter((item) => !existingIds.has(item.id));
  return { ...current, timeline: [...olderRows, ...current.timeline] };
}

export function AgentSessionPanel({ agent: initialAgent, api, onAgentChanged, previewHistory, settings, onWorkspaceDeleted }: AgentSessionPanelProps) {
  const [agent, setAgent] = useState(initialAgent);
  const [history, setHistory] = useState<AgentHistory>();
  const [capabilities, setCapabilities] = useState<AgentCapabilities>();
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [nextBefore, setNextBefore] = useState<number>();
  const [loadingOlder, setLoadingOlder] = useState(false);
  const generation = useRef(0);
  const historyRef = useRef<AgentHistory | undefined>(undefined);
  historyRef.current = history;
  // Written on every relayed `pi` frame (a ref, not state, so a frame burst
  // never adds a render); the pill samples it on its own interval tick.
  const streamActivityRef = useRef<StreamActivity>(emptyStreamActivity());
  const loadingOlderRef = useRef(false);
  const onAgentChangedRef = useRef(onAgentChanged);
  onAgentChangedRef.current = onAgentChanged;

  const updateAgent = useCallback((next: AgentSummary) => {
    setAgent(next);
    onAgentChangedRef.current?.(next);
  }, []);

  // Trust freshly fetched summaries as-is: a previous revision kept a stale
  // `running` status over an idle REST response to avoid a flicker when an
  // HTTP fetch raced a live run, but that veto never cleared when the
  // `settled` event was missed (daemon restart, new system / new browser
  // with an empty replay buffer), leaving the composer stuck showing
  // "generation in flight" and sending `steer` (a no-op when idle) instead
  // of `prompt`. Timeline safety for racing fetches is handled by
  // `mergeLoadedHistory` (transcript epoch), and a genuinely running agent
  // re-asserts `running` via the next socket status / `row_upsert` envelope,
  // so a brief stale-idle flash self-heals while a stuck-running state does
  // not.
  const load = useCallback(async (isInitial = false): Promise<AgentSessionLoadResult> => {
    const currentGeneration = ++generation.current;
    if (isInitial) setLoading(true);
    return await loadAgentSession({
      agentId: initialAgent.id,
      api,
      isCurrent: () => currentGeneration === generation.current,
      onSummary: updateAgent,
      onHistory: (loaded, loadedNextBefore) => {
        if (historyReplaced(historyRef.current, loaded)) setNextBefore(loadedNextBefore);
        setHistory((current) => mergeLoadedHistory(current, loaded));
      },
      onCapabilities: setCapabilities,
      onError: setError,
      onSettled: () => setLoading(false),
    });
  }, [api, initialAgent.id, updateAgent]);

  // Retry once on failure so a transient mobile suspend or dropped stream
  // recovers without a manual reload, on both first load and reconcile.
  const loadWithRetry = useCallback(async (isInitial = false) => {
    await loadAgentSessionWithRetry(load, isInitial);
  }, [load]);

  // Fetches the next page of older rows (scrolled into view above the
  // currently rendered timeline) and prepends them. Guarded by a ref rather
  // than just the `loadingOlder` state so back-to-back scroll events in the
  // same tick can't both slip through before the first fetch's state update
  // commits.
  const loadOlder = useCallback(async () => {
    if (nextBefore === undefined || loadingOlderRef.current) return;
    loadingOlderRef.current = true;
    setLoadingOlder(true);
    const currentGeneration = generation.current;
    try {
      const result = await api.history(initialAgent.id, nextBefore, HISTORY_PAGE_LIMIT);
      if (currentGeneration !== generation.current) return;
      const older = "unpersisted" in result ? undefined : result.history;
      setHistory((current) => prependOlderHistory(current, older));
      setNextBefore("unpersisted" in result ? undefined : result.nextBefore);
    } catch {
      // Leave nextBefore as-is so scrolling up again retries the same page.
    } finally {
      loadingOlderRef.current = false;
      setLoadingOlder(false);
    }
  }, [api, initialAgent.id, nextBefore]);

  useEffect(() => {
    setAgent(initialAgent);
    setHistory(undefined);
    setCapabilities(undefined);
    setNextBefore(undefined);
    loadingOlderRef.current = false;
    setLoadingOlder(false);
    streamActivityRef.current = emptyStreamActivity();
    void loadWithRetry(true);

    const subscription = subscribeAgent(
      initialAgent.id,
      (value, state) => {
        const envelopePayload = value && typeof value === "object" && "payload" in value && typeof (value as { payload?: unknown }).payload === "object"
          ? (value as { payload: Record<string, unknown> }).payload
          : undefined;
        const runStartedAt = typeof envelopePayload?.runStartedAt === "number"
          && Number.isSafeInteger(envelopePayload.runStartedAt)
          && envelopePayload.runStartedAt > 0
          ? envelopePayload.runStartedAt
          : undefined;
        if (state.status || runStartedAt !== undefined) {
          setAgent((current) => {
            const next = {
              ...current,
              ...(state.status ? { status: state.status } : {}),
              ...(runStartedAt !== undefined ? { runStartedAt } : {}),
            };
            onAgentChangedRef.current?.(next);
            return next;
          });
        }
        if (value && typeof value === "object" && "type" in value) {
          const type = (value as { type?: string }).type;
          const payload = envelopePayload;
          if (typeof type === "string") {
            trackStreamFrame(streamActivityRef.current, measureEnvelopeBytes(value), deriveStreamPhase(type, payload));
          } else {
            trackStreamFrame(streamActivityRef.current, measureEnvelopeBytes(value), null);
          }
          if (type === "attention" && payload?.id) {
            setAgent((current) => {
              const next = { ...current, pendingUiRequest: payload };
              onAgentChangedRef.current?.(next);
              return next;
            });
          } else if (type === "settled" || type === "agent_settled" || (state.status && state.status !== "needs-attention")) {
            setAgent((current) => {
              const next = { ...current, pendingUiRequest: undefined };
              onAgentChangedRef.current?.(next);
              return next;
            });
          }
          if (type === "settled" || type === "agent_settled") void load();
          if (type === "transcript_reset") void load();
          if (type === "title" && payload && typeof payload.title === "string" && payload.title.trim()) {
            const title = payload.title.trim().slice(0, 256);
            setAgent((current) => {
              if (current.title === title) return current;
              const next = { ...current, title };
              onAgentChangedRef.current?.(next);
              return next;
            });
          }
          if (type === "row_upsert" && payload) {
            const parsed = timelineItemPayloadSchema.safeParse(payload.row);
            if (parsed.success) setHistory((current) => applyRowUpsert(current, parsed.data));
          } else {
            setHistory((current) => applyUsageEvent(current, payload));
          }
        }
      },
      () => loadWithRetry(),
    );
    return () => subscription.close();
  }, [initialAgent.id, load, loadWithRetry]);

  return (
    <AgentPanel
      agent={agent}
      history={history}
      capabilities={capabilities}
      loading={loading}
      error={error}
      api={api}
      settings={settings}
      onRefresh={async () => { await load(); }}
      onModelChanged={updateAgent}
      onArchive={() => Promise.resolve()}
      onOptimisticMessage={(message, images, files) => {
        setHistory((current) => addOptimisticUserMessage(current, message, images, files));
      }}
      previewHistory={previewHistory}
      hasMoreHistory={nextBefore !== undefined}
      loadingMoreHistory={loadingOlder}
      onLoadMoreHistory={loadOlder}
      streamActivityRef={streamActivityRef}
      onWorkspaceDeleted={onWorkspaceDeleted}
    />
  );
}
