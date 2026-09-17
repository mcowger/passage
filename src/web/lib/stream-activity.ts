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
  /** Total `pi` envelopes relayed for the current run. Proves liveness even when chunks are tiny. */
  frames: number;
  /** Total UTF-8 bytes of relayed envelopes for the current run (wire-level, proves data is flowing). */
  bytes: number;
};

/** Fresh activity holder for the start of a run. */
export function emptyStreamActivity(): StreamActivity {
  return { lastFrameAt: 0, phase: null, frames: 0, bytes: 0 };
}

/**
 * Records one relayed envelope in place. Kept as a mutating helper because
 * the holder lives in a ref sampled on the pill's interval -- never state,
 * so a frame burst never adds a render.
 */
export function trackStreamFrame(activity: StreamActivity, byteLength: number, phase: StreamPhase | null): void {
  activity.lastFrameAt = Date.now();
  activity.frames += 1;
  if (Number.isSafeInteger(byteLength) && byteLength > 0) activity.bytes += byteLength;
  if (phase) activity.phase = phase;
}

/** UTF-8 byte length of one relayed envelope value (best-effort, never throws). */
export function measureEnvelopeBytes(value: unknown): number {
  try {
    const json = JSON.stringify(value);
    if (typeof json !== "string") return 0;
    return new TextEncoder().encode(json).byteLength;
  } catch {
    return 0;
  }
}

/** Compact human-readable byte count for the pill (`842 B`, `12.4 KB`, `3.1 MB`). */
export function formatByteCount(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return "0 B";
  if (bytes < 1024) return `${Math.round(bytes)} B`;
  const kb = bytes / 1024;
  if (kb < 1024) return `${kb >= 100 ? Math.round(kb) : kb.toFixed(1)} KB`;
  const mb = kb / 1024;
  if (mb < 1024) return `${mb >= 100 ? Math.round(mb) : mb.toFixed(1)} MB`;
  const gb = mb / 1024;
  return `${gb >= 100 ? Math.round(gb) : gb.toFixed(1)} GB`;
}

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
