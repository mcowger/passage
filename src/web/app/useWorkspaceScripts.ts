import { useCallback, useEffect, useRef, useState } from "react";
import type { WorkspaceScriptRuntime } from "../../shared/domain/workspace-actions.ts";
import type { WorkspaceApi } from "../api.ts";
import { subscribeWorkspace } from "../workspaceSocket.ts";

/** `paseo.json` scripts for the selected workspace: list snapshot,
 *  start/stop/restart verbs, and live refresh. Refresh triggers: workspace
 *  switch, any workspace event for this workspace (script runs publish
 *  `actions-changed` with `script:<name>` run IDs), and reconcile after
 *  reconnect. Mutations apply the returned snapshot optimistically. */
export function useWorkspaceScripts(api: WorkspaceApi, workspaceId: string | undefined) {
  const [scripts, setScripts] = useState<WorkspaceScriptRuntime[]>([]);
  const [scriptsLoaded, setScriptsLoaded] = useState(false);
  const [busyName, setBusyName] = useState<string | null>(null);
  const generation = useRef(0);

  const loadScripts = useCallback(
    async (id: string) => {
      const gen = ++generation.current;
      try {
        const next = await api.listWorkspaceScripts(id);
        if (generation.current !== gen) return;
        setScripts(next.scripts);
        setScriptsLoaded(true);
      } catch {
        if (generation.current !== gen) return;
        setScripts([]);
        setScriptsLoaded(true);
      }
    },
    [api],
  );

  useEffect(() => {
    setScripts([]);
    setScriptsLoaded(false);
    setBusyName(null);
    if (workspaceId) void loadScripts(workspaceId);
  }, [workspaceId, loadScripts]);

  useEffect(() => {
    if (!workspaceId) return;
    const sub = subscribeWorkspace(
      workspaceId,
      () => {
        void loadScripts(workspaceId);
      },
      async () => {
        await loadScripts(workspaceId);
      },
    );
    return () => sub.close();
  }, [workspaceId, loadScripts]);

  // Port health is display-only and read at fetch time: while anything
  // runs, refetch on a slow cadence so listening/not-listening stays
  // current without spamming the daemon. Idle workspaces never poll.
  useEffect(() => {
    if (!workspaceId || !scripts.some((s) => s.lifecycle === "running")) return;
    const timer = setInterval(() => {
      void loadScripts(workspaceId);
    }, 5000);
    return () => clearInterval(timer);
  }, [workspaceId, scripts, loadScripts]);

  const mutate = useCallback(
    async (name: string, fn: (id: string, scriptName: string) => Promise<WorkspaceScriptRuntime>): Promise<WorkspaceScriptRuntime | undefined> => {
      if (!workspaceId) return undefined;
      setBusyName(name);
      try {
        const next = await fn(workspaceId, name);
        setScripts((current) =>
          current.some((s) => s.name === next.name)
            ? current.map((s) => (s.name === next.name ? next : s))
            : [...current, next],
        );
        return next;
      } finally {
        setBusyName(null);
        void loadScripts(workspaceId);
      }
    },
    [workspaceId, loadScripts],
  );

  const startScript = useCallback(
    (name: string): Promise<WorkspaceScriptRuntime | undefined> =>
      mutate(name, (id, scriptName) => api.startWorkspaceScript(id, scriptName)),
    [api, mutate],
  );
  const stopScript = useCallback(
    (name: string): Promise<WorkspaceScriptRuntime | undefined> =>
      mutate(name, (id, scriptName) => api.stopWorkspaceScript(id, scriptName)),
    [api, mutate],
  );
  const restartScript = useCallback(
    (name: string): Promise<WorkspaceScriptRuntime | undefined> =>
      mutate(name, (id, scriptName) => api.restartWorkspaceScript(id, scriptName)),
    [api, mutate],
  );

  return { scripts, scriptsLoaded, busyName, startScript, stopScript, restartScript, loadScripts };
}
