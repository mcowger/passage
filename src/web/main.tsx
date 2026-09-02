import { StrictMode, useCallback, useEffect, useMemo, useRef, useState, type FormEvent, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import type { AgentCapabilities, AgentHistory, AgentSummary, TimelineItem, ToolActivity } from "../shared/domain/agents.ts";
import type { JsonValue } from "../shared/protocol/index.ts";
import type { WorkspaceSnapshot, Workspace } from "../shared/domain/workspaces.ts";
import type { TerminalSummary } from "../shared/domain/terminals.ts";
import { createWorkspaceApi } from "./api.ts";
import { subscribeAgent } from "./agentSocket.ts";
import { AgentPanel, Sidebar, WorkspaceOverview } from "./components.tsx";
import { ExplorerPanel } from "./components/ExplorerPanel.tsx";
import { ChangesPanel } from "./components/ChangesPanel.tsx";
import { EditorPanel } from "./components/EditorPanel.tsx";
import { DiffPanel } from "./components/DiffPanel.tsx";
import { TerminalPanel } from "./components/TerminalPanel.tsx";
import { NewWorktreeModal } from "./components/NewWorktreeModal.tsx";
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

  if (type === "message_update") {
    const event = payload.assistantMessageEvent as { type?: string; delta?: string; content?: string } | undefined;
    const usage = payload.usage as { input?: number; output?: number; cacheRead?: number; cacheWrite?: number; totalTokens?: number; cost?: { total?: number } } | undefined;
    const nextUsage = usage ? {
      input: usage.input ?? base.usage.input,
      output: usage.output ?? base.usage.output,
      cacheRead: usage.cacheRead ?? base.usage.cacheRead,
      cacheWrite: usage.cacheWrite ?? base.usage.cacheWrite,
      totalTokens: usage.totalTokens ?? base.usage.totalTokens,
      cost: usage.cost?.total ?? base.usage.cost,
    } : base.usage;

    if (event?.type === "text_delta" && typeof event.delta === "string") {
      const timeline = [...base.timeline];
      let found = false;
      for (let index = timeline.length - 1; index >= 0; index -= 1) {
        const item = timeline[index];
        if (item && item.kind === "assistant") {
          timeline[index] = { ...item, text: item.text + event.delta };
          found = true;
          break;
        }
      }
      if (!found) {
        timeline.push({ kind: "assistant", id: `assistant-${Date.now()}`, text: event.delta });
      }
      return { ...base, timeline, usage: nextUsage };
    }

    if (event?.type === "thinking_delta" && typeof event.delta === "string") {
      const timeline = [...base.timeline];
      let found = false;
      for (let index = timeline.length - 1; index >= 0; index -= 1) {
        const item = timeline[index];
        if (item && item.kind === "thinking") {
          timeline[index] = { ...item, text: item.text + event.delta };
          found = true;
          break;
        }
      }
      if (!found) {
        timeline.push({ kind: "thinking", id: `thinking-${Date.now()}`, text: event.delta });
      }
      return { ...base, timeline, usage: nextUsage };
    }

    if (usage) {
      return { ...base, usage: nextUsage };
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
    return { ...base, timeline };
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
    return { ...base, timeline };
  }

  return prev;
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
    <div className="modal-backdrop" onClick={onCancel}>
      <form className="modal" onSubmit={onSubmit} onClick={(e) => e.stopPropagation()} aria-label={title} role="dialog" aria-modal="true">
        <button type="button" className="icon-button close" onClick={onCancel} aria-label="Close dialog">×</button>
        <p className="eyebrow">Workspace setup</p>
        <h2>{title}</h2>
        {error && <div className="alert form-alert" role="alert">{error}</div>}
        {children}
        <div className="form-actions">
          <button type="button" className="secondary" onClick={onCancel}>Cancel</button>
          <button className="primary">{submitLabel}</button>
        </div>
      </form>
    </div>
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
  const agentLoadGeneration = useRef(0);
  const agentsLoadGeneration = useRef(0);

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
    }
  }, [loadAgents, loadTerminals, selectedWorkspaceId]);

  useEffect(() => {
    if (!selectedAgentId) return;
    void loadAgent(selectedAgentId, true);
    const subscription = subscribeAgent(
      selectedAgentId,
      (value, state) => {
        if (state.status) setAgents((current) => current.map((agent) => agent.id === selectedAgentId ? { ...agent, status: state.status! } : agent));
        const envelope = (value && typeof value === "object" && "type" in value) ? (value as { type?: string }) : undefined;
        const type = envelope?.type;
        if (type === "settled" || type === "agent_settled" || type === "turn_end" || type === "agent_end") {
          void loadAgent(selectedAgentId, false);
        } else {
          setHistory((prev) => applyStreamEvent(prev, value));
        }
      },
      () => loadAgent(selectedAgentId, false),
    );
    return () => subscription.close();
  }, [loadAgent, selectedAgentId]);

  const workspace = snapshot?.workspaces.find((item) => item.id === selectedWorkspaceId);
  const project = snapshot?.projects.find((item) => item.id === workspace?.projectId);
  const activeProject = project ?? snapshot?.projects.find((item) => !item.archivedAt);
  const selectedAgent = agents.find((agent) => agent.id === selectedAgentId);

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
  };

  const handleSelectTerminal = (id: string) => {
    setSelectedTerminalId(id);
    setActiveTab("terminal");
    setDrawerOpen(false);
  };

  const handleSelectWorkspace = (id: string) => {
    setSelectedWorkspaceId(id);
    setSelectedAgentId(undefined);
    setSelectedTerminalId(undefined);
    setActiveTab("overview");
    setDrawerOpen(false);
  };

  const selectedTerminal = terminals.find((t) => t.id === selectedTerminalId) ?? terminals[0];

  return (
    <div className="app">
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
            <nav className="workspace-nav-bar" aria-label="Workspace views">
              <div className="nav-tabs">
                <button
                  className={`nav-tab ${activeTab === "overview" ? "active" : ""}`}
                  onClick={() => setActiveTab("overview")}
                >
                  ℹ Overview
                </button>
                <button
                  className={`nav-tab ${activeTab === "agent" ? "active" : ""}`}
                  onClick={() => {
                    if (!selectedAgentId && agents[0]) setSelectedAgentId(agents[0].id);
                    setActiveTab("agent");
                  }}
                >
                  ◈ Agent {agents.length > 0 && <span className="tab-badge">{agents.length}</span>}
                </button>
                <button
                  className={`nav-tab ${activeTab === "terminal" ? "active" : ""}`}
                  onClick={() => {
                    if (!selectedTerminalId && terminals[0]) setSelectedTerminalId(terminals[0].id);
                    setActiveTab("terminal");
                  }}
                >
                  &gt;_ Terminal {terminals.length > 0 && <span className="tab-badge">{terminals.length}</span>}
                </button>
                <button
                  className={`nav-tab ${activeTab === "explorer" ? "active" : ""}`}
                  onClick={() => setActiveTab("explorer")}
                >
                  📁 Files
                </button>
                <button
                  className={`nav-tab ${activeTab === "changes" ? "active" : ""}`}
                  onClick={() => setActiveTab("changes")}
                >
                  ± Changes
                </button>
                {openEditorPath && (
                  <button
                    className={`nav-tab ${activeTab === "editor" ? "active" : ""}`}
                    onClick={() => setActiveTab("editor")}
                  >
                    📄 {openEditorPath.split("/").pop()}
                    <span
                      className="tab-close"
                      title="Close editor tab"
                      onClick={(e) => {
                        e.stopPropagation();
                        setOpenEditorPath(undefined);
                        if (activeTab === "editor") setActiveTab("explorer");
                      }}
                    >
                      ×
                    </span>
                  </button>
                )}
                {openDiffPath !== undefined && (
                  <button
                    className={`nav-tab ${activeTab === "diff" ? "active" : ""}`}
                    onClick={() => setActiveTab("diff")}
                  >
                    🔍 Diff {openDiffPath ? `(${openDiffPath.split("/").pop()})` : ""}
                    <span
                      className="tab-close"
                      title="Close diff tab"
                      onClick={(e) => {
                        e.stopPropagation();
                        setOpenDiffPath(undefined);
                        if (activeTab === "diff") setActiveTab("changes");
                      }}
                    >
                      ×
                    </span>
                  </button>
                )}
              </div>
            </nav>

            <div className="workspace-view">
              {activeTab === "overview" && (
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
                  }}
                  onOpenTerminal={() => {
                    if (!selectedTerminalId && terminals[0]) setSelectedTerminalId(terminals[0].id);
                    setActiveTab("terminal");
                  }}
                  onOpenExplorer={() => setActiveTab("explorer")}
                  onOpenChanges={() => setActiveTab("changes")}
                  onOpenDiff={() => {
                    setOpenDiffPath("");
                    setActiveTab("diff");
                  }}
                />
              )}

              {activeTab === "terminal" && (
                selectedTerminal ? (
                  <TerminalPanel
                    key={selectedTerminal.id}
                    terminal={selectedTerminal}
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
                    <p>Launch an interactive PTY shell in this workspace.</p>
                    <button className="primary" onClick={() => void createTerminal()}>Launch terminal</button>
                  </div>
                )
              )}

              {activeTab === "agent" && (
                selectedAgent ? (
                  <AgentPanel
                    key={selectedAgent.id}
                    agent={selectedAgent}
                    history={history}
                    capabilities={capabilities}
                    loading={agentLoading}
                    error={agentError}
                    api={api}
                    onRefresh={() => loadAgent(selectedAgent.id)}
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
                    <h1>No agent active</h1>
                    <p>Create a new agent to start an autonomous coding conversation.</p>
                    <button className="primary" onClick={() => void createAgent()}>New agent</button>
                  </div>
                )
              )}

              {activeTab === "explorer" && (
                <ExplorerPanel
                  workspaceId={workspace.id}
                  api={api}
                  selectedFile={openEditorPath}
                  onOpenFile={(path) => {
                    setOpenEditorPath(path);
                    setActiveTab("editor");
                  }}
                />
              )}

              {activeTab === "changes" && (
                <ChangesPanel
                  workspaceId={workspace.id}
                  api={api}
                  onOpenFile={(path) => {
                    setOpenEditorPath(path);
                    setActiveTab("editor");
                  }}
                  onOpenDiff={(path) => {
                    setOpenDiffPath(path);
                    setActiveTab("diff");
                  }}
                />
              )}

              {activeTab === "editor" && (
                openEditorPath ? (
                  <EditorPanel
                    workspaceId={workspace.id}
                    filePath={openEditorPath}
                    api={api}
                    onClose={() => {
                      setOpenEditorPath(undefined);
                      setActiveTab("explorer");
                    }}
                    onOpenDiff={(path) => {
                      setOpenDiffPath(path);
                      setActiveTab("diff");
                    }}
                  />
                ) : (
                  <div className="empty">
                    <span className="empty-icon" aria-hidden="true">📄</span>
                    <h1>No file opened</h1>
                    <p>Select a file from the Explorer or Changes panel to view and edit.</p>
                    <button className="primary" onClick={() => setActiveTab("explorer")}>Open Explorer</button>
                  </div>
                )
              )}

              {activeTab === "diff" && (
                <DiffPanel
                  workspaceId={workspace.id}
                  initialPath={openDiffPath}
                  api={api}
                  onOpenFile={(path) => {
                    setOpenEditorPath(path);
                    setActiveTab("editor");
                  }}
                  onClose={() => {
                    setOpenDiffPath(undefined);
                    setActiveTab("changes");
                  }}
                />
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
