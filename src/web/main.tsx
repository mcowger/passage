import { StrictMode, useCallback, useEffect, useMemo, useRef, useState, type FormEvent, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import type { AgentHistory, AgentSummary } from "../shared/domain/agents.ts";
import type { WorkspaceSnapshot, Workspace } from "../shared/domain/workspaces.ts";
import type { TerminalSummary } from "../shared/domain/terminals.ts";
import type { PaneTab, WorkspaceLayout, LayoutNode } from "../shared/domain/layout.ts";
import { addTabToGroup, createDefaultLayout, getFirstTabGroup, removeTabFromTree, replaceOverviewTabs } from "../shared/domain/layout.ts";
import type { WorkspaceSettings } from "../shared/domain/settings.ts";
import { DEFAULT_WORKSPACE_SETTINGS } from "../shared/domain/settings.ts";
import type { ThemePack, FontPack } from "../shared/domain/customization.ts";
import { BUILTIN_THEMES, BUILTIN_FONTS } from "../shared/domain/customization.ts";
import { createWorkspaceApi, friendlyApiError } from "./api.ts";
import { AgentSessionPanel } from "./components/AgentSessionPanel.tsx";
import { Sidebar } from "./components/Sidebar.tsx";
import { WorkspaceDetailsModal } from "./components/WorkspaceDetailsModal.tsx";
import { ExplorerPanel } from "./components/ExplorerPanel.tsx";
import { ChangesPanel } from "./components/ChangesPanel.tsx";
import { EditorPanel } from "./components/EditorPanel.tsx";
import { DiffPanel } from "./components/DiffPanel.tsx";
import { TerminalPanel } from "./components/TerminalPanel.tsx";
import { NewWorktreeModal } from "./components/NewWorktreeModal.tsx";
import { SplitCanvas } from "./components/SplitCanvas.tsx";
import { CommandPalette } from "./components/CommandPalette.tsx";
import { SettingsModal } from "./components/SettingsModal.tsx";
import { showAgentNotification } from "./notifications.ts";
import { Button } from "./components/ui/button.tsx";
import { MoreHorizontal, Plus } from "lucide-react";
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
import "./styles.css";

function applyThemeTokens(theme?: ThemePack) {
  if (!theme || typeof document === "undefined") return;
  const root = document.documentElement;
  root.dataset.themeMode = theme.mode;
  if (theme.mode === "dark") {
    root.classList.add("dark");
  } else {
    root.classList.remove("dark");
  }
  for (const [key, value] of Object.entries(theme.tokens)) {
    if (value) {
      const cssVar = `--${key.replace(/([A-Z])/g, "-$1").toLowerCase()}`;
      root.style.setProperty(cssVar, value);
    }
  }
}

function applyFontTokens(font?: FontPack) {
  if (!font || typeof document === "undefined") return;
  const root = document.documentElement;
  root.style.setProperty("--font-ui", font.uiFontFamily);
  root.style.setProperty("--font-mono", font.monoFontFamily);
}

type FormKind = "project" | "worktree";
type TabKind = "overview" | "agent" | "terminal" | "explorer" | "changes" | "editor" | "diff";

type FormDialogProps = {
  title: string;
  submitLabel: string;
  error?: string;
  onCancel: () => void;
  onSubmit: (event: FormEvent<HTMLFormElement>) => void;
  children: ReactNode;
};

function FormDialog({ title, submitLabel, error, onCancel, onSubmit, children }: FormDialogProps) {
  return (
    <Dialog open onOpenChange={(isOpen) => { if (!isOpen) onCancel(); }}>
      <DialogContent className="max-w-[480px]">
        <form onSubmit={onSubmit} aria-label={title} className="flex flex-col gap-4">
          <DialogHeader>
            <p className="text-xs uppercase tracking-wider text-muted-foreground font-semibold">Workspace setup</p>
            <DialogTitle className="text-lg font-semibold">{title}</DialogTitle>
          </DialogHeader>
          {error && <Alert variant="destructive"><AlertDescription className="text-sm font-medium">{error}</AlertDescription></Alert>}
          {children}
          <div className="flex justify-end gap-2 pt-2">
            <Button type="button" variant="secondary" onClick={onCancel}>Cancel</Button>
            <Button type="submit">{submitLabel}</Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function stripGitTabsFromLayout(node: LayoutNode): LayoutNode | null {
  if (node.type === "tabs") {
    const tabs = node.tabs.filter((tab) => tab.kind !== "changes" && tab.kind !== "diff");
    if (tabs.length === 0) return null;
    const activeTabId = tabs.some((tab) => tab.id === node.activeTabId) ? node.activeTabId : tabs[0].id;
    return { ...node, tabs, activeTabId };
  }
  const children: LayoutNode[] = [];
  const sizes: number[] = [];
  for (let i = 0; i < node.children.length; i++) {
    const next = stripGitTabsFromLayout(node.children[i]);
    if (next) {
      children.push(next);
      sizes.push(node.sizes[i] ?? 1 / node.children.length);
    }
  }
  if (children.length === 0) return null;
  if (children.length === 1) return children[0];
  const total = sizes.reduce((sum, size) => sum + size, 0);
  return { ...node, children, sizes: sizes.map((size) => size / total) };
}

function layoutContainsGitTabs(node: LayoutNode): boolean {
  if (node.type === "tabs") return node.tabs.some((tab) => tab.kind === "changes" || tab.kind === "diff");
  return node.children.some(layoutContainsGitTabs);
}

function NonGitPane({ title }: { title: string }) {
  return (
    <div className="empty flex flex-col items-center justify-center p-8 text-center max-w-md mx-auto">
      <span className="empty-icon text-3xl mb-2" aria-hidden="true">±</span>
      <h1 className="text-lg font-semibold text-foreground mb-1">{title} unavailable</h1>
      <p className="text-xs text-muted-foreground">This workspace is not inside a Git repository.</p>
    </div>
  );
}

const LAST_WORKSPACE_KEY = "passage.lastWorkspaceId";

function readLastWorkspaceId(): string | undefined {
  try {
    return localStorage.getItem(LAST_WORKSPACE_KEY) ?? undefined;
  } catch {
    return undefined;
  }
}

function App() {
  const api = useMemo(() => createWorkspaceApi(), []);
  const [snapshot, setSnapshot] = useState<WorkspaceSnapshot>();
  const [snapshotError, setSnapshotError] = useState("");
  const [formError, setFormError] = useState("");
  const [selectedWorkspaceId, setSelectedWorkspaceId] = useState<string>();
  const [selectedAgentId, setSelectedAgentId] = useState<string>();
  const [selectedTerminalId, setSelectedTerminalId] = useState<string>();
  const [activeTab, setActiveTab] = useState<TabKind>("agent");
  const [openEditorPath, setOpenEditorPath] = useState<string>();
  const [openDiffPath, setOpenDiffPath] = useState<string>();
  const [agents, setAgents] = useState<AgentSummary[]>([]);
  const [terminals, setTerminals] = useState<TerminalSummary[]>([]);
  const [previewHistory, setPreviewHistory] = useState<AgentHistory | null>(null);
  const [agentError, setAgentError] = useState("");
  const [form, setForm] = useState<FormKind>();
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [layout, setLayout] = useState<WorkspaceLayout>();
  const [settings, setSettings] = useState<WorkspaceSettings>(DEFAULT_WORKSPACE_SETTINGS);
  const [themes, setThemes] = useState<ThemePack[]>(BUILTIN_THEMES);
  const [fonts, setFonts] = useState<FontPack[]>(BUILTIN_FONTS);
  const [commandPaletteOpen, setCommandPaletteOpen] = useState(false);
  const [settingsModalOpen, setSettingsModalOpen] = useState(false);
  const [workspaceDetailsOpen, setWorkspaceDetailsOpen] = useState(false);
  const [worktreeModalTab, setWorktreeModalTab] = useState<"create" | "discover">("create");
  const [worktreeModalProjectId, setWorktreeModalProjectId] = useState<string>();
  const [isOffline, setIsOffline] = useState(typeof navigator !== "undefined" ? !navigator.onLine : false);
  const [isMobile, setIsMobile] = useState(typeof window !== "undefined" ? window.innerWidth < 768 : false);
  const [dirtyEditors, setDirtyEditors] = useState<Record<string, string>>({});
  const [pendingDirtyClose, setPendingDirtyClose] = useState<{ tabId: string; path: string } | null>(null);
  const [dirtySaveBusy, setDirtySaveBusy] = useState(false);
  const editorSaveHandlers = useRef(new Map<string, () => Promise<boolean>>());

  const agentsLoadGeneration = useRef(0);

  // Register service worker and offline listeners
  useEffect(() => {
    if (typeof window !== "undefined") {
      const handleOnline = () => setIsOffline(false);
      const handleOffline = () => setIsOffline(true);
      const handleResize = () => setIsMobile(window.innerWidth < 768);

      window.addEventListener("online", handleOnline);
      window.addEventListener("offline", handleOffline);
      window.addEventListener("resize", handleResize);

      if ("serviceWorker" in navigator && process.env.NODE_ENV === "production") {
        navigator.serviceWorker.register("/sw.js").catch(() => {});
      }

      return () => {
        window.removeEventListener("online", handleOnline);
        window.removeEventListener("offline", handleOffline);
        window.removeEventListener("resize", handleResize);
      };
    }
  }, []);

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

  const refreshWorkspaces = useCallback(async (): Promise<boolean> => {
    try {
      setSnapshotError("");
      const next = await api.snapshot();
      setSnapshot(next);
      setSelectedWorkspaceId((current) => {
        const candidates = next.workspaces.filter((workspace) => !workspace.archivedAt);
        if (current && candidates.some((workspace) => workspace.id === current)) return current;
        const last = readLastWorkspaceId();
        if (last && candidates.some((workspace) => workspace.id === last)) return last;
        return candidates[0]?.id ?? next.workspaces[0]?.id;
      });
      return true;
    } catch (cause) {
      setSnapshotError(cause instanceof Error ? cause.message : "Unable to load workspace snapshot");
      return false;
    }
  }, [api]);

  const loadAgents = useCallback(async (workspaceId: string, selectFirst = true) => {
    const generation = ++agentsLoadGeneration.current;
    try {
      const next = await api.listAgents(workspaceId);
      if (generation !== agentsLoadGeneration.current) return;
      setAgentError("");
      setAgents(next);
      setSelectedAgentId((current) => {
        if (current && next.some((agent) => agent.id === current)) return current;
        return selectFirst ? next[0]?.id : undefined;
      });
    } catch (cause) {
      if (generation !== agentsLoadGeneration.current) return;
      setAgentError(cause instanceof Error ? cause.message : "Unable to load agents");
    }
  }, [api]);

  const loadTerminals = useCallback(async (workspaceId: string, selectFirst = true) => {
    try {
      const next = await api.listTerminals(workspaceId);
      setTerminals(next);
      setSelectedTerminalId((current) => {
        if (current && next.some((t) => t.id === current)) return current;
        return selectFirst ? next[0]?.id : undefined;
      });
    } catch {}
  }, [api]);

  const loadLayoutAndSettings = useCallback(async (workspaceId: string) => {
    try {
      const [fetchedLayout, fetchedSettings, fetchedThemes, fetchedFonts] = await Promise.all([
        api.getLayout(workspaceId)
          .then((l) => ({ ...l, root: replaceOverviewTabs(l.root) }))
          .catch(() => createDefaultLayout(workspaceId)),
        api.getSettings(workspaceId).catch(() => DEFAULT_WORKSPACE_SETTINGS),
        api.getThemes().catch(() => BUILTIN_THEMES),
        api.getFonts().catch(() => BUILTIN_FONTS),
      ]);
      setLayout(fetchedLayout);
      setSettings(fetchedSettings);
      setThemes(fetchedThemes);
      setFonts(fetchedFonts);

      const activeTheme = fetchedThemes.find((t) => t.id === fetchedSettings.themeId) ?? fetchedThemes[0];
      const activeFont = fetchedFonts.find((f) => f.id === fetchedSettings.fontId) ?? fetchedFonts[0];
      applyThemeTokens(activeTheme);
      applyFontTokens(activeFont);
    } catch {}
  }, [api]);

  useEffect(() => { void refreshWorkspaces(); }, [refreshWorkspaces]);

  useEffect(() => {
    if (!selectedWorkspaceId) return;
    try {
      localStorage.setItem(LAST_WORKSPACE_KEY, selectedWorkspaceId);
    } catch {}
  }, [selectedWorkspaceId]);

  useEffect(() => {
    agentsLoadGeneration.current += 1;
    setAgents([]);
    setTerminals([]);
    setSelectedAgentId(undefined);
    setSelectedTerminalId(undefined);
    setOpenEditorPath(undefined);
    setOpenDiffPath(undefined);
    setActiveTab("agent");
    if (selectedWorkspaceId) {
      void loadAgents(selectedWorkspaceId);
      void loadTerminals(selectedWorkspaceId);
      void loadLayoutAndSettings(selectedWorkspaceId);
    }
  }, [loadAgents, loadTerminals, loadLayoutAndSettings, selectedWorkspaceId]);

  const workspace = snapshot?.workspaces.find((item) => item.id === selectedWorkspaceId);
  const project = snapshot?.projects.find((item) => item.id === workspace?.projectId);
  const activeProject = project ?? snapshot?.projects.find((item) => !item.archivedAt);
  const selectedTerminal = terminals.find((t) => t.id === selectedTerminalId) ?? terminals[0];
  const isGitWorkspace = workspace?.mainRepositoryRoot != null;

  const handleLayoutChange = useCallback(
    (nextLayout: WorkspaceLayout) => {
      setLayout(nextLayout);
      if (selectedWorkspaceId) {
        void api.saveLayout(selectedWorkspaceId, nextLayout).catch(() => {});
      }
    },
    [api, selectedWorkspaceId]
  );

  const handleSaveSettings = useCallback(
    async (nextSettings: WorkspaceSettings) => {
      setSettings(nextSettings);
      if (selectedWorkspaceId) {
        await api.saveSettings(selectedWorkspaceId, nextSettings);
      }
      const activeTheme = themes.find((t) => t.id === nextSettings.themeId) ?? themes[0];
      const activeFont = fonts.find((f) => f.id === nextSettings.fontId) ?? fonts[0];
      applyThemeTokens(activeTheme);
      applyFontTokens(activeFont);
    },
    [api, selectedWorkspaceId, themes, fonts]
  );

  const openPaneTab = useCallback(
    (tab: PaneTab) => {
      if ((tab.kind === "changes" || tab.kind === "diff") && workspace?.mainRepositoryRoot == null) return;
      if (!layout) {
        handleLayoutChange(createDefaultLayout(workspace?.id ?? "default", tab));
        return;
      }
      const firstGroup = getFirstTabGroup(layout.root);
      if (!firstGroup) return;
      const nextRoot = addTabToGroup(layout.root, firstGroup.id, tab);
      handleLayoutChange({ ...layout, root: nextRoot });
    },
    [layout, handleLayoutChange, workspace?.mainRepositoryRoot, workspace?.id]
  );

  const openEditorFile = useCallback((path: string) => {
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
      handleLayoutChange({ ...layout, root: renameInTree(layout.root) });
    }
    // The renamed tab already exists in place; just reveal it when it was open.
    if (wasOpenEditor) setActiveTab("editor");
  }, [layout, handleLayoutChange, openEditorPath]);

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
      if (nextRoot && selectedWorkspaceId) {
        handleLayoutChange({ ...layout, root: nextRoot });
      }
    }
  }, [layout, handleLayoutChange, selectedWorkspaceId]);

  useEffect(() => {
    if (!workspace || !layout) return;
    if (workspace.mainRepositoryRoot != null) return;
    if (!layoutContainsGitTabs(layout.root)) return;
    const stripped = stripGitTabsFromLayout(layout.root);
    if (stripped) {
      handleLayoutChange({ ...layout, root: stripped });
    } else {
      handleLayoutChange(createDefaultLayout(workspace.id));
    }
    setActiveTab((current) => (current === "changes" || current === "diff" ? "agent" : current));
  }, [workspace, layout, handleLayoutChange]);

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

  const createTerminal = async () => {
    if (!workspace) return;
    try {
      const created = await api.createTerminal(workspace.id);
      setTerminals((current) => [...current, created]);
      setSelectedTerminalId(created.id);
      setActiveTab("terminal");
      openPaneTab({
        id: `terminal-${created.id}`,
        kind: "terminal",
        title: created.title,
        targetId: created.id,
      });
    } catch {}
  };

  const closeAgentTab = async (tabId: string) => {
    if (!tabId.startsWith("agent-") || !selectedWorkspaceId) return;
    const agentId = tabId.slice("agent-".length);
    if (!agents.some((agent) => agent.id === agentId)) return;
    try {
      await api.archiveAgent(agentId);
      if (selectedAgentId === agentId) setSelectedAgentId(undefined);
      await loadAgents(selectedWorkspaceId, false);
    } catch (cause) {
      setAgentError(cause instanceof Error ? cause.message : "Unable to close agent session");
    }
  };

  const handleSelectAgent = (id: string) => {
    setSelectedAgentId(id);
    setActiveTab("agent");
    setDrawerOpen(false);
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
    if (layout && selectedWorkspaceId) {
      const nextRoot = removeTabFromTree(layout.root, tabId);
      handleLayoutChange(nextRoot ? { ...layout, root: nextRoot } : createDefaultLayout(selectedWorkspaceId));
    }
    if (tabId.startsWith("editor-")) setOpenEditorPath(undefined);
    if (tabId.startsWith("diff-")) setOpenDiffPath(undefined);
  }, [layout, selectedWorkspaceId, handleLayoutChange]);

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
    }
  }, []);

  const handleSelectWorkspace = (id: string) => {
    setSelectedWorkspaceId(id);
    setSelectedAgentId(undefined);
    setSelectedTerminalId(undefined);
    setActiveTab("agent");
    setDrawerOpen(false);
  };

  // Render tab content for SplitCanvas & single-pane mode
  const renderTabContent = (tab: PaneTab): ReactNode => {
    if (!workspace || !project) {
      return (
        <div className="empty">
          <span className="empty-icon" aria-hidden="true">⌂</span>
          <h1>Select a workspace</h1>
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
            onAgentChanged={(updatedAgent) => {
              setAgents((current) => current.map((agent) => agent.id === updatedAgent.id ? updatedAgent : agent));
            }}
            previewHistory={previewEnabled ? previewHistory ?? undefined : undefined}
          />
        ) : tab.kind === "overview" ? (
          <div className="empty flex flex-col items-center justify-center p-8 text-center max-w-md mx-auto">
            <span className="empty-icon text-3xl mb-2 text-primary" aria-hidden="true">◈</span>
            <h1 className="text-lg font-semibold text-foreground mb-1">Workspace Overview</h1>
            <p className="text-xs text-muted-foreground mb-4">Start a new agent session to begin a conversation.</p>
            {!workspace.archivedAt && <Button size="xs" onClick={() => void createAgent()}>+ Start Agent Session</Button>}
          </div>
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
        const termId = tab.targetId ?? selectedTerminalId;
        const currentTerm = terminals.find((t) => t.id === termId) ?? selectedTerminal;
        return currentTerm ? (
          <TerminalPanel
            key={currentTerm.id}
            terminal={currentTerm}
            api={api}
            onClose={() => {
              closeTabNow(`terminal-${currentTerm.id}`);
              setActiveTab("overview");
            }}
            onTerminated={() => {
              void loadTerminals(workspace.id);
            }}
          />
        ) : (
          <div className="empty">
            <span className="empty-icon" aria-hidden="true">&gt;_</span>
            <h1>No active terminal</h1>
            <button className="primary" onClick={() => void createTerminal()}>Launch terminal</button>
          </div>
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

      case "changes":
        if (!isGitWorkspace) return <NonGitPane title="Changes" />;
        return (
          <ChangesPanel
            workspaceId={workspace.id}
            api={api}
            onOpenFile={openEditorFile}
            onOpenDiff={openDiffFile}
          />
        );

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
          <div className="empty">
            <span className="empty-icon" aria-hidden="true">📄</span>
            <h1>No file selected</h1>
          </div>
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

      default:
        return <div className="empty">Unknown view</div>;
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

      <button className="mobile-nav" onClick={() => setDrawerOpen(true)} aria-label="Open navigation">
        <span aria-hidden="true">☰</span> Navigate
      </button>

      {snapshot ? (
        <Sidebar
          data={snapshot}
          selected={selectedWorkspaceId}
          selectedAgent={selectedAgentId}
          selectedTerminal={selectedTerminalId}
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
          onDiscoverWorktrees={(projId) => {
            setFormError("");
            setWorktreeModalTab("discover");
            setWorktreeModalProjectId(projId);
            setForm("worktree");
          }}
          agents={agents}
          onSelectAgent={handleSelectAgent}
          terminals={terminals}
          onSelectTerminal={handleSelectTerminal}
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
            {/* Top Command & Settings Bar */}
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
                  {agents.length > 0 && <span className="tab-badge">{agents.length}</span>}
                </button>
                <button
                  className={`nav-tab ${activeTab === "terminal" ? "active" : ""}`}
                  onClick={() => {
                    const target = terminals.find((t) => t.id === selectedTerminalId) ?? terminals[0];
                    if (target) {
                      setSelectedTerminalId(target.id);
                      setActiveTab("terminal");
                      handleSelectTerminal(target.id);
                    } else {
                      void createTerminal();
                    }
                  }}
                >
                  &gt;_ Terminal {terminals.length > 0 && <span className="tab-badge">{terminals.length}</span>}
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

            {/* Split Canvas for Desktop, Single active tab view for Mobile */}
            <div className="workspace-view">
              {isMobile ? (
                renderTabContent({
                  id: `mobile-${activeTab}`,
                  kind: activeTab,
                  title: activeTab,
                  targetId: activeTab === "agent" ? selectedAgentId : activeTab === "terminal" ? selectedTerminalId : activeTab === "editor" ? openEditorPath : activeTab === "diff" ? openDiffPath : undefined,
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
                    void closeAgentTab(tabId);
                    if (tabId.startsWith("editor-")) setOpenEditorPath(undefined);
                    if (tabId.startsWith("diff-")) setOpenDiffPath(undefined);
                  }}
                  workspaceId={workspace.id}
                />
              ) : (
                <div className="empty">Loading workspace layout…</div>
              )}
            </div>
          </div>
        ) : (
          <div className="empty">
            <span className="empty-icon" aria-hidden="true">⌂</span>
            <h1>Select a workspace</h1>
            <p>Choose a workspace from navigation or register a project to begin.</p>
          </div>
        )}
      </main>

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
          setActiveTab(view);
          if (workspace) openPaneTab({ id: `${view}-${workspace.id}`, kind: view, title: view });
        }}
        onCreateAgent={() => void createAgent()}
        onCreateTerminal={() => void createTerminal()}
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
        fonts={fonts}
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
          <label>Project name<input name="label" required placeholder="Payments platform" /></label>
          <label>Directory path<input name="path" required placeholder="/home/user/code/payments" /></label>
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
          api={api}
          onClose={() => {
            setForm(undefined);
            setWorktreeModalProjectId(undefined);
          }}
          onCreated={(created) => {
            void refreshWorkspaces().then(() => {
              setSelectedWorkspaceId(created.id);
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
