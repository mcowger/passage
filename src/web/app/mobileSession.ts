import type { AgentSummary } from "../../shared/domain/agents.ts";
import type { TerminalSummary } from "../../shared/domain/terminals.ts";
import type { WebPreview } from "../../shared/domain/previews.ts";
import type { MobileDestinationKind, MobileReturn } from "../components/MobileNav.tsx";
import { AGENT_STATUS_LABEL, getAgentStatusKind } from "../components/agentStatus.ts";
import type { TabKind } from "./appHelpers.tsx";

export type MobileSessionState = {
  activeTab: TabKind;
  agents: AgentSummary[];
  selectedAgentId: string | undefined;
  terminals: TerminalSummary[];
  selectedTerminalId: string | undefined;
  previews: WebPreview[];
  selectedPreviewId: string | undefined;
  openEditorPath: string | undefined;
  openDiffPath: string | undefined;
};

// Mobile return stack: leaving a working destination for Files, an editor,
// or another surface records where "Back to ..." should return. Explicit
// jumps (switcher, back button, selecting the agent) clear it.
export function resolveMobileReturn(state: MobileSessionState): MobileReturn | null {
  const { activeTab, agents, selectedAgentId, terminals, selectedTerminalId, previews, selectedPreviewId } = state;
    if (activeTab === "agent") {
      const target = agents.find((agent) => agent.id === selectedAgentId) ?? agents[0];
      if (!target) return null;
      return { kind: "agent", targetId: target.id, label: target.title };
    }
    if (activeTab === "terminal") {
      const target = terminals.find((t) => t.id === selectedTerminalId) ?? terminals[0];
      if (!target) return null;
      return { kind: "terminal", targetId: target.id, label: target.title };
    }
    if (activeTab === "preview") {
      const target = previews.find((p) => p.id === selectedPreviewId) ?? previews[0];
      if (!target) return null;
      return { kind: "preview", targetId: target.id, label: target.label };
    }
    if (activeTab === "explorer") return { kind: "explorer", label: "Files" };
    if (activeTab === "changes") return { kind: "changes", label: "Changes" };
    if (activeTab === "overview") return { kind: "overview", label: "Overview" };
    return null;
}

export function resolveMobileDest(state: MobileSessionState): {
  kind: MobileDestinationKind;
  title: string;
  meta?: string;
} {
  const {
    activeTab,
    agents,
    selectedAgentId,
    terminals,
    selectedTerminalId,
    previews,
    selectedPreviewId,
    openEditorPath,
    openDiffPath,
  } = state;
    if (activeTab === "agent") {
      const current = agents.find((a) => a.id === selectedAgentId) ?? agents[0];
      return current
        ? { kind: "agent", title: current.title, meta: AGENT_STATUS_LABEL[getAgentStatusKind(current)] }
        : { kind: "agent", title: "Agent" };
    }
    if (activeTab === "terminal") {
      const current = terminals.find((t) => t.id === selectedTerminalId) ?? terminals[0];
      return { kind: "terminal", title: current?.title ?? "Terminal" };
    }
    if (activeTab === "preview") {
      const current = previews.find((p) => p.id === selectedPreviewId) ?? previews[0];
      return { kind: "preview", title: current?.label ?? "Preview" };
    }
    if (activeTab === "explorer") return { kind: "explorer", title: "Files" };
    if (activeTab === "changes") return { kind: "changes", title: "Changes" };
    if (activeTab === "overview") return { kind: "overview", title: "Overview" };
    if (activeTab === "editor") {
      return { kind: "editor", title: openEditorPath?.split("/").pop() ?? "Editor" };
    }
    return { kind: "diff", title: openDiffPath ? `Diff: ${openDiffPath.split("/").pop()}` : "Diff" };
}
