import { useEffect, useRef, useState } from "react";
import type { Project, Workspace, WorkspaceSnapshot } from "../shared/domain/workspaces.ts";
import type { AgentCapabilities, AgentHistory, AgentSummary, TimelineItem } from "../shared/domain/agents.ts";
import { MAX_AGENT_IMAGES, MAX_AGENT_IMAGE_DATA_BYTES, type AgentImage } from "../shared/protocol/agents.ts";
import type { WorkspaceApi } from "./api.ts";

type SidebarProps = {
  data: WorkspaceSnapshot;
  selected?: string;
  selectedAgent?: string;
  open: boolean;
  onClose: () => void;
  onSelect: (id: string) => void;
  onNewProject: () => void;
  onNewWorkspace: () => void;
  agents: AgentSummary[];
  onSelectAgent: (id: string) => void;
};

export function Sidebar({ data, selected, selectedAgent, open, onClose, onSelect, onNewProject, onNewWorkspace, agents, onSelectAgent }: SidebarProps) {
  const activeProjects = data.projects.filter((project) => !project.archivedAt);
  return (
    <aside className={`sidebar ${open ? "drawer-open" : ""}`} aria-label="Projects and workspaces">
      <div className="brand">
        <span className="mark" aria-hidden="true">P</span>
        <strong>Passage</strong>
        <button className="icon-button mobile-only" onClick={onClose} aria-label="Close navigation">×</button>
      </div>
      <button className="primary full" onClick={onNewWorkspace}>＋ New workspace</button>
      <button className="secondary full" onClick={onNewProject}>Register project</button>
      <div className="side-label">Projects</div>
      <div className="project-list">
        {activeProjects.map((project) => (
          <ProjectRow
            key={project.id}
            project={project}
            workspaces={data.workspaces}
            selected={selected}
            selectedAgent={selectedAgent}
            onSelect={onSelect}
            agents={selected ? agents : []}
            onSelectAgent={onSelectAgent}
          />
        ))}
      </div>
      {activeProjects.length === 0 && <p className="muted side-empty">No active projects registered yet.</p>}
      <footer><span className="connected-dot" aria-hidden="true">●</span> Connected <span>·</span> Local daemon</footer>
    </aside>
  );
}

function ProjectRow({ project, workspaces, selected, selectedAgent, onSelect, agents, onSelectAgent }: {
  project: Project;
  workspaces: Workspace[];
  selected?: string;
  selectedAgent?: string;
  onSelect: (id: string) => void;
  agents: AgentSummary[];
  onSelectAgent: (id: string) => void;
}) {
  const rows = workspaces.filter((workspace) => workspace.projectId === project.id);
  return (
    <section className="project">
      <div className="project-title">
        <span aria-hidden="true">▾</span>
        <strong>{project.displayLabel}</strong>
        <code title={project.canonicalRootPath}>{project.canonicalRootPath}</code>
      </div>
      {rows.map((workspace) => (
        <div className="workspace-group" key={workspace.id}>
          <button
            className={`workspace-row ${workspace.id === selected && !selectedAgent ? "selected" : ""}`}
            onClick={() => onSelect(workspace.id)}
          >
            <span className="status-dot" aria-label={workspace.archivedAt ? "Archived" : "Ready"}>●</span>
            <span className="workspace-copy">
              <b>{workspace.displayLabel}</b>
              <small>{workspace.kind} · {workspace.branchRef ?? "directory workspace"}</small>
              <small title={workspace.cwd}>{workspace.cwd}</small>
            </span>
          </button>
          {workspace.id === selected && agents.filter((agent) => agent.workspaceId === workspace.id).map((agent) => (
            <button
              className={`agent-row ${agent.id === selectedAgent ? "selected" : ""}`}
              key={agent.id}
              onClick={() => onSelectAgent(agent.id)}
            >
              <span aria-hidden="true">◈</span>
              <span>{agent.title}</span>
              <small>{agent.status}</small>
            </button>
          ))}
        </div>
      ))}
      {rows.length === 0 && <p className="muted project-empty">No workspaces</p>}
    </section>
  );
}

type WorkspaceOverviewProps = {
  workspace?: Workspace;
  project?: Project;
  api: WorkspaceApi;
  refresh: () => Promise<void>;
  onCreateAgent: () => Promise<void>;
};

export function WorkspaceOverview({ workspace, project, api, refresh, onCreateAgent }: WorkspaceOverviewProps) {
  const [editing, setEditing] = useState(false);
  const [label, setLabel] = useState(workspace?.displayLabel ?? "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    setLabel(workspace?.displayLabel ?? "");
    setEditing(false);
    setError("");
  }, [workspace?.id, workspace?.displayLabel]);

  if (!workspace || !project) {
    return (
      <div className="empty">
        <span className="empty-icon" aria-hidden="true">⌂</span>
        <h1>Select a workspace</h1>
        <p>Choose a workspace from navigation or register a project to begin.</p>
      </div>
    );
  }

  const mutate = async (action: () => Promise<unknown>) => {
    setBusy(true);
    setError("");
    try {
      await action();
      await refresh();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Action failed");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="overview">
      <div className="crumb">{project.displayLabel} <span>/</span> Workspace</div>
      <header className="workspace-header">
        <div>
          <div className="title-line"><span className="status-dot" aria-hidden="true">●</span><h1>{workspace.displayLabel}</h1></div>
          <div className="meta">
            <code>{workspace.kind}</code>
            <code>{workspace.branchRef ?? "directory"}</code>
            <span>{workspace.archivedAt ? "Archived" : "Ready"}</span>
          </div>
        </div>
        <div className="actions">
          <button className="secondary" onClick={() => setEditing((value) => !value)}>Rename</button>
          {workspace.archivedAt ? (
            <button className="primary" onClick={() => void mutate(() => api.reopenWorkspace(workspace.id))} disabled={busy}>Reopen</button>
          ) : (
            <button className="danger-button" onClick={() => void mutate(() => api.archiveWorkspace(workspace.id))} disabled={busy}>Archive</button>
          )}
        </div>
      </header>

      {editing && (
        <form className="inline-form" onSubmit={(event) => {
          event.preventDefault();
          void mutate(async () => {
            await api.labelWorkspace(workspace.id, label);
            setEditing(false);
          });
        }}>
          <input value={label} onChange={(event) => setLabel(event.target.value)} aria-label="Workspace label" autoFocus required />
          <button className="primary" disabled={busy}>Save label</button>
        </form>
      )}
      {error && <div className="alert" role="alert">Could not update workspace: {error}</div>}

      <div className="overview-grid">
        <article>
          <span className="card-icon" aria-hidden="true">✦</span>
          <h2>Start with an agent</h2>
           <p>Start a Pi agent in this workspace.</p>
          <button className="primary" onClick={() => void onCreateAgent()} disabled={busy}>New agent</button>
        </article>
        <article>
          <span className="card-icon" aria-hidden="true">⌘</span>
          <h2>Directory workspace</h2>
          <p className="muted">Authoritative working directory</p>
          <code className="path">{workspace.cwd}</code>
        </article>
      </div>

      <section className="details">
        <h2>Workspace details</h2>
        <dl>
          <div><dt>Project root</dt><dd>{project.canonicalRootPath}</dd></div>
          <div><dt>Checkout root</dt><dd>{workspace.checkoutRoot ?? "Not applicable"}</dd></div>
          <div><dt>Main repository</dt><dd>{workspace.mainRepositoryRoot ?? "Not applicable"}</dd></div>
          <div><dt>Ownership</dt><dd>{workspace.ownershipState}</dd></div>
        </dl>
      </section>
    </div>
  );
}

type AgentPanelProps = {
  agent: AgentSummary;
  history?: AgentHistory;
  capabilities?: AgentCapabilities;
  loading: boolean;
  error?: string;
  api: WorkspaceApi;
  onRefresh: () => Promise<void>;
  onArchive: () => Promise<void>;
  onOptimisticMessage?: (message: string) => void;
};

export function AgentPanel({ agent, history, capabilities, loading, error, api, onRefresh, onArchive, onOptimisticMessage }: AgentPanelProps) {
  const draftKey = `passage:agent:${agent.id}:draft`;
  const conciseKey = `passage:agent:${agent.id}:concise`;
  const [draft, setDraft] = useState(() => localStorage.getItem(draftKey) ?? "");
  const [concise, setConcise] = useState(() => localStorage.getItem(conciseKey) === "true");
  const [busy, setBusy] = useState(false);
  const [composerError, setComposerError] = useState("");
  const [images, setImages] = useState<Array<AgentImage & { name: string }>>([]);
  const reservedImageCount = useRef(0);
  const running = agent.status === "running";

  useEffect(() => {
    setDraft(localStorage.getItem(draftKey) ?? "");
    setConcise(localStorage.getItem(conciseKey) === "true");
    setImages([]);
    reservedImageCount.current = 0;
  }, [draftKey, conciseKey]);

  const updateDraft = (value: string) => {
    setDraft(value);
    localStorage.setItem(draftKey, value);
  };
  const toggleConcise = () => {
    const next = !concise;
    setConcise(next);
    localStorage.setItem(conciseKey, String(next));
  };
  const run = async (action: () => Promise<unknown>, clearDraft = false, refreshAfter = true) => {
    setBusy(true);
    setComposerError("");
    try {
      await action();
      if (clearDraft) {
        updateDraft("");
        localStorage.removeItem(draftKey);
      }
      if (refreshAfter) await onRefresh();
    } catch (cause) {
      setComposerError(cause instanceof Error ? cause.message : "Agent command failed");
    } finally {
      setBusy(false);
    }
  };
  const send = (kind: "prompt" | "steer" | "followUp") => {
    const value = draft.trim();
    if (!value) return;
    onOptimisticMessage?.(value);
    void run(async () => {
      await api[kind](agent.id, value, images);
      setImages([]);
      reservedImageCount.current = 0;
    }, true, false);
  };

  const addImages = async (files: FileList | null) => {
    if (!files) return;
    let reserved = 0;
    try {
      const selected = Array.from(files);
      if (selected.length + reservedImageCount.current > MAX_AGENT_IMAGES) throw new Error(`Attach at most ${MAX_AGENT_IMAGES} images`);
      reservedImageCount.current += selected.length;
      reserved = selected.length;
      const attachments = await Promise.all(selected.map(async (file) => {
        if (!file.type.match(/^image\/(png|jpeg|gif|webp)$/)) throw new Error(`${file.name} is not a supported image`);
        if (file.size > MAX_AGENT_IMAGE_DATA_BYTES) throw new Error(`${file.name} is too large`);
        const bytes = new Uint8Array(await file.arrayBuffer());
        let binary = "";
        for (const byte of bytes) binary += String.fromCharCode(byte);
        return {
          type: "image" as const,
          data: btoa(binary),
          mimeType: file.type as AgentImage["mimeType"],
          name: file.name,
        };
      }));
      setImages((current) => {
        const available = MAX_AGENT_IMAGES - current.length;
        if (attachments.length > available) {
          reservedImageCount.current -= attachments.length;
          return current;
        }
        return [...current, ...attachments];
      });
      setComposerError("");
    } catch (cause) {
      reservedImageCount.current -= reserved;
      setComposerError(cause instanceof Error ? cause.message : "Unable to attach image");
    }
  };

  const model = history?.currentModel
    ? `${history.currentModel.provider}/${history.currentModel.modelId}`
    : agent.modelPreference ?? "model unavailable";
  const thinking = history?.currentThinkingLevel ?? agent.thinkingPreference ?? "default";
  const modelOptions = capabilities?.models.filter((option) => option.authenticated) ?? [];
  const currentModel = history?.currentModel
    ? `${history.currentModel.provider}:${history.currentModel.modelId}`
    : modelOptions.find((option) => `${option.provider}/${option.id}` === agent.modelPreference)
      ? modelOptions.find((option) => `${option.provider}/${option.id}` === agent.modelPreference)!
      : undefined;
  const currentModelValue = typeof currentModel === "string"
    ? currentModel
    : currentModel ? `${currentModel.provider}:${currentModel.id}` : "";
  const thinkingOptions = capabilities?.thinkingLevels ?? [];

  return (
    <section className="agent-panel" aria-label={`Agent ${agent.title}`}>
      <header className="agent-header">
        <div>
          <div className="eyebrow">Agent</div>
          <h1>{agent.title}</h1>
          <span className="agent-status">{agent.status} · {model}</span>
        </div>
        <div className="agent-header-actions">
          <label className="thinking-select">Model
            <select
              value={currentModelValue}
              onChange={(event) => {
                const [provider, modelId] = event.target.value.split(":", 2);
                if (provider && modelId) void run(() => api.setModel(agent.id, provider, modelId));
              }}
              disabled={busy || modelOptions.length === 0}
            >
              {!currentModelValue && <option value="">{model}</option>}
              {modelOptions.map((option) => <option key={`${option.provider}:${option.id}`} value={`${option.provider}:${option.id}`}>{option.name}</option>)}
            </select>
          </label>
          <label className="thinking-select">Thinking
            <select value={thinking} onChange={(event) => void run(() => api.setThinking(agent.id, event.target.value))} disabled={busy || !capabilities || thinkingOptions.length === 0}>
              {!thinkingOptions.includes(thinking) && <option value={thinking}>{thinking}</option>}
              {thinkingOptions.map((level) => <option key={level} value={level}>{level}</option>)}
            </select>
          </label>
          <button className="secondary" onClick={toggleConcise}>{concise ? "Detailed" : "Concise"}</button>
          <button className="danger-button" onClick={() => void run(onArchive, false, false)} disabled={busy}>Archive</button>
        </div>
      </header>

      {history && (
        <div className="usage-strip">
          <span>{history.usage.input.toLocaleString()} in</span>
          <span>{history.usage.output.toLocaleString()} out</span>
          <span>{history.usage.cacheRead.toLocaleString()} cache read</span>
          <span>${history.usage.cost.toFixed(4)}</span>
        </div>
      )}
      {(error || composerError) && (
        <div className="alert agent-alert" role="alert">
          {error || composerError}
          <button className="secondary" onClick={() => void onRefresh()}>Retry</button>
        </div>
      )}
      <div className="timeline">
        {loading ? <p className="muted">Loading history…</p>
          : !history?.timeline.length ? <p className="empty-inline">No persisted conversation yet.</p>
            : history.timeline.map((item) => <TimelineRow key={item.id} item={item} concise={concise} />)}
      </div>

      <footer className="composer">
        <textarea
          value={draft}
          onChange={(event) => updateDraft(event.target.value)}
          placeholder={running ? "Steer now or queue a follow-up…" : "Prompt this agent…"}
          aria-label="Agent message"
          rows={3}
        />
        {images.length > 0 && (
          <div className="attachment-list" aria-label="Attached images">
            {images.map((image) => (
              <button key={`${image.name}:${image.data.length}`} type="button" className="attachment" onClick={() => {
                setImages((current) => current.filter((item) => item !== image));
                reservedImageCount.current -= 1;
              }}>
                {image.name} ×
              </button>
            ))}
          </div>
        )}
        <div className="composer-actions">
          <label className="secondary attachment-button">
            Attach image
            <input type="file" accept="image/png,image/jpeg,image/gif,image/webp" multiple onChange={(event) => { void addImages(event.target.files); event.currentTarget.value = ""; }} />
          </label>
          {running ? (
            <>
              <button className="secondary" onClick={() => send("steer")} disabled={busy}>Steer now</button>
              <button className="secondary" onClick={() => send("followUp")} disabled={busy}>Queue follow-up</button>
              <button className="danger-button" onClick={() => void run(() => api.abort(agent.id))} disabled={busy}>Abort</button>
            </>
          ) : (
            <button className="primary" onClick={() => send("prompt")} disabled={busy}>Prompt</button>
          )}
        </div>
      </footer>
    </section>
  );
}

function ToolRow({ item }: { item: Extract<TimelineItem, { kind: "tool" }> }) {
  return (
    <details className={`timeline-row tool ${item.status}`} open={item.status === "error"}>
      <summary><strong>⚙ {item.name}</strong><span>{item.status}</span></summary>
      <pre>{JSON.stringify(item.input, null, 2)}</pre>
      {(item.error || item.result) && <pre>{item.error ?? item.result}</pre>}
    </details>
  );
}

function TimelineRow({ item, concise }: { item: TimelineItem; concise: boolean }) {
  if (item.kind === "unknown") return <article className="timeline-row unknown"><strong>Unknown activity</strong><code>{item.entryType}</code></article>;
  if (item.kind === "tool") {
    if (concise && !item.significant && item.status !== "error") return null;
    return <ToolRow item={item} />;
  }
  if (item.kind === "process") {
    return (
      <details className="timeline-row process">
        <summary><strong>Process</strong><span>{item.activities.length} activities</span></summary>
        {item.activities.map((activity) => <ToolRow key={activity.id} item={activity} />)}
      </details>
    );
  }
  if (item.kind === "thinking") {
    return <details className="timeline-row thinking"><summary><strong>Thinking</strong></summary><p>{item.text}</p></details>;
  }
  if (item.kind === "summary") {
    return <article className="timeline-row summary"><strong>{item.summaryType === "compaction" ? "Compacted context" : "Branch summary"}</strong><p>{item.text}</p></article>;
  }
  return <article className={`timeline-row ${item.kind}`}><strong>{item.kind === "user" ? "You" : "Assistant"}</strong><p>{item.text}</p></article>;
}
