import { useEffect, useRef, useState } from "react";
import type { Project, Workspace, WorkspaceSnapshot } from "../shared/domain/workspaces.ts";
import type { AgentCapabilities, AgentHistory, AgentSummary, TimelineItem, ToolActivity } from "../shared/domain/agents.ts";
import type { TerminalSummary } from "../shared/domain/terminals.ts";
import { MAX_AGENT_IMAGES, MAX_AGENT_IMAGE_DATA_BYTES, type AgentImage } from "../shared/protocol/agents.ts";
import type { WorkspaceApi } from "./api.ts";
import { FileTypeIcon } from "./components/FileTypeIcon.tsx";
import { ModelPicker } from "./components/ModelPicker.tsx";
import { Button } from "./components/ui/button.tsx";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "./components/ui/dialog.tsx";
import { Folder, GitBranch, ChevronDown, ChevronRight, MoreHorizontal, Bot, Terminal as TerminalIcon, FolderDown, FileText, FilePlus, Pencil, Search, Settings } from "lucide-react";
import { cn } from "./lib/utils.ts";
import { getToolDiff, type ToolDiff } from "./lib/tool-diff.ts";

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
  onManageWorkspace?: (workspace: Workspace) => void;
  onDiscoverWorktrees?: (projectId?: string) => void;
};

export function Sidebar({
  data,
  selected,
  selectedAgent,
  selectedTerminal,
  open,
  onClose,
  onSelect,
  onNewProject,
  onNewWorkspace,
  onNewWorktree,
  agents,
  onSelectAgent,
  terminals,
  onSelectTerminal,
  onManageWorkspace,
  onDiscoverWorktrees,
}: SidebarProps) {
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
          <div className="flex gap-1.5 w-full">
            <Button variant="secondary" size="sm" className="flex-1 justify-start text-xs font-normal" onClick={onNewWorktree}>
              ＋ New worktree
            </Button>
            {onDiscoverWorktrees && (
              <Button
                variant="secondary"
                size="sm"
                className="px-2.5 text-xs font-normal"
                onClick={() => onDiscoverWorktrees()}
                title="Discover and import existing git worktrees"
              >
                <FolderDown className="w-3.5 h-3.5" />
              </Button>
            )}
          </div>
        )}
        <Button variant="secondary" size="sm" className="w-full justify-start text-xs font-normal" onClick={onNewWorkspace}>
          ＋ Directory workspace
        </Button>
        <Button variant="secondary" size="sm" className="w-full justify-start text-xs font-normal" onClick={onNewProject}>
          Register project
        </Button>
      </div>
      <div className="side-label">Projects &amp; Worktrees</div>
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
            onManageWorkspace={onManageWorkspace}
            onDiscoverWorktrees={onDiscoverWorktrees}
          />
        ))}
      </div>
      {activeProjects.length === 0 && <p className="muted side-empty">No active projects registered yet.</p>}
      <footer>
        <span className="footer-status"><span className="connected-dot" aria-hidden="true" /> Connected</span>
        <span className="muted">v1.4.0</span>
      </footer>
    </aside>
  );
}

function ProjectRow({
  project,
  workspaces,
  selected,
  selectedAgent,
  selectedTerminal,
  onSelect,
  agents,
  onSelectAgent,
  terminals,
  onSelectTerminal,
  onManageWorkspace,
  onDiscoverWorktrees,
}: {
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
  onManageWorkspace?: (workspace: Workspace) => void;
  onDiscoverWorktrees?: (projectId?: string) => void;
}) {
  const [collapsed, setCollapsed] = useState(false);
  const activeRows = workspaces.filter((workspace) => workspace.projectId === project.id && !workspace.archivedAt);
  const archivedRows = workspaces.filter((workspace) => workspace.projectId === project.id && workspace.archivedAt);
  const [showArchived, setShowArchived] = useState(false);
  const rows = showArchived ? [...activeRows, ...archivedRows] : activeRows;
  return (
    <section className="project">
      <div
        className="project-title group/proj"
        onClick={() => setCollapsed(!collapsed)}
        role="button"
        tabIndex={0}
        aria-expanded={!collapsed}
        onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") setCollapsed(!collapsed); }}
      >
        <span className="project-chevron" aria-hidden="true">
          {collapsed ? <ChevronRight className="w-3 h-3 text-muted-foreground" /> : <ChevronDown className="w-3 h-3 text-muted-foreground" />}
        </span>
        <Folder className="w-3.5 h-3.5 text-muted-foreground/80 shrink-0" />
        <strong>{project.displayLabel}</strong>
        <code title={project.canonicalRootPath}>{project.canonicalRootPath}</code>
        {onDiscoverWorktrees && (
          <button
            type="button"
            className="opacity-0 group-hover/proj:opacity-100 p-0.5 rounded hover:bg-surface-hover text-muted-foreground hover:text-foreground transition-opacity ml-1"
            onClick={(e) => {
              e.stopPropagation();
              onDiscoverWorktrees(project.id);
            }}
            title="Discover & import worktrees for this project"
          >
            <FolderDown className="w-3 h-3" />
          </button>
        )}
      </div>
      {!collapsed && (
        <div className="workspace-list">
          {rows.map((workspace) => {
            const isWorkspaceSelected = workspace.id === selected;
            const workspaceAgents = isWorkspaceSelected ? agents.filter((agent) => agent.workspaceId === workspace.id) : [];
            const workspaceTerminals = isWorkspaceSelected ? terminals.filter((term) => term.workspaceId === workspace.id) : [];
            const hasActiveAgent = workspaceAgents.some((a) => a.status === "running");

            return (
              <div className="workspace-group group/ws" key={workspace.id}>
                <div
                  className={cn(
                    "workspace-row group flex items-center justify-between",
                    isWorkspaceSelected && !selectedAgent && !selectedTerminal && "selected"
                  )}
                  onClick={() => onSelect(workspace.id)}
                  role="button"
                  tabIndex={0}
                >
                  <div className="flex items-center gap-1.5 min-w-0 flex-1">
                    <span
                      className={cn("status-dot shrink-0", hasActiveAgent ? "running" : "idle")}
                      aria-label={workspace.archivedAt ? "Archived" : "Ready"}
                    />
                    {workspace.kind === "worktree" ? (
                      <GitBranch className="w-3 h-3 text-primary/90 shrink-0" />
                    ) : (
                      <Folder className="w-3 h-3 text-muted-foreground/70 shrink-0" />
                    )}
                    <div className="workspace-copy min-w-0 flex-1">
                      <div className="flex items-center gap-1 leading-tight">
                        <b className="truncate text-xs font-medium">{workspace.displayLabel}</b>
                        {workspace.kind === "worktree" ? (
                          <span className="text-[9px] px-1 py-0.2 rounded bg-muted text-muted-foreground font-mono shrink-0">
                            worktree
                          </span>
                        ) : (
                          <span className="text-[9px] px-1 py-0.2 rounded bg-muted/50 text-muted-foreground shrink-0">
                            dir
                          </span>
                        )}
                        {workspace.archivedAt && (
                          <span className="text-[9px] px-1 py-0.2 rounded bg-amber-500/15 text-amber-600 font-medium shrink-0">
                            archived
                          </span>
                        )}
                      </div>
                      {workspace.branchRef && (
                        <small className="text-[10px] text-muted-foreground font-mono truncate block mt-0.5">
                          ⎇ {workspace.branchRef}
                        </small>
                      )}
                    </div>
                  </div>

                  {onManageWorkspace && (
                    <button
                      type="button"
                      className="opacity-0 group-hover/ws:opacity-100 p-0.5 rounded hover:bg-surface-hover text-muted-foreground hover:text-foreground transition-opacity"
                      onClick={(e) => {
                        e.stopPropagation();
                        onManageWorkspace(workspace);
                      }}
                      title="Workspace details and actions"
                      aria-label="Workspace details and actions"
                    >
                      <MoreHorizontal className="w-3.5 h-3.5" />
                    </button>
                  )}
                </div>

                {isWorkspaceSelected && (workspaceAgents.length > 0 || workspaceTerminals.length > 0) && (
                  <div className="agent-tree-list">
                    {workspaceAgents.map((agent) => (
                      <button
                        className={cn("agent-row", agent.id === selectedAgent && "selected")}
                        key={agent.id}
                        onClick={() => onSelectAgent(agent.id)}
                      >
                        <span
                          className={cn("status-dot dot-sm shrink-0", agent.status === "running" ? "running" : "idle")}
                          aria-hidden="true"
                        />
                        <Bot className="w-3 h-3 text-muted-foreground shrink-0" />
                        <span className="agent-row-title text-xs">{agent.title}</span>
                        <small className={cn("agent-row-meta", agent.status === "running" && "running")}>
                          {agent.status === "running" ? "running" : "idle"}
                        </small>
                      </button>
                    ))}
                    {workspaceTerminals.map((term) => (
                      <button
                        className={cn("agent-row", term.id === selectedTerminal && "selected")}
                        key={term.id}
                        onClick={() => onSelectTerminal(term.id)}
                      >
                        <TerminalIcon className="w-3 h-3 text-muted-foreground shrink-0" />
                        <span className="agent-row-title text-xs">{term.title}</span>
                        <small className="agent-row-meta">{term.status}</small>
                      </button>
                    ))}
                  </div>
                )}
              </div>
            );
          })}
          {archivedRows.length > 0 && (
            <button
              type="button"
              className="text-[10.5px] text-muted-foreground/60 hover:text-muted-foreground transition-colors px-2 py-0.5 mt-0.5 text-left flex items-center gap-1 cursor-pointer"
              onClick={(e) => {
                e.stopPropagation();
                setShowArchived(!showArchived);
              }}
            >
              <span>{showArchived ? "▾ Hide archived" : `▸ Archived (${archivedRows.length})`}</span>
            </button>
          )}
          {rows.length === 0 && <p className="muted project-empty">No active workspaces</p>}
        </div>
      )}
    </section>
  );
}

export { WorkspaceDetailsModal } from "./components/WorkspaceDetailsModal.tsx";

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
  const changeSummary = summarizeChanges(history?.timeline ?? []);

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
        {changeSummary && (
          <div
            className="agent-change-summary"
            aria-label={`${changeSummary.fileCount} changed files, ${changeSummary.additions} additions, ${changeSummary.deletions} deletions`}
          >
            <span className="agent-change-files">
              <Pencil size={12} aria-hidden="true" />
              {changeSummary.fileCount} changed file{changeSummary.fileCount === 1 ? "" : "s"}
            </span>
            <span className="add-count">+{changeSummary.additions}</span>
            <span className="del-count">-{changeSummary.deletions}</span>
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

type ToolIconKind = "read" | "edit" | "write" | "command" | "search" | "other";

type ToolSummary = {
  icon: ToolIconKind;
  title: string;
  subtitle: string;
};

function getToolSummary(item: Extract<TimelineItem, { kind: "tool" }>): ToolSummary {
  const input = (item.input ?? {}) as Record<string, unknown>;
  switch (item.name) {
    case "read":
    case "readFile":
      return fileToolSummary("read", "Read File", input);
    case "edit":
    case "editFile":
      return fileToolSummary("edit", "Edit File", input);
    case "write":
    case "writeFile":
      return fileToolSummary("write", "Write File", input);
    case "bash":
      return { icon: "command", title: "Shell Command", subtitle: String(input.command ?? "") };
    case "glob":
      return { icon: "search", title: "Find Files", subtitle: String(input.pattern ?? "") };
    case "grep":
      return { icon: "search", title: "Grep Code", subtitle: String(input.pattern ?? "") };
    default:
      return { icon: "other", title: item.name, subtitle: "" };
  }
}

function fileToolSummary(icon: ToolIconKind, title: string, input: Record<string, unknown>): ToolSummary {
  const path = String(input.path ?? input.filePath ?? "");
  return { icon, title, subtitle: path };
}

function ToolIcon({ kind }: { kind: ToolIconKind }) {
  const props = { size: 13, strokeWidth: 1.8, "aria-hidden": true };
  switch (kind) {
    case "read": return <FileText {...props} />;
    case "edit": return <Pencil {...props} />;
    case "write": return <FilePlus {...props} />;
    case "command": return <TerminalIcon {...props} />;
    case "search": return <Search {...props} />;
    default: return <Settings {...props} />;
  }
}

function ToolRow({ item }: { item: Extract<TimelineItem, { kind: "tool" }> }) {
  const { icon, title, subtitle } = getToolSummary(item);
  const diff = getToolDiff(item);
  return (
    <details className={`tool-row ${item.status}`} open={item.status === "error"}>
      <summary className="tool-row-summary">
        <span className="tool-row-left">
          <span className="tool-row-icon"><ToolIcon kind={icon} /></span>
          <span className="tool-row-title">{title}</span>
          {subtitle && icon !== "command" && <FileTypeIcon path={subtitle} size={13} />}
          {subtitle && <span className="tool-row-target-text">{subtitle}</span>}
          {diff && (diff.additions > 0 || diff.deletions > 0) && (
            <span className="tool-row-delta" aria-label={`${diff.additions} additions, ${diff.deletions} deletions`}>
              <span className="add-count">+{diff.additions}</span>
              <span className="del-count">-{diff.deletions}</span>
            </span>
          )}
        </span>
        <span className="tool-row-right">
          <span className={`tool-badge ${item.status}`}>{item.status}</span>
        </span>
      </summary>
      <div className="tool-expanded-body">
        {diff ? <ToolDiffPreview diff={diff} /> : item.input && (
          <pre className="tool-input-pre"><code>{typeof item.input === "string" ? item.input : JSON.stringify(item.input, null, 2)}</code></pre>
        )}
        {(item.error || item.result) && (
          <div className="tool-output-wrap">
            <span className="tool-output-label">{item.error ? "Error" : "Output"}</span>
            <pre className={`tool-output-pre ${item.error ? "error" : ""}`}><code>{item.error ?? item.result}</code></pre>
          </div>
        )}
      </div>
    </details>
  );
}

const MAX_INLINE_DIFF_LINES = 80;

function ToolDiffPreview({ diff }: { diff: ToolDiff }) {
  const visibleLines = diff.lines.slice(0, MAX_INLINE_DIFF_LINES);
  const omittedLines = diff.lines.length - visibleLines.length;
  return (
    <div className="tool-diff-preview" aria-label={`Inline diff for ${diff.path || "changed file"}`}>
      <div className="tool-diff-header">
        <span className="tool-diff-file">
          {diff.path && <FileTypeIcon path={diff.path} size={14} />}
          <code>{diff.path || "Changed content"}</code>
        </span>
        <span className="tool-diff-context">{diff.contextLines} unmodified lines</span>
      </div>
      <div className="tool-diff-lines">
        {visibleLines.map((line, index) => (
          <div className={`tool-diff-line ${line.kind}`} key={`${line.kind}:${line.oldLine ?? ""}:${line.newLine ?? ""}:${index}`}>
            <span className="tool-diff-number">{line.oldLine ?? ""}</span>
            <span className="tool-diff-number">{line.newLine ?? ""}</span>
            <span className="tool-diff-marker">{line.kind === "added" ? "+" : line.kind === "removed" ? "-" : " "}</span>
            <code>{line.text}</code>
          </div>
        ))}
        {omittedLines > 0 && <div className="tool-diff-omitted">{omittedLines} more lines hidden</div>}
      </div>
    </div>
  );
}

function summarizeChanges(timeline: TimelineItem[]): { fileCount: number; additions: number; deletions: number } | undefined {
  const files = new Set<string>();
  let additions = 0;
  let deletions = 0;
  const activities = timeline.flatMap((item): ToolActivity[] => item.kind === "tool" ? [item] : item.kind === "process" ? item.activities : []);
  for (const activity of activities) {
    const diff = getToolDiff(activity);
    if (!diff || !diff.path || (diff.additions === 0 && diff.deletions === 0)) continue;
    files.add(diff.path);
    additions += diff.additions;
    deletions += diff.deletions;
  }
  return files.size > 0 ? { fileCount: files.size, additions, deletions } : undefined;
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
          <span className="timeline-concise-title"><ToolIcon kind={icon} /> {title}</span>
          {subtitle && icon !== "command" && <FileTypeIcon path={subtitle} size={13} />}
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
