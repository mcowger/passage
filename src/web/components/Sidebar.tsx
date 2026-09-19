import { useState } from "react";
import type { Project, Workspace, WorkspaceSnapshot } from "../../shared/domain/workspaces.ts";
import type { AgentSummary } from "../../shared/domain/agents.ts";
import { Button } from "./ui/button.tsx";
import { CopyValueButton } from "./CopyValueButton.tsx";
import {
  Folder,
  FolderDown,
  GitBranch,
  ChevronDown,
  ChevronRight,
  MoreHorizontal,
  Trash2,
  Plus,
  PauseCircle,
} from "lucide-react";
import { cn } from "../lib/utils.ts";
import type { BuildInfo } from "../../shared/build-info.ts";
import { formatBuildDetail, formatBuildLabel } from "../../shared/build-info.ts";
import type { DaemonLifecycleSnapshot } from "../api.ts";
import type { ConnectionHealth } from "../socketLifecycle.ts";
import { WsHealthIndicator } from "./WsHealthIndicator.tsx";
import { AGENT_STATUS_LABEL, getWorkspaceStatusKind, type AgentStatusKind } from "./agentStatus.ts";
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
  open: boolean;
  onClose: () => void;
  onSelect: (id: string) => void;
  onNewProject: () => void;
  onNewWorktree?: (projectId: string) => void;
  agents: AgentSummary[];
  /** At-a-glance activity per workspace from `GET /api/agents/status-by-workspace`.
   *  Covers ALL workspaces; `agents` only carries the selected workspace's
   *  agents, which is why every non-selected dot used to render grey until
   *  clicked. Absent entries (or an absent map) fall back to `agents`. */
  workspaceStatuses?: Record<string, AgentStatusKind>;
  onManageWorkspace?: (workspace: Workspace) => void;
  onDiscoverWorktrees?: (projectId?: string) => void;
  onArchiveProject?: (id: string) => void;
  build?: BuildInfo | null;
  /** Absent/null hides the drain control entirely rather than showing a misleading default phase. */
  daemon?: DaemonLifecycleSnapshot | null;
  daemonBusy?: boolean;
  onBeginDrain?: () => void;
  onCancelDrain?: () => void;
  /** Real `/ws` heartbeat status (docs/IOSWEBSOCKETS.md), not assumed
   *  connected. Absent renders the same as "checking" -- never a false
   *  "Connected" before the first heartbeat lands. */
  wsHealth?: ConnectionHealth;
};

const DAEMON_PHASE_LABEL: Record<DaemonLifecycleSnapshot["phase"], string> = {
  running: "Running",
  draining: "Draining\u2026",
  ready: "Ready to stop",
  stopping: "Stopping\u2026",
};

/** Maintenance-mode control: begin/cancel drain and a truthful, bounded
 *  drain and a truthful, bounded view of what is still blocking readiness.
 *  Draining itself stops nothing -- it only closes new-work admission --
 *  so this is deliberately understated next to the build/version footer,
 *  not a full-screen takeover. Distinguishes "daemon draining" from "Pi
 *  failed": blockers are agent activity, not errors. */
function DaemonDrainControl({ daemon, busy, onBeginDrain, onCancelDrain }: {
  daemon: DaemonLifecycleSnapshot;
  busy?: boolean;
  onBeginDrain?: () => void;
  onCancelDrain?: () => void;
}) {
  const draining = daemon.phase === "draining" || daemon.phase === "ready";
  if (!draining) {
    return (
      <Tooltip>
        <TooltipTrigger asChild>
          <Button variant="ghost" size="icon-xs" onClick={onBeginDrain} disabled={busy || daemon.phase === "stopping"} aria-label="Begin daemon drain for maintenance">
            <PauseCircle aria-hidden="true" />
          </Button>
        </TooltipTrigger>
        <TooltipContent side="top">Begin drain (stop accepting new agent work)</TooltipContent>
      </Tooltip>
    );
  }
  const blockerSummary = daemon.blockers.length > 0
    ? `Waiting on ${daemon.blockedCount} agent${daemon.blockedCount === 1 ? "" : "s"}: ${daemon.blockers.slice(0, 5).map((blocker) => `${blocker.agentId} (${blocker.reason})`).join(", ")}${daemon.blockersTruncated ? "\u2026" : ""}`
    : "No agent work is blocking readiness.";
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          type="button"
          className="footer-status daemon-drain-status"
          onClick={onCancelDrain}
          disabled={busy}
          aria-label={`${DAEMON_PHASE_LABEL[daemon.phase]}. ${blockerSummary} Activate to cancel drain.`}
        >
          <span className={cn("connected-dot", daemon.phase === "ready" ? "idle" : "active")} aria-hidden="true" />
          {DAEMON_PHASE_LABEL[daemon.phase]}{daemon.blockedCount > 0 ? ` (${daemon.blockedCount})` : ""}
        </button>
      </TooltipTrigger>
      <TooltipContent side="top">{blockerSummary} Click to cancel drain.</TooltipContent>
    </Tooltip>
  );
}

export function Sidebar({
  data,
  selected,
  open,
  onClose,
  onSelect,
  onNewProject,
  onNewWorktree,
  agents,
  workspaceStatuses,
  onManageWorkspace,
  onDiscoverWorktrees,
  onArchiveProject,
  build,
  daemon,
  daemonBusy,
  onBeginDrain,
  onCancelDrain,
  wsHealth,
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
      <div className="side-label">Projects &amp; Worktrees</div>
      <div className="project-list">
        {activeProjects.map((project) => (
          <ProjectRow
            key={project.id}
            project={project}
            workspaces={data.workspaces}
            selected={selected}
            agents={agents}
            onSelect={onSelect}
            onManageWorkspace={onManageWorkspace}
            onNewWorktree={onNewWorktree}
            onDiscoverWorktrees={onDiscoverWorktrees}
            onRequestRemoveProject={onArchiveProject ? setPendingRemove : undefined}
            workspaceStatuses={workspaceStatuses}
          />
        ))}
      </div>
      {activeProjects.length === 0 && <p className="muted side-empty">No active projects registered yet.</p>}
      <footer>
        <WsHealthIndicator health={wsHealth} />
        {daemon && <DaemonDrainControl daemon={daemon} busy={daemonBusy} onBeginDrain={onBeginDrain} onCancelDrain={onCancelDrain} />}
        <span className="flex items-center gap-1">
          <span
            className="muted"
            title={build ? formatBuildDetail(build) : undefined}
          >
            {build ? formatBuildLabel(build) : "dev"}
          </span>
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
  agents,
  workspaceStatuses,
  onSelect,
  onManageWorkspace,
  onNewWorktree,
  onDiscoverWorktrees,
  onRequestRemoveProject,
}: {
  project: Project;
  workspaces: Workspace[];
  selected?: string;
  agents: AgentSummary[];
  workspaceStatuses?: Record<string, AgentStatusKind>;
  onSelect: (id: string) => void;
  onManageWorkspace?: (workspace: Workspace) => void;
  onNewWorktree?: (projectId: string) => void;
  onDiscoverWorktrees?: (projectId?: string) => void;
  onRequestRemoveProject?: (project: Project) => void;
}) {
  const collapsedKey = `passage:project-collapsed:${project.id}`;
  const [collapsedOverride, setCollapsedOverride] = useState<boolean | null>(() => {
    try {
      if (typeof window === "undefined" || typeof localStorage === "undefined") return null;
      const raw = localStorage.getItem(collapsedKey);
      if (raw === "1") return true;
      if (raw === "0") return false;
      return null;
    } catch {
      return null;
    }
  });
  const isDefaultWorkspace = (workspace: Workspace) =>
    workspace.kind !== "worktree" && workspace.cwd === project.canonicalRootPath;
  const byLabel = (a: Workspace, b: Workspace) => {
    const defaultDelta = Number(isDefaultWorkspace(b)) - Number(isDefaultWorkspace(a));
    if (defaultDelta !== 0) return defaultDelta;
    return a.displayLabel.localeCompare(b.displayLabel);
  };
  const activeRows = workspaces
    .filter((workspace) => workspace.projectId === project.id && !workspace.archivedAt)
    .sort(byLabel);
  const archivedRows = workspaces
    .filter((workspace) => workspace.projectId === project.id && workspace.archivedAt)
    .sort(byLabel);
  const [showArchived, setShowArchived] = useState(false);
  const rows = showArchived ? [...activeRows, ...archivedRows] : activeRows;
  // Default-only projects (no real worktrees) start collapsed to cut noise.
  // An explicit user toggle wins and is persisted per project; otherwise the
  // default follows the current rows so a new worktree auto-expands.
  const defaultCollapsed = !activeRows.some((workspace) => !isDefaultWorkspace(workspace));
  const collapsed = collapsedOverride ?? defaultCollapsed;
  const setCollapsed = (next: boolean) => {
    setCollapsedOverride(next);
    try {
      localStorage.setItem(collapsedKey, next ? "1" : "0");
    } catch {
      /* storage unavailable (private mode, SSR) -- session state still works */
    }
  };
  return (
    <section className="project">
      <div
        className="project-title group/proj min-w-0"
        onClick={() => setCollapsed(!collapsed)}
        role="button"
        tabIndex={0}
        aria-expanded={!collapsed}
        onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); setCollapsed(!collapsed); } }}
      >
        <span className="project-chevron shrink-0" aria-hidden="true">
          {collapsed ? <ChevronRight className="w-3 h-3 text-muted-foreground" /> : <ChevronDown className="w-3 h-3 text-muted-foreground" />}
        </span>
        <Folder className="w-3.5 h-3.5 text-muted-foreground/80 shrink-0" />
        <strong className="min-w-0 flex-1 truncate" title={project.displayLabel}>{project.displayLabel}</strong>
        {onNewWorktree && (
          <button
            type="button"
            className="project-new-hover opacity-0 group-hover/proj:opacity-100 focus-visible:opacity-100 p-0.5 rounded hover:bg-surface-hover text-muted-foreground hover:text-foreground transition-opacity ml-1 shrink-0"
            onClick={(e) => {
              e.stopPropagation();
              onNewWorktree(project.id);
            }}
            title="New worktree"
            aria-label={`New worktree in ${project.displayLabel}`}
          >
            <Plus className="w-3 h-3" />
          </button>
        )}
        {onDiscoverWorktrees && (
          <button
            type="button"
            className="opacity-0 group-hover/proj:opacity-100 focus-visible:opacity-100 touch-visible p-0.5 rounded hover:bg-surface-hover text-muted-foreground hover:text-foreground transition-opacity ml-1 shrink-0"
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
            className="opacity-0 group-hover/proj:opacity-100 focus-visible:opacity-100 touch-visible p-0.5 rounded hover:bg-surface-hover text-muted-foreground hover:text-danger transition-opacity ml-1 shrink-0"
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
            // The selected workspace's agents are loaded live and are the
            // freshest signal; every other workspace has no agents loaded
            // (only the selected workspace is fetched), so it MUST use the
            // aggregated map -- otherwise it renders grey until clicked.
            const workspaceAgents = agents.filter(
              (agent) => agent.workspaceId === workspace.id
            );
            const liveKind = workspaceAgents.length > 0 ? getWorkspaceStatusKind(workspaceAgents) : undefined;
            const statusKind = isWorkspaceSelected
              ? (liveKind ?? workspaceStatuses?.[workspace.id] ?? "empty")
              : (workspaceStatuses?.[workspace.id] ?? liveKind ?? "empty");
            const statusLabel = workspace.archivedAt ? "Archived" : AGENT_STATUS_LABEL[statusKind];

            return (
              <div className="workspace-group group/ws" key={workspace.id}>
                <div
                  className={cn(
                    "workspace-row group flex items-center justify-between",
                    isWorkspaceSelected && "selected"
                  )}
                  onClick={() => onSelect(workspace.id)}
                  role="button"
                  tabIndex={0}
                >
                  <div className="flex items-center gap-1.5 min-w-0 flex-1">
                    <span
                      className={cn("status-dot shrink-0", statusKind)}
                      aria-label={statusLabel}
                      title={statusLabel}
                    />
                    {workspace.kind === "worktree" ? (
                      <GitBranch className="w-3 h-3 text-muted-foreground/70 shrink-0" />
                    ) : (
                      <Folder className="w-3 h-3 text-muted-foreground/70 shrink-0" />
                    )}
                    <div className="workspace-copy min-w-0 flex-1">
                      <div className="flex items-center gap-1 leading-tight">
                        <b className="truncate text-xs font-medium" title={workspace.displayLabel}>{workspace.displayLabel}</b>
                        {isDefaultWorkspace(workspace) ? (
                          <span className="text-[9px] px-1 py-0.2 rounded bg-primary/10 text-primary font-medium shrink-0">
                            default
                          </span>
                        ) : null}
                        {workspace.archivedAt && (
                          <span className="text-[9px] px-1 py-0.2 rounded bg-amber-500/15 text-amber-600 font-medium shrink-0">
                            archived
                          </span>
                        )}
                      </div>
                    </div>
                  </div>

                  {onManageWorkspace && (
                    <span className="flex items-center gap-0.5 opacity-0 group-hover/ws:opacity-100 focus-within:opacity-100 touch-visible transition-opacity">
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
          {rows.length === 0 && <p className="muted project-empty">No worktrees yet</p>}
          {onNewWorktree && (
            <button
              type="button"
              className="new-worktree-row text-[11px] text-muted-foreground hover:text-foreground transition-colors px-2 py-1 mt-0.5 text-left items-center gap-1 cursor-pointer"
              onClick={(e) => {
                e.stopPropagation();
                onNewWorktree(project.id);
              }}
            >
              <Plus className="w-3 h-3" /> New worktree
            </button>
          )}
        </div>
      )}
    </section>
  );
}
