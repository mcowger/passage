import { useCallback, useEffect, useRef, useState } from "react";
import type { BuildInfo } from "../../shared/build-info.ts";
import type { ConnectionHealth } from "../socketLifecycle.ts";
import type { WorkspaceApi } from "../api.ts";
import { subscribeDaemon } from "../daemonSocket.ts";

/**
 * Daemon build identity and WS transport health.
 * Owns the always-mounted daemon socket subscription; App just reads.
 * The daemon channel is presence/health only (the server answers each
 * subscribe with `snapshot-required` and emits nothing further), so the
 * snapshot refetch below runs on connect/reconnect/suspend and the
 * heartbeat drives the connection indicator after that.
 */
export function useDaemon(api: WorkspaceApi) {
  const [build, setBuild] = useState<BuildInfo | null>(null);
  // Daemon build identity for the sidebar footer + deploy verification.
  // Best-effort: the sidebar falls back to dev when unknown.
  const refreshDaemon = useCallback(async () => {
    try {
      const daemon = await api.daemonSnapshot();
      setBuild(daemon.build);
    } catch {
      setBuild(null);
    }
  }, [api]);

  useEffect(() => { void refreshDaemon(); }, [refreshDaemon]);

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

  return { build, wsHealth };
}
