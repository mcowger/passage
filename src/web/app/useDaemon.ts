import { useCallback, useEffect, useRef, useState } from "react";
import type { BuildInfo } from "../../shared/build-info.ts";
import type { ConnectionHealth } from "../socketLifecycle.ts";
import type { DaemonLifecycleSnapshot, WorkspaceApi } from "../api.ts";
import { subscribeDaemon } from "../daemonSocket.ts";

/**
 * Daemon build identity, lifecycle (drain) state, and WS transport health.
 * Owns the always-mounted daemon socket subscription; App just reads.
 */
export function useDaemon(api: WorkspaceApi) {
  const [build, setBuild] = useState<BuildInfo | null>(null);
  const [daemonLifecycle, setDaemonLifecycle] = useState<DaemonLifecycleSnapshot | null>(null);
  const [drainBusy, setDrainBusy] = useState(false);
  // Daemon build identity for the sidebar footer + deploy verification,
  // plus lifecycle phase/blockers (DaemonLifecycle drain state).
  // Best-effort: the sidebar falls back to dev when unknown
  // and hides the drain control entirely when the phase is unknown.
  const refreshDaemon = useCallback(async () => {
    try {
      const daemon = await api.daemonSnapshot();
      setBuild(daemon.build);
      setDaemonLifecycle(daemon);
    } catch {
      setBuild(null);
      setDaemonLifecycle(null);
    }
  }, [api]);

  useEffect(() => { void refreshDaemon(); }, [refreshDaemon]);

  // Live daemon lifecycle invalidation: begin/cancel drain and readiness
  // changes made here or in another window/tab. Reconnects, missed
  // sequences, and mobile suspension reconcile immediately -- a stale
  // drain phase must never linger silently.
  const refreshDaemonRef = useRef(refreshDaemon);
  refreshDaemonRef.current = refreshDaemon;
  // Real WS transport health for the sidebar's connection indicator, not a
  // hardcoded label (docs/IOSWEBSOCKETS.md): the daemon socket is the one
  // always-mounted `/ws` connection, so its heartbeat status stands in for
  // overall reachability.
  const [wsHealth, setWsHealth] = useState<ConnectionHealth>("checking");
  useEffect(() => {
    let invalidateTimer: ReturnType<typeof setTimeout> | undefined;
    const subscription = subscribeDaemon(
      () => {
        if (invalidateTimer) clearTimeout(invalidateTimer);
        invalidateTimer = setTimeout(() => {
          invalidateTimer = undefined;
          void refreshDaemonRef.current();
        }, 300);
      },
      async () => { void refreshDaemonRef.current(); },
      setWsHealth,
    );
    return () => {
      if (invalidateTimer) clearTimeout(invalidateTimer);
      subscription.close();
    };
  }, []);

  const handleBeginDrain = useCallback(async () => {
    setDrainBusy(true);
    try {
      const daemon = await api.beginDrain();
      setDaemonLifecycle((current) => current ? { ...current, ...daemon } : null);
    } catch {
      // The live subscription/reconcile above will still catch up if this
      // request actually landed despite a dropped response.
    } finally {
      setDrainBusy(false);
    }
  }, [api]);

  const handleCancelDrain = useCallback(async () => {
    setDrainBusy(true);
    try {
      const daemon = await api.cancelDrain();
      setDaemonLifecycle((current) => current ? { ...current, ...daemon } : null);
    } catch {
    } finally {
      setDrainBusy(false);
    }
  }, [api]);
  return { build, daemonLifecycle, drainBusy, wsHealth, handleBeginDrain, handleCancelDrain };
}
