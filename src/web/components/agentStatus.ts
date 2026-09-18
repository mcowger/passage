import type { AgentSummary } from "../../shared/domain/agents.ts";

export type AgentStatusKind = "empty" | "idle" | "active" | "attention";

type StatusInput = Pick<AgentSummary, "status"> & {
  pendingUiRequest?: unknown;
};

/**
 * Maps an agent to its dot color kind:
 * - attention (red, pulsing): waiting on the user (needs-attention status or a pending UI request) or errored
 * - active (orange, pulsing): currently working (running, stopping)
 * - idle (blue): ready with prior work (idle, archived, no work in flight)
 * - empty (gray): nothing happening yet (initializing)
 */
export function getAgentStatusKind(agent: StatusInput): AgentStatusKind {
  if (agent.pendingUiRequest != null) return "attention";
  if (agent.status === "needs-attention" || agent.status === "error" || agent.status === "interrupted") return "attention";
  if (agent.status === "running" || agent.status === "stopping") {
    return "active";
  }
  if (agent.status === "initializing") return "empty";
  return "idle";
}

/**
 * Workspace dot aggregates its agents with attention > active > idle > empty priority.
 * Empty (no agents, or only initializing agents) is empty/gray.
 */
export function getWorkspaceStatusKind(agents: StatusInput[]): AgentStatusKind {
  let sawActive = false;
  let sawIdle = false;
  for (const agent of agents) {
    const kind = getAgentStatusKind(agent);
    if (kind === "attention") return "attention";
    if (kind === "active") sawActive = true;
    else if (kind === "idle") sawIdle = true;
  }
  if (sawActive) return "active";
  if (sawIdle) return "idle";
  return "empty";
}

export const AGENT_STATUS_LABEL: Record<AgentStatusKind, string> = {
  empty: "Empty",
  idle: "Ready",
  active: "Active",
  attention: "Needs attention",
};
