import { StrictMode, useCallback, useEffect, useMemo, useRef, useState, type FormEvent, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import type { AgentCapabilities, AgentHistory, AgentSummary, TimelineItem, ToolActivity } from "../shared/domain/agents.ts";
import type { JsonValue } from "../shared/protocol/index.ts";
import type { WorkspaceSnapshot } from "../shared/domain/workspaces.ts";
import { createWorkspaceApi } from "./api.ts";
import { subscribeAgent } from "./agentSocket.ts";
import { AgentPanel, Sidebar, WorkspaceOverview } from "./components.tsx";
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
        timeline.push({ kind: "assistant", id: `live-assistant-${Date.now()}`, text: event.delta });
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
        timeline.push({ kind: "thinking", id: `live-thinking-${Date.now()}`, text: event.delta });
      }
      return { ...base, timeline, usage: nextUsage };
    }

    if (usage) {
      return { ...base, usage: nextUsage };
    }
  }

  if (type === "message_start") {
    const msg = payload.message as { role?: string; content?: Array<{ type?: string; text?: string }> } | undefined;
    if (msg?.role === "assistant") {
      const text = msg.content?.find((c) => c.type === "text")?.text ?? "";
      const timeline = [...base.timeline];
      const last = timeline.at(-1);
      if (!last || last.kind !== "assistant" || !last.id.startsWith("live-assistant")) {
        timeline.push({ kind: "assistant", id: `live-assistant-${Date.now()}`, text });
        return { ...base, timeline };
      }
    }
  }

  if (type === "tool_execution_start") {
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
          ...(isError ? { error: result ?? "Tool failed" } : {}),
        };
      }
      return item;
    });
    return { ...base, timeline };
  }

  return base;
}

type FormKind = "project" | "workspace";

type FormDialogProps = {
  title: string;
  submitLabel: string;
  children: ReactNode;
  error?: string;
  onSubmit: (event: FormEvent<HTMLFormElement>) => void;
  onCancel: () => void;
};

function FormDialog({ title, submitLabel, children, error, onSubmit, onCancel }: FormDialogProps) {
  return (
    <div className="modal-backdrop" role="presentation">
      <form className="modal" onSubmit={onSubmit} aria-label={title} role="dialog" aria-modal="true">
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
  const [agents, setAgents] = useState<AgentSummary[]>([]);
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

  const loadAgent = useCallback(async (agentId: string, isInitial = false) => {
    const generation = ++agentLoadGeneration.current;
    if (isInitial) setAgentLoading(true);
    try {
      const [summary, result] = await Promise.all([api.agent(agentId), api.history(agentId)]);
      if (generation !== agentLoadGeneration.current) return;
      setAgentError("");
      setAgents((current) => current.map((agent) => agent.id === summary.id ? summary : agent));
      setHistory("unpersisted" in result ? undefined : result.history);
      if (summary.live) {
        try {
          const capabilities = await api.capabilities(agentId);
          if (generation === agentLoadGeneration.current) setCapabilities(capabilities);
        } catch {
          if (generation === agentLoadGeneration.current) setCapabilities(undefined);
        }
      } else {
        setCapabilities(undefined);
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
    setSelectedAgentId(undefined);
    setHistory(undefined);
    setCapabilities(undefined);
    if (selectedWorkspaceId) void loadAgents(selectedWorkspaceId);
  }, [loadAgents, selectedWorkspaceId]);
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
    } catch (cause) {
      setAgentError(cause instanceof Error ? cause.message : "Unable to create agent");
    }
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
    } catch (cause) {
      setAgentError(cause instanceof Error ? cause.message : "Unable to archive agent");
    }
  };

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
          open={drawerOpen}
          onClose={() => setDrawerOpen(false)}
          onSelect={(id) => { setSelectedWorkspaceId(id); setSelectedAgentId(undefined); setDrawerOpen(false); }}
          onNewProject={() => { setFormError(""); setForm("project"); }}
          onNewWorkspace={() => { setFormError(""); setForm(snapshot.projects.some((item) => !item.archivedAt) ? "workspace" : "project"); }}
          agents={agents}
          onSelectAgent={(id) => { setSelectedAgentId(id); setDrawerOpen(false); }}
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
        {selectedAgent ? (
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
          <WorkspaceOverview
            workspace={workspace}
            project={project}
            api={api}
            refresh={async () => { await refreshWorkspaces(); }}
            onCreateAgent={createAgent}
          />
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
          title={`New workspace in ${activeProject.displayLabel}`}
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
    </div>
  );
}

const root = document.getElementById("root");
if (!root) throw new Error("Passage root element is missing");
createRoot(root).render(<StrictMode><App /></StrictMode>);
