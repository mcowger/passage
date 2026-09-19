import { StrictMode, useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import type { Workspace } from "../shared/domain/workspaces.ts";
import type { PaneTab } from "../shared/domain/layout.ts";
import { countTabsOfKind, createDefaultLayout, updateTabInTree } from "../shared/domain/layout.ts";
import { resolveFontFamilies } from "../shared/domain/customization.ts";
import { createWorkspaceApi } from "./api.ts";
import { AgentSessionPanel } from "./components/AgentSessionPanel.tsx";
import { MobileContextBar, MobileSessionSheet, type MobileReturn } from "./components/MobileNav.tsx";
import { AGENT_STATUS_LABEL, getAgentStatusKind, getWorkspaceStatusKind } from "./components/agentStatus.ts";
import { Sidebar } from "./components/Sidebar.tsx";
import { WsHealthIndicator } from "./components/WsHealthIndicator.tsx";
import { WorkspaceDetailsModal } from "./components/WorkspaceDetailsModal.tsx";
import { ExplorerPanel } from "./components/ExplorerPanel.tsx";
import { ChangesPanel } from "./components/ChangesPanel.tsx";
import { EditorPanel } from "./components/EditorPanel.tsx";
import { DiffPanel } from "./components/DiffPanel.tsx";
import { TerminalTabPane } from "./components/TerminalTabPane.tsx";
import { PreviewPanel } from "./components/PreviewPanel.tsx";
import { WorkspaceOverview } from "./components/WorkspaceOverview.tsx";
import { NewWorktreeModal } from "./components/NewWorktreeModal.tsx";
import { DirectoryPicker } from "./components/DirectoryPicker.tsx";
import { SplitCanvas } from "./components/SplitCanvas.tsx";
import { CommandPalette } from "./components/CommandPalette.tsx";
import { SettingsModal } from "./components/SettingsModal.tsx";
import { initKeyboardInset } from "./lib/keyboard-inset.ts";
import { useEdgeSwipeDrawer } from "./components/useEdgeSwipeDrawer.ts";
import { Button } from "./components/ui/button.tsx";
import { Input } from "./components/ui/input.tsx";
import { FileCode, Globe, MoreHorizontal, Plus } from "lucide-react";
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "./components/ui/empty.tsx";
import { Spinner } from "./components/ui/spinner.tsx";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "./components/ui/dialog.tsx";
import { TooltipProvider } from "./components/ui/tooltip.tsx";
import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "./components/ui/alert-dialog.tsx";
import { Alert, AlertDescription } from "./components/ui/alert.tsx";
import { Toaster } from "./components/ui/sonner.tsx";
import { toast } from "sonner";
import "./styles.css";

import {
  NonGitPane,
  FormDialog,
  computeIsMobile,
  setupToastId,
  type FormKind,
  type TabKind,
} from "./app/appHelpers.tsx";
import { useDaemon } from "./app/useDaemon.ts";
import { useWorkspaceList } from "./app/useWorkspaceList.ts";
import { useWorkspaceLayout } from "./app/useWorkspaceLayout.ts";
import { useWorkspaceResources } from "./app/useWorkspaceResources.ts";
import { useWorkspaceActions } from "./app/useWorkspaceActions.ts";
import { resolveMobileDest, resolveMobileReturn, type MobileSessionState } from "./app/mobileSession.ts";

function App() {
  const api = useMemo(() => createWorkspaceApi(), []);
  const {
    snapshot,
    snapshotError,
    setSnapshotError,
    selectedWorkspaceId,
    setSelectedWorkspaceId,
    workspaceStatuses,
    setWorkspaceStatuses,
    refreshWorkspaces,
  } = useWorkspaceList(api);
  const {
    layout,
    setLayout,
    settings,
    themes,
    fontOptions,
    loadLayoutAndSettings,
    handleLayoutChange,
    handleSaveSettings,
  } = useWorkspaceLayout(api, selectedWorkspaceId);
  const handleWorkspaceSwitched = useCallback(() => {
    setOpenEditorPath(undefined);
    setOpenDiffPath(undefined);
    setActiveTab("agent");
  }, []);
  const {
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
  } = useWorkspaceResources(api, selectedWorkspaceId, {
    loadLayout: loadLayoutAndSettings,
    onWorkspaceSwitched: handleWorkspaceSwitched,
  });
  const [formError, setFormError] = useState("");
  const [activeTab, setActiveTab] = useState<TabKind>("agent");
  const [mobileReturnTo, setMobileReturnTo] = useState<MobileReturn | null>(null);
  const [mobileSessionOpen, setMobileSessionOpen] = useState(false);
  const [openEditorPath, setOpenEditorPath] = useState<string>();
  const [openDiffPath, setOpenDiffPath] = useState<string>();
  const [form, setForm] = useState<FormKind>();
  const [dirSuggestOpen, setDirSuggestOpen] = useState(false);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [commandPaletteOpen, setCommandPaletteOpen] = useState(false);
  const [settingsModalOpen, setSettingsModalOpen] = useState(false);
  const [workspaceDetailsOpen, setWorkspaceDetailsOpen] = useState(false);
  const [worktreeModalTab, setWorktreeModalTab] = useState<"create" | "discover">("create");
  const [worktreeModalProjectId, setWorktreeModalProjectId] = useState<string>();
  const [isOffline, setIsOffline] = useState(typeof navigator !== "undefined" ? !navigator.onLine : false);
  // Mobile-first initial: a PWA cold start (esp. via deep link) can briefly
  // misreport a narrow viewport as wide before the viewport settles. Touch
  // devices are overwhelmingly handsets, so assume mobile until a reliable
  // measurement says desktop — the reverse flash (desktop tree on a 390px
  // phone) is what produced page-level horizontal scrolling.
  const [isMobile, setIsMobile] = useState(() => computeIsMobile());
  const [dirtyEditors, setDirtyEditors] = useState<Record<string, string>>({});
  const [pendingDirtyClose, setPendingDirtyClose] = useState<{ tabId: string; path: string } | null>(null);
  const [dirtySaveBusy, setDirtySaveBusy] = useState(false);
  const editorSaveHandlers = useRef(new Map<string, () => Promise<boolean>>());


  // Register service worker and offline listeners
  useEffect(() => {
    if (typeof window !== "undefined") {
      const handleOnline = () => setIsOffline(false);
      const handleOffline = () => setIsOffline(true);
      const handleResize = () => setIsMobile(computeIsMobile());

      window.addEventListener("online", handleOnline);
      window.addEventListener("offline", handleOffline);
      window.addEventListener("resize", handleResize);
      const mobileQuery = window.matchMedia?.("(max-width: 767px)");
      const handleQueryChange = () => setIsMobile(computeIsMobile());
      mobileQuery?.addEventListener?.("change", handleQueryChange);

      if ("serviceWorker" in navigator && process.env.NODE_ENV === "production") {
        navigator.serviceWorker.register("/sw.js").catch(() => {});
      }

      return () => {
        window.removeEventListener("online", handleOnline);
        window.removeEventListener("offline", handleOffline);
        window.removeEventListener("resize", handleResize);
        mobileQuery?.removeEventListener?.("change", handleQueryChange);
      };
    }
  }, []);

  // iOS keyboard inset polyfill: pins the composer above the software
  // keyboard via --kb-inset and corrects --app-height (docs/IOS-PWA-NATIVE.md §4).
  useEffect(() => initKeyboardInset(), []);

  // Mobile edge gesture: swipe right from the left edge toward the middle
  // opens the sidebar drawer; swipe left inside it closes it again.
  // Placed after the isMobile state above so the enabled flag is readable.
  useEdgeSwipeDrawer({
    enabled: isMobile,
    drawerOpen,
    onOpen: () => setDrawerOpen(true),
    onClose: () => setDrawerOpen(false),
  });


  // Global keyboard shortcuts (Command Palette, Layout reset)
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setCommandPaletteOpen((prev) => !prev);
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, []);


  // The selected workspace's agents are authoritative and live (socket-fed).
  // Fold them into the map immediately so the selected dot never waits for
  // the next poll tick after a local transition (e.g. run -> idle).
  useEffect(() => {
    if (!selectedWorkspaceId) return;
    const live = getWorkspaceStatusKind(agents);
    setWorkspaceStatuses((current) =>
      current[selectedWorkspaceId] === live ? current : { ...current, [selectedWorkspaceId]: live }
    );
  }, [agents, selectedWorkspaceId]);




  const { build, daemonLifecycle, drainBusy, wsHealth, handleBeginDrain, handleCancelDrain } = useDaemon(api);




  const workspace = snapshot?.workspaces.find((item) => item.id === selectedWorkspaceId);
  const project = snapshot?.projects.find((item) => item.id === workspace?.projectId);
  const activeProject = project ?? snapshot?.projects.find((item) => !item.archivedAt);
  const selectedTerminal = terminals.find((t) => t.id === selectedTerminalId) ?? terminals[0];
  const isGitWorkspace = workspace?.mainRepositoryRoot != null;

  // Mobile return stack input (resolved via app/mobileSession.ts).
  const mobileSelection: MobileSessionState = {
    activeTab,
    agents,
    selectedAgentId,
    terminals,
    selectedTerminalId,
    previews,
    selectedPreviewId,
    openEditorPath,
    openDiffPath,
  };

  const captureMobileReturn = () => {
    if (!isMobile) return;
    setMobileReturnTo((current) => current ?? resolveMobileReturn(mobileSelection));
  };
  // Ref-stable capturer for memoized callbacks (openEditorFile/openDiffFile)
  // whose closures predate the latest render.
  const captureMobileReturnRef = useRef(captureMobileReturn);
  captureMobileReturnRef.current = captureMobileReturn;

  const mobileDest = resolveMobileDest(mobileSelection);

  // Resources are ended when their canvas pane closes, so the top-bar counts
  // reflect the tabs actually present for the current workspace rather than
  // any durable rows left behind by an earlier session.
  const openAgentCount = useMemo(() => {
    if (!layout) return 0;
    return countTabsOfKind(layout.root, "agent", new Set(agents.map((agent) => agent.id)));
  }, [layout, agents]);

  const openTerminalCount = useMemo(() => {
    if (!layout) return 0;
    return countTabsOfKind(layout.root, "terminal", new Set(terminals.map((terminal) => terminal.id)));
  }, [layout, terminals]);

  const openPreviewCount = useMemo(() => {
    if (!layout) return 0;
    return countTabsOfKind(layout.root, "preview", new Set(previews.map((preview) => preview.id)));
  }, [layout, previews]);



  const actions = useWorkspaceActions({
    api,
    workspaceId: selectedWorkspaceId,
    workspace,
    layout,
    onLayoutChange: handleLayoutChange,
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
    captureMobileReturnRef,
    loadAgents,
    loadTerminals,
    refreshWorkspaces,
  });
  const {
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
  } = actions;
  // Render tab content for SplitCanvas & single-pane mode
  const renderTabContent = (tab: PaneTab): ReactNode => {
    if (!workspace || !project) {
      return (
        <div className="empty flex flex-1 flex-col items-center justify-center p-8 text-center max-w-md mx-auto">
          <span className="empty-icon text-3xl mb-2" aria-hidden="true">⌂</span>
          <h1 className="text-lg font-semibold text-foreground mb-1">Select a workspace</h1>
          <p className="text-xs text-muted-foreground mb-4">Choose a workspace from navigation or register a project to begin.</p>
          <Button size="xs" onClick={() => { setFormError(""); setForm("project"); }}>+ Add Project</Button>
        </div>
      );
    }

    switch (tab.kind) {
      case "overview":
      case "agent": {
        const agentId = tab.targetId;
        const currentAgent = agentId ? agents.find((a) => a.id === agentId) : undefined;
        const previewEnabled = typeof window !== "undefined"
          && new URLSearchParams(window.location.search).get("transcriptPreview") === "1";
        return currentAgent ? (
          <AgentSessionPanel
            key={currentAgent.id}
            agent={currentAgent}
            api={api}
            settings={settings}
            onAgentChanged={(updatedAgent) => {
              const previous = agents.find((agent) => agent.id === updatedAgent.id);
              setAgents((current) => current.map((agent) => agent.id === updatedAgent.id ? updatedAgent : agent));
              // Auto-titles (and any later rename) arrive over the agent
              // socket; keep the open pane tab label in sync so it stops
              // reading "Agent" too. Guarded to the title change so
              // ordinary status traffic never rewrites the layout.
              if (previous && previous.title !== updatedAgent.title && layout) {
                const tabId = `agent-${updatedAgent.id}`;
                handleLayoutChange({
                  ...layout,
                  root: updateTabInTree(layout.root, tabId, { id: tabId, kind: "agent", title: updatedAgent.title, targetId: updatedAgent.id }),
                });
              }
            }}
            previewHistory={previewEnabled ? previewHistory ?? undefined : undefined}
            onWorkspaceDeleted={handleWorkspaceRemoved}
          />
        ) : tab.kind === "overview" ? (
          <WorkspaceOverview
            workspace={workspace}
            project={project}
            agents={agents}
            terminals={terminals}
            previews={previews}
            isGitWorkspace={isGitWorkspace}
            agentError={agentError}
            autoStartingAgent={autoAgentPending}
            onNewAgent={() => void createAgent()}
            onOpenAgent={handleSelectAgent}
            onListArchivedAgents={() => (workspace ? api.listArchivedAgents(workspace.id) : Promise.resolve([]))}
            onReopenAgent={reopenAgent}
            onNewTerminal={() => void createTerminal()}
            onOpenFiles={() => {
              captureMobileReturn();
              setActiveTab("explorer");
              openPaneTab({ id: `explorer-${workspace.id}`, kind: "explorer", title: "Files" });
            }}
            onOpenChanges={() => {
              captureMobileReturn();
              setActiveTab("changes");
              openPaneTab({ id: `changes-${workspace.id}`, kind: "changes", title: "Changes" });
            }}
            onNewPreview={() => void createPreview()}
          />
        ) : (
          <div className="empty flex flex-col items-center justify-center p-8 text-center max-w-md mx-auto">
            <span className="empty-icon text-3xl mb-2 text-primary" aria-hidden="true">◈</span>
            <h1 className="text-lg font-semibold text-foreground mb-1">Pi Agent</h1>
            <p className="text-xs text-muted-foreground mb-4">
              Autonomous coding agent attached to this workspace.
            </p>
            {agentError && (
              <Alert variant="destructive" className="mb-4 w-full text-left">
                <AlertDescription className="text-xs">{agentError}</AlertDescription>
              </Alert>
            )}
            {workspace.archivedAt ? (
              <div className="flex flex-col items-center gap-2">
                <span className="text-xs text-amber-600 bg-amber-500/10 px-2 py-1 rounded">
                  This workspace is archived.
                </span>
                <Button
                  size="xs"
                  onClick={async () => {
                    setAgentError("");
                    await api.reopenWorkspace(workspace.id);
                    await refreshWorkspaces();
                  }}
                >
                  Reopen Workspace
                </Button>
              </div>
            ) : (
              <Button size="xs" onClick={() => void createAgent()}>
                + Start Agent Session
              </Button>
            )}
          </div>
        );
      }

      case "terminal": {
        const terminalFamilies = resolveFontFamilies(fontOptions, settings.fonts);
        return (
          <TerminalTabPane
            key={tab.id}
            tab={tab}
            workspace={workspace}
            terminals={terminals}
            terminalsLoaded={terminalsLoaded}
            api={api}
            terminalFontFamily={terminalFamilies.xterm}
            terminalFontSize={settings.terminalFontSize}
            onClose={() => {
              closeTabNow(tab.id);
              setActiveTab("overview");
            }}
            onTerminated={() => {
              void loadTerminals(workspace.id);
            }}
            onTerminalAttached={handleTerminalAttached}
          />
        );
      }

      case "explorer":
        return (
          <ExplorerPanel
            workspaceId={workspace.id}
            api={api}
            selectedFile={openEditorPath}
            onOpenFile={openEditorFile}
            workspaceCwd={workspace.cwd}
            onRenamed={handleExplorerRenamed}
            onDeleted={handleExplorerDeleted}
          />
        );

      case "changes": {
        if (!isGitWorkspace) return <NonGitPane title="Changes" />;
        const selectedAgent = agents.find((a) => a.id === selectedAgentId) ?? agents[0];
        const settled = !selectedAgent || (selectedAgent.status !== "running" && selectedAgent.status !== "stopping" && selectedAgent.status !== "initializing");
        return (
          <ChangesPanel
            workspaceId={workspace.id}
            api={api}
            onOpenFile={openEditorFile}
            onOpenDiff={openDiffFile}
            onWorkspaceDeleted={handleWorkspaceRemoved}
            agentSettled={settled}
            agentStatusLabel={selectedAgent ? AGENT_STATUS_LABEL[getAgentStatusKind(selectedAgent)] : undefined}
            suggestModel={settings.suggestModel}
            suggestThinkingLevel={settings.suggestThinkingLevel}
            commitPrompt={settings.commitPrompt}
            selectedAgentId={selectedAgent?.id}
          />
        );
      }

      case "editor": {
        const filePath = tab.targetId ?? openEditorPath;
        const openFileDiff = isGitWorkspace ? openDiffFile : undefined;
        return filePath ? (
          <EditorPanel
            workspaceId={workspace.id}
            filePath={filePath}
            api={api}
            tabId={`editor-${filePath}`}
            onDirtyChange={handleEditorDirtyChange}
            onClose={() => {
              const tid = `editor-${filePath}`;
              const dirtyPath = dirtyEditors[tid];
              if (dirtyPath !== undefined) {
                setPendingDirtyClose({ tabId: tid, path: dirtyPath });
                return;
              }
              closeTabNow(tid);
              setActiveTab("explorer");
            }}
            onOpenDiff={openFileDiff}
          />
        ) : (
          <Empty className="border-none p-6">
            <EmptyHeader>
              <EmptyMedia variant="icon">
                <FileCode className="size-5 text-muted-foreground" />
              </EmptyMedia>
              <EmptyTitle>No file selected</EmptyTitle>
              <EmptyDescription>Choose a file from the explorer to view or edit.</EmptyDescription>
            </EmptyHeader>
          </Empty>
        );
      }

      case "diff": {
        if (!isGitWorkspace) return <NonGitPane title="Diff" />;
        const diffPath = tab.targetId ?? openDiffPath;
        return (
          <DiffPanel
            workspaceId={workspace.id}
            initialPath={diffPath}
            api={api}
            onOpenFile={openEditorFile}
            onClose={() => {
              closeTabNow(`diff-${diffPath}`);
              setActiveTab("changes");
            }}
          />
        );
      }

      case "preview": {
        const previewId = tab.targetId ?? selectedPreviewId;
        const currentPreview = previews.find((p) => p.id === previewId) ?? previews[0];
        return currentPreview ? (
          <PreviewPanel
            key={currentPreview.id}
            preview={currentPreview}
            api={api}
            onPreviewChanged={(updated) => {
              setPreviews((current) => current.map((p) => (p.id === updated.id ? updated : p)));
            }}
            onClose={() => {
              // Closing the pane stops and removes the preview.
              closeTabNow(`preview-${currentPreview.id}`);
              setActiveTab("overview");
            }}
          />
        ) : (
          <Empty className="border-none p-6">
            <EmptyHeader>
              <EmptyMedia variant="icon">
                <Globe className="size-5 text-muted-foreground" />
              </EmptyMedia>
              <EmptyTitle>No web preview</EmptyTitle>
              <EmptyDescription>Start a live web preview for this workspace.</EmptyDescription>
            </EmptyHeader>
            <EmptyContent>
              <Button size="sm" onClick={() => void createPreview()}>
                Start web preview
              </Button>
            </EmptyContent>
          </Empty>
        );
      }

      default:
        return (
          <Empty className="border-none p-6">
            <EmptyHeader>
              <EmptyTitle>Unknown view</EmptyTitle>
            </EmptyHeader>
          </Empty>
        );
    }
  };

  return (
    <div className="app">
      {isOffline && (
        <div className="offline-banner" role="status">
          <span>⚠️ You are currently offline. Local changes cannot sync until connection is restored.</span>
          <button type="button" onClick={() => void refreshWorkspaces()}>
            Reconnect
          </button>
        </div>
      )}

      {/* No workspace (or desktop, where CSS hides this): the topbar carries
       *  the drawer button and the always-visible WS health indicator. With
       *  a workspace on mobile the context bar below takes over both roles,
       *  so the topbar stays out of the way instead of doubling the chrome. */}
      {(!isMobile || !workspace) && (
      <div className="mobile-topbar">
        <button className="mobile-nav" onClick={() => setDrawerOpen(true)} aria-label="Open navigation">
          <span aria-hidden="true">☰</span> Navigate
        </button>
        {/* The sidebar footer's indicator is inside a drawer, hidden by
         *  default on mobile -- this is the always-visible mobile home for
         *  the same real WS heartbeat status (docs/IOSWEBSOCKETS.md). */}
        <WsHealthIndicator health={wsHealth} />
      </div>
      )}

      {snapshot ? (
        <Sidebar
          data={snapshot}
          selected={selectedWorkspaceId}
          open={drawerOpen}
          onClose={() => setDrawerOpen(false)}
          onSelect={handleSelectWorkspace}
          onNewProject={() => { setFormError(""); setForm("project"); }}
          onNewWorktree={(projectId) => {
            setFormError("");
            setWorktreeModalTab("create");
            setWorktreeModalProjectId(projectId);
            setForm("worktree");
          }}
          agents={agents}
          workspaceStatuses={workspaceStatuses}
          build={build}
          daemon={daemonLifecycle}
          daemonBusy={drainBusy}
          wsHealth={wsHealth}
          onBeginDrain={handleBeginDrain}
          onCancelDrain={handleCancelDrain}
          onDiscoverWorktrees={(projId) => {
            setFormError("");
            setWorktreeModalTab("discover");
            setWorktreeModalProjectId(projId);
            setForm("worktree");
          }}
          onManageWorkspace={(ws) => {
            setSelectedWorkspaceId(ws.id);
            setWorkspaceDetailsOpen(true);
          }}
          onArchiveProject={async (id) => {
            try {
              await api.archiveProject(id);
              await refreshWorkspaces();
            } catch (err) {
              setSnapshotError(err instanceof Error ? err.message : String(err));
            }
          }}
        />
      ) : (
        <aside className="sidebar loading">Loading Passage…</aside>
      )}
      {drawerOpen && <button className="drawer-scrim" onClick={() => setDrawerOpen(false)} aria-label="Close navigation" />}

      <main className="main">
        {snapshotError && (
          <div className="alert page-alert" role="alert">
            Unable to load authoritative state: {snapshotError}
            <button className="secondary" onClick={() => void refreshWorkspaces()}>Retry</button>
          </div>
        )}

        {workspace ? (
          <div className="workspace-container">
            {/* Mobile context bar, or the desktop tab strip */}
            {isMobile ? (
              <MobileContextBar
                workspaceLabel={workspace.displayLabel}
                destKind={mobileDest.kind}
                destTitle={mobileDest.title}
                destMeta={mobileDest.meta}
                returnLabel={mobileReturnTo?.label ?? null}
                wsHealth={wsHealth}
                onOpenDrawer={() => setDrawerOpen(true)}
                onOpenSwitcher={() => setMobileSessionOpen(true)}
                onBack={goMobileBack}
                onNewAgent={() => { setMobileReturnTo(null); void createAgent(); }}
                onNewTerminal={() => { setMobileReturnTo(null); void createTerminal(); }}
                onNewPreview={() => { setMobileReturnTo(null); void createPreview(); }}
                onOpenCommands={() => setCommandPaletteOpen(true)}
                onOpenSettings={() => setSettingsModalOpen(true)}
                onOpenWorkspaceDetails={() => setWorkspaceDetailsOpen(true)}
                onCloseCurrent={mobileCloseAction?.action}
                closeLabel={mobileCloseAction?.label}
              />
            ) : (
            <nav className="workspace-nav-bar" aria-label="Workspace views">
              <div className="workspace-nav-brand min-w-0 max-w-[30vw] flex items-center gap-1.5">
                <button
                  type="button"
                  className="flex items-center gap-1.5 px-2 py-1 rounded hover:bg-surface-hover text-left transition-colors cursor-pointer border border-transparent hover:border-border min-w-0 max-w-full overflow-hidden"
                  onClick={() => setWorkspaceDetailsOpen(true)}
                  title="View workspace details & management options"
                >
                  <span className="workspace-crumb-title min-w-0">
                    <b className="font-semibold text-xs text-foreground truncate max-w-[12vw]" title={project?.displayLabel}>{project?.displayLabel}</b>
                    <span className="text-muted-foreground mx-1 shrink-0">/</span>
                    <span className="text-xs text-foreground font-medium truncate max-w-[14vw]" title={workspace.displayLabel}>{workspace.displayLabel}</span>
                  </span>
                  {workspace.branchRef && <code className="branch-pill truncate max-w-[10vw] shrink-0" title={workspace.branchRef}>⎇ {workspace.branchRef}</code>}
                  {workspace.archivedAt && (
                    <span className="text-[10px] px-1 py-0.2 rounded bg-amber-500/15 text-amber-600 font-medium">
                      archived
                    </span>
                  )}
                  <MoreHorizontal className="w-3.5 h-3.5 text-muted-foreground ml-0.5" />
                </button>
              </div>
              <div className="nav-tabs shrink-0">
                <button
                  type="button"
                  className={`nav-tab ${activeTab === "agent" ? "active" : ""}`}
                  aria-label="Create new agent session"
                  title="Create new agent session"
                  onClick={() => void createAgent()}
                >
                  ◈ Agent <Plus className="h-3.5 w-3.5" aria-hidden="true" />
                  {openAgentCount > 0 && <span className="tab-badge">{openAgentCount}</span>}
                </button>
                <button
                  type="button"
                  className={`nav-tab ${activeTab === "terminal" ? "active" : ""}`}
                  aria-label="Create new terminal"
                  title="Create new terminal"
                  onClick={() => void createTerminal()}
                >
                  &gt;_ Terminal <Plus className="h-3.5 w-3.5" aria-hidden="true" />
                  {openTerminalCount > 0 && <span className="tab-badge">{openTerminalCount}</span>}
                </button>
                <button
                  type="button"
                  className={`nav-tab ${activeTab === "preview" ? "active" : ""}`}
                  aria-label="Create new web preview"
                  title="Create new web preview"
                  onClick={() => void createPreview()}
                >
                  ◉ Preview <Plus className="h-3.5 w-3.5" aria-hidden="true" />
                  {openPreviewCount > 0 && <span className="tab-badge">{openPreviewCount}</span>}
                </button>
                <button
                  className={`nav-tab ${activeTab === "explorer" ? "active" : ""}`}
                  onClick={() => {
                    setActiveTab("explorer");
                    openPaneTab({ id: `explorer-${workspace.id}`, kind: "explorer", title: "Files" });
                  }}
                >
                  📁 Files
                </button>
                {isGitWorkspace && (
                  <button
                    className={`nav-tab ${activeTab === "changes" ? "active" : ""}`}
                    onClick={() => {
                      setActiveTab("changes");
                      openPaneTab({ id: `changes-${workspace.id}`, kind: "changes", title: "Changes" });
                    }}
                  >
                    ± Changes
                  </button>
                )}
              </div>

              <div className="workspace-nav-actions shrink-0">
                <button
                  type="button"
                  className="nav-action-btn"
                  title="Command Palette (Ctrl+K)"
                  onClick={() => setCommandPaletteOpen(true)}
                >
                  🔍 Commands <kbd>⌘K</kbd>
                </button>
                <button
                  type="button"
                  className="nav-action-btn"
                  title="Settings & Themes"
                  onClick={() => setSettingsModalOpen(true)}
                >
                  ⚙ Settings
                </button>
              </div>
            </nav>
            )}

            {/* Split Canvas for Desktop, Single active tab view for Mobile */}
            <div className="workspace-view">
              {isMobile ? (
                renderTabContent({
                  id: `mobile-${activeTab}`,
                  kind: activeTab,
                  title: activeTab,
                  targetId: activeTab === "agent" ? selectedAgentId : activeTab === "terminal" ? selectedTerminalId : activeTab === "preview" ? selectedPreviewId : activeTab === "editor" ? openEditorPath : activeTab === "diff" ? openDiffPath : undefined,
                })
              ) : layout ? (
                <SplitCanvas
                  layout={layout}
                  onLayoutChange={handleLayoutChange}
                  renderTabContent={renderTabContent}
                  onActivateTab={handleActivateTab}
                  onCloseTab={(tabId) => {
                    const dirtyPath = dirtyEditors[tabId];
                    if (dirtyPath !== undefined) {
                      setPendingDirtyClose({ tabId, path: dirtyPath });
                      return false;
                    }
                    endTabResource(tabId);
                    if (tabId.startsWith("editor-")) setOpenEditorPath(undefined);
                    if (tabId.startsWith("diff-")) setOpenDiffPath(undefined);
                  }}
                  workspaceId={workspace.id}
                  agents={agents}
                />
              ) : (
                <Empty className="border-none p-6">
                  <EmptyHeader>
                    <EmptyMedia variant="icon">
                      <Spinner className="size-5 text-muted-foreground" />
                    </EmptyMedia>
                    <EmptyTitle>Loading workspace layout…</EmptyTitle>
                  </EmptyHeader>
                </Empty>
              )}
            </div>
          </div>
        ) : (
          <div className="empty flex flex-1 flex-col items-center justify-center p-8 text-center max-w-md mx-auto">
            <span className="empty-icon text-3xl mb-2" aria-hidden="true">⌂</span>
            <h1 className="text-lg font-semibold text-foreground mb-1">Select a workspace</h1>
            <p className="text-xs text-muted-foreground mb-4">Choose a workspace from navigation or register a project to begin.</p>
            <Button size="xs" onClick={() => { setFormError(""); setForm("project"); }}>+ Add Project</Button>
          </div>
        )}
      </main>

      {/* Mobile session switcher */}
      {workspace && (
      <MobileSessionSheet
        open={mobileSessionOpen}
        onClose={() => setMobileSessionOpen(false)}
        agents={agents}
        terminals={terminals}
        previews={previews}
        showChanges={isGitWorkspace}
        currentKind={activeTab}
        currentTargetId={activeTab === "agent" ? selectedAgentId : activeTab === "terminal" ? selectedTerminalId : activeTab === "preview" ? selectedPreviewId : activeTab === "editor" ? openEditorPath : activeTab === "diff" ? openDiffPath : undefined}
        selectedAgentId={selectedAgentId}
        selectedTerminalId={selectedTerminalId}
        selectedPreviewId={selectedPreviewId}
        onSelectAgent={handleSelectAgent}
        onSelectTerminal={handleSelectTerminal}
        onSelectPreview={handleSelectPreview}
        onOpenFiles={() => {
          captureMobileReturn();
          setActiveTab("explorer");
          openPaneTab({ id: `explorer-${workspace.id}`, kind: "explorer", title: "Files" });
        }}
        onOpenChanges={() => {
          captureMobileReturn();
          setActiveTab("changes");
          openPaneTab({ id: `changes-${workspace.id}`, kind: "changes", title: "Changes" });
        }}
        onNewAgent={() => { setMobileReturnTo(null); void createAgent(); }}
        onNewTerminal={() => { setMobileReturnTo(null); void createTerminal(); }}
        onCloseAgent={closeAgentOnMobile}
        onCloseTerminal={closeTerminalOnMobile}
        onClosePreview={closePreviewOnMobile}
      />
      )}

      {/* Command Palette */}
      <CommandPalette
        open={commandPaletteOpen}
        onClose={() => setCommandPaletteOpen(false)}
        snapshot={snapshot ?? { projects: [], workspaces: [], locations: [] }}
        selectedWorkspaceId={selectedWorkspaceId}
        isGitWorkspace={isGitWorkspace}
        agents={agents}
        terminals={terminals}
        onSelectWorkspace={handleSelectWorkspace}
        onSelectAgent={handleSelectAgent}
        onSelectTerminal={handleSelectTerminal}
        onOpenView={(view) => {
          if ((view === "changes" || view === "diff") && !isGitWorkspace) return;
          captureMobileReturn();
          setActiveTab(view);
          if (workspace) openPaneTab({ id: `${view}-${workspace.id}`, kind: view, title: view });
        }}
        onCreateAgent={() => void createAgent()}
        onCreateTerminal={() => void createTerminal({ forceNew: true })}
        onResetLayout={() => {
          if (workspace) handleLayoutChange(createDefaultLayout(workspace.id));
        }}
        onOpenSettings={() => setSettingsModalOpen(true)}
        onDiscoverWorktrees={() => {
          setFormError("");
          setWorktreeModalTab("discover");
          setWorktreeModalProjectId(activeProject?.id);
          setForm("worktree");
        }}
      />

      {/* Settings Modal */}
      <SettingsModal
        open={settingsModalOpen}
        onClose={() => setSettingsModalOpen(false)}
        settings={settings}
        onSaveSettings={handleSaveSettings}
        themes={themes}
        fontOptions={fontOptions}
        api={api}
        projects={snapshot?.projects ?? []}
        locations={snapshot?.locations ?? []}
        onLocationsChanged={async () => { await refreshWorkspaces(); }}
      />

      {/* Workspace Details & Management Modal */}
      {workspace && project && (
        <WorkspaceDetailsModal
          open={workspaceDetailsOpen}
          onClose={() => setWorkspaceDetailsOpen(false)}
          workspace={workspace}
          project={project}
          api={api}
          onRefresh={async () => { await refreshWorkspaces(); }}
        />
      )}

      {/* Unsaved editor changes confirmation */}
      <AlertDialog open={pendingDirtyClose !== null} onOpenChange={(isOpen) => { if (!isOpen && !dirtySaveBusy) setPendingDirtyClose(null); }}>
        <AlertDialogContent className="max-w-[440px]">
          <AlertDialogHeader>
            <AlertDialogTitle>Unsaved changes</AlertDialogTitle>
            <AlertDialogDescription>
              Do you want to save the changes you made to {pendingDirtyClose?.path ?? "this file"}? Your changes will be lost if you don&apos;t save them.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={dirtySaveBusy}>Cancel</AlertDialogCancel>
            <Button
              size="xs"
              variant="secondary"
              disabled={dirtySaveBusy}
              onClick={() => {
                if (!pendingDirtyClose) return;
                closeTabNow(pendingDirtyClose.tabId);
                if (pendingDirtyClose.tabId.startsWith("editor-")) setActiveTab("explorer");
                setPendingDirtyClose(null);
              }}
            >
              Discard
            </Button>
            <Button
              size="xs"
              disabled={dirtySaveBusy}
              onClick={() => {
                if (!pendingDirtyClose) return;
                const save = editorSaveHandlers.current.get(pendingDirtyClose.tabId);
                if (!save) {
                  setPendingDirtyClose(null);
                  return;
                }
                setDirtySaveBusy(true);
                void save().then((ok) => {
                  setDirtySaveBusy(false);
                  if (!ok) return;
                  closeTabNow(pendingDirtyClose.tabId);
                  if (pendingDirtyClose.tabId.startsWith("editor-")) setActiveTab("explorer");
                  setPendingDirtyClose(null);
                });
              }}
            >
              {dirtySaveBusy ? "Saving..." : "Save"}
            </Button>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* Workspace Creation Modals */}
      {form === "project" && (
        <FormDialog
          title="Register a project"
          submitLabel="Register project"
          error={formError}
          onCancel={() => { setFormError(""); setForm(undefined); }}
          // While directory suggestions are visible, Escape dismisses only
          // the suggestion list (see DirectoryPicker), not the dialog.
          onEscapeKeyDown={(event) => { if (dirSuggestOpen) event.preventDefault(); }}
          onSubmit={(event) => {
            event.preventDefault();
            const data = new FormData(event.currentTarget);
            const displayLabel = String(data.get("label") ?? "").trim();
            const configuredRootPath = String(data.get("path") ?? "").trim();
            if (!displayLabel || !configuredRootPath) {
              setFormError("Project name and directory path cannot be empty.");
              return;
            }
            void runWorkspaceMutation(() => api.registerProject({
              configuredRootPath,
              displayLabel,
            }));
          }}
        >
          <label>Project name<Input name="label" required placeholder="Payments platform" /></label>
          <label>Directory path<DirectoryPicker api={api} name="path" placeholder="/home/user/code/payments" onOpenChange={setDirSuggestOpen} /></label>
          <p className="form-help">The daemon resolves and verifies this directory before registering it.</p>
        </FormDialog>
      )}

      {form === "worktree" && snapshot && (
        <NewWorktreeModal
          projects={snapshot.projects}
          locations={snapshot.locations}
          defaultProjectId={worktreeModalProjectId ?? activeProject?.id}
          lockedProjectId={worktreeModalProjectId}
          initialTab={worktreeModalTab}
          suggestModel={settings.suggestModel}
          suggestThinkingLevel={settings.suggestThinkingLevel}
          worktreePrompt={settings.worktreePrompt}
          api={api}
          onClose={() => {
            setForm(undefined);
            setWorktreeModalProjectId(undefined);
          }}
          onCreated={(created) => {
            if (created.setup) {
              pendingSetupRuns.current.set(created.workspace.id, created.setup.id);
              toast.loading("Setting up workspace", {
                id: setupToastId(created.setup.id),
                description: "Running the worktree setup action in the background.",
                duration: Infinity,
              });
            }
            void refreshWorkspaces().then(() => {
              setSelectedWorkspaceId(created.workspace.id);
              setActiveTab("agent");
            });
          }}
          onLocationsChanged={async () => { await refreshWorkspaces(); }}
        />
      )}
    </div>
  );
}

const root = document.getElementById("root");
if (!root) throw new Error("Passage root element is missing");
createRoot(root).render(<StrictMode><TooltipProvider><App /><Toaster /></TooltipProvider></StrictMode>);
