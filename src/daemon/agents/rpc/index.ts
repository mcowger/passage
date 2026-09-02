import { homedir } from "node:os";
import { join } from "node:path";
import { LfJsonlParser } from "../../../shared/jsonl/parser.ts";
import {
  MAX_AGENT_IMAGE_DATA_CHARACTERS,
  MAX_AGENT_IMAGES,
  MAX_AGENT_MESSAGE_BYTES,
  type AgentImage,
} from "../../../shared/protocol/agents.ts";

export type PiRecord = { type?: string; id?: string; [key: string]: unknown };
export type PiImageBlock = AgentImage;
export type PiCommand =
  | { type: "get_state" | "get_tree" | "get_available_models" | "get_available_thinking_levels" | "abort" | "abort_bash" }
  | { type: "get_entries"; start?: number; end?: number; limit?: number }
  | { type: "prompt" | "steer" | "follow_up"; message: string; images?: readonly PiImageBlock[]; streamingBehavior?: "steer" | "followUp" }
  | { type: "set_steering_mode"; mode: "one-at-a-time" | "all" }
  | { type: "set_follow_up_mode"; mode: "one-at-a-time" | "all" }
  | { type: "set_model"; provider: string; modelId: string }
  | { type: "set_thinking_level"; level: string }
  | { type: "compact"; customInstructions?: string }
  | { type: "bash"; command: string; excludeFromContext?: boolean };
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
  maxCommandBytes?: number; maxRecordBytes?: number; maxEventBytes?: number; maxStderrBytes?: number;
};

const encoder = new TextEncoder();
const MAX_PI_COMMAND_BYTES = MAX_AGENT_IMAGES * MAX_AGENT_IMAGE_DATA_CHARACTERS + MAX_AGENT_MESSAGE_BYTES + 4096;
const asError = (value: unknown) => value instanceof Error ? value : new Error(String(value));

function bunRuntime(): string {
  if (process.execPath.endsWith("/bun") || process.execPath.endsWith("\\bun.exe")) return process.execPath;
  const executable = process.env.PASSAGE_BUN_PATH ?? Bun.which("bun");
  if (!executable) throw new Error("Bun runtime was not found; set PASSAGE_BUN_PATH");
  return executable;
}

function piAgentDirectory(): string {
  return process.env.PI_CODING_AGENT_DIR ?? join(homedir(), ".pi", "agent");
}
async function drain(stream: ReadableStream<Uint8Array>, consume: (chunk: Uint8Array) => void) {
  const reader = stream.getReader();
  try { while (true) { const result = await reader.read(); if (result.done) return; consume(result.value); } }
  finally { reader.releaseLock(); }
}

export class PiRpcProcess {
  readonly child: Bun.Subprocess<"pipe", "pipe", "pipe">;
  readonly generation: number;
  readonly events: PiEvent[] = [];
  readonly stderr: string[] = [];
  lifecycle: PiLifecycle = "running";
  eventsTruncated = false;
  stderrTruncated = false;
  private sequence = 0; private eventBytes = 0; private stderrBytes = 0; private nextId = 0;
  private readonly stderrDecoder = new TextDecoder();
  private readonly listeners = new Set<(event: PiEvent) => void>();
  private readonly lifecycleListeners = new Set<(event: PiLifecycleEvent) => void>();
  private readonly pending = new Map<string, { resolve: (record: PiRecord) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> }>();
  private shutdownPromise?: Promise<void>;
  private readonly limits: Required<Pick<PiRpcOptions, "maxCommandBytes" | "maxRecordBytes" | "maxEventBytes" | "maxStderrBytes">>;

  constructor(options: PiRpcOptions, generation: number) {
    if (!options.cwd || !options.sessionDir || !options.sessionId) throw new Error("Pi cwd, sessionDir, and sessionId are required");
    this.generation = generation;
    this.limits = { maxCommandBytes: options.maxCommandBytes ?? MAX_PI_COMMAND_BYTES, maxRecordBytes: options.maxRecordBytes ?? 1024 * 1024, maxEventBytes: options.maxEventBytes ?? 4 * 1024 * 1024, maxStderrBytes: options.maxStderrBytes ?? 32 * 1024 };
    if (!Object.values(this.limits).every((value) => Number.isSafeInteger(value) && value > 0)) {
      throw new Error("Pi RPC limits must be positive safe integers");
    }
    const pi = options.executable ?? process.env.PASSAGE_PI_PATH ?? Bun.which("pi");
    if (!pi) throw new Error("Pi CLI was not found; set PASSAGE_PI_PATH");
    const command = options.executable ? [options.executable, ...(options.executableArgs ?? [])] : [bunRuntime(), pi];
    command.push("--mode", "rpc", "--session-dir", options.sessionDir, "--session-id", options.sessionId, "--no-extensions", "--no-skills", "--no-prompt-templates", "--no-themes", "--no-context-files", "--no-approve");
    this.child = Bun.spawn(command, {
      cwd: options.cwd,
      env: { ...process.env, PI_CODING_AGENT_DIR: piAgentDirectory() },
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
    });
    const parser = new LfJsonlParser<PiRecord>(record => this.receive(record), this.limits.maxRecordBytes);
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
  private protocolFailure(error: unknown) { this.failPending(asError(error)); if (this.child.exitCode === null) this.child.kill(); }
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
    const id = `passage-${this.generation}-${++this.nextId}`; const line = `${JSON.stringify({ ...command, id })}\n`;
    if (encoder.encode(line).byteLength > this.limits.maxCommandBytes) return Promise.reject(new Error("Pi command exceeds byte limit"));
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error(`Pi request timed out: ${command.type}`)); }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      try { this.child.stdin.write(line); } catch (error) { clearTimeout(timer); this.pending.delete(id); reject(asError(error)); }
    });
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

export class PiRpcManager {
  private readonly processes = new Map<string, PiRpcProcess>(); private readonly starts = new Map<string, Promise<PiRpcProcess>>(); private readonly generations = new Map<string, number>();
  constructor(private readonly maxActiveAgents = 8) { if (!Number.isSafeInteger(maxActiveAgents) || maxActiveAgents < 1) throw new Error("maxActiveAgents must be positive"); }
  start(agentId: string, options: PiRpcOptions) {
    if (!/^[A-Za-z0-9_-]{1,128}$/.test(agentId)) return Promise.reject(new Error("invalid agentId"));
    const live = this.processes.get(agentId); if (live?.lifecycle === "running") return Promise.resolve(live); this.processes.delete(agentId);
    const existing = this.starts.get(agentId); if (existing) return existing;
    for (const [id, process] of this.processes) if (process.lifecycle !== "running") this.processes.delete(id);
    if (this.processes.size + this.starts.size >= this.maxActiveAgents) return Promise.reject(new Error("maximum active Pi agents reached"));
    const generation = (this.generations.get(agentId) ?? 0) + 1;
    const start = Promise.resolve().then(async () => { const process = new PiRpcProcess(options, generation); this.generations.set(agentId, generation); this.processes.set(agentId, process); try { await process.request({ type: "get_state" }); return process; } catch (error) { await process.shutdown(); if (this.processes.get(agentId) === process) this.processes.delete(agentId); throw error; } }).finally(() => this.starts.delete(agentId));
    this.starts.set(agentId, start); return start;
  }
  get(agentId: string) { const process = this.processes.get(agentId); if (process && process.lifecycle !== "running") { this.processes.delete(agentId); return undefined; } return process; }
  async stop(agentId: string, timeoutMs?: number) { const process = this.processes.get(agentId); if (!process) return; await process.shutdown(timeoutMs); if (this.processes.get(agentId) === process) this.processes.delete(agentId); }
  async shutdown() {
    await Promise.allSettled(this.starts.values());
    await Promise.all([...this.processes].map(([agentId]) => this.stop(agentId)));
  }
}
