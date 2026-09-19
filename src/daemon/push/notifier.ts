import type { AgentService, AgentServiceEvent } from "../agents/service.ts";
import type { WorkspaceService } from "../workspaces/service.ts";
import type { PushService } from "./service.ts";
import { logger } from "../logging.ts";

const log = logger("push");
const MAX_PREVIEW_CHARS = 180;

/** True for the two agreed triggers: needs-attention (incl. error) and
 *  run completion (settled idle). Everything else stays quiet. */
export function shouldNotify(event: AgentServiceEvent): "attention" | "done" | undefined {
  if (event.status === "needs-attention" || event.status === "error") return "attention";
  if (event.type === "settled" && event.status === "idle") return "done";
  // Reconcile paths emit plain status idle after a run; only settled-idle
  // counts as "done" so idle polls never spam.
  return undefined;
}

function previewText(event: AgentServiceEvent): string | undefined {
  const raw = typeof event.error === "string" && event.error.trim() !== "" ? event.error : undefined;
  if (!raw) return undefined;
  const single = raw.replace(/\s+/g, " ").trim();
  return single.length > MAX_PREVIEW_CHARS ? `${single.slice(0, MAX_PREVIEW_CHARS - 1)}…` : single;
}

/** Wire agent status transitions to Web Push fan-out. Never throws into the
 *  agent pipeline: notification failures are logged, never fatal. Respects
 *  the global `notificationsEnabled` setting so turning the toggle off in
 *  Settings stops daemon sends too (not just local Notification). */
export function wireAgentPushNotifications(deps: {
  agentService: AgentService;
  workspaceService: WorkspaceService;
  push: PushService;
}): () => boolean {
  const { agentService, workspaceService, push } = deps;
  return agentService.subscribe((event) => {
    try {
      const kind = shouldNotify(event);
      if (!kind) return;
      if (!push.isConfigured) return;
      const agent = agentService.snapshot(event.agentId);
      let enabled = false;
      let workspaceLabel = agent.workspaceId;
      try {
        const settings = workspaceService.getSettings(agent.workspaceId);
        enabled = settings.notificationsEnabled === true;
      } catch {
        return;
      }
      if (!enabled) return;
      try {
        const snapshot = workspaceService.snapshot();
        workspaceLabel = snapshot.workspaces.find((w) => w.id === agent.workspaceId)?.displayLabel ?? agent.workspaceId;
      } catch {}
      const preview = previewText(event);
      const title = kind === "attention"
        ? `${agent.title} — needs attention`
        : `${agent.title} — done`;
      const body = preview ?? (kind === "attention"
        ? `Agent in ${workspaceLabel} is waiting on you.`
        : `Agent in ${workspaceLabel} finished.`);
      const url = `/?workspaceId=${encodeURIComponent(agent.workspaceId)}&agentId=${encodeURIComponent(agent.id)}&source=push`;
      void push.sendToAll({
        title: title.slice(0, 128),
        body: body.slice(0, 512),
        tag: `agent-${agent.id}-${kind}`,
        url,
        workspaceId: agent.workspaceId,
        agentId: agent.id,
      }).catch(() => undefined);
    } catch (error) {
      log.warn("Agent push notify failed", { event: "push.notify_failed" });
    }
  });
}
