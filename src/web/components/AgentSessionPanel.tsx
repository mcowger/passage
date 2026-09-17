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
  onHistory: (history: AgentHistory | undefined) => void;
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
export async function loadAgentSession(loader: AgentSessionLoader): Promise<void> {
  try {
    const [summary, result] = await Promise.all([loader.api.agent(loader.agentId), loader.api.history(loader.agentId)]);
    if (!loader.isCurrent()) return;
    loader.onSummary(summary);
    loader.onHistory("unpersisted" in result ? undefined : result.history);
    loader.onError("");
  } catch (cause) {
    if (loader.isCurrent()) {
      loader.onError(cause instanceof Error ? cause.message : "Unable to load agent");
      loader.onSettled();
    }
    return;
  }
  if (loader.isCurrent()) loader.onSettled();
  try {
    const capabilities = await loader.api.capabilities(loader.agentId);
    if (loader.isCurrent()) loader.onCapabilities(capabilities);
  } catch {
    if (loader.isCurrent()) loader.onCapabilities(undefined);
  }
}

export function AgentSessionPanel({ agent: initialAgent, api, onAgentChanged, previewHistory, settings }: AgentSessionPanelProps) {
  const [agent, setAgent] = useState(initialAgent);
  const [history, setHistory] = useState<AgentHistory>();
  const [capabilities, setCapabilities] = useState<AgentCapabilities>();
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const generation = useRef(0);
  const onAgentChangedRef = useRef(onAgentChanged);
  onAgentChangedRef.current = onAgentChanged;

  const updateAgent = useCallback((next: AgentSummary) => {
    setAgent(next);
    onAgentChangedRef.current?.(next);
  }, []);

  const load = useCallback(async (isInitial = false) => {
    const currentGeneration = ++generation.current;
    if (isInitial) setLoading(true);
    await loadAgentSession({
      agentId: initialAgent.id,
      api,
      isCurrent: () => currentGeneration === generation.current,
      onSummary: updateAgent,
      onHistory: setHistory,
      onCapabilities: setCapabilities,
      onError: setError,
      onSettled: () => setLoading(false),
    });
  }, [api, initialAgent.id, updateAgent]);

  useEffect(() => {
    setAgent(initialAgent);
    setHistory(undefined);
    setCapabilities(undefined);
    void load(true);

    const subscription = subscribeAgent(
      initialAgent.id,
      (value, state) => {
        if (state.status) {
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
      () => load(),
    );
    return () => subscription.close();
  }, [initialAgent.id, load]);

  return (
    <AgentPanel
      agent={agent}
      history={history}
      capabilities={capabilities}
      loading={loading}
      error={error}
      api={api}
      settings={settings}
      onRefresh={() => load()}
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
