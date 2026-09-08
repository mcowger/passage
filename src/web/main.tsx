import { StrictMode, useCallback, useEffect, useMemo, useRef, useState, type FormEvent, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import type { AgentCapabilities, AgentHistory, AgentSummary, TimelineItem, ToolActivity } from "../shared/domain/agents.ts";
import type { JsonValue } from "../shared/protocol/index.ts";
import type { WorkspaceSnapshot, Workspace } from "../shared/domain/workspaces.ts";
import type { TerminalSummary } from "../shared/domain/terminals.ts";
import type { LayoutNode, PaneTab, WorkspaceLayout } from "../shared/domain/layout.ts";
import { addTabToGroup, createDefaultLayout, getFirstTabGroup } from "../shared/domain/layout.ts";
import type { WorkspaceSettings } from "../shared/domain/settings.ts";
import { DEFAULT_WORKSPACE_SETTINGS } from "../shared/domain/settings.ts";
import type { ThemePack, FontPack } from "../shared/domain/customization.ts";
import { BUILTIN_THEMES, BUILTIN_FONTS } from "../shared/domain/customization.ts";
import { createWorkspaceApi } from "./api.ts";
import { subscribeAgent } from "./agentSocket.ts";
import { AgentPanel, Sidebar, WorkspaceOverview } from "./components.tsx";
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
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "./components/ui/dialog.tsx";
import "./styles.css";

function applyStreamEvent(prev: AgentHistory | undefined, envelope: unknown): AgentHistory | undefined {
  if (!envelope || typeof envelope !== "object") return prev;
  const { type, payload } = envelope as { type?: string; payload?: Record<string, unknown> };
  if (!type || !payload) return prev;

  const base: AgentHistory = prev ? { ...prev, timeline: [...prev.timeline] } : {
    sessionId: "",
    revision: { mtimeMs: Date.now(), size: 0, contentHash: "" },
    timeline: [],
    branches: [],
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: 0 },
    unknownRecordCount: 0,
    agentErrorCount: 0,
    malformedRecordCount: 0,
    partialTail: false,
    invalidUtf8Count: 0,
    rewritten: false,
  };

  const usage = payload.usage as { input?: number; output?: number; cacheRead?: number; cacheWrite?: number; totalTokens?: number; cost?: { total?: number } } | undefined;
  const nextUsage = usage ? {
    input: usage.input ?? base.usage.input,
    output: usage.output ?? base.usage.output,
    cacheRead: usage.cacheRead ?? base.usage.cacheRead,
    cacheWrite: usage.cacheWrite ?? base.usage.cacheWrite,
    totalTokens: usage.totalTokens ?? base.usage.totalTokens,
    cost: usage.cost?.total ?? base.usage.cost,
  } : base.usage;

  const event = payload.assistantMessageEvent as { type?: string; delta?: string; content?: string } | undefined;
  const delta = (event?.type === "text_delta" && typeof event.delta === "string" ? event.delta : undefined)
    ?? (typeof payload.delta === "string" ? payload.delta : undefined)
    ?? (typeof payload.text === "string" ? payload.text : undefined);

  if (delta) {
    const timeline = [...base.timeline];
    let found = false;
    for (let index = timeline.length - 1; index >= 0; index -= 1) {
      const item = timeline[index];
      if (item && item.kind === "assistant") {
        timeline[index] = { ...item, text: item.text + delta };
        found = true;
        break;
      }
    }
    if (!found) {
      timeline.push({ kind: "assistant", id: `assistant-${Date.now()}`, text: delta });
    }
    return { ...base, timeline, usage: nextUsage };
  }

  const thinkingDelta = (event?.type === "thinking_delta" && typeof event.delta === "string" ? event.delta : undefined)
    ?? (typeof payload.thinking === "string" ? payload.thinking : undefined);

  if (thinkingDelta) {
    const timeline = [...base.timeline];
    let found = false;
    for (let index = timeline.length - 1; index >= 0; index -= 1) {
      const item = timeline[index];
      if (item && item.kind === "thinking") {
        timeline[index] = { ...item, text: item.text + thinkingDelta };
        found = true;
        break;
      }
    }
    if (!found) {
      timeline.push({ kind: "thinking", id: `thinking-${Date.now()}`, text: thinkingDelta });
    }
    return { ...base, timeline, usage: nextUsage };
  }

  // Full assistant message update
  const messageObj = payload.message as { role?: string; content?: string | Array<{ type?: string; text?: string }> } | undefined;
  if (messageObj && (messageObj.role === "assistant" || !messageObj.role)) {
    const fullText = typeof messageObj.content === "string"
      ? messageObj.content
      : Array.isArray(messageObj.content)
        ? messageObj.content.map((c) => (c && typeof c === "object" && "text" in c ? String(c.text) : "")).join("")
        : "";
    if (fullText) {
      const timeline = [...base.timeline];
      let found = false;
      for (let index = timeline.length - 1; index >= 0; index -= 1) {
        const item = timeline[index];
        if (item && item.kind === "assistant") {
          timeline[index] = { ...item, text: fullText };
          found = true;
          break;
        }
      }
      if (!found) {
        timeline.push({ kind: "assistant", id: `assistant-${Date.now()}`, text: fullText });
      }
      return { ...base, timeline, usage: nextUsage };
    }
  }

  if (type === "tool_call" || type === "tool_start" || type === "tool_execution_start") {
    const toolCallId = String(payload.toolCallId ?? `tool-${Date.now()}`);
    const toolName = String(payload.toolName ?? "tool");
    const args = (payload.args ?? {}) as JsonValue;
    const timeline = [...base.timeline];
    const existingIndex = timeline.findIndex((item) => item.kind === "tool" && item.id === toolCallId);
    if (existingIndex >= 0) {
      timeline[existingIndex] = { ...timeline[existingIndex] as ToolActivity, status: "running" };
    } else {
      timeline.push({
        kind: "tool",
        id: toolCallId,
        name: toolName,
        input: args,
        status: "running",
        significant: true,
      });
    }
    return { ...base, timeline, usage: nextUsage };
  }

  if (type === "tool_execution_end") {
    const toolCallId = String(payload.toolCallId ?? "");
    const result = payload.result !== undefined ? String(payload.result) : undefined;
    const isError = Boolean(payload.isError);
    const timeline = base.timeline.map((item) => {
      if (item.kind === "tool" && (item.id === toolCallId || (!toolCallId && item.status === "running"))) {
        return {
          ...item,
          status: (isError ? "error" : "complete") as "error" | "complete",
          ...(result !== undefined ? { result } : {}),
        };
      }
      return item;
    });
    return { ...base, timeline, usage: nextUsage };
  }

  if (usage) {
    return { ...base, usage: nextUsage };
  }

  return prev;
}

function applyThemeTokens(theme?: ThemePack) {
  if (!theme || typeof document === "undefined") return;
  const root = document.documentElement;
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

type FormKind = "project" | "workspace" | "worktree";
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
          {error && <div className="text-sm text-destructive font-medium" role="alert">{error}</div>}
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

function App() {
  const api = useMemo(() => createWorkspaceApi(), []);
  const [snapshot, setSnapshot] = useState<WorkspaceSnapshot>();
  const [snapshotError, setSnapshotError] = useState("");
  const [formError, setFormError] = useState("");
  const [selectedWorkspaceId, setSelectedWorkspaceId] = useState<string>();
  const [selectedAgentId, setSelectedAgentId] = useState<string>();
  const [selectedTerminalId, setSelectedTerminalId] = useState<string>();
  const [activeTab, setActiveTab] = useState<TabKind>("overview");
  const [openEditorPath, setOpenEditorPath] = useState<string>();
  const [openDiffPath, setOpenDiffPath] = useState<string>();
  const [agents, setAgents] = useState<AgentSummary[]>([]);
  const [terminals, setTerminals] = useState<TerminalSummary[]>([]);
  const [history, setHistory] = useState<AgentHistory>();
  const [capabilities, setCapabilities] = useState<AgentCapabilities>();
  const [agentError, setAgentError] = useState("");
  const [agentLoading, setAgentLoading] = useState(false);
  const [form, setForm] = useState<FormKind>();
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [layout, setLayout] = useState<WorkspaceLayout>();
  const [settings, setSettings] = useState<WorkspaceSettings>(DEFAULT_WORKSPACE_SETTINGS);
  const [themes, setThemes] = useState<ThemePack[]>(BUILTIN_THEMES);
  const [fonts, setFonts] = useState<FontPack[]>(BUILTIN_FONTS);
  const [commandPaletteOpen, setCommandPaletteOpen] = useState(false);
  const [settingsModalOpen, setSettingsModalOpen] = useState(false);
  const [isOffline, setIsOffline] = useState(typeof navigator !== "undefined" ? !navigator.onLine : false);
  const [isMobile, setIsMobile] = useState(typeof window !== "undefined" ? window.innerWidth < 768 : false);

  const agentsRef = useRef(agents);
  agentsRef.current = agents;
  const settingsRef = useRef(settings);
  settingsRef.current = settings;

  const agentLoadGeneration = useRef(0);
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
        if (current && next.workspaces.some((workspace) => workspace.id === current)) return current;
        return next.workspaces.find((workspace) => !workspace.archivedAt)?.id ?? next.workspaces[0]?.id;
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
        api.getLayout(workspaceId).catch(() => createDefaultLayout(workspaceId)),
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

  const loadAgent = useCallback(async (agentId: string, isInitial = false) => {
    const generation = ++agentLoadGeneration.current;
    if (isInitial) setAgentLoading(true);
    try {
      const [summary, result] = await Promise.all([api.agent(agentId), api.history(agentId)]);
      if (generation !== agentLoadGeneration.current) return;
      setAgentError("");
      setAgents((current) => current.map((agent) => agent.id === summary.id ? summary : agent));
      setHistory("unpersisted" in result ? undefined : result.history);
      try {
        const capabilities = await api.capabilities(agentId);
        if (generation === agentLoadGeneration.current) setCapabilities(capabilities);
      } catch {
        if (generation === agentLoadGeneration.current) setCapabilities(undefined);
      }
    } catch (cause) {
      if (generation !== agentLoadGeneration.current) return;
      setAgentError(cause instanceof Error ? cause.message : "Unable to load agent");
    } finally {
      if (generation === agentLoadGeneration.current) setAgentLoading(false);
    }
  }, [api]);

  useEffect(() => { void refreshWorkspaces(); }, [refreshWorkspaces]);

  useEffect(() => {
    agentsLoadGeneration.current += 1;
    agentLoadGeneration.current += 1;
    setAgents([]);
    setTerminals([]);
    setSelectedAgentId(undefined);
    setSelectedTerminalId(undefined);
    setHistory(undefined);
    setCapabilities(undefined);
    setOpenEditorPath(undefined);
    setOpenDiffPath(undefined);
    setActiveTab("overview");
    if (selectedWorkspaceId) {
      void loadAgents(selectedWorkspaceId);
      void loadTerminals(selectedWorkspaceId);
      void loadLayoutAndSettings(selectedWorkspaceId);
    }
  }, [loadAgents, loadTerminals, loadLayoutAndSettings, selectedWorkspaceId]);

  useEffect(() => {
    if (!selectedAgentId) return;
    void loadAgent(selectedAgentId, true);
    const subscription = subscribeAgent(
      selectedAgentId,
      (value, state) => {
        if (state.status) {
          setAgents((current) =>
            current.map((agent) => (agent.id === selectedAgentId ? { ...agent, status: state.status! } : agent))
          );
        }
        const envelope = (value && typeof value === "object" && "type" in value) ? (value as { type?: string }) : undefined;
        const type = envelope?.type;
        if (type === "settled" || type === "agent_settled" || type === "turn_end" || type === "agent_end" || type === "message_end") {
          void loadAgent(selectedAgentId, false);
          if (settingsRef.current.notificationsEnabled) {
            const agentObj = agentsRef.current.find((a) => a.id === selectedAgentId);
            showAgentNotification(
              `Agent: ${agentObj?.title ?? "Activity finished"}`,
              "Agent completed turn and is waiting for input."
            );
          }
        }
        setHistory((prev) => applyStreamEvent(prev, value));
      },
      () => loadAgent(selectedAgentId, false),
    );
    return () => subscription.close();
  }, [loadAgent, selectedAgentId]);

  const workspace = snapshot?.workspaces.find((item) => item.id === selectedWorkspaceId);
  const project = snapshot?.projects.find((item) => item.id === workspace?.projectId);
  const activeProject = project ?? snapshot?.projects.find((item) => !item.archivedAt);
  const selectedAgent = agents.find((agent) => agent.id === selectedAgentId);
  const selectedTerminal = terminals.find((t) => t.id === selectedTerminalId) ?? terminals[0];

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
      if (!layout) return;
      const firstGroup = getFirstTabGroup(layout.root);
      if (!firstGroup) return;
      const nextRoot = addTabToGroup(layout.root, firstGroup.id, tab);
      handleLayoutChange({ ...layout, root: nextRoot });
    },
    [layout, handleLayoutChange]
  );

  const runWorkspaceMutation = async (action: () => Promise<unknown>) => {
    try {
      setFormError("");
      await action();
      if (await refreshWorkspaces()) setForm(undefined);
      else setFormError("Saved, but Passage could not refresh the workspace list. Retry the refresh above.");
    } catch (cause) {
      setFormError(cause instanceof Error ? cause.message : "Request failed");
    }
  };

  const createAgent = async () => {
    if (!workspace) return;
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

  const archiveSelectedAgent = async () => {
    if (!selectedAgentId || !selectedWorkspaceId) return;
    try {
      setAgentError("");
      await api.archiveAgent(selectedAgentId);
      setSelectedAgentId(undefined);
      setHistory(undefined);
      setCapabilities(undefined);
      await loadAgents(selectedWorkspaceId, false);
      setActiveTab("overview");
    } catch (cause) {
      setAgentError(cause instanceof Error ? cause.message : "Unable to archive agent");
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

  const handleSelectWorkspace = (id: string) => {
    setSelectedWorkspaceId(id);
    setSelectedAgentId(undefined);
    setSelectedTerminalId(undefined);
    setActiveTab("overview");
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
        return (
          <WorkspaceOverview
            workspace={workspace}
            project={project}
            api={api}
            refresh={async () => { await refreshWorkspaces(); }}
            onCreateAgent={createAgent}
            onCreateTerminal={createTerminal}
            onOpenAgent={() => {
              if (!selectedAgentId && agents[0]) setSelectedAgentId(agents[0].id);
              setActiveTab("agent");
              if (agents[0]) handleSelectAgent(agents[0].id);
            }}
            onOpenTerminal={() => {
              if (!selectedTerminalId && terminals[0]) setSelectedTerminalId(terminals[0].id);
              setActiveTab("terminal");
              if (terminals[0]) handleSelectTerminal(terminals[0].id);
            }}
            onOpenExplorer={() => {
              setActiveTab("explorer");
              openPaneTab({ id: `explorer-${workspace.id}`, kind: "explorer", title: "Files" });
            }}
            onOpenChanges={() => {
              setActiveTab("changes");
              openPaneTab({ id: `changes-${workspace.id}`, kind: "changes", title: "Changes" });
            }}
            onOpenDiff={() => {
              setOpenDiffPath("");
              setActiveTab("diff");
              openPaneTab({ id: `diff-${workspace.id}`, kind: "diff", title: "Diff" });
            }}
          />
        );

      case "agent": {
        const agentId = tab.targetId ?? selectedAgentId;
        const currentAgent = agents.find((a) => a.id === agentId) ?? selectedAgent;
        return currentAgent ? (
          <AgentPanel
            key={currentAgent.id}
            agent={currentAgent}
            history={history}
            capabilities={capabilities}
            loading={agentLoading}
            error={agentError}
            api={api}
            onRefresh={() => loadAgent(currentAgent.id)}
            onArchive={archiveSelectedAgent}
            onOptimisticMessage={(message) => {
              setHistory((prev) => {
                const base: AgentHistory = prev ? { ...prev, timeline: [...prev.timeline] } : {
                  sessionId: "",
                  revision: { mtimeMs: Date.now(), size: 0, contentHash: "" },
                  timeline: [],
                  branches: [],
                  usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: 0 },
                  unknownRecordCount: 0,
                  agentErrorCount: 0,
                  malformedRecordCount: 0,
                  partialTail: false,
                  invalidUtf8Count: 0,
                  rewritten: false,
                };
                return {
                  ...base,
                  timeline: [...base.timeline, { kind: "user", id: `user-${Date.now()}`, text: message }],
                };
              });
            }}
          />
        ) : (
          <div className="empty">
            <span className="empty-icon" aria-hidden="true">◈</span>
            <h1>No agent selected</h1>
            <button className="primary" onClick={() => void createAgent()}>New agent</button>
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
            onOpenFile={(path) => {
              setOpenEditorPath(path);
              setActiveTab("editor");
              openPaneTab({
                id: `editor-${path}`,
                kind: "editor",
                title: path.split("/").pop() ?? path,
                targetId: path,
              });
            }}
          />
        );

      case "changes":
        return (
          <ChangesPanel
            workspaceId={workspace.id}
            api={api}
            onOpenFile={(path) => {
              setOpenEditorPath(path);
              setActiveTab("editor");
              openPaneTab({
                id: `editor-${path}`,
                kind: "editor",
                title: path.split("/").pop() ?? path,
                targetId: path,
              });
            }}
            onOpenDiff={(path) => {
              setOpenDiffPath(path);
              setActiveTab("diff");
              openPaneTab({
                id: `diff-${path}`,
                kind: "diff",
                title: `Diff: ${path.split("/").pop() ?? path}`,
                targetId: path,
              });
            }}
          />
        );

      case "editor": {
        const filePath = tab.targetId ?? openEditorPath;
        return filePath ? (
          <EditorPanel
            workspaceId={workspace.id}
            filePath={filePath}
            api={api}
            onClose={() => {
              setOpenEditorPath(undefined);
              setActiveTab("explorer");
            }}
            onOpenDiff={(path) => {
              setOpenDiffPath(path);
              setActiveTab("diff");
              openPaneTab({
                id: `diff-${path}`,
                kind: "diff",
                title: `Diff: ${path.split("/").pop() ?? path}`,
                targetId: path,
              });
            }}
          />
        ) : (
          <div className="empty">
            <span className="empty-icon" aria-hidden="true">📄</span>
            <h1>No file selected</h1>
          </div>
        );
      }

      case "diff": {
        const diffPath = tab.targetId ?? openDiffPath;
        return (
          <DiffPanel
            workspaceId={workspace.id}
            initialPath={diffPath}
            api={api}
            onOpenFile={(path) => {
              setOpenEditorPath(path);
              setActiveTab("editor");
              openPaneTab({
                id: `editor-${path}`,
                kind: "editor",
                title: path.split("/").pop() ?? path,
                targetId: path,
              });
            }}
            onClose={() => {
              setOpenDiffPath(undefined);
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
          onNewWorkspace={() => { setFormError(""); setForm("workspace"); }}
          onNewWorktree={() => { setFormError(""); setForm("worktree"); }}
          agents={agents}
          onSelectAgent={handleSelectAgent}
          terminals={terminals}
          onSelectTerminal={handleSelectTerminal}
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
              <div className="workspace-nav-brand">
                <span className="workspace-crumb-title"><b>{project?.displayLabel}</b> {workspace.branchRef && <code className="branch-pill">⎇ {workspace.branchRef}</code>}</span>
              </div>
              <div className="nav-tabs">
                <button
                  className={`nav-tab ${activeTab === "overview" ? "active" : ""}`}
                  onClick={() => {
                    setActiveTab("overview");
                    openPaneTab({ id: `overview-${workspace.id}`, kind: "overview", title: "Overview" });
                  }}
                >
                  ℹ Overview
                </button>
                <button
                  className={`nav-tab ${activeTab === "agent" ? "active" : ""}`}
                  onClick={() => {
                    if (!selectedAgentId && agents[0]) setSelectedAgentId(agents[0].id);
                    setActiveTab("agent");
                    if (agents[0]) handleSelectAgent(agents[0].id);
                  }}
                >
                  ◈ Agent {agents.length > 0 && <span className="tab-badge">{agents.length}</span>}
                </button>
                <button
                  className={`nav-tab ${activeTab === "terminal" ? "active" : ""}`}
                  onClick={() => {
                    if (!selectedTerminalId && terminals[0]) setSelectedTerminalId(terminals[0].id);
                    setActiveTab("terminal");
                    if (terminals[0]) handleSelectTerminal(terminals[0].id);
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
                <button
                  className={`nav-tab ${activeTab === "changes" ? "active" : ""}`}
                  onClick={() => {
                    setActiveTab("changes");
                    openPaneTab({ id: `changes-${workspace.id}`, kind: "changes", title: "Changes" });
                  }}
                >
                  ± Changes
                </button>
              </div>

              <div className="workspace-nav-actions">
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
                  onCloseTab={(tabId) => {
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
        agents={agents}
        terminals={terminals}
        onSelectWorkspace={handleSelectWorkspace}
        onSelectAgent={handleSelectAgent}
        onSelectTerminal={handleSelectTerminal}
        onOpenView={(view) => {
          setActiveTab(view);
          if (workspace) openPaneTab({ id: `${view}-${workspace.id}`, kind: view, title: view });
        }}
        onCreateAgent={() => void createAgent()}
        onCreateTerminal={() => void createTerminal()}
        onResetLayout={() => {
          if (workspace) handleLayoutChange(createDefaultLayout(workspace.id));
        }}
        onOpenSettings={() => setSettingsModalOpen(true)}
      />

      {/* Settings Modal */}
      <SettingsModal
        open={settingsModalOpen}
        onClose={() => setSettingsModalOpen(false)}
        settings={settings}
        onSaveSettings={handleSaveSettings}
        themes={themes}
        fonts={fonts}
      />

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
            void runWorkspaceMutation(() => api.registerProject({
              configuredRootPath: String(data.get("path")).trim(),
              displayLabel: String(data.get("label")).trim(),
            }));
          }}
        >
          <label>Project name<input name="label" required placeholder="Payments platform" /></label>
          <label>Directory path<input name="path" required placeholder="/home/user/code/payments" /></label>
          <p className="form-help">The daemon resolves and verifies this directory before registering it.</p>
        </FormDialog>
      )}

      {form === "workspace" && activeProject && (
        <FormDialog
          title={`New directory workspace in ${activeProject.displayLabel}`}
          submitLabel="Create workspace"
          error={formError}
          onCancel={() => { setFormError(""); setForm(undefined); }}
          onSubmit={(event) => {
            event.preventDefault();
            const data = new FormData(event.currentTarget);
            const cwd = String(data.get("cwd")).trim();
            void runWorkspaceMutation(() => api.createDirectoryWorkspace(activeProject.id, {
              displayLabel: String(data.get("label")).trim(),
              ...(cwd ? { cwd } : {}),
            }));
          }}
        >
          <label>Workspace label<input name="label" required placeholder="Invoice retries" /></label>
          <label>Subdirectory (optional)<input name="cwd" placeholder="services/importer" /></label>
          <p className="form-help">Paths are resolved by the daemon inside the registered project root.</p>
        </FormDialog>
      )}

      {form === "worktree" && snapshot && (
        <NewWorktreeModal
          projects={snapshot.projects}
          locations={snapshot.locations}
          defaultProjectId={activeProject?.id}
          api={api}
          onClose={() => setForm(undefined)}
          onCreated={(created) => {
            void refreshWorkspaces().then(() => {
              setSelectedWorkspaceId(created.id);
              setActiveTab("overview");
            });
          }}
        />
      )}
    </div>
  );
}

const root = document.getElementById("root");
if (!root) throw new Error("Passage root element is missing");
createRoot(root).render(<StrictMode><App /></StrictMode>);
