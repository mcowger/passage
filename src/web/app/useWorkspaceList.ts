import { useCallback, useEffect, useRef, useState } from "react";
import type { WorkspaceSnapshot } from "../../shared/domain/workspaces.ts";
import type { AgentStatusKind } from "../components/agentStatus.ts";
import type { WorkspaceApi } from "../api.ts";
import { subscribeWorkspaces } from "../workspaceSocket.ts";
import { LAST_WORKSPACE_KEY, readLastWorkspaceId } from "./appHelpers.tsx";

/**
 * Workspace list, selection, and sidebar status dots. Owns the snapshot
 * fetch, the status poll, the cross-window list subscription, and last
 * workspace persistence. The live fold of selected-workspace agents into
 * the dots stays in App next to the agents state it reads.
 */
export function useWorkspaceList(api: WorkspaceApi) {
  const [snapshot, setSnapshot] = useState<WorkspaceSnapshot>();
  const [snapshotError, setSnapshotError] = useState("");
  const [selectedWorkspaceId, setSelectedWorkspaceId] = useState<string>();
  // At-a-glance activity per workspace for the sidebar dots, covering ALL
  // workspaces (not just the selected one whose agents are loaded above).
  // Missing entries render as empty/gray. Refreshed on snapshot load,
  // on a poll interval, and immediately from live selected-workspace agents.
  const [workspaceStatuses, setWorkspaceStatuses] = useState<Record<string, AgentStatusKind>>({});
  const refreshWorkspaces = useCallback(async (): Promise<boolean> => {
    try {
      setSnapshotError("");
      const next = await api.snapshot();
      setSnapshot(next);
      setSelectedWorkspaceId((current) => {
        const candidates = next.workspaces.filter((workspace) => !workspace.archivedAt);
        // Push deep-link (?workspaceId=&agentId=&source=push) wins over last-used.
        try {
          const params = new URLSearchParams(window.location.search);
          const linked = params.get("workspaceId");
          if (linked && candidates.some((workspace) => workspace.id === linked)) return linked;
        } catch {}
        if (current && candidates.some((workspace) => workspace.id === current)) return current;
        const last = readLastWorkspaceId();
        if (last && candidates.some((workspace) => workspace.id === last)) return last;
        return candidates[0]?.id ?? next.workspaces[0]?.id;
      });
      // The workspace list just changed -- refresh the at-a-glance dots too
      // so new/removed workspaces never show a stale color.
      void api.workspaceAgentStatuses().then(setWorkspaceStatuses).catch(() => {});
      return true;
    } catch (cause) {
      setSnapshotError(cause instanceof Error ? cause.message : "Unable to load workspace snapshot");
      return false;
    }
  }, [api]);

  const refreshWorkspaceStatuses = useCallback(async () => {
    try {
      setWorkspaceStatuses(await api.workspaceAgentStatuses());
    } catch {
      // Best-effort: stale dots beat a broken page; the next poll retries.
    }
  }, [api]);

  // Poll the aggregated status map so non-selected workspaces stay live
  // without loading every workspace's full agent list. 5s keeps the dots
  // fresh without hammering the daemon; visibility-gated to avoid
  // background-tab churn.
  useEffect(() => {
    void refreshWorkspaceStatuses();
    const timer = setInterval(() => {
      if (typeof document !== "undefined" && document.hidden) return;
      void refreshWorkspaceStatuses();
    }, 5000);
    const onFocus = () => { void refreshWorkspaceStatuses(); };
    window.addEventListener("focus", onFocus);
    return () => {
      clearInterval(timer);
      window.removeEventListener("focus", onFocus);
    };
  }, [refreshWorkspaceStatuses]);
  useEffect(() => { void refreshWorkspaces(); }, [refreshWorkspaces]);
  // Live workspace-list invalidation from other windows/tabs: the mutating
  // window already reloaded its snapshot inline, so WS echoes (own or
  // remote) are debounced into a single refetch. Reconnects, missed
  // sequences, and mobile suspension reconcile immediately. Without this,
  // a workspace deleted in one window lingers in every other window.
  const refreshWorkspacesRef = useRef(refreshWorkspaces);
  refreshWorkspacesRef.current = refreshWorkspaces;
  useEffect(() => {
    let invalidateTimer: ReturnType<typeof setTimeout> | undefined;
    const subscription = subscribeWorkspaces(
      () => {
        if (invalidateTimer) clearTimeout(invalidateTimer);
        invalidateTimer = setTimeout(() => {
          invalidateTimer = undefined;
          void refreshWorkspacesRef.current();
        }, 750);
      },
      async () => {
        void refreshWorkspacesRef.current();
      },
    );
    return () => {
      if (invalidateTimer) clearTimeout(invalidateTimer);
      subscription.close();
    };
  }, []);

  useEffect(() => {
    if (!selectedWorkspaceId) return;
    try {
      localStorage.setItem(LAST_WORKSPACE_KEY, selectedWorkspaceId);
    } catch {}
  }, [selectedWorkspaceId]);
  return {
    snapshot,
    snapshotError,
    setSnapshotError,
    selectedWorkspaceId,
    setSelectedWorkspaceId,
    workspaceStatuses,
    setWorkspaceStatuses,
    refreshWorkspaces,
  };
}
