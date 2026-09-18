/** Holder socket transport: daemon-side client of `passage pi-holder`.
 *
 * Same `request()` / `subscribe()` surface as the direct-spawn process, so
 * `AgentService` code above the manager does not change. Framing and
 * correlation mirror `PiRpcProcess`; the socket replaces the pipes.
 */
import { connect, type Socket } from "node:net";
import { LfJsonlParser } from "../../../shared/jsonl/parser.ts";
import {
  MAX_AGENT_FILES,
  MAX_AGENT_FILE_DATA_CHARACTERS,
  MAX_AGENT_IMAGE_DATA_CHARACTERS,
  MAX_AGENT_IMAGES,
  MAX_AGENT_MESSAGE_BYTES,
} from "../../../shared/protocol/agents.ts";
import { parsePiExtensionUiDialog } from "../ui.ts";
import { errorFields, logger } from "../../logging.ts";
import { isHolderControlFrame } from "../holder/protocol.ts";
import type {
  PiCommand,
  PiEvent,
  PiExtensionUiResponse,
  PiLifecycle,
  PiLifecycleEvent,
  PiRecord,
  PiResponse,
} from "./index.ts";

const encoder = new TextEncoder();
const MAX_PI_COMMAND_BYTES =
  MAX_AGENT_IMAGES * MAX_AGENT_IMAGE_DATA_CHARACTERS +
  MAX_AGENT_FILES * MAX_AGENT_FILE_DATA_CHARACTERS +
  MAX_AGENT_MESSAGE_BYTES +
  65536;
const OUTPUT_LOG_INTERVAL_MS = 10_000;

const CUSTOM_ANSWER_ROW = /^(?:\d+\.\s*)?(?:Type something\.?|Other\b.*)$/i;
const asError = (value: unknown): Error => (value instanceof Error ? value : new Error(String(value)));

function matchSelectOption(options: string[], value: string): string | undefined {
  if (options.includes(value)) return value;
  const target = value.trim().toLowerCase();
  return (
    options.find(
      (option) =>
        option.replace(/^\d+\.\s*/, "").split(/\s*[\u2014\u2013-]\s*/)[0]?.trim().toLowerCase() === target,
    ) ?? options.find((option) => option.toLowerCase().includes(target))
  );
}

export type HolderTransportOptions = {
  agentId: string;
  socketPath: string;
  generation: number;
  timeoutMs?: number;
  maxCommandBytes?: number;
  maxRecordBytes?: number;
  maxEventBytes?: number;
  maxStderrBytes?: number;
};

/** Daemon-side handle for one holder-backed agent. Duck-compatible with
 * `PiRpcProcess` (see `PiProcessHandle` in `./index.ts`). */
export class HolderPiProcess {
  readonly generation: number;
  readonly events: PiEvent[] = [];
  readonly stderr: string[] = [];
  lifecycle: PiLifecycle = "running";
  eventsTruncated = false;
  stderrTruncated = false;
  transport = "holder" as const;

  private readonly agentId: string;
  private readonly socketPath: string;
  private socket: Socket | undefined;
  private buffer = "";
  private sequence = 0;
  private eventBytes = 0;
  private stderrBytes = 0;
  private nextId: number;
  private pendingUiRequest?: PiRecord;
  private customAnswer?: string;
  private readonly listeners = new Set<(event: PiEvent) => void>();
  private readonly lifecycleListeners = new Set<(event: PiLifecycleEvent) => void>();
  private readonly pending = new Map<
    string,
    { resolve: (record: PiRecord) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> }
  >();
  private helloAck: { latestSeq: number; piAlive: boolean; piExitCode?: number } | undefined;
  private helloResolve?: (ack: { latestSeq: number; piAlive: boolean; piExitCode?: number }) => void;
  private helloReject?: (error: Error) => void;
  private helloTimer?: ReturnType<typeof setTimeout>;
  private reconnectTimer?: ReturnType<typeof setTimeout>;
  private reconnectAttempts = 0;
  private connectionAttempt = 0;
  private readonly connectionPrefix = crypto.randomUUID();
  private connectionId: string | undefined;
  private lastOutputLogAt = 0;
  private outputFrames = 0;
  private outputBytes = 0;
  private readonly outputTypes = new Set<string>();
  private closed = false;
  private after = 0;
  private readonly stderrDecoder = new TextDecoder();
  private readonly limits: Required<Pick<HolderTransportOptions, "maxCommandBytes" | "maxRecordBytes" | "maxEventBytes" | "maxStderrBytes">>;
  private readonly parser: LfJsonlParser<PiRecord>;

  constructor(options: HolderTransportOptions) {
    this.agentId = options.agentId;
    this.socketPath = options.socketPath;
    this.generation = options.generation;
    // Random base per daemon connection: same `passage-<gen>-<n>` format,
    // but a reconnecting daemon cannot reuse an ID a dead daemon may still
    // have in flight inside pi (stale responses are then ignored safely).
    this.nextId = Math.floor(Math.random() * 1_000_000);
    this.limits = {
      maxCommandBytes: options.maxCommandBytes ?? MAX_PI_COMMAND_BYTES,
      maxRecordBytes: options.maxRecordBytes ?? MAX_PI_COMMAND_BYTES + 1024 * 1024,
      maxEventBytes: options.maxEventBytes ?? MAX_PI_COMMAND_BYTES * 2 + 4 * 1024 * 1024,
      maxStderrBytes: options.maxStderrBytes ?? 64 * 1024,
    };
    this.parser = new LfJsonlParser<PiRecord>(
      (record) => this.receive(record),
      this.limits.maxRecordBytes,
      (line) => this.captureStderr(encoder.encode(`${line}\n`)),
    );
  }

  /** Connect + hello handshake. Resolves once hello_ack arrives. */
  connect(timeoutMs = 10_000): Promise<void> {
    if (this.socket || this.closed) return Promise.resolve();
    return new Promise((resolve, reject) => {
      this.helloResolve = (ack) => {
        this.helloAck = ack;
        this.after = ack.latestSeq;
        if (!ack.piAlive) {
          this.onHolderPiExit(ack.piExitCode ?? 1);
        }
        resolve();
      };
      this.helloReject = reject;
      this.helloTimer = setTimeout(() => {
        this.helloReject = undefined;
        this.helloResolve = undefined;
        try {
          this.socket?.destroy();
        } catch {}
        this.socket = undefined;
        reject(new Error("holder hello timed out"));
      }, timeoutMs);
      this.openSocket();
    });
  }

  private openSocket(): void {
    const connectionId = `${this.connectionPrefix}-${++this.connectionAttempt}`;
    this.connectionId = connectionId;
    logger("pi-holder").info("Connecting to holder", {
      event: "holder.connecting",
      agentId: this.agentId,
      generation: this.generation,
      connectionId,
      attempt: this.connectionAttempt,
    });
    let socket: Socket;
    try {
      socket = connect(this.socketPath);
    } catch (error) {
      this.onSocketError(asError(error));
      return;
    }
    this.socket = socket;
    this.buffer = "";
    socket.on("connect", () => {
      this.reconnectAttempts = 0;
      try {
        socket.write(`${JSON.stringify({ type: "passage_hello", agentId: this.agentId, after: this.after, connectionId })}\n`);
        logger("pi-holder").info("Holder socket connected", {
          event: "holder.connected",
          agentId: this.agentId,
          generation: this.generation,
          connectionId,
          after: this.after,
        });
      } catch (error) {
        this.onSocketError(asError(error));
      }
    });
    socket.on("data", (chunk) => this.onSocketData(chunk));
    socket.on("error", (error) => this.onSocketError(asError(error)));
    socket.on("close", () => this.onSocketClose());
  }

  private onSocketData(chunk: Buffer | string): void {
    this.buffer += chunk.toString("utf8");
    let newline: number;
    while ((newline = this.buffer.indexOf("\n")) !== -1) {
      const line = this.buffer.slice(0, newline).replace(/\r$/, "");
      this.buffer = this.buffer.slice(newline + 1);
      if (!line.trim()) continue;
      if (encoder.encode(line).byteLength > this.limits.maxRecordBytes) {
        this.captureStderr(encoder.encode(`${line}\n`));
        continue;
      }
      let record: unknown;
      try {
        record = JSON.parse(line);
      } catch {
        this.captureStderr(encoder.encode(`${line}\n`));
        continue;
      }
      if (isHolderControlFrame(record)) {
        this.onControl(record);
        continue;
      }
      this.logOutputActivity(record as PiRecord, encoder.encode(line).byteLength);
      try {
        this.parser.push(`${line}\n`);
      } catch (error) {
        logger("pi-rpc").warn("Holder record exceeds byte limit", {
          event: "pi.holder_record_skipped",
          agentId: this.agentId,
          ...errorFields(error),
        });
      }
    }
    if (encoder.encode(this.buffer).byteLength > this.limits.maxRecordBytes) {
      this.captureStderr(encoder.encode(`${this.buffer}\n`));
      this.buffer = "";
    }
  }

  private logOutputActivity(record: PiRecord, bytes: number): void {
    this.outputFrames += 1;
    this.outputBytes += bytes;
    if (typeof record.type === "string") this.outputTypes.add(record.type);
    const now = Date.now();
    if (now - this.lastOutputLogAt < OUTPUT_LOG_INTERVAL_MS) return;
    logger("pi-holder").info("Received Pi output from holder", {
      event: "holder.output_received",
      agentId: this.agentId,
      generation: this.generation,
      connectionId: this.connectionId,
      frames: this.outputFrames,
      bytes: this.outputBytes,
      types: [...this.outputTypes].slice(0, 16),
    });
    this.lastOutputLogAt = now;
    this.outputFrames = 0;
    this.outputBytes = 0;
    this.outputTypes.clear();
  }

  private onControl(record: { type: string } & Record<string, unknown>): void {
    switch (record.type) {
      case "passage_hello_ack": {
        const ack = {
          latestSeq: typeof record.latestSeq === "number" ? record.latestSeq : 0,
          piAlive: record.piAlive !== false,
          ...(typeof record.piExitCode === "number" ? { piExitCode: record.piExitCode } : {}),
        };
        if (this.helloResolve) {
          clearTimeout(this.helloTimer);
          const resolve = this.helloResolve;
          this.helloResolve = undefined;
          this.helloReject = undefined;
          resolve(ack);
        } else {
          this.helloAck = ack;
          this.after = Math.max(this.after, ack.latestSeq);
        }
        logger("pi-holder").info("Holder hello received", {
          event: "holder.hello_received",
          agentId: this.agentId,
          generation: this.generation,
          connectionId: this.connectionId,
          latestSeq: ack.latestSeq,
          piAlive: ack.piAlive,
          ...(ack.piExitCode === undefined ? {} : { piExitCode: ack.piExitCode }),
        });
        if (typeof record.generation === "number" && record.generation !== this.generation) {
          logger("pi-rpc").warn("Holder generation mismatch", {
            event: "pi.holder_generation_mismatch",
            agentId: this.agentId,
            expected: this.generation,
            actual: record.generation,
          });
        }
        break;
      }
      case "passage_stderr":
        if (Array.isArray(record.stderr)) {
          for (const part of record.stderr) {
            if (typeof part === "string") this.captureStderr(encoder.encode(part));
          }
        }
        if (record.stderrTruncated === true) this.stderrTruncated = true;
        break;
      case "passage_status":
        if (record.piAlive === false) this.onHolderPiExit(typeof record.piExitCode === "number" ? record.piExitCode : 1);
        break;
      case "passage_pong":
        for (const done of this.pongWaiters) {
          try {
            done();
          } catch {}
        }
        this.pongWaiters.clear();
        break;
      default:
        break;
    }
  }

  private receive(record: PiRecord): void {
    if (record.type === "response" && typeof record.id === "string") {
      const request = this.pending.get(record.id);
      if (!request) return;
      clearTimeout(request.timer);
      this.pending.delete(record.id);
      if ((record as PiResponse).success === false) {
        request.reject(new Error(String((record as PiResponse).error ?? "Pi command failed")));
      } else {
        request.resolve(record);
      }
      return;
    }
    const dialog = parsePiExtensionUiDialog(record);
    if (dialog) {
      if (this.answerCustomFollowUp(dialog)) return;
      this.pendingUiRequest = record;
    } else if (record.type === "agent_settled" || record.type === "turn_end") {
      this.customAnswer = undefined;
      this.pendingUiRequest = undefined;
    }
    const event = { ...record, sequence: ++this.sequence, generation: this.generation };
    this.events.push(event);
    this.eventBytes += encoder.encode(JSON.stringify(event)).byteLength;
    while (this.eventBytes > this.limits.maxEventBytes && this.events.length > 0) {
      const removed = this.events.shift()!;
      this.eventBytes -= encoder.encode(JSON.stringify(removed)).byteLength;
      this.eventsTruncated = true;
    }
    for (const listener of this.listeners) {
      try {
        listener(event);
      } catch {}
    }
  }

  private captureStderr(chunk: Uint8Array): void {
    const keep = Math.max(0, this.limits.maxStderrBytes - this.stderrBytes);
    const part = chunk.slice(0, keep);
    if (part.byteLength > 0) {
      this.stderr.push(this.stderrDecoder.decode(part, { stream: true }));
      this.stderrBytes += part.byteLength;
    }
    if (chunk.byteLength > keep) this.stderrTruncated = true;
  }

  private onSocketError(error: Error): void {
    if (this.helloReject) {
      clearTimeout(this.helloTimer);
      const reject = this.helloReject;
      this.helloReject = undefined;
      this.helloResolve = undefined;
      reject(error);
      return;
    }
    if (this.closed || this.lifecycle !== "running") return;
    logger("pi-rpc").warn("Holder socket error", {
      event: "pi.holder_socket_error",
      agentId: this.agentId,
      generation: this.generation,
      connectionId: this.connectionId,
      ...errorFields(error),
    });
  }

  private onSocketClose(): void {
    this.socket = undefined;
    if (this.helloReject) {
      clearTimeout(this.helloTimer);
      const reject = this.helloReject;
      this.helloReject = undefined;
      this.helloResolve = undefined;
      reject(new Error("holder socket closed before hello_ack"));
      return;
    }
    if (this.closed || this.lifecycle !== "running") return;
    // Daemon-side disconnect: the holder (and pi) keep running — that is
    // the feature. Fail pending requests fast (same semantics as a crashed
    // pi: the caller retries with a fresh ID), then reconnect and resume
    // from the last hello offset.
    this.failPending(new Error("holder connection lost"));
    logger("pi-holder").info("Holder connection lost, reconnecting", {
      event: "holder.detached",
      agentId: this.agentId,
      generation: this.generation,
      connectionId: this.connectionId,
    });
    const delay = Math.min(5_000, 200 * 2 ** Math.min(this.reconnectAttempts++, 4));
    this.reconnectTimer = setTimeout(() => {
      if (this.closed || this.lifecycle !== "running") return;
      this.openSocket();
      // Re-hello timeout: if the holder is gone entirely, surface it so
      // the manager can respawn (same as a crashed pi today).
      this.helloTimer = setTimeout(() => {
        if (this.lifecycle !== "running" || this.closed) return;
        this.lifecycle = "crashed";
        this.failPending(new Error("holder is unreachable"));
        this.emitLifecycle({ lifecycle: "crashed", exitCode: 1, generation: this.generation, stderr: [...this.stderr], stderrTruncated: this.stderrTruncated });
      }, 10_000);
      this.helloTimer.unref?.();
    }, delay);
    this.reconnectTimer.unref?.();
  }

  private onHolderPiExit(code: number): void {
    if (this.lifecycle !== "running") return;
    this.lifecycle = code === 0 ? "stopped" : "crashed";
    this.failPending(new Error(`Pi process exited (${code})`));
    const event: PiLifecycleEvent = {
      lifecycle: this.lifecycle,
      exitCode: code,
      generation: this.generation,
      stderr: [...this.stderr],
      stderrTruncated: this.stderrTruncated,
    };
    for (const listener of this.lifecycleListeners) {
      try {
        listener(event);
      } catch {}
    }
    this.listeners.clear();
    this.lifecycleListeners.clear();
  }

  private emitLifecycle(event: PiLifecycleEvent): void {
    for (const listener of this.lifecycleListeners) {
      try {
        listener(event);
      } catch {}
    }
    this.listeners.clear();
    this.lifecycleListeners.clear();
  }

  private failPending(error: Error): void {
    for (const [id, request] of this.pending) {
      clearTimeout(request.timer);
      request.reject(error);
      this.pending.delete(id);
    }
  }

  request(command: PiCommand, timeoutMs = 10_000): Promise<PiRecord> {
    if (this.lifecycle !== "running") return Promise.reject(new Error(`Pi process is ${this.lifecycle}`));
    if (!this.socket || this.socket.destroyed) return Promise.reject(new Error("holder is not connected"));
    if (!Number.isFinite(timeoutMs) || timeoutMs < 0) return Promise.reject(new Error("request timeout must be non-negative"));
    const id = `passage-${this.generation}-${++this.nextId}`;
    const line = `${JSON.stringify({ ...command, id })}\n`;
    if (encoder.encode(line).byteLength > this.limits.maxCommandBytes) {
      return Promise.reject(new Error("Pi command exceeds byte limit"));
    }
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        logger("pi-rpc").warn("Pi request timed out", { event: "pi.request_timeout", generation: this.generation, command: command.type, timeoutMs });
        reject(new Error(`Pi request timed out: ${command.type}`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      try {
        this.socket!.write(line);
        logger("pi-holder").info("Forwarded command to holder", {
          event: "holder.command_forwarded",
          agentId: this.agentId,
          generation: this.generation,
          connectionId: this.connectionId,
          command: command.type,
          pending: this.pending.size,
        });
      } catch (error) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(asError(error));
      }
    });
  }

  getPendingUiRequest(): PiRecord | undefined {
    return this.pendingUiRequest;
  }

  respondExtensionUi(response: PiExtensionUiResponse): void {
    if (this.lifecycle !== "running") throw new Error(`Pi process is ${this.lifecycle}`);
    const pending = this.getPendingUiRequest();
    const targetId = pending?.id ? String(pending.id) : response.id;
    let finalValue = "value" in response ? response.value : undefined;
    this.customAnswer = undefined;
    if (pending?.method === "select" && Array.isArray(pending.options) && finalValue) {
      const options = (pending.options as unknown[]).filter((option): option is string => typeof option === "string");
      const custom = "custom" in response && response.custom === true;
      const match = custom ? undefined : matchSelectOption(options, finalValue);
      if (match !== undefined) {
        finalValue = match;
      } else {
        const escape = options.find((option) => CUSTOM_ANSWER_ROW.test(option.trim()));
        if (escape !== undefined) {
          this.customAnswer = finalValue;
          finalValue = escape;
        }
      }
    }
    const payload: Record<string, unknown> = { type: "extension_ui_response", id: targetId };
    if ("cancelled" in response && response.cancelled) {
      payload.cancelled = true;
    } else if ("confirmed" in response && response.confirmed !== undefined) {
      payload.confirmed = response.confirmed;
    } else if (finalValue !== undefined) {
      payload.value = finalValue;
    }
    const line = `${JSON.stringify(payload)}\n`;
    if (encoder.encode(line).byteLength > this.limits.maxCommandBytes) throw new Error("Pi UI response exceeds byte limit");
    if (!this.socket || this.socket.destroyed) throw new Error("holder is not connected");
    this.socket.write(line);
    this.pendingUiRequest = undefined;
  }

  private answerCustomFollowUp(dialog: { method: string; id: string }): boolean {
    const value = this.customAnswer;
    this.customAnswer = undefined;
    if (value === undefined || dialog.method !== "input") return false;
    try {
      if (!this.socket || this.socket.destroyed) return false;
      this.socket.write(`${JSON.stringify({ type: "extension_ui_response", id: dialog.id, value })}\n`);
    } catch {
      return false;
    }
    this.pendingUiRequest = undefined;
    return true;
  }

  replay(after = 0): { snapshotRequired: boolean; events: PiEvent[] } {
    const first = this.events[0]?.sequence;
    return {
      snapshotRequired: this.eventsTruncated && first !== undefined && after < first - 1,
      events: this.events.filter((event) => event.sequence > after),
    };
  }

  subscribe(listener: (event: PiEvent) => void, after = 0): () => boolean {
    for (const event of this.replay(after).events) {
      try {
        listener(event);
      } catch {}
    }
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  subscribeLifecycle(listener: (event: PiLifecycleEvent) => void): () => boolean {
    this.lifecycleListeners.add(listener);
    return () => this.lifecycleListeners.delete(listener);
  }

  private readonly pongWaiters = new Set<() => void>();

  ping(timeoutMs = 3_000): Promise<void> {
    if (!this.socket || this.socket.destroyed) return Promise.reject(new Error("holder is not connected"));
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pongWaiters.delete(done);
        reject(new Error("holder ping timed out"));
      }, timeoutMs);
      const done = (): void => {
        clearTimeout(timer);
        resolve();
      };
      this.pongWaiters.add(done);
      try {
        this.socket!.write(`${JSON.stringify({ type: "passage_ping" })}\n`);
      } catch (error) {
        clearTimeout(timer);
        this.pongWaiters.delete(done);
        reject(asError(error));
      }
    });
  }

  /** Graceful stop: `passage_stop` asks the holder to close pi stdin, wait
   * for clean exit, SIGTERM/SIGKILL the tree, remove its files, and exit.
   * Resolves only once the holder is actually gone (socket refusing),
   * so callers can assert teardown — not merely on socket close. */
  async shutdown(timeoutMs = 10_000): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.lifecycle = "stopping";
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    if (this.helloTimer) clearTimeout(this.helloTimer);
    this.failPending(new Error("Pi process is stopping"));
    try {
      this.socket?.write(`${JSON.stringify({ type: "passage_stop" })}\n`);
    } catch {}
    const { existsSync } = await import("node:fs");
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      // Holder removes the socket file as its last act before exiting.
      if (!existsSync(this.socketPath)) break;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    try {
      this.socket?.destroy();
    } catch {}
    this.socket = undefined;
    this.lifecycle = "stopped";
  }

  /** Forced local teardown without contacting the holder (sweep path). */
  destroy(): void {
    this.closed = true;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    if (this.helloTimer) clearTimeout(this.helloTimer);
    this.failPending(new Error("Pi process is stopping"));
    try {
      this.socket?.destroy();
    } catch {}
    this.socket = undefined;
  }
}
