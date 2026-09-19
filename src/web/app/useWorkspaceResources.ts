import { useCallback, useEffect, useRef, useState } from "react";
import type { AgentHistory, AgentSummary } from "../../shared/domain/agents.ts";
import type { TerminalSummary } from "../../shared/domain/terminals.ts";
import type { WebPreview } from "../../shared/domain/previews.ts";
import type { WorkspaceActionRun } from "../../shared/domain/workspace-actions.ts";
import type { WorkspaceApi } from "../api.ts";
import { toast } from "sonner";
import { subscribeWorkspace } from "../workspaceSocket.ts";
import { setupToastId } from "./appHelpers.tsx";

export type WorkspaceResourcesCallbacks = {
  loadLayout: (workspaceId: string) => void;
  onWorkspaceSwitched: () => void;
};

/**
 * Agents, terminals, and previews for the selected workspace: lists,
 * selection, loaders, setup-run toast orchestration, and the
 * cross-window reconcile subscription. Tab state and layout stay in App.
 */
export function useWorkspaceResources(
  api: WorkspaceApi,
  workspaceId: string | undefined,
  callbacks: WorkspaceResourcesCallbacks,
) {
  const { loadLayout, onWorkspaceSwitched } = callbacks;
  const [selectedAgentId, setSelectedAgentId] = useState<string>();
  const [selectedTerminalId, setSelectedTerminalId] = useState<string>();
  const [agents, setAgents] = useState<AgentSummary[]>([]);
  const [agentsLoaded, setAgentsLoaded] = useState(false);
  const [autoAgentPending, setAutoAgentPending] = useState(false);
  const [terminals, setTerminals] = useState<TerminalSummary[]>([]);
  const [terminalsLoaded, setTerminalsLoaded] = useState(false);
  const [previews, setPreviews] = useState<WebPreview[]>([]);
  const [selectedPreviewId, setSelectedPreviewId] = useState<string>();
  const [previewHistory, setPreviewHistory] = useState<AgentHistory | null>(null);
  const [agentError, setAgentError] = useState("");
  const pendingSetupRuns = useRef(new Map<string, string>());
  const autoAgentAttempted = useRef(new Set<string>());
  const announcedSetupRuns = useRef(new Set<string>());
  const agentsLoadGeneration = useRef(0);
  const terminalsLoadGeneration = useRef(0);
  // Offline transcript preview for rendering verification (?transcriptPreview=1
  // with PASSAGE_TRANSCRIPT_PREVIEW=1 on the daemon). Never live agent state.
  useEffect(() => {
    if (typeof window === "undefined") return;
    if (new URLSearchParams(window.location.search).get("transcriptPreview") !== "1") return;
    let cancelled = false;
    void api.transcriptPreview()
      .then((preview) => { if (!cancelled) setPreviewHistory(preview); })
      .catch(() => { if (!cancelled) setPreviewHistory(null); });
    return () => { cancelled = true; };
  }, [api]);
  const loadAgents = useCallback(async (workspaceId: string, selectFirst = true) => {
    const generation = ++agentsLoadGeneration.current;
    try {
      const next = await api.listAgents(workspaceId);
      if (generation !== agentsLoadGeneration.current) return;
      setAgentError("");
      setAgents(next);
      setSelectedAgentId((current) => {
        // Push deep-link (?agentId=) wins once when the agent list lands.
        try {
          const linked = new URLSearchParams(window.location.search).get("agentId");
          if (linked && next.some((agent) => agent.id === linked)) return linked;
        } catch {}
        if (current && next.some((agent) => agent.id === current)) return current;
        return selectFirst ? next[0]?.id : undefined;
      });
      setAgentsLoaded(true);
    } catch (cause) {
      if (generation !== agentsLoadGeneration.current) return;
      setAgentError(cause instanceof Error ? cause.message : "Unable to load agents");
      setAgentsLoaded(true);
    }
  }, [api]);

  const loadTerminals = useCallback(async (workspaceId: string, selectFirst = true) => {
    const generation = ++terminalsLoadGeneration.current;
    try {
      const next = await api.listTerminals(workspaceId);
      if (generation !== terminalsLoadGeneration.current) return;
      setTerminals(next);
      setSelectedTerminalId((current) => {
        if (current && next.some((t) => t.id === current)) return current;
        return selectFirst ? next[0]?.id : undefined;
      });
      setTerminalsLoaded(true);
    } catch {
      if (generation !== terminalsLoadGeneration.current) return;
      setTerminals([]);
      setTerminalsLoaded(true);
    }
  }, [api]);

  const loadPreviews = useCallback(async (workspaceId: string, selectFirst = true) => {
    try {
      const next = await api.listPreviews(workspaceId);
      setPreviews(next);
      setSelectedPreviewId((current) => {
        if (current && next.some((p) => p.id === current)) return current;
        return selectFirst ? next[0]?.id : undefined;
      });
    } catch {}
  }, [api]);
  useEffect(() => {
    agentsLoadGeneration.current += 1;
    terminalsLoadGeneration.current += 1;
    setAgents([]);
    setAgentsLoaded(false);
    setAutoAgentPending(false);
    setTerminals([]);
    setTerminalsLoaded(false);
    setPreviews([]);
    setSelectedAgentId(undefined);
    setSelectedTerminalId(undefined);
    setSelectedPreviewId(undefined);
    onWorkspaceSwitched();
    if (workspaceId) {
      void loadAgents(workspaceId);
      void loadTerminals(workspaceId);
      void loadPreviews(workspaceId);
      void loadLayout(workspaceId);
    }
  }, [loadAgents, loadTerminals, loadPreviews, loadLayout, onWorkspaceSwitched, workspaceId]);
  useEffect(() => {
    if (!workspaceId) return;
    const settleSetupRun = (run: WorkspaceActionRun) => {
      if (run.status === "running" || announcedSetupRuns.current.has(run.id)) return;
      announcedSetupRuns.current.add(run.id);
      pendingSetupRuns.current.delete(run.workspaceId);
      const id = setupToastId(run.id);
      if (run.status === "succeeded") {
        toast.success("Workspace setup complete", {
          id,
          description: `Finished ${run.results.length} setup command${run.results.length === 1 ? "" : "s"}.`,
          duration: 5000,
        });
        return;
      }
      const failed = run.results.find((result) => result.exitCode !== 0);
      toast.error("Workspace setup failed", {
        id,
        description: failed
          ? `${failed.command}${failed.exitCode === null ? " was cancelled or timed out." : ` exited with code ${failed.exitCode}.`}`
          : run.error ?? "The setup action did not complete.",
        duration: 8000,
      });
    };
    const ensureSetupToast = () => {
      const runId = pendingSetupRuns.current.get(workspaceId);
      if (!runId || announcedSetupRuns.current.has(runId)) return;
      // Re-assert the loading state so the progression toast stays visible
      // across reloads or workspace switches, and so a run that finished
      // before we subscribed still resolves into the same toast.
      toast.loading("Setting up workspace", {
        id: setupToastId(runId),
        description: "Running the worktree setup action in the background.",
        duration: Infinity,
      });
      void api.getWorkspaceActionRun(workspaceId, runId).then(settleSetupRun).catch(() => undefined);
    };
    ensureSetupToast();
    const sub = subscribeWorkspace(
      workspaceId,
      (event) => {
        if (event.type !== "actions-changed") return;
        const payload = event.payload as { runId?: unknown };
        const runId = typeof payload.runId === "string" ? payload.runId : undefined;
        if (!runId || pendingSetupRuns.current.get(workspaceId) !== runId || announcedSetupRuns.current.has(runId)) return;
        void api.getWorkspaceActionRun(workspaceId, runId).then(settleSetupRun).catch(() => undefined);
      },
      async () => {
        await Promise.all([
          loadAgents(workspaceId, false),
          loadTerminals(workspaceId, false),
          loadPreviews(workspaceId, false),
        ]);
      }
    );
    return () => sub.close();
  }, [workspaceId, loadAgents, loadTerminals, loadPreviews]);
  return {
    agents,
    setAgents,
    agentsLoaded,
    agentError,
    setAgentError,
    selectedAgentId,
    setSelectedAgentId,
    autoAgentPending,
    setAutoAgentPending,
    autoAgentAttempted,
    terminals,
    setTerminals,
    terminalsLoaded,
    selectedTerminalId,
    setSelectedTerminalId,
    previews,
    setPreviews,
    selectedPreviewId,
    setSelectedPreviewId,
    previewHistory,
    loadAgents,
    loadTerminals,
    loadPreviews,
    pendingSetupRuns,
  };
}
