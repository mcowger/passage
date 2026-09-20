import type { AgentSummary } from "../../shared/domain/agents.ts";

export type AgentStatusKind = "empty" | "idle" | "active" | "attention";

type StatusInput = Pick<AgentSummary, "status" | "interruptedByRestart"> & {
  pendingUiRequest?: unknown;
};

/**
 * Maps an agent to its dot color kind:
 * - attention (red, pulsing): waiting on the user (needs-attention status or a pending UI request), errored,
 *   or genuinely interrupted mid-life (process lost while the daemon was up)
 * - active (orange, pulsing): currently working (running, stopping)
 * - idle (blue): ready with prior work (idle, archived, no work in flight)
 * - empty (gray): nothing happening yet (initializing) or interrupted by a
 *   daemon restart (expected process loss; resuming needs a manual retry,
 *   not urgent attention)
 */
export function getAgentStatusKind(agent: StatusInput): AgentStatusKind {
  if (agent.pendingUiRequest != null) return "attention";
  if (agent.status === "needs-attention" || agent.status === "error") return "attention";
  if (agent.status === "interrupted") return agent.interruptedByRestart === true ? "empty" : "attention";
  if (agent.status === "running" || agent.status === "stopping") {
    return "active";
  }
  if (agent.status === "initializing") return "empty";
  return "idle";
}

/**
 * Workspace dot aggregates its agents with attention > active > idle > empty priority.
 * Empty (no agents, or only initializing / restart-interrupted agents) is empty/gray.
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
