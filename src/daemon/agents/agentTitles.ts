import type { TimelineItem } from "../../shared/domain/agents.ts";
import type { AgentStatus } from "../../shared/domain/agents.ts";
import { MetadataRepositories } from "../metadata/repositories.ts";
import { AgentRuntime } from "./runtime.ts";
import { AgentTitleSuggester, DEFAULT_AGENT_TITLE } from "./title-suggester.ts";
import { collectTitleSources } from "./serviceHelpers.ts";
import type { AgentServiceEvent } from "./runtime.ts";

export type AgentTitleDeps = {
  repositories: MetadataRepositories;
  runtime: AgentRuntime;
  titleSuggester: Pick<AgentTitleSuggester, "suggestTitle">;
  getSuggestConfig?: (workspaceId: string) => { model?: string; thinkingLevel?: string; titlePrompt?: string } | undefined;
  emit: (event: AgentServiceEvent) => void;
};

/**
 * Fire-and-forget auto-titles from transcript content. Takes the
 * repositories, runtime, suggestion backend, and an emit sink; never throws
 * and never blocks the message path.
 */
export class AgentTitles {
  private readonly repositories: MetadataRepositories;
  private readonly runtime: AgentRuntime;
  private readonly titleSuggester: Pick<AgentTitleSuggester, "suggestTitle">;
  private readonly getSuggestConfig?: (workspaceId: string) => { model?: string; thinkingLevel?: string; titlePrompt?: string } | undefined;
  private readonly emit: (event: AgentServiceEvent) => void;

  constructor(deps: AgentTitleDeps) {
    this.repositories = deps.repositories;
    this.runtime = deps.runtime;
    this.titleSuggester = deps.titleSuggester;
    this.getSuggestConfig = deps.getSuggestConfig;
    this.emit = deps.emit;
  }

  /** Fire-and-forget auto-title: once the transcript holds the first user
   *  message plus the first agent response, asks the workspace's
   *  suggestion model for a 3-4 word title and persists it. Only agents
   *  still carrying the create() placeholder are eligible (a custom
   *  create-time title or an already applied suggestion opts out). Never
   *  throws and never blocks the message path -- failures simply leave the
   *  placeholder in place and retry on the next titlable event. */
  maybeAutoTitle(agentId: string, timeline: TimelineItem[], allowUserOnly = false): void {
    const sources = collectTitleSources(timeline);
    if (sources.length === 0) return;
    if (sources.length === 1 && !allowUserOnly) return;
    const agent = this.repositories.agents.get(agentId);
    if (!agent || agent.archivedAt) return;
    if (agent.titleOverridden || agent.title !== DEFAULT_AGENT_TITLE) return;
    if (this.runtime.titleSuggestions.has(agentId)) return;
    this.runtime.titleSuggestions.add(agentId);
    void (async () => {
      try {
        let model: string | undefined;
        let thinkingLevel: string | undefined;
        let titlePrompt = "";
        try {
          const config = this.getSuggestConfig?.(agent.workspaceId);
          model = config?.model?.trim() || undefined;
          thinkingLevel = config?.thinkingLevel?.trim() || undefined;
          titlePrompt = config?.titlePrompt ?? "";
        } catch { model = undefined; thinkingLevel = undefined; titlePrompt = ""; }
        let cwd: string | undefined;
        try { cwd = this.repositories.workspaces.get(agent.workspaceId)?.cwd; } catch { cwd = undefined; }
        const title = await this.titleSuggester.suggestTitle(sources, cwd, model, thinkingLevel, titlePrompt);
        if (!title) return;
        const current = this.repositories.agents.get(agentId);
        if (!current || current.archivedAt || current.titleOverridden || current.title !== DEFAULT_AGENT_TITLE) return;
        this.repositories.agents.updateTitle(agentId, title);
        const status = (this.repositories.agents.get(agentId)?.lastKnownStatus as AgentStatus) ?? "idle";
        this.emit({ agentId, type: "title", status, payload: { title } });
      } catch {} finally {
        this.runtime.titleSuggestions.delete(agentId);
      }
    })();
  }
}
