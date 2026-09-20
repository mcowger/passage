import { pickPreviewTargetUrl } from "../../shared/preview-target.ts";
import { errorFields, logger } from "../logging.ts";

/** Minimal preview surface the agent runtime needs. `WebPreviewManager`
 *  satisfies this structurally; tests use in-memory fakes. */
export type AgentPreviewBackend = {
  list(workspaceId: string): { id: string }[];
  sessionName(id: string): string;
  portCandidates(
    workspaceId: string,
    excludedPorts?: number[],
  ): Promise<{ port: number; confidence: "high" | "uncertain"; source: "script" | "process" }[]>;
  create(workspaceId: string, input: { label?: string; targetUrl: string }): Promise<{ id: string }>;
  open(id: string): Promise<unknown>;
};

export type AgentPreviewSupport = {
  /** Pin this session into a new Pi process when the workspace has exactly
   *  one preview, else null (ambiguity resolves with the shim, not env). */
  sessionForWorkspace(workspaceId: string): string | null;
  /** Create (+background-open) the default preview when the workspace has
   *  none. Idempotent per workspace, never throws, never blocks the caller
   *  on Chromium launch. */
  ensurePreviewForWorkspace(workspaceId: string): Promise<void>;
};

const AUTO_OPEN_LABEL = "Agent preview";

export function createAgentPreviewSupport(
  backend: AgentPreviewBackend,
  options?: { serverPort?: number },
): AgentPreviewSupport {
  const inflight = new Map<string, Promise<void>>();
  return {
    sessionForWorkspace(workspaceId) {
      try {
        const rows = backend.list(workspaceId);
        if (rows.length !== 1) return null;
        return backend.sessionName(rows[0].id);
      } catch {
        return null;
      }
    },
    ensurePreviewForWorkspace(workspaceId) {
      const running = inflight.get(workspaceId);
      if (running) return running;
      const work = (async () => {
        try {
          if (backend.list(workspaceId).length > 0) return;
          const candidates = await backend.portCandidates(
            workspaceId,
            options?.serverPort !== undefined ? [options.serverPort] : [],
          );
          const targetUrl = pickPreviewTargetUrl(candidates);
          const created = await backend.create(workspaceId, { label: AUTO_OPEN_LABEL, targetUrl });
          // Open in the background: Chromium launch must not block the
          // agent's first message. The row already exists, so the spawn env
          // pins the session; the manager reconciles the stream on open.
          void backend.open(created.id).catch((cause: unknown) => {
            logger("preview").warn("Agent preview auto-open failed", {
              event: "preview.auto_open_failed",
              previewId: created.id,
              ...errorFields(cause),
            });
          });
        } catch (cause) {
          logger("preview").warn("Agent preview auto-open failed", {
            event: "preview.auto_open_failed",
            workspaceId,
            ...errorFields(cause),
          });
        } finally {
          // Only this work can hold the slot (a successor starts after
          // this entry is gone), so an unconditional delete is safe.
          inflight.delete(workspaceId);
        }
      })();
      inflight.set(workspaceId, work);
      return work;
    },
  };
}
