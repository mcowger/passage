/** Live activity state for the composer pill, sourced from the `pi` channel
 *  frame stream rather than from an estimate of streamed text. */

export type StreamPhase =
  | "thinking"
  | "responding"
  | "composing-tool-call"
  | "running-tool"
  | "receiving-tool-result";

export type StreamActivity = {
  /** Epoch ms of the most recent envelope relayed for this agent; 0 until the first frame. */
  lastFrameAt: number;
  /** Latest content phase observed in the frame stream. */
  phase: StreamPhase | null;
};

/** How long after the last relayed frame the pill still counts as receiving. */
export const RECEIVING_ACTIVITY_WINDOW_MS = 1200;

export const STREAM_PHASE_LABELS: Record<StreamPhase, string> = {
  thinking: "thinking",
  responding: "responding",
  "composing-tool-call": "composing tool call",
  "running-tool": "running tool",
  "receiving-tool-result": "receiving tool result",
};

const ASSISTANT_MESSAGE_PHASES: Record<string, StreamPhase> = {
  thinking_start: "thinking",
  thinking_delta: "thinking",
  text_start: "responding",
  text_delta: "responding",
  toolcall_start: "composing-tool-call",
  toolcall_delta: "composing-tool-call",
  toolcall_end: "running-tool",
};

/**
 * Maps one relayed `pi` envelope to an activity phase. Deliberately narrow:
 * lifecycle, status, queue, `row_upsert`, and terminal assistant subtypes all
 * return null so the caller keeps the last meaningful phase instead of
 * blanking the pill between messages.
 */
export function deriveStreamPhase(
  type: string,
  payload: Record<string, unknown> | undefined,
): StreamPhase | null {
  if (type === "message_update") {
    const assistantMessageEvent = payload?.assistantMessageEvent;
    if (!assistantMessageEvent || typeof assistantMessageEvent !== "object" || Array.isArray(assistantMessageEvent)) {
      return null;
    }
    const subtype = (assistantMessageEvent as { type?: unknown }).type;
    return typeof subtype === "string" ? ASSISTANT_MESSAGE_PHASES[subtype] ?? null : null;
  }
  if (type === "tool_execution_start") return "running-tool";
  if (type === "tool_execution_update") return "receiving-tool-result";
  return null;
}
