import { homedir } from "node:os";
import { join } from "node:path";
import { LfJsonlParser } from "../../../shared/jsonl/parser.ts";
import {
  MAX_AGENT_FILES,
  MAX_AGENT_FILE_DATA_CHARACTERS,
  MAX_AGENT_IMAGE_DATA_CHARACTERS,
  MAX_AGENT_IMAGES,
  MAX_AGENT_MESSAGE_BYTES,
  type AgentImage,
} from "../../../shared/protocol/agents.ts";
import { parsePiExtensionUiDialog, type PiExtensionUiDialog } from "../ui.ts";
import { errorFields, logger } from "../../logging.ts";

export type PiRecord = { type?: string; id?: string; [key: string]: unknown };
export type PiImageBlock = AgentImage;
export type PiCommand =
  | { type: "get_state" | "get_tree" | "get_available_models" | "get_available_thinking_levels" | "get_commands" | "abort" | "abort_bash" | "clear_queue" }
  | { type: "get_entries"; start?: number; end?: number; limit?: number }
  | { type: "prompt" | "steer" | "follow_up"; message: string; images?: readonly PiImageBlock[]; streamingBehavior?: "steer" | "followUp" }
  | { type: "set_steering_mode"; mode: "one-at-a-time" | "all" }
  | { type: "set_follow_up_mode"; mode: "one-at-a-time" | "all" }
  | { type: "set_model"; provider: string; modelId: string }
  | { type: "set_thinking_level"; level: string }
  | { type: "compact"; customInstructions?: string }
  | { type: "bash"; command: string; excludeFromContext?: boolean };
/** One entry from pi's `get_commands` response (extension, prompt, or skill command). */
export type PiAvailableCommand = {
  name: string;
  description?: string;
  source: string;
  location?: string;
  path?: string;
};
export type PiResponse<T = unknown> = PiRecord & { type: "response"; id: string; command: PiCommand["type"]; success: boolean; data?: T; error?: unknown };
export function isPiResponse(record: PiRecord): record is PiResponse { return record.type === "response" && typeof record.id === "string" && typeof record.success === "boolean"; }
export function responseData<T>(record: PiRecord): T | undefined { return isPiResponse(record) ? record.data as T | undefined : undefined; }
export type PiLifecycle = "running" | "stopping" | "stopped" | "crashed";
export type PiLifecycleEvent = {
  lifecycle: "stopped" | "crashed";
  exitCode: number;
  generation: number;
  stderr: string[];
  stderrTruncated: boolean;
};
export type PiEvent = PiRecord & { sequence: number; generation: number };
export type ReplayResult = { snapshotRequired: boolean; events: PiEvent[] };
export type PiRpcOptions = {
  cwd: string; sessionDir: string; sessionId: string; executable?: string; executableArgs?: string[];
  model?: string; disableTools?: boolean;
  maxCommandBytes?: number; maxRecordBytes?: number; maxEventBytes?: number; maxStderrBytes?: number;
};

const encoder = new TextEncoder();
const MAX_PI_COMMAND_BYTES = MAX_AGENT_IMAGES * MAX_AGENT_IMAGE_DATA_CHARACTERS + MAX_AGENT_FILES * MAX_AGENT_FILE_DATA_CHARACTERS + MAX_AGENT_MESSAGE_BYTES + 65536;
const asError = (value: unknown) => value instanceof Error ? value : new Error(String(value));

function piAgentDirectory(): string {
  return process.env.PI_CODING_AGENT_DIR ?? join(homedir(), ".pi", "agent");
}
/** Map a card answer back to the select row pi offered, label-first. */
function matchSelectOption(options: string[], value: string): string | undefined {
  if (options.includes(value)) return value;
  const target = value.trim().toLowerCase();
  return options.find((option) => option.replace(/^\d+\.\s*/, "").split(/\s*[\u2014\u2013-]\s*/)[0]?.trim().toLowerCase() === target)
    ?? options.find((option) => option.toLowerCase().includes(target));
}

async function drain(stream: ReadableStream<Uint8Array>, consume: (chunk: Uint8Array) => void) {
  const reader = stream.getReader();
  try { while (true) { const result = await reader.read(); if (result.done) return; consume(result.value); } }
  finally { reader.releaseLock(); }
}

export type PiExtensionUiResponse =
  | { id: string; value: string; custom?: boolean }
  | { id: string; confirmed: boolean }
  | { id: string; cancelled: true };

// ask_user_question's RPC fallback appends a free-text escape row to every
// select dialog; picking it is how the extension is told to re-prompt with
// `ctx.ui.input` for a typed answer.
const CUSTOM_ANSWER_ROW = /^(?:\d+\.\s*)?(?:Type something\.?|Other\b.*)$/i;

export class PiRpcProcess {
  readonly child: Bun.Subprocess<"pipe", "pipe", "pipe">;
  readonly generation: number;
  readonly transport = "direct" as const;
  readonly events: PiEvent[] = [];
  readonly stderr: string[] = [];
  lifecycle: PiLifecycle = "running";
  eventsTruncated = false;
  stderrTruncated = false;
  private sequence = 0; private eventBytes = 0; private stderrBytes = 0; private nextId = 0;
  private pendingUiRequest?: PiRecord;
  private customAnswer?: string;
  private readonly stderrDecoder = new TextDecoder();
  private readonly listeners = new Set<(event: PiEvent) => void>();
  private readonly lifecycleListeners = new Set<(event: PiLifecycleEvent) => void>();
  private readonly pending = new Map<string, { resolve: (record: PiRecord) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> }>();
  private shutdownPromise?: Promise<void>;
  private readonly limits: Required<Pick<PiRpcOptions, "maxCommandBytes" | "maxRecordBytes" | "maxEventBytes" | "maxStderrBytes">>;

  constructor(options: PiRpcOptions, generation: number) {
    if (!options.cwd || !options.sessionDir || !options.sessionId) throw new Error("Pi cwd, sessionDir, and sessionId are required");
    this.generation = generation;
    this.limits = {
      maxCommandBytes: options.maxCommandBytes ?? MAX_PI_COMMAND_BYTES,
      maxRecordBytes: options.maxRecordBytes ?? MAX_PI_COMMAND_BYTES + 1024 * 1024,
      maxEventBytes: options.maxEventBytes ?? (MAX_PI_COMMAND_BYTES * 2) + (4 * 1024 * 1024),
      maxStderrBytes: options.maxStderrBytes ?? 64 * 1024,
    };
    if (!Object.values(this.limits).every((value) => Number.isSafeInteger(value) && value > 0)) {
      throw new Error("Pi RPC limits must be positive safe integers");
    }
    const pi = options.executable ?? process.env.PASSAGE_PI_PATH ?? Bun.which("pi");
    if (!pi) throw new Error("Pi CLI was not found; set PASSAGE_PI_PATH");
    const command = options.executable ? [options.executable, ...(options.executableArgs ?? [])] : [pi];
    if (options.model) command.push("--model", options.model);
    command.push("--mode", "rpc", "--session-dir", options.sessionDir, "--session-id", options.sessionId, "--no-prompt-templates", "--no-themes", "--no-context-files", "--no-approve");
    if (options.disableTools) command.push("--no-tools");
    this.child = Bun.spawn(command, {
      cwd: options.cwd,
      env: { ...process.env, PI_CODING_AGENT_DIR: piAgentDirectory() },
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
    });
    logger("pi-rpc").info("Pi process started", { event: "pi.process_started", generation });
    const parser = new LfJsonlParser<PiRecord>(
      record => this.receive(record),
      this.limits.maxRecordBytes,
      line => this.captureStderr(encoder.encode(line + "\n")),
    );
    void drain(this.child.stdout, chunk => parser.push(chunk)).then(() => parser.finish()).catch(error => this.protocolFailure(error));
    void drain(this.child.stderr, chunk => this.captureStderr(chunk));
    void this.child.exited.then(code => this.exited(code));
  }

  private receive(record: PiRecord) {
    if (record.type === "response" && typeof record.id === "string") {
      const request = this.pending.get(record.id); if (!request) return;
      clearTimeout(request.timer); this.pending.delete(record.id);
      if (record.success === false) request.reject(new Error(String(record.error ?? "Pi command failed"))); else request.resolve(record);
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
    this.events.push(event); this.eventBytes += encoder.encode(JSON.stringify(event)).byteLength;
    while (this.eventBytes > this.limits.maxEventBytes && this.events.length) { const removed = this.events.shift()!; this.eventBytes -= encoder.encode(JSON.stringify(removed)).byteLength; this.eventsTruncated = true; }
    for (const listener of this.listeners) { try { listener(event); } catch { /* subscribers are isolated */ } }
  }
  private captureStderr(chunk: Uint8Array) {
    const keep = Math.max(0, this.limits.maxStderrBytes - this.stderrBytes); const part = chunk.slice(0, keep);
    if (part.byteLength) { this.stderr.push(this.stderrDecoder.decode(part, { stream: true })); this.stderrBytes += part.byteLength; }
    if (chunk.byteLength > keep) this.stderrTruncated = true;
  }
  private protocolFailure(error: unknown) {
    logger("pi-rpc").error("Pi protocol failure", { event: "pi.protocol_failure", generation: this.generation, ...errorFields(error) });
    this.failPending(asError(error));
    if (this.child.exitCode === null) this.child.kill();
  }
  private exited(code: number) {
    const tail = this.stderrDecoder.decode();
    if (tail) this.captureStderr(encoder.encode(tail));
    this.lifecycle = this.lifecycle === "stopping" || code === 0 ? "stopped" : "crashed";
    this.failPending(new Error(`Pi process exited (${code})`));
    const event: PiLifecycleEvent = {
      lifecycle: this.lifecycle,
      exitCode: code,
      generation: this.generation,
      stderr: [...this.stderr],
      stderrTruncated: this.stderrTruncated,
    };
    logger("pi-rpc")[this.lifecycle === "crashed" ? "error" : "info"]("Pi process exited", {
      event: this.lifecycle === "crashed" ? "pi.process_crashed" : "pi.process_stopped",
      generation: this.generation,
      exitCode: code,
      stderrBytes: this.stderr.reduce((total, part) => total + encoder.encode(part).byteLength, 0),
      stderrTruncated: this.stderrTruncated,
    });
    for (const listener of this.lifecycleListeners) {
      try { listener(event); } catch {}
    }
    this.listeners.clear();
    this.lifecycleListeners.clear();
  }
  private failPending(error: Error) { for (const [id, request] of this.pending) { clearTimeout(request.timer); request.reject(error); this.pending.delete(id); } }

  request(command: PiCommand, timeoutMs = 10_000): Promise<PiRecord> {
    if (this.lifecycle !== "running") return Promise.reject(new Error(`Pi process is ${this.lifecycle}`));
    if (!Number.isFinite(timeoutMs) || timeoutMs < 0) return Promise.reject(new Error("request timeout must be non-negative"));
    const id = `passage-${this.generation}-${++this.nextId}`;
    const line = `${JSON.stringify({ ...command, id })}\n`;
    if (encoder.encode(line).byteLength > this.limits.maxCommandBytes) return Promise.reject(new Error("Pi command exceeds byte limit"));
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        logger("pi-rpc").warn("Pi request timed out", { event: "pi.request_timeout", generation: this.generation, command: command.type, timeoutMs });
        reject(new Error(`Pi request timed out: ${command.type}`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      try { this.child.stdin.write(line); } catch (error) { clearTimeout(timer); this.pending.delete(id); reject(asError(error)); }
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
      // Select answers must be one of the offered rows: pi hands the raw
      // string back to the extension, which reads the row number off it. A
      // typed answer parses as "nothing selected" and cancels the whole
      // questionnaire ("User declined to answer questions"), so answer with
      // the free-text row and let the input follow-up carry the text.
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

    const payload: Record<string, unknown> = {
      type: "extension_ui_response",
      id: targetId,
    };
    if ("cancelled" in response && response.cancelled) {
      payload.cancelled = true;
    } else if ("confirmed" in response && response.confirmed !== undefined) {
      payload.confirmed = response.confirmed;
    } else if (finalValue !== undefined) {
      payload.value = finalValue;
    }

    this.writeUiResponse(payload);
    this.pendingUiRequest = undefined;
  }

  private writeUiResponse(payload: Record<string, unknown>): void {
    const line = `${JSON.stringify(payload)}\n`;
    if (encoder.encode(line).byteLength > this.limits.maxCommandBytes) throw new Error("Pi UI response exceeds byte limit");
    this.child.stdin.write(line);
  }

  /**
   * After the free-text row is selected, ask_user_question re-prompts with
   * `ctx.ui.input` to collect the answer. The user already typed it into the
   * Passage card, so answer that hop inline and keep it out of the event log —
   * surfacing it would pop a second, redundant prompt.
   */
  private answerCustomFollowUp(dialog: PiExtensionUiDialog): boolean {
    const value = this.customAnswer;
    this.customAnswer = undefined;
    if (value === undefined || dialog.method !== "input") return false;
    try {
      this.writeUiResponse({ type: "extension_ui_response", id: dialog.id, value });
    } catch (error) {
      logger("pi-rpc").warn("Pi custom answer follow-up failed", { event: "pi.custom_answer_failed", generation: this.generation, ...errorFields(error) });
      return false;
    }
    this.pendingUiRequest = undefined;
    return true;
  }
  replay(after = 0): ReplayResult { const first = this.events[0]?.sequence; return { snapshotRequired: this.eventsTruncated && first !== undefined && after < first - 1, events: this.events.filter(event => event.sequence > after) }; }
  subscribe(listener: (event: PiEvent) => void, after = 0) { for (const event of this.replay(after).events) { try { listener(event); } catch {} } this.listeners.add(listener); return () => this.listeners.delete(listener); }
  subscribeLifecycle(listener: (event: PiLifecycleEvent) => void) {
    this.lifecycleListeners.add(listener);
    return () => this.lifecycleListeners.delete(listener);
  }
  shutdown(timeoutMs = 2_000): Promise<void> {
    if (this.shutdownPromise) return this.shutdownPromise;
    this.lifecycle = "stopping";
    this.shutdownPromise = (async () => { this.child.stdin.end(); let timeout: ReturnType<typeof setTimeout>; const deadline = new Promise(resolve => { timeout = setTimeout(resolve, timeoutMs); }); await Promise.race([this.child.exited, deadline]); clearTimeout(timeout!); if (this.child.exitCode === null) this.child.kill(); await this.child.exited; this.lifecycle = "stopped"; })();
    return this.shutdownPromise;
  }
}

/** Either transport behind one agent: direct-spawn child (tests/fallback)
 * or a detached holder reached over its Unix socket (production default).
 * Both expose the same framing/correlation surface so `AgentService` code
 * above the manager does not change. */
export type PiProcessHandle = PiRpcProcess | import("./holder-transport.ts").HolderPiProcess;

export type PiRpcManagerOptions = {
  /** Sessions root (`<root>/<agentId>/rpc.sock`). Falls back to
   * `dirname(options.sessionDir)` per start when unset (tests). */
  sessionsRoot?: string;
  /** Force direct-spawn even when holder is available (tests only). */
  direct?: boolean;
  /** Extra Pi flags forwarded to freshly spawned holders. */
  piDefaults?: Omit<PiRpcOptions, "cwd" | "sessionDir" | "sessionId">;
};

function holderEnabled(option: boolean | undefined): boolean {
  if (option !== undefined) return option;
  const flag = process.env.PASSAGE_PI_HOLDER;
  if (flag === "0" || flag?.toLowerCase() === "false") return false;
  return true;
}

export class PiRpcManager {
  private readonly processes = new Map<string, PiProcessHandle>(); private readonly starts = new Map<string, Promise<PiProcessHandle>>(); private readonly generations = new Map<string, number>();
  private readonly sessionsRoot?: string;
  private readonly forceDirect: boolean;
  private readonly piDefaults: Omit<PiRpcOptions, "cwd" | "sessionDir" | "sessionId">;
  // Every open (non-archived) agent holds a slot until archived or the
  // daemon restarts -- there is no idle eviction -- so this needs headroom
  // for realistic concurrent-open-agent counts, not just concurrent runs.
  // Each idle `pi --mode rpc` process costs roughly 150-200MB RSS.
  constructor(private readonly maxActiveAgents = 32, options?: PiRpcManagerOptions) {
    if (!Number.isSafeInteger(maxActiveAgents) || maxActiveAgents < 1) throw new Error("maxActiveAgents must be positive");
    this.sessionsRoot = options?.sessionsRoot;
    this.forceDirect = options?.direct === true;
    this.piDefaults = options?.piDefaults ?? {};
  }
  private useHolder(): boolean { return !this.forceDirect && holderEnabled(undefined); }
  /** Holder path only when the manager was explicitly wired with a sessions
   * root (production). Test managers built bare (`new PiRpcManager(n)`)
   * always take the direct-spawn fallback, as do runs with
   * `PASSAGE_PI_HOLDER=0`. */
  private holderRoot(options: PiRpcOptions): string | undefined {
    if (!this.useHolder() || !this.sessionsRoot) return undefined;
    if (!options.sessionDir || !options.sessionId) return undefined;
    return this.sessionsRoot;
  }
  start(agentId: string, options: PiRpcOptions): Promise<PiProcessHandle> {
    if (!/^[A-Za-z0-9_-]{1,128}$/.test(agentId)) return Promise.reject(new Error("invalid agentId"));
    const live = this.processes.get(agentId); if (live?.lifecycle === "running") return Promise.resolve(live); this.processes.delete(agentId);
    const existing = this.starts.get(agentId); if (existing) return existing;
    for (const [id, process] of this.processes) if (process.lifecycle !== "running") this.processes.delete(id);
    if (this.processes.size + this.starts.size >= this.maxActiveAgents) return Promise.reject(new Error("maximum active Pi agents reached"));
    const start: Promise<PiProcessHandle> = Promise.resolve().then(async () => {
      const root = this.holderRoot(options);
      if (root) {
        return this.startHolder(agentId, options, root);
      }
      return this.startDirect(agentId, options);
    }).finally(() => this.starts.delete(agentId));
    this.starts.set(agentId, start); return start;
  }
  private async startDirect(agentId: string, options: PiRpcOptions): Promise<PiProcessHandle> {
    const generation = (this.generations.get(agentId) ?? 0) + 1;
    const process = new PiRpcProcess(options, generation); this.generations.set(agentId, generation); this.processes.set(agentId, process); try { await process.request({ type: "get_state" }); return process; } catch (error) { await process.shutdown(); if (this.processes.get(agentId) === process) this.processes.delete(agentId); throw error; }
  }
  private async startHolder(agentId: string, options: PiRpcOptions, sessionsRoot: string): Promise<PiProcessHandle> {
    const { ensureHolder, readGeneration } = await import("../holder/spawn.ts");
    const { socketPathFor } = await import("../holder/protocol.ts");
    const { HolderPiProcess } = await import("./holder-transport.ts");
    const sessionDir = options.sessionDir;
    // Generation survives daemon restarts via holder.json: a fresh holder
    // bumps it, a re-attach reuses the live holder's generation.
    const ack = await ensureHolder({
      agentId,
      sessionsRoot,
      sessionId: options.sessionId,
      cwd: options.cwd,
      generation: readGeneration(sessionDir) + 1,
      // Explicit per-start values win; undefined must not clobber manager
      // defaults (service passes only cwd/sessionDir/sessionId).
      pi: {
        ...this.piDefaults,
        ...(options.executable !== undefined ? { executable: options.executable } : {}),
        ...(options.executableArgs !== undefined ? { executableArgs: options.executableArgs } : {}),
        ...(options.model !== undefined ? { model: options.model } : {}),
        ...(options.disableTools !== undefined ? { disableTools: options.disableTools } : {}),
        ...(options.maxCommandBytes !== undefined ? { maxCommandBytes: options.maxCommandBytes } : {}),
        ...(options.maxRecordBytes !== undefined ? { maxRecordBytes: options.maxRecordBytes } : {}),
        ...(options.maxEventBytes !== undefined ? { maxEventBytes: options.maxEventBytes } : {}),
        ...(options.maxStderrBytes !== undefined ? { maxStderrBytes: options.maxStderrBytes } : {}),
      },
    });
    const generation = typeof ack.generation === "number" && ack.generation > 0 ? ack.generation : readGeneration(sessionDir);
    const process = new HolderPiProcess({
      agentId,
      socketPath: socketPathFor(sessionDir),
      generation,
      maxCommandBytes: options.maxCommandBytes,
      maxRecordBytes: options.maxRecordBytes,
      maxEventBytes: options.maxEventBytes,
      maxStderrBytes: options.maxStderrBytes,
    });
    this.generations.set(agentId, generation); this.processes.set(agentId, process);
    try { await process.connect(); await process.request({ type: "get_state" }); return process; } catch (error) { process.destroy(); if (this.processes.get(agentId) === process) this.processes.delete(agentId); throw error; }
  }
  /** Reconnect to a live holder that outlived a daemon restart (vs `start`
   * which spawns when none exists). Throws when no live holder answers. */
  async attach(agentId: string, options?: Partial<PiRpcOptions>): Promise<PiProcessHandle> {
    if (!/^[A-Za-z0-9_-]{1,128}$/.test(agentId)) throw new Error("invalid agentId");
    const live = this.processes.get(agentId); if (live?.lifecycle === "running") return live;
    const existing = this.starts.get(agentId); if (existing) return existing;
    const root = this.sessionsRoot ?? (options?.sessionDir ? options.sessionDir.replace(/[/\\][^/\\]+[/\\]?$/, "") : undefined);
    if (!root) throw new Error("sessions root is required to attach");
    const { readGeneration } = await import("../holder/spawn.ts");
    const { socketPathFor } = await import("../holder/protocol.ts");
    const { HolderPiProcess } = await import("./holder-transport.ts");
    const sessionDir = options?.sessionDir ?? `${root}/${agentId}`;
    const generation = Math.max(readGeneration(sessionDir), this.generations.get(agentId) ?? 0);
    if (generation < 1) throw new Error("no holder generation recorded");
    logger("pi-holder").info("Attaching to surviving holder", { event: "holder.attach_attempt", agentId, generation });
    const process = new HolderPiProcess({
      agentId,
      socketPath: socketPathFor(sessionDir),
      generation,
      maxCommandBytes: options?.maxCommandBytes,
      maxRecordBytes: options?.maxRecordBytes,
      maxEventBytes: options?.maxEventBytes,
      maxStderrBytes: options?.maxStderrBytes,
    });
    const attach: Promise<PiProcessHandle> = (async () => {
      await process.connect();
      this.generations.set(agentId, generation); this.processes.set(agentId, process);
      await process.request({ type: "get_state" });
      logger("pi-holder").info("Attached to surviving holder", { event: "holder.attach_completed", agentId, generation });
      return process;
    })().finally(() => this.starts.delete(agentId));
    this.starts.set(agentId, attach);
    try { return await attach; } catch (error) { process.destroy(); if (this.processes.get(agentId) === process) this.processes.delete(agentId); throw error; }
  }
  /** Boot sweep: kill holders with no live, unarchived agent; report
   * respawns (dead socket + live agent) for lazy restart on next use. */
  async sweep(lookup: (agentId: string) => { archived: boolean } | undefined): Promise<{ kept: string[]; killed: string[]; respawned: string[] }> {
    if (!this.sessionsRoot) return { kept: [], killed: [], respawned: [] };
    const { sweepHolders } = await import("../holder/spawn.ts");
    return sweepHolders(this.sessionsRoot, lookup, (agentId) => this.stop(agentId));
  }
  transportFor(agentId: string): "holder" | "direct" | undefined {
    const process = this.processes.get(agentId);
    if (!process) return undefined;
    return (process as PiProcessHandle).transport;
  }
  get(agentId: string) { const process = this.processes.get(agentId); if (process && process.lifecycle !== "running") { this.processes.delete(agentId); return undefined; } return process; }
  async stop(agentId: string, timeoutMs?: number) { const process = this.processes.get(agentId); if (!process) return; await process.shutdown(timeoutMs); if (this.processes.get(agentId) === process) this.processes.delete(agentId); }
  async shutdown() {
    await Promise.allSettled(this.starts.values());
    await Promise.all([...this.processes].map(([agentId]) => this.stop(agentId)));
  }
  /** Daemon shutdown: detach from holders WITHOUT stopping them (runs
   * survive daemon restarts — that is the feature) while still reaping
   * direct-spawn children. Explicit per-agent stop/archive still goes
   * through `stop()` → `passage_stop`. */
  async detachAll() {
    await Promise.allSettled(this.starts.values());
    await Promise.all([...this.processes].map(async ([agentId, process]) => {
      try {
        if (process.transport === "holder") {
          (process as import("./holder-transport.ts").HolderPiProcess).destroy();
        } else {
          await process.shutdown();
        }
      } catch {}
      if (this.processes.get(agentId) === process) this.processes.delete(agentId);
    }));
  }
}
