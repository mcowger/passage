import { useCallback, useEffect, useRef, useState } from "react";
import type { AgentCapabilities, AgentHistory, AgentSummary } from "../../shared/domain/agents.ts";
import type { WorkspaceSettings } from "../../shared/domain/settings.ts";
import { subscribeAgent } from "../agentSocket.ts";
import type { WorkspaceApi } from "../api.ts";
import { applyStreamEvent } from "../lib/streaming-events.ts";
import { AgentPanel } from "./AgentPanel.tsx";

export type AgentSessionPanelProps = {
  agent: AgentSummary;
  api: WorkspaceApi;
  onAgentChanged?: (agent: AgentSummary) => void;
  previewHistory?: AgentHistory;
  settings?: WorkspaceSettings;
};

export type AgentSessionLoader = {
  agentId: string;
  api: Pick<WorkspaceApi, "agent" | "history" | "capabilities">;
  isCurrent: () => boolean;
  onSummary: (summary: AgentSummary) => void;
  onHistory: (history: AgentHistory | undefined, summary: AgentSummary) => void;
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

/**
 * HTTP history is durable but can lag the live WebSocket projection. Retain
 * that projection until Pi settles so a stale snapshot cannot erase the new
 * user boundary or append subsequent deltas to an earlier turn.
 */
export function mergeAgentHistory(
  summary: AgentSummary,
  current: AgentHistory | undefined,
  incoming: AgentHistory | undefined,
): AgentHistory | undefined {
  if (!incoming) return current;
  if (
    summary.status === "running"
    && current
    && current.timeline.length > incoming.timeline.length
  ) {
    return {
      ...current,
      revision: incoming.revision,
      usage: current.usage.totalTokens > incoming.usage.totalTokens ? current.usage : incoming.usage,
    };
  }
  return incoming;
}

export async function loadAgentSession(loader: AgentSessionLoader): Promise<AgentSessionLoadResult> {
  try {
    const [summary, result] = await Promise.all([loader.api.agent(loader.agentId), loader.api.history(loader.agentId)]);
    if (!loader.isCurrent()) return "superseded";
    loader.onSummary(summary);
    loader.onHistory("unpersisted" in result ? undefined : result.history, summary);
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
    if (loader.isCurrent()) loader.onCapabilities(capabilities);
  } catch {
    if (loader.isCurrent()) loader.onCapabilities(undefined);
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

export function AgentSessionPanel({ agent: initialAgent, api, onAgentChanged, previewHistory, settings }: AgentSessionPanelProps) {
  const [agent, setAgent] = useState(initialAgent);
  const [history, setHistory] = useState<AgentHistory>();
  const [capabilities, setCapabilities] = useState<AgentCapabilities>();
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const generation = useRef(0);
  const statusRef = useRef(initialAgent.status);
  const onAgentChangedRef = useRef(onAgentChanged);
  onAgentChangedRef.current = onAgentChanged;

  const updateAgent = useCallback((next: AgentSummary) => {
    statusRef.current = next.status;
    setAgent(next);
    onAgentChangedRef.current?.(next);
  }, []);

  const updateLoadedAgent = useCallback((next: AgentSummary) => {
    const status = statusRef.current === "running" && next.status !== "running" ? "running" : next.status;
    updateAgent({ ...next, status });
  }, [updateAgent]);

  const load = useCallback(async (isInitial = false): Promise<AgentSessionLoadResult> => {
    const currentGeneration = ++generation.current;
    if (isInitial) setLoading(true);
    return await loadAgentSession({
      agentId: initialAgent.id,
      api,
      isCurrent: () => currentGeneration === generation.current,
      onSummary: updateLoadedAgent,
      onHistory: (incoming, summary) => {
        const currentSummary = statusRef.current === "running" ? { ...summary, status: "running" as const } : summary;
        setHistory((current) => mergeAgentHistory(currentSummary, current, incoming));
      },
      onCapabilities: setCapabilities,
      onError: setError,
      onSettled: () => setLoading(false),
    });
  }, [api, initialAgent.id, updateLoadedAgent]);

  // Retry once on failure so a transient mobile suspend or dropped stream
  // recovers without a manual reload, on both first load and reconcile.
  const loadWithRetry = useCallback(async (isInitial = false) => {
    await loadAgentSessionWithRetry(load, isInitial);
  }, [load]);

  useEffect(() => {
    statusRef.current = initialAgent.status;
    setAgent(initialAgent);
    setHistory(undefined);
    setCapabilities(undefined);
    void loadWithRetry(true);

    const subscription = subscribeAgent(
      initialAgent.id,
      (value, state) => {
        if (state.status) {
          statusRef.current = state.status;
          setAgent((current) => {
            const next = { ...current, status: state.status! };
            onAgentChangedRef.current?.(next);
            return next;
          });
        }
        if (value && typeof value === "object" && "type" in value) {
          const type = (value as { type?: string }).type;
          const payload = "payload" in value && typeof (value as { payload?: unknown }).payload === "object"
            ? (value as { payload: Record<string, unknown> }).payload
            : undefined;
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
        }
        setHistory((current) => applyStreamEvent(current, value) ?? current);
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
      onOptimisticMessage={(message) => {
        setHistory((current) => {
          const base = current ? { ...current, timeline: [...current.timeline] } : {
            sessionId: "",
            revision: { mtimeMs: Date.now(), size: 0, contentHash: "" },
            timeline: [],
            branches: [],
            usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: 0 },
            contextUsage: { tokens: null },
            unknownRecordCount: 0,
            agentErrorCount: 0,
            malformedRecordCount: 0,
            partialTail: false,
            invalidUtf8Count: 0,
            rewritten: false,
          } satisfies AgentHistory;
          return {
            ...base,
            timeline: [...base.timeline, { kind: "user", id: `user-${Date.now()}`, text: message }],
          };
        });
      }}
      previewHistory={previewHistory}
    />
  );
}
