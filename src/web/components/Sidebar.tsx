import { useState } from "react";
import type { Project, Workspace, WorkspaceSnapshot } from "../../shared/domain/workspaces.ts";
import type { AgentSummary } from "../../shared/domain/agents.ts";
import type { TerminalSummary } from "../../shared/domain/terminals.ts";
import { Button } from "./ui/button.tsx";
import { CopyValueButton } from "./CopyValueButton.tsx";
import {
  Folder,
  FolderDown,
  GitBranch,
  ChevronDown,
  ChevronRight,
  MoreHorizontal,
  Bot,
  Terminal as TerminalIcon,
  Trash2,
  Plus,
} from "lucide-react";
import { cn } from "../lib/utils.ts";
import { Tooltip, TooltipContent, TooltipTrigger } from "./ui/tooltip.tsx";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "./ui/alert-dialog.tsx";
import { buttonVariants } from "./ui/button.tsx";

export type SidebarProps = {
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
  onArchiveProject?: (id: string) => void;
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
  onArchiveProject,
}: SidebarProps) {
  const activeProjects = data.projects.filter((project) => !project.archivedAt);
  const [pendingRemove, setPendingRemove] = useState<Project | null>(null);
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
            <Button variant="secondary" size="xs" className="flex-1 justify-start text-xs font-normal" onClick={onNewWorktree}>
              ＋ New worktree
            </Button>
            {onDiscoverWorktrees && (
              <Button
                variant="secondary"
                size="xs"
                className="px-2.5 text-xs font-normal"
                onClick={() => onDiscoverWorktrees()}
                title="Discover and import existing git worktrees"
              >
                <FolderDown className="w-3.5 h-3.5" />
              </Button>
            )}
          </div>
        )}
        <Button variant="secondary" size="xs" className="w-full justify-start text-xs font-normal" onClick={onNewWorkspace}>
          ＋ Directory workspace
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
            onRequestRemoveProject={onArchiveProject ? setPendingRemove : undefined}
          />
        ))}
      </div>
      {activeProjects.length === 0 && <p className="muted side-empty">No active projects registered yet.</p>}
      <footer>
        <span className="footer-status"><span className="connected-dot" aria-hidden="true" /> Connected</span>
        <span className="flex items-center gap-1">
          <span className="muted">v1.4.0</span>
          <Tooltip>
            <TooltipTrigger asChild>
              <Button variant="ghost" size="icon-xs" onClick={onNewProject} aria-label="Register project">
                <Plus aria-hidden="true" />
              </Button>
            </TooltipTrigger>
            <TooltipContent side="top">Register project</TooltipContent>
          </Tooltip>
        </span>
      </footer>
      <AlertDialog open={pendingRemove !== null} onOpenChange={(isOpen) => { if (!isOpen) setPendingRemove(null); }}>
        <AlertDialogContent className="max-w-[440px]">
          <AlertDialogHeader>
            <AlertDialogTitle>Remove project?</AlertDialogTitle>
            <AlertDialogDescription>
              Are you sure you want to remove &ldquo;{pendingRemove?.displayLabel}&rdquo;? This will not delete any files on disk.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              className={buttonVariants({ variant: "destructive" })}
              onClick={() => {
                if (pendingRemove && onArchiveProject) onArchiveProject(pendingRemove.id);
                setPendingRemove(null);
              }}
            >
              Remove project
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
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
  onRequestRemoveProject,
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
  onRequestRemoveProject?: (project: Project) => void;
}) {
  const [collapsed, setCollapsed] = useState(false);
  const activeRows = workspaces.filter((workspace) => workspace.projectId === project.id && !workspace.archivedAt);
  const archivedRows = workspaces.filter((workspace) => workspace.projectId === project.id && workspace.archivedAt);
  const [showArchived, setShowArchived] = useState(false);
  const rows = showArchived ? [...activeRows, ...archivedRows] : activeRows;
  return (
    <section className="project">
      <div
        className="project-title group/proj min-w-0"
        onClick={() => setCollapsed(!collapsed)}
        role="button"
        tabIndex={0}
        aria-expanded={!collapsed}
        onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") setCollapsed(!collapsed); }}
      >
        <span className="project-chevron shrink-0" aria-hidden="true">
          {collapsed ? <ChevronRight className="w-3 h-3 text-muted-foreground" /> : <ChevronDown className="w-3 h-3 text-muted-foreground" />}
        </span>
        <Folder className="w-3.5 h-3.5 text-muted-foreground/80 shrink-0" />
        <strong className="min-w-0 flex-1 truncate" title={project.displayLabel}>{project.displayLabel}</strong>
        <code title={project.canonicalRootPath}>{project.canonicalRootPath}</code>
        {onDiscoverWorktrees && (
          <button
            type="button"
            className="opacity-0 group-hover/proj:opacity-100 p-0.5 rounded hover:bg-surface-hover text-muted-foreground hover:text-foreground transition-opacity ml-1 shrink-0"
            onClick={(e) => {
              e.stopPropagation();
              onDiscoverWorktrees(project.id);
            }}
            title="Discover & import worktrees for this project"
          >
            <FolderDown className="w-3 h-3" />
          </button>
        )}
        {onRequestRemoveProject && (
          <button
            type="button"
            className="opacity-0 group-hover/proj:opacity-100 p-0.5 rounded hover:bg-surface-hover text-muted-foreground hover:text-danger transition-opacity ml-1 shrink-0"
            onClick={(e) => {
              e.stopPropagation();
              onRequestRemoveProject(project);
            }}
            title="Remove project"
          >
            <Trash2 className="w-3 h-3" />
          </button>
        )}
      </div>
      {!collapsed && (
        <div className="workspace-list">
          {rows.map((workspace) => {
            const isWorkspaceSelected = workspace.id === selected;
            const workspaceAgents = isWorkspaceSelected ? agents.filter((agent) => agent.workspaceId === workspace.id) : [];
            const workspaceTerminals = isWorkspaceSelected ? terminals.filter((term) => term.workspaceId === workspace.id) : [];
            const hasActiveAgent = workspaceAgents.some((a) => a.status === "running" || a.status === "stopping");

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
                        <b className="truncate text-xs font-medium" title={workspace.displayLabel}>{workspace.displayLabel}</b>
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
                        <small className="text-[10px] text-muted-foreground font-mono truncate block mt-0.5" title={workspace.branchRef}>
                          ⎇ {workspace.branchRef}
                        </small>
                      )}
                      <small className="text-[10px] text-muted-foreground/70 font-mono truncate block" title={workspace.cwd}>
                        {workspace.cwd}
                      </small>
                    </div>
                  </div>

                  {onManageWorkspace && (
                    <span className="flex items-center gap-0.5 opacity-0 group-hover/ws:opacity-100 transition-opacity">
                      <CopyValueButton value={workspace.cwd} label="workspace path" />
                      <button
                        type="button"
                        className="p-0.5 rounded hover:bg-surface-hover text-muted-foreground hover:text-foreground"
                        onClick={(e) => {
                          e.stopPropagation();
                          onManageWorkspace(workspace);
                        }}
                        title="Workspace details and actions"
                        aria-label="Workspace details and actions"
                      >
                        <MoreHorizontal className="w-3.5 h-3.5" />
                      </button>
                    </span>
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
                          className={cn("status-dot dot-sm shrink-0", (agent.status === "running" || agent.status === "stopping") ? "running" : "idle")}
                          aria-hidden="true"
                        />
                        <Bot className="w-3 h-3 text-muted-foreground shrink-0" />
                        <span className="agent-row-title text-xs">{agent.title}</span>
                        <small className={cn("agent-row-meta", (agent.status === "running" || agent.status === "stopping") && "running")}>
                          {agent.status === "stopping" ? "stopping" : agent.status === "running" ? "running" : agent.status}
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
