import { useCallback, useEffect } from "react";
import type { PaneTab, LayoutNode, WorkspaceLayout } from "../../shared/domain/layout.ts";
import {
  addTabToGroup,
  createDefaultLayout,
  findFirstDeadTerminalTab,
  getFirstTabGroup,
  removeTabFromTree,
  updateTabInTree,
} from "../../shared/domain/layout.ts";
import { layoutContainsGitTabs, stripGitTabsFromLayout } from "./appHelpers.tsx";
import type { Workspace } from "../../shared/domain/workspaces.ts";
import type { AgentSummary } from "../../shared/domain/agents.ts";
import type { TerminalSummary } from "../../shared/domain/terminals.ts";
import type { WebPreview } from "../../shared/domain/previews.ts";
import type { WorkspaceApi } from "../api.ts";
import { friendlyApiError } from "../api.ts";
import type { TabKind } from "./appHelpers.tsx";
import type { MobileDestinationKind, MobileReturn } from "../components/MobileNav.tsx";
import { pickPreviewTargetUrl } from "./previewTarget.ts";

export type WorkspaceActionDeps = {
  api: WorkspaceApi;
  workspaceId: string | undefined;
  workspace: Workspace | undefined;
  layout: WorkspaceLayout | undefined;
  onLayoutChange: (layout: WorkspaceLayout) => void;
  agents: AgentSummary[];
  agentsLoaded: boolean;
  autoAgentPending: boolean;
  terminals: TerminalSummary[];
  previews: WebPreview[];
  selectedAgentId: string | undefined;
  selectedTerminalId: string | undefined;
  selectedPreviewId: string | undefined;
  openEditorPath: string | undefined;
  openDiffPath: string | undefined;
  dirtyEditors: Record<string, string>;
  activeTab: TabKind;
  mobileDest: { kind: MobileDestinationKind };
  mobileReturnTo: MobileReturn | null;
  setActiveTab: React.Dispatch<React.SetStateAction<TabKind>>;
  setAgentError: React.Dispatch<React.SetStateAction<string>>;
  setAgents: React.Dispatch<React.SetStateAction<AgentSummary[]>>;
  setAutoAgentPending: React.Dispatch<React.SetStateAction<boolean>>;
  setDirtyEditors: React.Dispatch<React.SetStateAction<Record<string, string>>>;
  setDrawerOpen: React.Dispatch<React.SetStateAction<boolean>>;
  setForm: React.Dispatch<React.SetStateAction<"project" | "worktree" | undefined>>;
  setFormError: React.Dispatch<React.SetStateAction<string>>;
  setLayout: React.Dispatch<React.SetStateAction<WorkspaceLayout | undefined>>;
  setMobileReturnTo: React.Dispatch<React.SetStateAction<MobileReturn | null>>;
  setMobileSessionOpen: React.Dispatch<React.SetStateAction<boolean>>;
  setOpenDiffPath: React.Dispatch<React.SetStateAction<string | undefined>>;
  setOpenEditorPath: React.Dispatch<React.SetStateAction<string | undefined>>;
  setPendingDirtyClose: React.Dispatch<React.SetStateAction<{ tabId: string; path: string } | null>>;
  setPreviews: React.Dispatch<React.SetStateAction<WebPreview[]>>;
  setSelectedAgentId: React.Dispatch<React.SetStateAction<string | undefined>>;
  setSelectedPreviewId: React.Dispatch<React.SetStateAction<string | undefined>>;
  setSelectedTerminalId: React.Dispatch<React.SetStateAction<string | undefined>>;
  setSelectedWorkspaceId: React.Dispatch<React.SetStateAction<string | undefined>>;
  setTerminals: React.Dispatch<React.SetStateAction<TerminalSummary[]>>;
  editorSaveHandlers: React.RefObject<Map<string, () => Promise<boolean>>>;
  autoAgentAttempted: React.RefObject<Set<string>>;
  autoAgentRequested: React.RefObject<Set<string>>;
  captureMobileReturnRef: React.RefObject<() => void>;
  loadAgents: (workspaceId: string, selectFirst?: boolean) => Promise<void>;
  loadTerminals: (workspaceId: string, selectFirst?: boolean) => Promise<void>;
  refreshWorkspaces: () => Promise<boolean>;
};

/**
 * Everything the shell does to a workspace: pane tabs, editors, files,
 * agents/terminals/previews lifecycle, mobile navigation, and the two
 * layout-sync effects. App keeps state and render; this owns the verbs.
 */
export function useWorkspaceActions(deps: WorkspaceActionDeps) {
  const {
    api,
    workspaceId,
    workspace,
    layout,
    onLayoutChange,
    agents,
    agentsLoaded,
    autoAgentPending,
    terminals,
    previews,
    selectedAgentId,
    selectedTerminalId,
    selectedPreviewId,
    openEditorPath,
    openDiffPath,
    dirtyEditors,
    activeTab,
    mobileDest,
    mobileReturnTo,
    setActiveTab,
    setAgentError,
    setAgents,
    setAutoAgentPending,
    setDirtyEditors,
    setDrawerOpen,
    setForm,
    setFormError,
    setLayout,
    setMobileReturnTo,
    setMobileSessionOpen,
    setOpenDiffPath,
    setOpenEditorPath,
    setPendingDirtyClose,
    setPreviews,
    setSelectedAgentId,
    setSelectedPreviewId,
    setSelectedTerminalId,
    setSelectedWorkspaceId,
    setTerminals,
    editorSaveHandlers,
    autoAgentAttempted,
    autoAgentRequested,
    captureMobileReturnRef,
    loadAgents,
    loadTerminals,
    refreshWorkspaces,
  } = deps;
  const openPaneTab = useCallback(
    (tab: PaneTab) => {
      if ((tab.kind === "changes" || tab.kind === "diff") && workspace?.mainRepositoryRoot == null) return;
      if (!layout) {
        onLayoutChange(createDefaultLayout(workspace?.id ?? "default", tab));
        return;
      }
      const firstGroup = getFirstTabGroup(layout.root);
      if (!firstGroup) return;
      const nextRoot = addTabToGroup(layout.root, firstGroup.id, tab);
      onLayoutChange({ ...layout, root: nextRoot });
    },
    [layout, onLayoutChange, workspace?.mainRepositoryRoot, workspace?.id]
  );

  const openEditorFile = useCallback((path: string) => {
    captureMobileReturnRef.current();
    setOpenEditorPath(path);
    setActiveTab("editor");
    openPaneTab({
      id: `editor-${path}`,
      kind: "editor",
      title: path.split("/").pop() ?? path,
      targetId: path,
    });
  }, [openPaneTab]);

  const openDiffFile = useCallback((path: string) => {
    captureMobileReturnRef.current();
    setOpenDiffPath(path);
    setActiveTab("diff");
    openPaneTab({
      id: `diff-${path}`,
      kind: "diff",
      title: `Diff: ${path.split("/").pop() ?? path}`,
      targetId: path,
    });
  }, [openPaneTab]);

  const handleExplorerRenamed = useCallback((oldPath: string, newPath: string) => {
    const wasOpenEditor = openEditorPath === oldPath;
    setOpenEditorPath((current) => (current === oldPath ? newPath : current));
    setOpenDiffPath((current) => (current === oldPath ? newPath : current));
    setDirtyEditors((prev) => {
      const oldKey = `editor-${oldPath}`;
      if (!(oldKey in prev)) return prev;
      const next = { ...prev };
      delete next[oldKey];
      next[`editor-${newPath}`] = newPath;
      return next;
    });
    if (layout) {
      const renameInTree = (node: LayoutNode): LayoutNode => {
        if (node.type === "tabs") {
          const tabs = node.tabs.map((tab) => {
            if (tab.targetId !== oldPath) return tab;
            if (tab.kind === "editor") {
              return { ...tab, id: `editor-${newPath}`, title: newPath.split("/").pop() ?? newPath, targetId: newPath };
            }
            if (tab.kind === "diff") {
              return { ...tab, id: `diff-${newPath}`, title: `Diff: ${newPath.split("/").pop() ?? newPath}`, targetId: newPath };
            }
            return tab;
          });
          const oldTabId = node.tabs.find((t) => t.targetId === oldPath)?.id;
          const renamedTab = tabs.find((t) => t.targetId === newPath);
          return {
            ...node,
            tabs,
            activeTabId: node.activeTabId === oldTabId && renamedTab ? renamedTab.id : node.activeTabId,
          };
        }
        return { ...node, children: node.children.map(renameInTree) };
      };
      onLayoutChange({ ...layout, root: renameInTree(layout.root) });
    }
    // The renamed tab already exists in place; just reveal it when it was open.
    if (wasOpenEditor) setActiveTab("editor");
  }, [layout, onLayoutChange, openEditorPath]);

  const handleExplorerDeleted = useCallback((path: string) => {
    const affects = (target: string | undefined) =>
      target === path || (target !== undefined && target.startsWith(`${path}/`));
    setOpenEditorPath((current) => (affects(current) ? undefined : current));
    setOpenDiffPath((current) => (affects(current) ? undefined : current));
    setDirtyEditors((prev) => {
      const next = { ...prev };
      let changed = false;
      for (const key of Object.keys(next)) {
        if (key === `editor-${path}` || key.startsWith(`editor-${path}/`)) {
          delete next[key];
          changed = true;
        }
      }
      return changed ? next : prev;
    });
    if (layout) {
      const prune = (node: LayoutNode): LayoutNode | null => {
        if (node.type === "tabs") {
          const tabs = node.tabs.filter((tab) =>
            (tab.kind === "editor" || tab.kind === "diff") ? !affects(tab.targetId) : true);
          if (tabs.length === 0) return null;
          return {
            ...node,
            tabs,
            activeTabId: tabs.some((t) => t.id === node.activeTabId) ? node.activeTabId : tabs[0].id,
          };
        }
        const children = node.children
          .map((child) => prune(child))
          .filter((child): child is LayoutNode => child !== null);
        if (children.length === 0) return null;
        if (children.length === 1) return children[0];
        return { ...node, children };
      };
      const nextRoot = prune(layout.root);
      if (nextRoot && workspaceId) {
        onLayoutChange({ ...layout, root: nextRoot });
      }
    }
  }, [layout, onLayoutChange, workspaceId]);

  useEffect(() => {
    if (!workspace || !layout) return;
    if (workspace.mainRepositoryRoot != null) return;
    if (!layoutContainsGitTabs(layout.root)) return;
    const stripped = stripGitTabsFromLayout(layout.root);
    if (stripped) {
      onLayoutChange({ ...layout, root: stripped });
    } else {
      onLayoutChange(createDefaultLayout(workspace.id));
    }
    setActiveTab((current) => (current === "changes" || current === "diff" ? "agent" : current));
  }, [workspace, layout, onLayoutChange]);

  const runWorkspaceMutation = async (action: () => Promise<unknown>) => {
    try {
      setFormError("");
      await action();
      if (await refreshWorkspaces()) setForm(undefined);
      else setFormError("Saved, but Passage could not refresh the workspace list. Retry the refresh above.");
    } catch (cause) {
      setFormError(friendlyApiError(cause, "Request failed. Try again."));
    }
  };

  const createAgent = async () => {
    if (!workspace) return;
    if (workspace.archivedAt) {
      setAgentError("Cannot create agent: Workspace is archived. Reopen it to start an agent.");
      return;
    }
    try {
      setAgentError("");
      const created = await api.createAgent(workspace.id);
      setAgents((current) => [...current, created]);
      setSelectedAgentId(created.id);
      setActiveTab("agent");
      openPaneTab({
        id: `agent-${created.id}`,
        kind: "agent",
        title: created.title,
        targetId: created.id,
      });
    } catch (cause) {
      setAgentError(cause instanceof Error ? cause.message : "Unable to create agent");
    }
  };

  const handleTerminalAttached = useCallback(
    (oldTabId: string, created: TerminalSummary) => {
      setTerminals((current) => {
        if (current.some((t) => t.id === created.id)) return current;
        return [...current, created];
      });
      setSelectedTerminalId(created.id);
      setActiveTab("terminal");
      setLayout((current) => {
        if (!current) return current;
        const updatedTab: PaneTab = {
          id: `terminal-${created.id}`,
          kind: "terminal",
          title: created.title,
          targetId: created.id,
        };
        const nextRoot = updateTabInTree(current.root, oldTabId, updatedTab);
        const nextLayout = { ...current, root: nextRoot };
        if (workspaceId) {
          void api.saveLayout(workspaceId, nextLayout).catch(() => {});
        }
        return nextLayout;
      });
    },
    [api, workspaceId]
  );

  const createTerminal = async (options?: { forceNew?: boolean }) => {
    if (!workspace) return;
    try {
      const created = await api.createTerminal(workspace.id);
      setTerminals((current) => (current.some((t) => t.id === created.id) ? current : [...current, created]));
      setSelectedTerminalId(created.id);
      setActiveTab("terminal");
      const liveIds = new Set(terminals.map((t) => t.id));
      const deadTab = (!options?.forceNew && layout) ? findFirstDeadTerminalTab(layout.root, liveIds) : null;
      if (deadTab) {
        handleTerminalAttached(deadTab.id, created);
      } else {
        openPaneTab({
          id: `terminal-${created.id}`,
          kind: "terminal",
          title: created.title,
          targetId: created.id,
        });
      }
    } catch {}
  };

  const createPreview = async () => {
    if (!workspace) return;
    try {
      const candidates = await api.previewCandidates(workspace.id).catch(() => []);
      const targetUrl = pickPreviewTargetUrl(candidates);
      const created = await api.createPreview(workspace.id, { targetUrl });
      setPreviews((current) => [...current, created]);
      setSelectedPreviewId(created.id);
      setActiveTab("preview");
      openPaneTab({
        id: `preview-${created.id}`,
        kind: "preview",
        title: created.label,
        targetId: created.id,
      });
    } catch {}
  };

  // Only a brand-new workspace (explicitly marked at creation time)
  // starts its first agent automatically, so it lands on a live session
  // instead of an empty canvas. Switching to an existing workspace that
  // happens to have no agents leaves it empty on purpose. Consumed once
  // per workspace so closing the last agent does not loop.
  useEffect(() => {
    if (!workspaceId || !workspace || workspace.archivedAt) return;
    if (!agentsLoaded || !layout) return;
    if (agents.length > 0 || autoAgentPending) return;
    if (!autoAgentRequested.current.has(workspaceId)) return;
    if (autoAgentAttempted.current.has(workspaceId)) {
      autoAgentRequested.current.delete(workspaceId);
      return;
    }
    autoAgentAttempted.current.add(workspaceId);
    autoAgentRequested.current.delete(workspaceId);
    setAutoAgentPending(true);
    setAgentError("");
    void api.createAgent(workspaceId)
      .then((created) => {
        setAgents((current) => (current.some((a) => a.id === created.id) ? current : [...current, created]));
        setSelectedAgentId(created.id);
        setActiveTab("agent");
        setLayout((current) => {
          if (!current) return current;
          const group = getFirstTabGroup(current.root);
          if (!group) return current;
          const tab: PaneTab = { id: `agent-${created.id}`, kind: "agent", title: created.title, targetId: created.id };
          const nextLayout = { ...current, root: addTabToGroup(current.root, group.id, tab) };
          void api.saveLayout(workspaceId, nextLayout).catch(() => {});
          return nextLayout;
        });
      })
      .catch((cause) => {
        setAgentError(cause instanceof Error ? cause.message : "Unable to create agent");
      })
      .finally(() => {
        setAutoAgentPending(false);
      });
  }, [workspaceId, workspace, agentsLoaded, layout, agents.length, autoAgentPending, api]);

  const handleSelectPreview = (id: string) => {
    setSelectedPreviewId(id);
    setActiveTab("preview");
    setDrawerOpen(false);
    setMobileReturnTo(null);
    const previewObj = previews.find((p) => p.id === id);
    if (previewObj) {
      openPaneTab({
        id: `preview-${id}`,
        kind: "preview",
        title: previewObj.label,
        targetId: id,
      });
    }
  };

  // Promoting an archived agent back to active: the daemon flips the
  // metadata row to `idle` (same Pi session resumes lazily), then the
  // active list reloads and the restored session opens in the canvas.
  const reopenAgent = useCallback(async (agentId: string) => {
    if (!workspaceId) throw new Error("No workspace selected");
    const restored = await api.reopenAgent(agentId);
    setAgents((current) => (current.some((agent) => agent.id === restored.id) ? current : [...current, restored]));
    setSelectedAgentId(restored.id);
    setActiveTab("agent");
    openPaneTab({
      id: `agent-${restored.id}`,
      kind: "agent",
      title: restored.title,
      targetId: restored.id,
    });
    return restored;
  }, [api, workspaceId, openPaneTab]);

  const closeAgentTab = useCallback(async (tabId: string) => {
    if (!tabId.startsWith("agent-") || !workspaceId) return;
    const agentId = tabId.slice("agent-".length);
    if (!agents.some((agent) => agent.id === agentId)) return;
    try {
      await api.archiveAgent(agentId);
      if (selectedAgentId === agentId) setSelectedAgentId(undefined);
      await loadAgents(workspaceId, false);
    } catch (cause) {
      setAgentError(cause instanceof Error ? cause.message : "Unable to close agent session");
    }
  }, [api, agents, loadAgents, selectedAgentId, workspaceId]);

  // Closing a canvas tab ends the underlying resource: agents are archived,
  // terminals are terminated, previews are stopped and deleted. No resource is
  // left running behind a closed tab.
  const endTabResource = useCallback((tabId: string) => {
    if (tabId.startsWith("agent-")) {
      void closeAgentTab(tabId);
      return;
    }
    if (tabId.startsWith("terminal-")) {
      const terminalId = tabId.slice("terminal-".length);
      setTerminals((current) => current.filter((terminal) => terminal.id !== terminalId));
      setSelectedTerminalId((current) => (current === terminalId ? undefined : current));
      void api.deleteTerminal(terminalId).catch(() => {});
      if (workspaceId) void loadTerminals(workspaceId, false);
      return;
    }
    if (tabId.startsWith("preview-")) {
      const previewId = tabId.slice("preview-".length);
      setPreviews((current) => current.filter((preview) => preview.id !== previewId));
      setSelectedPreviewId((current) => (current === previewId ? undefined : current));
      void api.deletePreview(previewId).catch(() => {});
    }
  }, [api, closeAgentTab, loadTerminals, workspaceId]);

  const handleSelectAgent = (id: string) => {
    setSelectedAgentId(id);
    setActiveTab("agent");
    setDrawerOpen(false);
    setMobileReturnTo(null);
    const agentObj = agents.find((a) => a.id === id);
    if (agentObj) {
      openPaneTab({
        id: `agent-${id}`,
        kind: "agent",
        title: agentObj.title,
        targetId: id,
      });
    }
  };

  const handleSelectTerminal = (id: string) => {
    setSelectedTerminalId(id);
    setActiveTab("terminal");
    setDrawerOpen(false);
    setMobileReturnTo(null);
    const termObj = terminals.find((t) => t.id === id);
    if (termObj) {
      openPaneTab({
        id: `terminal-${id}`,
        kind: "terminal",
        title: termObj.title,
        targetId: id,
      });
    }
  };

  const closeTabNow = useCallback((tabId: string) => {
    endTabResource(tabId);
    if (layout && workspaceId) {
      const nextRoot = removeTabFromTree(layout.root, tabId);
      onLayoutChange(nextRoot ? { ...layout, root: nextRoot } : createDefaultLayout(workspaceId));
    }
    if (tabId.startsWith("editor-")) setOpenEditorPath(undefined);
    if (tabId.startsWith("diff-")) setOpenDiffPath(undefined);
  }, [endTabResource, layout, workspaceId, onLayoutChange]);

  // Mobile close actions: the desktop close affordance lives in the canvas
  // tab strip, which mobile does not render, so without these there is no
  // way to close an agent, terminal, preview, or file view from a phone.
  // Resource semantics match closing the desktop tab (agents archived,
  // terminals terminated, previews stopped and deleted); when the closed
  // session was the one on screen, fall back to a sibling or Overview
  // because there is no tab strip to fall back to. The sheet stays open so
  // several sessions can be closed in a row.
  const closeAgentOnMobile = (agentId: string) => {
    const currentId = activeTab === "agent" ? (selectedAgentId ?? agents[0]?.id) : undefined;
    const next = agents.filter((agent) => agent.id !== agentId)[0];
    void closeAgentTab(`agent-${agentId}`).then(() => {
      if (currentId === agentId) {
        if (next) handleSelectAgent(next.id);
        else setActiveTab("overview");
      }
    });
  };

  const closeTerminalOnMobile = (terminalId: string) => {
    const currentId = activeTab === "terminal" ? (selectedTerminalId ?? terminals[0]?.id) : undefined;
    const next = terminals.filter((terminal) => terminal.id !== terminalId)[0];
    closeTabNow(`terminal-${terminalId}`);
    if (currentId === terminalId) {
      if (next) handleSelectTerminal(next.id);
      else setActiveTab("overview");
    }
  };

  const closePreviewOnMobile = (previewId: string) => {
    const currentId = activeTab === "preview" ? (selectedPreviewId ?? previews[0]?.id) : undefined;
    const next = previews.filter((preview) => preview.id !== previewId)[0];
    closeTabNow(`preview-${previewId}`);
    if (currentId === previewId) {
      if (next) handleSelectPreview(next.id);
      else setActiveTab("overview");
    }
  };

  const closeEditorOnMobile = () => {
    if (!openEditorPath) return;
    const tabId = `editor-${openEditorPath}`;
    // Same unsaved-changes gate as the editor header and desktop tab close.
    const dirtyPath = dirtyEditors[tabId];
    if (dirtyPath !== undefined) {
      setPendingDirtyClose({ tabId, path: dirtyPath });
      return;
    }
    closeTabNow(tabId);
    setActiveTab("explorer");
  };

  const closeDiffOnMobile = () => {
    if (!openDiffPath) return;
    closeTabNow(`diff-${openDiffPath}`);
    setActiveTab("changes");
  };

  const mobileCloseAction: { label: string; action: () => void } | null = (() => {
    if (mobileDest.kind === "agent") {
      const current = agents.find((agent) => agent.id === selectedAgentId) ?? agents[0];
      return current ? { label: `Close agent ${current.title}`, action: () => closeAgentOnMobile(current.id) } : null;
    }
    if (mobileDest.kind === "terminal") {
      const current = terminals.find((terminal) => terminal.id === selectedTerminalId) ?? terminals[0];
      return current ? { label: `Close terminal ${current.title}`, action: () => closeTerminalOnMobile(current.id) } : null;
    }
    if (mobileDest.kind === "preview") {
      const current = previews.find((preview) => preview.id === selectedPreviewId) ?? previews[0];
      return current ? { label: `Close preview ${current.label}`, action: () => closePreviewOnMobile(current.id) } : null;
    }
    if (mobileDest.kind === "editor") {
      if (!openEditorPath) return null;
      return { label: `Close editor ${openEditorPath.split("/").pop() ?? openEditorPath}`, action: closeEditorOnMobile };
    }
    if (mobileDest.kind === "diff") {
      if (!openDiffPath) return null;
      return { label: "Close diff", action: closeDiffOnMobile };
    }
    return null;
  })();

  const handleEditorDirtyChange = useCallback((tabId: string, path: string, isDirty: boolean, save: () => Promise<boolean>) => {
    editorSaveHandlers.current.set(tabId, save);
    setDirtyEditors((prev) => {
      if (isDirty) {
        if (prev[tabId] === path) return prev;
        return { ...prev, [tabId]: path };
      }
      if (!(tabId in prev)) return prev;
      const next = { ...prev };
      delete next[tabId];
      return next;
    });
  }, []);

  const handleActivateTab = useCallback((tab: PaneTab) => {
    if (tab.kind === "agent" && tab.targetId) {
      setSelectedAgentId(tab.targetId);
      setActiveTab("agent");
    } else if (tab.kind === "terminal" && tab.targetId) {
      setSelectedTerminalId(tab.targetId);
      setActiveTab("terminal");
    } else if (tab.kind === "preview" && tab.targetId) {
      setSelectedPreviewId(tab.targetId);
      setActiveTab("preview");
    }
  }, []);

  const handleSelectWorkspace = (id: string) => {
    setSelectedWorkspaceId(id);
    setSelectedAgentId(undefined);
    setSelectedTerminalId(undefined);
    setSelectedPreviewId(undefined);
    setActiveTab("agent");
    setDrawerOpen(false);
    setMobileReturnTo(null);
  };

  const goMobileBack = () => {
    const ret = mobileReturnTo;
    if (!ret) return;
    setMobileReturnTo(null);
    setMobileSessionOpen(false);
    if (ret.kind === "agent" && ret.targetId) {
      handleSelectAgent(ret.targetId);
      return;
    }
    if (ret.kind === "terminal" && ret.targetId) {
      handleSelectTerminal(ret.targetId);
      return;
    }
    if (ret.kind === "preview" && ret.targetId) {
      handleSelectPreview(ret.targetId);
      return;
    }
    if (!workspace) return;
    if (ret.kind === "explorer" || ret.kind === "changes" || ret.kind === "overview") {
      setActiveTab(ret.kind);
      openPaneTab({ id: `${ret.kind}-${workspace.id}`, kind: ret.kind, title: ret.label });
    }
  };

  // After a merged workspace is deleted, land on the home empty state rather
  // than auto-selecting another workspace. refreshWorkspaces otherwise picks
  // the first candidate, so clear the selection again once it settles.
  const handleWorkspaceRemoved = useCallback(async () => {
    setSelectedWorkspaceId(undefined);
    setSelectedAgentId(undefined);
    setSelectedTerminalId(undefined);
    setSelectedPreviewId(undefined);
    setActiveTab("agent");
    await refreshWorkspaces();
    setSelectedWorkspaceId(undefined);
  }, [refreshWorkspaces]);

  return {
    openPaneTab,
    openEditorFile,
    openDiffFile,
    handleExplorerRenamed,
    handleExplorerDeleted,
    runWorkspaceMutation,
    createAgent,
    handleTerminalAttached,
    createTerminal,
    createPreview,
    handleSelectPreview,
    reopenAgent,
    closeAgentTab,
    endTabResource,
    handleSelectAgent,
    handleSelectTerminal,
    closeTabNow,
    closeAgentOnMobile,
    closeTerminalOnMobile,
    closePreviewOnMobile,
    closeEditorOnMobile,
    closeDiffOnMobile,
    mobileCloseAction,
    handleEditorDirtyChange,
    handleActivateTab,
    handleSelectWorkspace,
    goMobileBack,
    handleWorkspaceRemoved,
  };
}
