import { useEffect, useRef, useState } from "react";
import type { Project, Workspace, WorkspaceSnapshot } from "../shared/domain/workspaces.ts";
import type { AgentCapabilities, AgentHistory, AgentSummary, TimelineItem } from "../shared/domain/agents.ts";
import type { TerminalSummary } from "../shared/domain/terminals.ts";
import { MAX_AGENT_IMAGES, MAX_AGENT_IMAGE_DATA_BYTES, type AgentImage } from "../shared/protocol/agents.ts";
import type { WorkspaceApi } from "./api.ts";
import { ModelPicker } from "./components/ModelPicker.tsx";
import { Button } from "./components/ui/button.tsx";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "./components/ui/dialog.tsx";

type SidebarProps = {
  data: WorkspaceSnapshot;
  selected?: string;
  selectedAgent?: string;
  selectedTerminal?: string;
  open: boolean;
  onClose: () => void;
  onSelect: (id: string) => void;
  onNewProject: () => void;
  onNewWorkspace: () => void;
  onNewWorktree?: () => void;
  agents: AgentSummary[];
  onSelectAgent: (id: string) => void;
  terminals: TerminalSummary[];
  onSelectTerminal: (id: string) => void;
};

export function Sidebar({ data, selected, selectedAgent, selectedTerminal, open, onClose, onSelect, onNewProject, onNewWorkspace, onNewWorktree, agents, onSelectAgent, terminals, onSelectTerminal }: SidebarProps) {
  const activeProjects = data.projects.filter((project) => !project.archivedAt);
  return (
    <aside className={`sidebar ${open ? "drawer-open" : ""}`} aria-label="Projects and workspaces">
      <div className="brand">
        <span className="mark" aria-hidden="true">P</span>
        <strong>Passage</strong>
        <button className="icon-button mobile-only" onClick={onClose} aria-label="Close navigation">×</button>
      </div>
      <div className="sidebar-actions flex flex-col gap-1.5">
        {onNewWorktree && (
          <Button variant="secondary" size="sm" className="w-full justify-start text-xs font-normal" onClick={onNewWorktree}>
            ＋ New worktree
          </Button>
        )}
        <Button variant="secondary" size="sm" className="w-full justify-start text-xs font-normal" onClick={onNewWorkspace}>
          ＋ Directory workspace
        </Button>
        <Button variant="secondary" size="sm" className="w-full justify-start text-xs font-normal" onClick={onNewProject}>
          Register project
        </Button>
      </div>
      <div className="side-label">Projects</div>
      <div className="project-list">
        {activeProjects.map((project) => (
          <ProjectRow
            key={project.id}
            project={project}
            workspaces={data.workspaces}
            selected={selected}
            selectedAgent={selectedAgent}
            selectedTerminal={selectedTerminal}
            onSelect={onSelect}
            agents={selected ? agents : []}
            onSelectAgent={onSelectAgent}
            terminals={selected ? terminals : []}
            onSelectTerminal={onSelectTerminal}
          />
        ))}
      </div>
      {activeProjects.length === 0 && <p className="muted side-empty">No active projects registered yet.</p>}
      <footer>
        <span className="footer-status"><span className="connected-dot" aria-hidden="true">●</span> Connected</span>
        <span className="muted">v1.4.0</span>
      </footer>
    </aside>
  );
}

function ProjectRow({ project, workspaces, selected, selectedAgent, selectedTerminal, onSelect, agents, onSelectAgent, terminals, onSelectTerminal }: {
  project: Project;
  workspaces: Workspace[];
  selected?: string;
  selectedAgent?: string;
  selectedTerminal?: string;
  onSelect: (id: string) => void;
  agents: AgentSummary[];
  onSelectAgent: (id: string) => void;
  terminals: TerminalSummary[];
  onSelectTerminal: (id: string) => void;
}) {
  const [collapsed, setCollapsed] = useState(false);
  const rows = workspaces.filter((workspace) => workspace.projectId === project.id);
  return (
    <section className="project">
      <div
        className="project-title"
        onClick={() => setCollapsed(!collapsed)}
        role="button"
        tabIndex={0}
        aria-expanded={!collapsed}
        onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") setCollapsed(!collapsed); }}
      >
        <span className="project-chevron" aria-hidden="true">{collapsed ? "▸" : "▾"}</span>
        <strong>{project.displayLabel}</strong>
        <code title={project.canonicalRootPath}>{project.canonicalRootPath}</code>
      </div>
      {!collapsed && rows.map((workspace) => {
        const isWorkspaceSelected = workspace.id === selected;
        const workspaceAgents = isWorkspaceSelected ? agents.filter((agent) => agent.workspaceId === workspace.id) : [];
        const workspaceTerminals = isWorkspaceSelected ? terminals.filter((term) => term.workspaceId === workspace.id) : [];
        const hasActiveAgent = workspaceAgents.some((a) => a.status === "running");

        return (
          <div className="workspace-group" key={workspace.id}>
            <button
              className={`workspace-row ${isWorkspaceSelected && !selectedAgent && !selectedTerminal ? "selected" : ""}`}
              onClick={() => onSelect(workspace.id)}
            >
              <span className={`status-dot ${hasActiveAgent ? "running" : "idle"}`} aria-label={workspace.archivedAt ? "Archived" : "Ready"}>●</span>
              <span className="workspace-copy">
                <b>{workspace.displayLabel}</b>
                <small>{workspace.branchRef ? `⎇ ${workspace.branchRef}` : "directory"} · {workspace.kind}</small>
              </span>
            </button>
            {isWorkspaceSelected && workspaceAgents.map((agent) => (
              <button
                className={`agent-row ${agent.id === selectedAgent ? "selected" : ""}`}
                key={agent.id}
                onClick={() => onSelectAgent(agent.id)}
              >
                <span className={`status-dot small ${agent.status === "running" ? "running" : "idle"}`} aria-hidden="true">●</span>
                <span className="agent-row-title">{agent.title}</span>
                <small className="agent-row-meta">{agent.status === "running" ? "running" : "idle"}</small>
              </button>
            ))}
            {isWorkspaceSelected && workspaceTerminals.map((term) => (
              <button
                className={`agent-row ${term.id === selectedTerminal ? "selected" : ""}`}
                key={term.id}
                onClick={() => onSelectTerminal(term.id)}
              >
                <span aria-hidden="true">&gt;_</span>
                <span className="agent-row-title">{term.title}</span>
                <small className="agent-row-meta">{term.status}</small>
              </button>
            ))}
          </div>
        );
      })}
      {!collapsed && rows.length === 0 && <p className="muted project-empty">No workspaces</p>}
    </section>
  );
}

type WorkspaceOverviewProps = {
  workspace?: Workspace;
  project?: Project;
  api: WorkspaceApi;
  refresh: () => Promise<void>;
  onCreateAgent: () => Promise<void>;
  onCreateTerminal?: () => Promise<void>;
  onOpenExplorer?: () => void;
  onOpenChanges?: () => void;
  onOpenDiff?: () => void;
  onOpenAgent?: () => void;
  onOpenTerminal?: () => void;
};

export function WorkspaceOverview({
  workspace,
  project,
  api,
  refresh,
  onCreateAgent,
  onCreateTerminal,
  onOpenExplorer,
  onOpenChanges,
  onOpenDiff,
  onOpenAgent,
  onOpenTerminal,
}: WorkspaceOverviewProps) {
  const [editing, setEditing] = useState(false);
  const [label, setLabel] = useState(workspace?.displayLabel ?? "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [confirmRemove, setConfirmRemove] = useState(false);
  const [forceRemove, setForceRemove] = useState(false);

  useEffect(() => {
    setLabel(workspace?.displayLabel ?? "");
    setEditing(false);
    setError("");
    setConfirmRemove(false);
    setForceRemove(false);
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

  const handleRepair = async () => {
    await mutate(() => api.repairWorktree(workspace.id));
  };

  const handleRemove = async () => {
    await mutate(() => api.removeWorktree(workspace.id, forceRemove));
    setConfirmRemove(false);
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
            {workspace.ownershipState === "repair" && (
              <span className="conflict-badge">Repair Required</span>
            )}
          </div>
        </div>
        <div className="actions">
          <button className="secondary" onClick={() => setEditing((value) => !value)}>Rename</button>
          {workspace.kind === "worktree" && (
            <button className="danger-button" onClick={() => setConfirmRemove(true)} disabled={busy}>
              Remove Worktree
            </button>
          )}
          {workspace.archivedAt ? (
            <button className="primary" onClick={() => void mutate(() => api.reopenWorkspace(workspace.id))} disabled={busy}>Reopen</button>
          ) : (
            <button className="secondary" onClick={() => void mutate(() => api.archiveWorkspace(workspace.id))} disabled={busy}>Archive</button>
          )}
        </div>
      </header>

      {workspace.ownershipState === "repair" && (
        <div className="alert repair-banner">
          <div>
            <strong>⚠️ Worktree ownership marker mismatch:</strong> Registration requires repair.
            {workspace.repairDetail && <p style={{ margin: "4px 0 0", fontSize: 12 }}>{workspace.repairDetail}</p>}
          </div>
          <button className="primary small" onClick={handleRepair} disabled={busy}>
            🔧 Repair Registration
          </button>
        </div>
      )}

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
          <span className="card-icon" aria-hidden="true">◈</span>
          <h2>Pi Agent</h2>
          <p>Run autonomous coding sessions and conversations.</p>
          <div style={{ display: "flex", gap: 8 }}>
            <button className="primary" onClick={() => void onCreateAgent()} disabled={busy}>New agent</button>
            {onOpenAgent && <button className="secondary" onClick={onOpenAgent}>Open Agent ↗</button>}
          </div>
        </article>
        <article>
          <span className="card-icon" aria-hidden="true">📁</span>
          <h2>File Explorer</h2>
          <p>Browse workspace directory tree and open files for editing.</p>
          {onOpenExplorer && <button className="secondary" onClick={onOpenExplorer}>Browse Files ↗</button>}
        </article>
        <article>
          <span className="card-icon" aria-hidden="true">±</span>
          <h2>Git Changes</h2>
          <p>Review working tree status, staged index, and ahead/behind counts.</p>
          {onOpenChanges && <button className="secondary" onClick={onOpenChanges}>View Changes ↗</button>}
        </article>
        <article>
          <span className="card-icon" aria-hidden="true">🔍</span>
          <h2>Diff Viewer</h2>
          <p>Structured unified and side-by-side Git diffs.</p>
          {onOpenDiff && <button className="secondary" onClick={onOpenDiff}>Inspect Diffs ↗</button>}
        </article>
        <article>
          <span className="card-icon" aria-hidden="true">&gt;_</span>
          <h2>Interactive Terminal</h2>
          <p>Persistent PTY shell attached directly to the daemon.</p>
          <div style={{ display: "flex", gap: 8 }}>
            {onCreateTerminal && (
              <button className="primary" onClick={() => void onCreateTerminal()} disabled={busy}>
                New terminal
              </button>
            )}
            {onOpenTerminal && (
              <button className="secondary" onClick={onOpenTerminal}>
                Open Terminal ↗
              </button>
            )}
          </div>
        </article>
      </div>

      <section className="details">
        <h2>Workspace details</h2>
        <dl>
          <div><dt>Project root</dt><dd>{project.canonicalRootPath}</dd></div>
          <div><dt>Working directory</dt><dd>{workspace.cwd}</dd></div>
          <div><dt>Checkout root</dt><dd>{workspace.checkoutRoot ?? "Not applicable"}</dd></div>
          <div><dt>Main repository</dt><dd>{workspace.mainRepositoryRoot ?? "Not applicable"}</dd></div>
          <div><dt>Branch ref</dt><dd>{workspace.branchRef ?? "None (directory)"}</dd></div>
          <div><dt>Ownership</dt><dd>{workspace.ownershipState}</dd></div>
          {workspace.markerPath && <div><dt>Marker path</dt><dd>{workspace.markerPath}</dd></div>}
        </dl>
      </section>

      {confirmRemove && (
        <Dialog open onOpenChange={(open) => { if (!open) setConfirmRemove(false); }}>
          <DialogContent className="max-w-[440px]">
            <DialogHeader>
              <DialogTitle className="text-lg font-semibold">Remove Git Worktree</DialogTitle>
            </DialogHeader>
            <p className="text-sm text-muted-foreground my-2">
              Are you sure you want to remove the worktree at <code className="font-mono text-xs">{workspace.cwd}</code>?
            </p>
            <label className="flex items-center gap-2 text-sm text-destructive font-medium my-2 cursor-pointer">
              <input
                type="checkbox"
                checked={forceRemove}
                onChange={(e) => setForceRemove(e.target.checked)}
                className="rounded border-input text-destructive focus:ring-destructive"
              />
              Force remove (discard any uncommitted or dirty changes)
            </label>
            <div className="flex justify-end gap-2 pt-2">
              <Button variant="secondary" onClick={() => setConfirmRemove(false)}>Cancel</Button>
              <Button variant="destructive" onClick={handleRemove} disabled={busy}>
                {busy ? "Removing..." : "Confirm Removal"}
              </Button>
            </div>
          </DialogContent>
        </Dialog>
      )}
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
  const timelineRef = useRef<HTMLDivElement>(null);
  const running = agent.status === "running";

  useEffect(() => {
    if (timelineRef.current) {
      timelineRef.current.scrollTop = timelineRef.current.scrollHeight;
    }
  }, [history?.timeline]);

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
    if (!value && images.length === 0) return;
    const finalMessage = value || (images.length > 0 ? "Attached image" : "");
    const payloadImages: AgentImage[] = images.map(({ type, data, mimeType }) => ({
      type,
      data,
      mimeType,
    }));
    onOptimisticMessage?.(finalMessage);
    void run(async () => {
      await api[kind](agent.id, finalMessage, payloadImages.length > 0 ? payloadImages : undefined);
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
        let mimeType = file.type;
        if (mimeType === "image/jpg") mimeType = "image/jpeg";
        if (!mimeType.match(/^image\/(png|jpeg|gif|webp)$/)) throw new Error(`${file.name} is not a supported image`);
        if (file.size > MAX_AGENT_IMAGE_DATA_BYTES) throw new Error(`${file.name} is too large`);
        const base64 = await new Promise<string>((resolve, reject) => {
          const reader = new FileReader();
          reader.onload = () => {
            const result = String(reader.result ?? "");
            const comma = result.indexOf(",");
            resolve(comma >= 0 ? result.slice(comma + 1) : result);
          };
          reader.onerror = () => reject(new Error(`Failed to read ${file.name}`));
          reader.readAsDataURL(file);
        });
        return {
          type: "image" as const,
          data: base64,
          mimeType: mimeType as AgentImage["mimeType"],
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
    ? (modelOptions.find((option) => option.provider === history.currentModel!.provider && option.id === history.currentModel!.modelId) ?? {
        name: history.currentModel.modelId,
        id: history.currentModel.modelId,
        provider: history.currentModel.provider,
      })
    : modelOptions.find((option) => `${option.provider}/${option.id}` === agent.modelPreference || option.id === agent.modelPreference)
      ? modelOptions.find((option) => `${option.provider}/${option.id}` === agent.modelPreference || option.id === agent.modelPreference)!
      : undefined;
  const currentModelValue = currentModel ? `${currentModel.provider}:${currentModel.id}` : "";
  const currentModelDisplayName = currentModel?.name ?? (model.includes("/") ? model.split("/")[1] : model);

  const totalTokens = history?.usage?.totalTokens ?? ((history?.usage?.input ?? 0) + (history?.usage?.output ?? 0));
  const contextPercentage = totalTokens > 0 ? Math.min(100, Math.max(0.1, (totalTokens / 200000) * 100)).toFixed(1) : "0.0";

  return (
    <section className="agent-panel" aria-label={`Agent conversation ${agent.title}`}>
      {(error || composerError) && (
        <div className="alert agent-alert" role="alert">
          <span>{error || composerError}</span>
          <button className="secondary small" onClick={() => void onRefresh()}>Retry</button>
        </div>
      )}
      <div className="timeline" ref={timelineRef}>
        {loading ? <p className="muted timeline-loading">Loading history…</p>
          : !history?.timeline.length ? (
            <div className="empty-transcript">
              <span className="empty-transcript-icon">◈</span>
              <h3>What are we working on?</h3>
              <p>Type a prompt below to start an autonomous session.</p>
            </div>
          ) : history.timeline.map((item) => <TimelineRow key={item.id} item={item} concise={concise} />)}
      </div>

      <footer className="composer-container">
        {running && (
          <div className="composer-status-line">
            <span className="pulse-dot" />
            <span>Pi Agent is running…</span>
          </div>
        )}
        <div className="composer-card">
          <textarea
            value={draft}
            onChange={(event) => updateDraft(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter" && !event.shiftKey) {
                event.preventDefault();
                if (running) send("steer");
                else send("prompt");
              }
            }}
            placeholder={running ? "Steer now (Enter) or queue follow-up…" : "@ for files/agents; / for commands and skills; ! for shell; # for snippets"}
            aria-label="Agent message"
            rows={2}
          />
          {composerError && (
            <div className="composer-error-alert" role="alert">
              <span>⚠️ {composerError}</span>
            </div>
          )}
          {images.length > 0 && (
            <div className="attachment-list" aria-label="Attached images">
              {images.map((image) => (
                <div key={`${image.name}:${image.data.length}`} className="attachment-chip">
                  <img
                    src={`data:${image.mimeType};base64,${image.data}`}
                    alt={image.name}
                    className="attachment-thumb"
                  />
                  <span className="attachment-name">{image.name}</span>
                  <button
                    type="button"
                    className="attachment-remove"
                    onClick={() => {
                      setImages((current) => current.filter((item) => item !== image));
                      reservedImageCount.current -= 1;
                    }}
                    aria-label={`Remove ${image.name}`}
                  >
                    ×
                  </button>
                </div>
              ))}
            </div>
          )}
          <div className="composer-toolbar">
            <div className="composer-toolbar-left">
              <label className="composer-attach-btn" title="Attach image">
                <span>⊕ Attach</span>
                <input type="file" accept="image/png,image/jpeg,image/gif,image/webp" multiple onChange={(event) => { void addImages(event.target.files); event.currentTarget.value = ""; }} />
              </label>
              {totalTokens > 0 && (
                <span className="composer-ctx-pill" title={`${totalTokens.toLocaleString()} tokens (${history?.usage?.input.toLocaleString() ?? 0} in · ${history?.usage?.output.toLocaleString() ?? 0} out · ${history?.usage?.cacheRead.toLocaleString() ?? 0} cache) · $${history?.usage?.cost.toFixed(4) ?? "0.0000"}`}>
                  <span className="context-dot" />
                  <span>{contextPercentage}% ctx</span>
                  <span className="composer-stat-sep">·</span>
                  <span>{totalTokens > 1000 ? `${(totalTokens / 1000).toFixed(1)}k tok` : `${totalTokens} tok`}</span>
                  {history?.usage?.cost !== undefined && history.usage.cost > 0 && (
                    <>
                      <span className="composer-stat-sep">·</span>
                      <span>${history.usage.cost.toFixed(3)}</span>
                    </>
                  )}
                </span>
              )}
            </div>
            <div className="composer-toolbar-right">
              <button
                type="button"
                className="composer-mode-toggle"
                onClick={toggleConcise}
                title={concise ? "Switch to Detailed mode" : "Switch to Concise mode"}
              >
                {concise ? "Concise" : "Detailed"}
              </button>
              <ModelPicker
                currentModelId={currentModel ? `${currentModel.provider}:${currentModel.id}` : undefined}
                currentModelName={currentModelDisplayName}
                currentThinking={thinking}
                capabilities={capabilities}
                onSelectModel={async (provider, modelId) => {
                  await run(() => api.setModel(agent.id, provider, modelId));
                }}
                onSelectThinking={async (level) => {
                  await run(() => api.setThinking(agent.id, level));
                }}
                disabled={busy}
              />
              {running ? (
                <>
                  <Button size="sm" onClick={() => send("steer")} disabled={busy}>Steer now</Button>
                  <Button variant="secondary" size="sm" onClick={() => send("followUp")} disabled={busy}>Queue follow-up</Button>
                  <Button variant="destructive" size="sm" onClick={() => void run(() => api.abort(agent.id))} disabled={busy} title="Stop agent execution">⏹ Stop</Button>
                </>
              ) : (
                <Button size="sm" className="send-btn" onClick={() => send("prompt")} disabled={busy || (!draft.trim() && images.length === 0)}>
                  Send ↵
                </Button>
              )}
            </div>
          </div>
        </div>
      </footer>
    </section>
  );
}

function getToolSummary(item: Extract<TimelineItem, { kind: "tool" }>): { icon: string; title: string; subtitle: string } {
  const input = (item.input ?? {}) as Record<string, unknown>;
  switch (item.name) {
    case "read":
    case "readFile":
      return { icon: "📄", title: "Read File", subtitle: String(input.path ?? input.filePath ?? "") };
    case "edit":
    case "editFile":
      return { icon: "✏️", title: "Edit File", subtitle: String(input.path ?? input.filePath ?? "") };
    case "write":
    case "writeFile":
      return { icon: "📝", title: "Write File", subtitle: String(input.path ?? input.filePath ?? "") };
    case "bash":
      return { icon: "⚡", title: "Shell Command", subtitle: String(input.command ?? "") };
    case "glob":
      return { icon: "🔍", title: "Find Files", subtitle: String(input.pattern ?? "") };
    case "grep":
      return { icon: "🔎", title: "Grep Code", subtitle: String(input.pattern ?? "") };
    default:
      return { icon: "⚙", title: item.name, subtitle: "" };
  }
}

function ToolRow({ item }: { item: Extract<TimelineItem, { kind: "tool" }> }) {
  const { icon, title, subtitle } = getToolSummary(item);
  return (
    <details className={`tool-row ${item.status}`} open={item.status === "error"}>
      <summary className="tool-row-summary">
        <span className="tool-row-left">
          <span className="tool-row-icon">{icon}</span>
          <span className="tool-row-title">{title}</span>
          <span className="tool-row-meta-tag">0.1s</span>
          {subtitle && <span className="tool-row-target-text">{subtitle}</span>}
        </span>
        <span className="tool-row-right">
          <span className={`tool-badge ${item.status}`}>{item.status}</span>
        </span>
      </summary>
      <div className="tool-expanded-body">
        {item.input && (
          <pre className="tool-input-pre"><code>{typeof item.input === "string" ? item.input : JSON.stringify(item.input, null, 2)}</code></pre>
        )}
        {(item.error || item.result) && (
          <pre className={`tool-output-pre ${item.error ? "error" : ""}`}><code>{item.error ?? item.result}</code></pre>
        )}
      </div>
    </details>
  );
}

function renderFormattedProse(text: string) {
  // Format commit references like "Committed in `0eaa8e7 feat(canvas): ...`."
  const commitMatch = text.match(/Committed in `([0-9a-f]{7,40})\s+([^`]+)`/);
  if (commitMatch) {
    const [full, hash, message] = commitMatch;
    const parts = text.split(full);
    return (
      <p>
        {parts[0]}Committed in <span className="commit-chip"><code>{hash} {message}</code></span>{parts[1]}
      </p>
    );
  }
  return <p>{text}</p>;
}

function TimelineRow({ item, concise }: { item: TimelineItem; concise: boolean }) {
  if (item.kind === "unknown") return <article className="timeline-row unknown"><strong>Unknown activity</strong><code>{item.entryType}</code></article>;
  if (item.kind === "tool") {
    if (concise && !item.significant && item.status !== "error") {
      const { icon, title, subtitle } = getToolSummary(item);
      return (
        <div className="timeline-concise-badge">
          <span>{icon} {title}</span>
          {subtitle && <code title={subtitle}>{subtitle}</code>}
        </div>
      );
    }
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
    const preview = item.text.slice(0, 70).replace(/\n/g, " ");
    return (
      <details className="thinking-row">
        <summary className="thinking-summary">
          <span className="thinking-icon">⚙</span>
          <span className="thinking-label">Thinking</span>
          <span className="thinking-preview">{preview}…</span>
        </summary>
        <div className="thinking-body">
          <p>{item.text}</p>
        </div>
      </details>
    );
  }
  if (item.kind === "summary") {
    return (
      <article className="timeline-row summary">
        <strong>{item.summaryType === "compaction" ? "Compacted context" : "Branch summary"}</strong>
        <p>{item.text}</p>
      </article>
    );
  }
  if (item.kind === "user") {
    return (
      <div className="user-message-container">
        <div className="user-message-card">
          <p>{item.text}</p>
        </div>
      </div>
    );
  }
  return (
    <article className="assistant-message-row">
      <div className="assistant-prose">
        {renderFormattedProse(item.text)}
      </div>
    </article>
  );
}
