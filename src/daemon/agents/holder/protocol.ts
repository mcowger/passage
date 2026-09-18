/** Holder wire protocol (see docs/ORHPANS.md).
 *
 * Two frame classes over one per-agent Unix socket, both LF-delimited JSON
 * objects (split only on LF, allow one trailing CR — same rule as the Pi
 * framing):
 *
 * 1. Data frames: verbatim Pi records in both directions. The holder adds
 *    nothing except buffering (holder-side sequence numbers live in the
 *    envelope only for replay accounting, never inside the Pi record).
 * 2. Control frames (`type: "passage_*"` namespace, never forwarded to pi).
 */
export const HOLDER_VERSION = 1;

/** `passage pi-holder` subcommand name (argv[2]). */
export const HOLDER_ARGV = "pi-holder";

export const HOLDER_SOCKET_NAME = "rpc.sock";
export const HOLDER_PID_NAME = "holder.pid";
export const HOLDER_META_NAME = "holder.json";
export const HOLDER_LOG_NAME = "holder.log";

/** Validated agent IDs only — also used for systemd scope names. */
export const AGENT_ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;

export type HolderMeta = {
  agentId: string;
  sessionId: string;
  generation: number;
  holderVersion: number;
  startedAt: string;
  socketPath: string;
  pid: number;
};

export type HolderHello = {
  type: "passage_hello";
  agentId: string;
  holderVersion: number;
  /** Highest holderSeq the daemon has already seen (resume offset). */
  after?: number;
  /** Opaque daemon-side ID used only to correlate connection diagnostics. */
  connectionId?: string;
};

export type HolderHelloAck = {
  type: "passage_hello_ack";
  agentId: string;
  holderVersion: number;
  generation: number;
  piAlive: boolean;
  piExitCode?: number;
  /** Highest holderSeq buffered (daemon resumes after this on reconnect). */
  latestSeq: number;
};

export type HolderReplayRequest = { type: "passage_replay"; after: number };
export type HolderStderrFrame = {
  type: "passage_stderr";
  stderr: string[];
  stderrTruncated: boolean;
};
export type HolderStatus = {
  type: "passage_status";
  piAlive: boolean;
  piExitCode?: number;
  daemonCount: number;
  uptimeMs: number;
  generation: number;
  holderVersion: number;
};
export type HolderStop = { type: "passage_stop" };
export type HolderPing = { type: "passage_ping" };
export type HolderPong = { type: "passage_pong" };

export type HolderControlFrame =
  | HolderHello
  | HolderHelloAck
  | HolderReplayRequest
  | HolderStderrFrame
  | HolderStatus
  | HolderStop
  | HolderPing
  | HolderPong;

export function isHolderControlFrame(record: unknown): record is HolderControlFrame {
  return (
    typeof record === "object" &&
    record !== null &&
    typeof (record as { type?: unknown }).type === "string" &&
    ((record as { type: string }).type === "passage_hello" ||
      (record as { type: string }).type === "passage_hello_ack" ||
      (record as { type: string }).type === "passage_replay" ||
      (record as { type: string }).type === "passage_stderr" ||
      (record as { type: string }).type === "passage_status" ||
      (record as { type: string }).type === "passage_stop" ||
      (record as { type: string }).type === "passage_ping" ||
      (record as { type: string }).type === "passage_pong")
  );
}

export function validateAgentId(agentId: string): string {
  if (!AGENT_ID_PATTERN.test(agentId)) throw new Error("invalid agentId");
  return agentId;
}

export function socketPathFor(sessionDir: string): string {
  return `${sessionDir}/${HOLDER_SOCKET_NAME}`;
}

export function pidPathFor(sessionDir: string): string {
  return `${sessionDir}/${HOLDER_PID_NAME}`;
}

export function metaPathFor(sessionDir: string): string {
  return `${sessionDir}/${HOLDER_META_NAME}`;
}

export function logPathFor(sessionDir: string): string {
  return `${sessionDir}/${HOLDER_LOG_NAME}`;
}

export function scopeUnitFor(agentId: string): string {
  return `passage-pi-${validateAgentId(agentId)}.scope`;
}

export function parseHolderMeta(value: unknown): HolderMeta | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const record = value as Record<string, unknown>;
  if (
    typeof record.agentId !== "string" ||
    typeof record.sessionId !== "string" ||
    typeof record.generation !== "number" ||
    typeof record.holderVersion !== "number" ||
    typeof record.startedAt !== "string" ||
    typeof record.socketPath !== "string" ||
    typeof record.pid !== "number"
  ) {
    return undefined;
  }
  return record as unknown as HolderMeta;
}
