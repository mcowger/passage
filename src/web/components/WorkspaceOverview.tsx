import { useState } from "react";
import { Archive, ArchiveRestore, Bot, FolderOpen, GitBranch, Globe, Plus, Terminal as TerminalIcon } from "lucide-react";
import type { AgentSummary } from "../../shared/domain/agents.ts";
import type { TerminalSummary } from "../../shared/domain/terminals.ts";
import type { WebPreview } from "../../shared/domain/previews.ts";
import type { Project, Workspace } from "../../shared/domain/workspaces.ts";
import { Button } from "./ui/button.tsx";
import { CopyValueButton } from "./CopyValueButton.tsx";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "./ui/card.tsx";
import { Alert, AlertDescription } from "./ui/alert.tsx";
import { Spinner } from "./ui/spinner.tsx";

export type WorkspaceOverviewProps = {
  workspace: Workspace;
  project?: Project;
  agents: AgentSummary[];
  terminals: TerminalSummary[];
  previews: WebPreview[];
  isGitWorkspace: boolean;
  agentError?: string;
  autoStartingAgent?: boolean;
  onNewAgent: () => void;
  onOpenAgent: (id: string) => void;
  onListArchivedAgents: () => Promise<AgentSummary[]>;
  onReopenAgent: (id: string) => Promise<AgentSummary>;
  onNewTerminal: () => void;
  onOpenFiles: () => void;
  onOpenChanges: () => void;
  onNewPreview: () => void;
};

export function WorkspaceOverview({
  workspace,
  project,
  agents,
  terminals,
  previews,
  isGitWorkspace,
  agentError,
  autoStartingAgent,
  onNewAgent,
  onOpenAgent,
  onListArchivedAgents,
  onReopenAgent,
  onNewTerminal,
  onOpenFiles,
  onOpenChanges,
  onNewPreview,
}: WorkspaceOverviewProps) {
  const showStarting = autoStartingAgent && agents.length === 0;
  const [archivedOpen, setArchivedOpen] = useState(false);
  const [archivedAgents, setArchivedAgents] = useState<AgentSummary[] | null>(null);
  const [archivedLoading, setArchivedLoading] = useState(false);
  const [archivedError, setArchivedError] = useState("");
  const [reopeningId, setReopeningId] = useState<string | null>(null);

  const toggleArchived = () => {
    if (archivedOpen) {
      setArchivedOpen(false);
      return;
    }
    setArchivedOpen(true);
    // Always refetch on open: agents archived elsewhere (e.g. closing a
    // canvas tab) must show up without a page reload.
    setArchivedLoading(true);
    setArchivedError("");
    void onListArchivedAgents()
      .then((next) => setArchivedAgents(next))
      .catch((cause) => setArchivedError(cause instanceof Error ? cause.message : "Unable to load archived agents"))
      .finally(() => setArchivedLoading(false));
  };

  const handleReopen = (agentId: string) => {
    setReopeningId(agentId);
    setArchivedError("");
    void onReopenAgent(agentId)
      .then(() => {
        setArchivedAgents((current) => current?.filter((agent) => agent.id !== agentId) ?? current);
        onOpenAgent(agentId);
      })
      .catch((cause) => setArchivedError(cause instanceof Error ? cause.message : "Unable to restore agent"))
      .finally(() => setReopeningId(null));
  };

  return (
    <div className="mx-auto flex w-full max-w-3xl flex-1 flex-col gap-4 overflow-y-auto p-6" aria-label="Workspace overview">
      <div className="flex flex-col gap-1">
        <p className="text-xs uppercase tracking-wider text-muted-foreground font-semibold">Workspace overview</p>
        <h1 className="text-xl font-semibold text-foreground">{workspace.displayLabel}</h1>
        <p className="flex items-center gap-1 text-xs text-muted-foreground font-mono min-w-0">
          <span className="truncate" title={workspace.cwd}>
            {project?.displayLabel ? `${project.displayLabel} / ` : ""}{workspace.cwd}
          </span>
          <CopyValueButton value={workspace.cwd} label="workspace path" />
        </p>
        {workspace.branchRef && (
          <p className="flex items-center gap-1 text-xs text-muted-foreground font-mono min-w-0">
            <span className="truncate" title={workspace.branchRef}>
              ⎇ {workspace.branchRef}
            </span>
            <CopyValueButton value={workspace.branchRef} label="branch name" />
          </p>
        )}
        <p className="text-xs text-muted-foreground">
          {agents.length} agent{agents.length === 1 ? "" : "s"} · {terminals.length} terminal{terminals.length === 1 ? "" : "s"} · {previews.length} preview{previews.length === 1 ? "" : "s"}
        </p>
      </div>

      {agentError && (
        <Alert variant="destructive">
          <AlertDescription className="text-xs">{agentError}</AlertDescription>
        </Alert>
      )}

      {showStarting ? (
        <Card>
          <CardContent className="flex items-center gap-2 py-5 text-sm text-muted-foreground">
            <Spinner className="size-4" aria-hidden="true" />
            <span role="status">Starting agent session…</span>
          </CardContent>
        </Card>
      ) : (
        <Card>
          <CardHeader>
            <CardTitle className="text-sm">Start working</CardTitle>
            <CardDescription>An agent session is already running for new workspaces. Pick up where you left off or start fresh.</CardDescription>
          </CardHeader>
          <CardContent className="flex flex-wrap gap-2">
            <Button size="sm" onClick={onNewAgent} aria-label="Start new agent session">
              <Plus aria-hidden="true" /> New agent
            </Button>
            <Button size="sm" variant="secondary" onClick={onNewTerminal}>
              <TerminalIcon aria-hidden="true" /> New terminal
            </Button>
            <Button size="sm" variant="secondary" onClick={onOpenFiles}>
              <FolderOpen aria-hidden="true" /> Files
            </Button>
            {isGitWorkspace && (
              <Button size="sm" variant="secondary" onClick={onOpenChanges}>
                <GitBranch aria-hidden="true" /> Changes
              </Button>
            )}
            <Button size="sm" variant="secondary" onClick={onNewPreview}>
              <Globe aria-hidden="true" /> Preview
            </Button>
          </CardContent>
        </Card>
      )}

      <div className="grid gap-4 md:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-1.5 text-sm">
              <Bot className="size-4 text-muted-foreground" aria-hidden="true" /> Agents
            </CardTitle>
            <CardDescription>{agents.length === 0 ? "No agent sessions yet." : `${agents.length} session${agents.length === 1 ? "" : "s"} in this workspace.`}</CardDescription>
          </CardHeader>
          <CardContent className="flex flex-col gap-1.5">
            {agents.slice(0, 5).map((agent) => (
              <button
                key={agent.id}
                type="button"
                onClick={() => onOpenAgent(agent.id)}
                className="flex items-center justify-between gap-2 rounded-md border border-border px-2.5 py-1.5 text-left text-xs hover:bg-surface-hover"
              >
                <span className="min-w-0 flex-1 truncate font-medium text-foreground" title={agent.title}>{agent.title}</span>
                <span className="shrink-0 text-[11px] text-muted-foreground">{agent.status}</span>
              </button>
            ))}
            {agents.length === 0 && !showStarting && (
              <p className="text-xs text-muted-foreground">Start an agent to begin a conversation.</p>
            )}
            {agents.length > 5 && (
              <p className="text-[11px] text-muted-foreground">+ {agents.length - 5} more in the sidebar</p>
            )}
            <div className="mt-1 border-t border-border pt-1.5">
              <button
                type="button"
                onClick={toggleArchived}
                aria-expanded={archivedOpen}
                aria-label={archivedOpen ? "Hide archived agents" : "View archived agents"}
                className="flex w-full items-center gap-1.5 rounded-md px-2.5 py-1.5 text-left text-xs text-muted-foreground hover:bg-surface-hover hover:text-foreground"
              >
                <Archive className="size-3.5" aria-hidden="true" />
                {archivedOpen ? "Hide archived agents" : "View archived agents"}
              </button>
              {archivedOpen && (
                <div className="flex flex-col gap-1.5 px-1 pt-1.5">
                  {archivedLoading && (
                    <p className="flex items-center gap-2 px-1.5 py-1 text-xs text-muted-foreground">
                      <Spinner className="size-3.5" aria-hidden="true" />
                      <span role="status">Loading archived agents…</span>
                    </p>
                  )}
                  {archivedError && (
                    <p role="alert" className="rounded-md border border-destructive/40 px-2.5 py-1.5 text-xs text-destructive">{archivedError}</p>
                  )}
                  {!archivedLoading && !archivedError && archivedAgents?.length === 0 && (
                    <p className="px-1.5 py-1 text-xs text-muted-foreground">No archived agents in this workspace.</p>
                  )}
                  {archivedAgents?.map((agent) => (
                    <div
                      key={agent.id}
                      className="flex items-center justify-between gap-2 rounded-md border border-border px-2.5 py-1.5 text-xs"
                    >
                      <span className="min-w-0 flex-1 truncate font-medium text-foreground" title={agent.title}>{agent.title}</span>
                      <Button
                        size="xs"
                        variant="secondary"
                        disabled={reopeningId !== null}
                        onClick={() => handleReopen(agent.id)}
                        aria-label={`Restore agent ${agent.title}`}
                      >
                        {reopeningId === agent.id ? (
                          <Spinner className="size-3" aria-hidden="true" />
                        ) : (
                          <ArchiveRestore className="size-3" aria-hidden="true" />
                        )}
                        Restore
                      </Button>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="text-sm">Workspace surfaces</CardTitle>
            <CardDescription>Jump to files, review changes, or open a live preview.</CardDescription>
          </CardHeader>
          <CardContent className="flex flex-col gap-1.5 text-xs">
            <button type="button" onClick={onOpenFiles} className="flex items-center gap-2 rounded-md border border-border px-2.5 py-1.5 text-left hover:bg-surface-hover">
              <FolderOpen className="size-3.5 text-muted-foreground" aria-hidden="true" />
              <span><span className="font-medium text-foreground">Browse files</span> <span className="text-muted-foreground">— explorer &amp; editor</span></span>
            </button>
            {isGitWorkspace ? (
              <button type="button" onClick={onOpenChanges} className="flex items-center gap-2 rounded-md border border-border px-2.5 py-1.5 text-left hover:bg-surface-hover">
                <GitBranch className="size-3.5 text-muted-foreground" aria-hidden="true" />
                <span><span className="font-medium text-foreground">Review changes</span> <span className="text-muted-foreground">— status &amp; diffs</span></span>
              </button>
            ) : (
              <p className="rounded-md border border-border px-2.5 py-1.5 text-muted-foreground">Not inside a Git repository — changes unavailable.</p>
            )}
            <button type="button" onClick={onNewTerminal} className="flex items-center gap-2 rounded-md border border-border px-2.5 py-1.5 text-left hover:bg-surface-hover">
              <TerminalIcon className="size-3.5 text-muted-foreground" aria-hidden="true" />
              <span><span className="font-medium text-foreground">Open terminal</span> <span className="text-muted-foreground">— {terminals.length} running</span></span>
            </button>
            <button type="button" onClick={onNewPreview} className="flex items-center gap-2 rounded-md border border-border px-2.5 py-1.5 text-left hover:bg-surface-hover">
              <Globe className="size-3.5 text-muted-foreground" aria-hidden="true" />
              <span><span className="font-medium text-foreground">Live preview</span> <span className="text-muted-foreground">— {previews.length} running</span></span>
            </button>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
