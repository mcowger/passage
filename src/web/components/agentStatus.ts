import type { AgentSummary } from "../../shared/domain/agents.ts";

export type AgentStatusKind = "idle" | "active" | "attention";

type StatusInput = Pick<AgentSummary, "status"> & {
  pendingUiRequest?: unknown;
};

/**
 * Maps an agent to its dot color kind:
 * - attention (red): waiting on the user (needs-attention status or a pending UI request) or errored
 * - active (green): currently working (initializing, running, stopping)
 * - idle (gray): everything else (idle, archived, no work in flight)
 */
export function getAgentStatusKind(agent: StatusInput): AgentStatusKind {
  if (agent.pendingUiRequest != null) return "attention";
  if (agent.status === "needs-attention" || agent.status === "error") return "attention";
  if (agent.status === "running" || agent.status === "stopping" || agent.status === "initializing") {
    return "active";
  }
  return "idle";
}

/**
 * Workspace dot aggregates its agents with attention > active > idle priority.
 * Empty (no agents) is idle/gray.
 */
export function getWorkspaceStatusKind(agents: StatusInput[]): AgentStatusKind {
  let sawActive = false;
  for (const agent of agents) {
    const kind = getAgentStatusKind(agent);
    if (kind === "attention") return "attention";
    if (kind === "active") sawActive = true;
  }
  return sawActive ? "active" : "idle";
}

export const AGENT_STATUS_LABEL: Record<AgentStatusKind, string> = {
  idle: "Ready",
  active: "Active",
  attention: "Needs attention",
};
