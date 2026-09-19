import { StrictMode, useCallback, useEffect, useMemo, useRef, useState, type FormEvent, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import type { AgentHistory, AgentSummary } from "../shared/domain/agents.ts";
import type { WorkspaceSnapshot, Workspace } from "../shared/domain/workspaces.ts";
import type { TerminalSummary } from "../shared/domain/terminals.ts";
import type { WebPreview } from "../shared/domain/previews.ts";
import type { PaneTab, WorkspaceLayout, LayoutNode } from "../shared/domain/layout.ts";
import { addTabToGroup, countTabsOfKind, createDefaultLayout, findFirstDeadTerminalTab, getFirstTabGroup, removeTabFromTree, replaceOverviewTabs, updateTabInTree } from "../shared/domain/layout.ts";
import type { WorkspaceSettings } from "../shared/domain/settings.ts";
import { DEFAULT_WORKSPACE_SETTINGS } from "../shared/domain/settings.ts";
import type { ThemePack, FontMapping, FontOption } from "../shared/domain/customization.ts";
import { BUILTIN_THEMES, AVAILABLE_FONTS, resolveFontFamilies } from "../shared/domain/customization.ts";
import { createWorkspaceApi, friendlyApiError } from "./api.ts";
import type { BuildInfo } from "../shared/build-info.ts";
import { subscribeWorkspace, subscribeWorkspaces } from "./workspaceSocket.ts";
import { subscribeDaemon } from "./daemonSocket.ts";
import type { ConnectionHealth } from "./socketLifecycle.ts";
import type { DaemonLifecycleSnapshot } from "./api.ts";
import type { WorkspaceActionRun } from "../shared/domain/workspace-actions.ts";
import { AgentSessionPanel } from "./components/AgentSessionPanel.tsx";
import { MobileContextBar, MobileSessionSheet, type MobileDestinationKind, type MobileReturn } from "./components/MobileNav.tsx";
import { AGENT_STATUS_LABEL, getAgentStatusKind, getWorkspaceStatusKind, type AgentStatusKind } from "./components/agentStatus.ts";
import { Sidebar } from "./components/Sidebar.tsx";
import { WsHealthIndicator } from "./components/WsHealthIndicator.tsx";
import { WorkspaceDetailsModal } from "./components/WorkspaceDetailsModal.tsx";
import { ExplorerPanel } from "./components/ExplorerPanel.tsx";
import { ChangesPanel } from "./components/ChangesPanel.tsx";
import { EditorPanel } from "./components/EditorPanel.tsx";
import { DiffPanel } from "./components/DiffPanel.tsx";
import { TerminalPanel } from "./components/TerminalPanel.tsx";
import { TerminalTabPane } from "./components/TerminalTabPane.tsx";
import { PreviewPanel } from "./components/PreviewPanel.tsx";
import { WorkspaceOverview } from "./components/WorkspaceOverview.tsx";
import { NewWorktreeModal } from "./components/NewWorktreeModal.tsx";
import { DirectoryPicker } from "./components/DirectoryPicker.tsx";
import { SplitCanvas } from "./components/SplitCanvas.tsx";
import { CommandPalette } from "./components/CommandPalette.tsx";
import { SettingsModal } from "./components/SettingsModal.tsx";
import { showAgentNotification } from "./notifications.ts";
import { initKeyboardInset } from "./lib/keyboard-inset.ts";
import { Button } from "./components/ui/button.tsx";
import { Input } from "./components/ui/input.tsx";
import { FileCode, Globe, MoreHorizontal, Plus, Terminal as TerminalIcon } from "lucide-react";
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

function applyFontTokens(mapping: FontMapping | undefined, options: FontOption[]) {
  if (typeof document === "undefined") return;
  const families = resolveFontFamilies(options, mapping);
  const root = document.documentElement;
  root.style.setProperty("--font-ui", families.ui);
  root.style.setProperty("--font-mono", families.mono);
  root.style.setProperty("--font-editor", families.editor);
  root.style.setProperty("--font-xterm", families.xterm);
}

type FormKind = "project" | "worktree";
type TabKind = "overview" | "agent" | "terminal" | "explorer" | "changes" | "editor" | "diff" | "preview";

type FormDialogProps = {
  title: string;
  submitLabel: string;
  error?: string;
  onCancel: () => void;
  onSubmit: (event: FormEvent<HTMLFormElement>) => void;
  onEscapeKeyDown?: (event: KeyboardEvent) => void;
  children: ReactNode;
};

function FormDialog({ title, submitLabel, error, onCancel, onSubmit, onEscapeKeyDown, children }: FormDialogProps) {
  return (
    <Dialog open onOpenChange={(isOpen) => { if (!isOpen) onCancel(); }}>
      <DialogContent className="max-w-[480px]" onEscapeKeyDown={onEscapeKeyDown}>
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

function setupToastId(runId: string): string {
  return `workspace-setup-${runId}`;
}

function App() {
  const api = useMemo(() => createWorkspaceApi(), []);
  const [snapshot, setSnapshot] = useState<WorkspaceSnapshot>();
  const [snapshotError, setSnapshotError] = useState("");
  const [build, setBuild] = useState<BuildInfo | null>(null);
  const [daemonLifecycle, setDaemonLifecycle] = useState<DaemonLifecycleSnapshot | null>(null);
  const [drainBusy, setDrainBusy] = useState(false);
  const [formError, setFormError] = useState("");
  const [selectedWorkspaceId, setSelectedWorkspaceId] = useState<string>();
  const [selectedAgentId, setSelectedAgentId] = useState<string>();
  const [selectedTerminalId, setSelectedTerminalId] = useState<string>();
  const [activeTab, setActiveTab] = useState<TabKind>("agent");
  const [mobileReturnTo, setMobileReturnTo] = useState<MobileReturn | null>(null);
  const [mobileSessionOpen, setMobileSessionOpen] = useState(false);
  const [openEditorPath, setOpenEditorPath] = useState<string>();
  const [openDiffPath, setOpenDiffPath] = useState<string>();
  const [agents, setAgents] = useState<AgentSummary[]>([]);
  const [agentsLoaded, setAgentsLoaded] = useState(false);
  const [autoAgentPending, setAutoAgentPending] = useState(false);
  // At-a-glance activity per workspace for the sidebar dots, covering ALL
  // workspaces (not just the selected one whose agents are loaded above).
  // Missing entries render as empty/gray. Refreshed on snapshot load,
  // on a poll interval, and immediately from live selected-workspace agents.
  const [workspaceStatuses, setWorkspaceStatuses] = useState<Record<string, AgentStatusKind>>({});
  const [terminals, setTerminals] = useState<TerminalSummary[]>([]);
  const [terminalsLoaded, setTerminalsLoaded] = useState(false);
  const [previews, setPreviews] = useState<WebPreview[]>([]);
  const [selectedPreviewId, setSelectedPreviewId] = useState<string>();
  const [previewHistory, setPreviewHistory] = useState<AgentHistory | null>(null);
  const [agentError, setAgentError] = useState("");
  const [form, setForm] = useState<FormKind>();
  const [dirSuggestOpen, setDirSuggestOpen] = useState(false);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [layout, setLayout] = useState<WorkspaceLayout>();
  const [settings, setSettings] = useState<WorkspaceSettings>(DEFAULT_WORKSPACE_SETTINGS);
  const [themes, setThemes] = useState<ThemePack[]>(BUILTIN_THEMES);
  const [fontOptions, setFontOptions] = useState<FontOption[]>(AVAILABLE_FONTS);
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
  const pendingSetupRuns = useRef(new Map<string, string>());
  const autoAgentAttempted = useRef(new Set<string>());
  const announcedSetupRuns = useRef(new Set<string>());

  const agentsLoadGeneration = useRef(0);
  const terminalsLoadGeneration = useRef(0);

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

  // iOS keyboard inset polyfill: pins the composer above the software
  // keyboard via --kb-inset and corrects --app-height (docs/IOS-PWA-NATIVE.md §4).
  useEffect(() => initKeyboardInset(), []);

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

  const loadLayoutAndSettings = useCallback(async (workspaceId: string) => {
    try {
      const [fetchedLayout, fetchedSettings, fetchedThemes, fetchedFontOptions] = await Promise.all([
        api.getLayout(workspaceId)
          .then((l) => ({ ...l, root: replaceOverviewTabs(l.root) }))
          .catch(() => createDefaultLayout(workspaceId)),
        api.getSettings(workspaceId).catch(() => DEFAULT_WORKSPACE_SETTINGS),
        api.getThemes().catch(() => BUILTIN_THEMES),
        api.getFontOptions().catch(() => AVAILABLE_FONTS),
      ]);
      setLayout(fetchedLayout);
      setSettings(fetchedSettings);
      setThemes(fetchedThemes);
      setFontOptions(fetchedFontOptions);

      const activeTheme = fetchedThemes.find((t) => t.id === fetchedSettings.themeId) ?? fetchedThemes[0];
      applyThemeTokens(activeTheme);
      applyFontTokens(fetchedSettings.fonts, fetchedFontOptions);
    } catch {}
  }, [api]);

  useEffect(() => { void refreshWorkspaces(); }, [refreshWorkspaces]);

  // Daemon build identity for the sidebar footer + deploy verification,
  // plus lifecycle phase/blockers (docs/BACKTOSQUAREONE.md step 5).
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
    setOpenEditorPath(undefined);
    setOpenDiffPath(undefined);
    setActiveTab("agent");
    if (selectedWorkspaceId) {
      void loadAgents(selectedWorkspaceId);
      void loadTerminals(selectedWorkspaceId);
      void loadPreviews(selectedWorkspaceId);
      void loadLayoutAndSettings(selectedWorkspaceId);
    }
  }, [loadAgents, loadTerminals, loadPreviews, loadLayoutAndSettings, selectedWorkspaceId]);

  useEffect(() => {
    if (!selectedWorkspaceId) return;
    const workspaceId = selectedWorkspaceId;
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
      selectedWorkspaceId,
      (event) => {
        if (event.type !== "actions-changed") return;
        const payload = event.payload as { runId?: unknown };
        const runId = typeof payload.runId === "string" ? payload.runId : undefined;
        if (!runId || pendingSetupRuns.current.get(selectedWorkspaceId) !== runId || announcedSetupRuns.current.has(runId)) return;
        void api.getWorkspaceActionRun(selectedWorkspaceId, runId).then(settleSetupRun).catch(() => undefined);
      },
      async () => {
        await Promise.all([
          loadAgents(selectedWorkspaceId, false),
          loadTerminals(selectedWorkspaceId, false),
          loadPreviews(selectedWorkspaceId, false),
        ]);
      }
    );
    return () => sub.close();
  }, [selectedWorkspaceId, loadAgents, loadTerminals, loadPreviews]);

  const workspace = snapshot?.workspaces.find((item) => item.id === selectedWorkspaceId);
  const project = snapshot?.projects.find((item) => item.id === workspace?.projectId);
  const activeProject = project ?? snapshot?.projects.find((item) => !item.archivedAt);
  const selectedTerminal = terminals.find((t) => t.id === selectedTerminalId) ?? terminals[0];
  const isGitWorkspace = workspace?.mainRepositoryRoot != null;

  // Mobile return stack: leaving a working destination for Files, an editor,
  // or another surface records where "Back to …" should return. Explicit
  // jumps (switcher, back button, selecting the agent) clear it.
  const buildMobileReturn = (): MobileReturn | null => {
    if (activeTab === "agent") {
      const target = agents.find((agent) => agent.id === selectedAgentId) ?? agents[0];
      if (!target) return null;
      return { kind: "agent", targetId: target.id, label: target.title };
    }
    if (activeTab === "terminal") {
      const target = terminals.find((t) => t.id === selectedTerminalId) ?? terminals[0];
      if (!target) return null;
      return { kind: "terminal", targetId: target.id, label: target.title };
    }
    if (activeTab === "preview") {
      const target = previews.find((p) => p.id === selectedPreviewId) ?? previews[0];
      if (!target) return null;
      return { kind: "preview", targetId: target.id, label: target.label };
    }
    if (activeTab === "explorer") return { kind: "explorer", label: "Files" };
    if (activeTab === "changes") return { kind: "changes", label: "Changes" };
    if (activeTab === "overview") return { kind: "overview", label: "Overview" };
    return null;
  };

  const captureMobileReturn = () => {
    if (!isMobile) return;
    setMobileReturnTo((current) => current ?? buildMobileReturn());
  };
  // Ref-stable capturer for memoized callbacks (openEditorFile/openDiffFile)
  // whose closures predate the latest render.
  const captureMobileReturnRef = useRef(captureMobileReturn);
  captureMobileReturnRef.current = captureMobileReturn;

  const mobileDest: { kind: MobileDestinationKind; title: string; meta?: string } = (() => {
    if (activeTab === "agent") {
      const current = agents.find((a) => a.id === selectedAgentId) ?? agents[0];
      return current
        ? { kind: "agent", title: current.title, meta: AGENT_STATUS_LABEL[getAgentStatusKind(current)] }
        : { kind: "agent", title: "Agent" };
    }
    if (activeTab === "terminal") {
      const current = terminals.find((t) => t.id === selectedTerminalId) ?? terminals[0];
      return { kind: "terminal", title: current?.title ?? "Terminal" };
    }
    if (activeTab === "preview") {
      const current = previews.find((p) => p.id === selectedPreviewId) ?? previews[0];
      return { kind: "preview", title: current?.label ?? "Preview" };
    }
    if (activeTab === "explorer") return { kind: "explorer", title: "Files" };
    if (activeTab === "changes") return { kind: "changes", title: "Changes" };
    if (activeTab === "overview") return { kind: "overview", title: "Overview" };
    if (activeTab === "editor") {
      return { kind: "editor", title: openEditorPath?.split("/").pop() ?? "Editor" };
    }
    return { kind: "diff", title: openDiffPath ? `Diff: ${openDiffPath.split("/").pop()}` : "Diff" };
  })();

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
      // Shared fields (theme/fonts/prompts/suggestion model/default display
      // options) are stored globally: adopt the server-merged snapshot so
      // local state never diverges from what a restart or another workspace
      // will read back.
      const saved = selectedWorkspaceId
        ? await api.saveSettings(selectedWorkspaceId, nextSettings)
        : nextSettings;
      setSettings(saved);
      const activeTheme = themes.find((t) => t.id === saved.themeId) ?? themes[0];
      applyThemeTokens(activeTheme);
      applyFontTokens(saved.fonts, fontOptions);
    },
    [api, selectedWorkspaceId, themes, fontOptions]
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
        if (selectedWorkspaceId) {
          void api.saveLayout(selectedWorkspaceId, nextLayout).catch(() => {});
        }
        return nextLayout;
      });
    },
    [api, selectedWorkspaceId]
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
      const targetUrl = candidates.find((c) => c.confidence === "high")
        ? `http://localhost:${candidates.find((c) => c.confidence === "high")!.port}`
        : "http://localhost:3000";
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

  // Opening a workspace with no agents starts one right away so a new
  // workspace lands on a live agent session instead of an empty canvas.
  // Attempted once per workspace so closing the last agent does not loop.
  useEffect(() => {
    if (!selectedWorkspaceId || !workspace || workspace.archivedAt) return;
    if (!agentsLoaded || !layout) return;
    if (agents.length > 0 || autoAgentPending) return;
    if (autoAgentAttempted.current.has(selectedWorkspaceId)) return;
    autoAgentAttempted.current.add(selectedWorkspaceId);
    setAutoAgentPending(true);
    setAgentError("");
    void api.createAgent(selectedWorkspaceId)
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
          void api.saveLayout(selectedWorkspaceId, nextLayout).catch(() => {});
          return nextLayout;
        });
      })
      .catch((cause) => {
        setAgentError(cause instanceof Error ? cause.message : "Unable to create agent");
      })
      .finally(() => {
        setAutoAgentPending(false);
      });
  }, [selectedWorkspaceId, workspace, agentsLoaded, layout, agents.length, autoAgentPending, api]);

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
    if (!selectedWorkspaceId) throw new Error("No workspace selected");
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
  }, [api, selectedWorkspaceId, openPaneTab]);

  const closeAgentTab = useCallback(async (tabId: string) => {
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
  }, [api, agents, loadAgents, selectedAgentId, selectedWorkspaceId]);

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
      if (selectedWorkspaceId) void loadTerminals(selectedWorkspaceId, false);
      return;
    }
    if (tabId.startsWith("preview-")) {
      const previewId = tabId.slice("preview-".length);
      setPreviews((current) => current.filter((preview) => preview.id !== previewId));
      setSelectedPreviewId((current) => (current === previewId ? undefined : current));
      void api.deletePreview(previewId).catch(() => {});
    }
  }, [api, closeAgentTab, loadTerminals, selectedWorkspaceId]);

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
    if (layout && selectedWorkspaceId) {
      const nextRoot = removeTabFromTree(layout.root, tabId);
      handleLayoutChange(nextRoot ? { ...layout, root: nextRoot } : createDefaultLayout(selectedWorkspaceId));
    }
    if (tabId.startsWith("editor-")) setOpenEditorPath(undefined);
    if (tabId.startsWith("diff-")) setOpenDiffPath(undefined);
  }, [endTabResource, layout, selectedWorkspaceId, handleLayoutChange]);

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
