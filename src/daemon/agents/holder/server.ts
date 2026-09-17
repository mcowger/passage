/** Per-agent Pi holder: owns one `pi --mode rpc` child and serves it over a
 * Unix socket so the daemon can restart without interrupting the run.
 *
 * Deliberately dumb: no Pi semantics, no SQLite, no HTTP. Byte-proxy
 * daemon→pi stdin, pi→buffer→socket broadcast, bounded replay + stderr.
 *
 * Dependency-light by design (see docs/ORHPANS.md "Binary mode"): only
 * node builtins + the shared LF-JSONL parser. Never import daemon, HTTP,
 * SQLite, or logging modules here — the holder runs detached with only
 * what it was started with.
 */
import { chmodSync, mkdirSync, unlinkSync, writeFileSync } from "node:fs";
import { createServer, type Socket } from "node:net";
import { homedir } from "node:os";
import { join } from "node:path";
import { LfJsonlParser } from "../../../shared/jsonl/parser.ts";
import {
  HOLDER_VERSION,
  isHolderControlFrame,
  metaPathFor,
  pidPathFor,
  type HolderHelloAck,
  type HolderMeta,
} from "./protocol.ts";

const encoder = new TextEncoder();
const decoder = new TextDecoder();

export type HolderServerOptions = {
  agentId: string;
  sessionDir: string;
  sessionId: string;
  cwd: string;
  socketPath: string;
  generation: number;
  executable?: string;
  executableArgs?: string[];
  model?: string;
  disableTools?: boolean;
  maxEventBytes?: number;
  maxStderrBytes?: number;
  maxRecordBytes?: number;
  /** Override process.exit (tests only). Called with the exit code instead. */
  onExit?: (code: number) => void;
  /** Idle exit: no daemon connection AND no pi output for this long. 0 disables. */
  idleMs?: number;
  /** How long to linger for collection after pi exits on its own. */
  exitLingerMs?: number;
  /** Grace period for pi clean exit on passage_stop. */
  stopGraceMs?: number;
};

function piAgentDirectory(): string {
  return process.env.PI_CODING_AGENT_DIR ?? join(homedir(), ".pi", "agent");
}

function log(agentId: string, event: string, extra?: Record<string, unknown>): void {
  try {
    process.stderr.write(`${JSON.stringify({ holder: agentId, event, ...extra })}\n`);
  } catch {}
}

type BufferedLine = { seq: number; line: string; bytes: number };

export class HolderServer {
  private child!: Bun.Subprocess<"pipe", "pipe", "pipe">;
  private server = createServer();
  private readonly daemons = new Set<Socket>();
  private readonly buffers = new Map<Socket, string>();
  private readonly lines: BufferedLine[] = [];
  private bufferBytes = 0;
  private latestSeq = 0;
  private readonly stderrParts: string[] = [];
  private stderrBytes = 0;
  private stderrTruncated = false;
  private piAlive = true;
  private piExitCode: number | undefined;
  private readonly startedAt = Date.now();
  private lastDaemonActivity = Date.now();
  private lastPiOutput = Date.now();
  private stopping = false;
  private exited = false;
  private idleTimer?: ReturnType<typeof setInterval>;
  private lingerTimer?: ReturnType<typeof setTimeout>;

  constructor(private readonly options: HolderServerOptions) {
    const maxEventBytes = options.maxEventBytes ?? 12 * 1024 * 1024;
    const maxStderrBytes = options.maxStderrBytes ?? 64 * 1024;
    if (!Number.isSafeInteger(maxEventBytes) || maxEventBytes < 1) throw new Error("invalid maxEventBytes");
    if (!Number.isSafeInteger(maxStderrBytes) || maxStderrBytes < 1) throw new Error("invalid maxStderrBytes");
  }

  get maxEventBytes(): number {
    return this.options.maxEventBytes ?? 12 * 1024 * 1024;
  }

  get maxStderrBytes(): number {
    return this.options.maxStderrBytes ?? 64 * 1024;
  }

  async start(): Promise<void> {
    const { agentId, sessionDir, sessionId, cwd, socketPath, generation } = this.options;
    mkdirSync(sessionDir, { recursive: true, mode: 0o700 });
    try {
      chmodSync(sessionDir, 0o700);
    } catch {}

    this.spawnPi();

    try {
      unlinkSync(socketPath);
    } catch {}
    await new Promise<void>((resolve, reject) => {
      this.server.on("error", reject);
      this.server.listen(socketPath, () => {
        this.server.removeListener("error", reject);
        resolve();
      });
    });
    try {
      chmodSync(socketPath, 0o600);
    } catch {}
    this.server.on("connection", (socket) => this.onConnection(socket));
    this.server.on("error", (error) => log(agentId, "holder.socket_error", { error: String(error) }));

    const meta: HolderMeta = {
      agentId,
      sessionId,
      generation,
      holderVersion: HOLDER_VERSION,
      startedAt: new Date(this.startedAt).toISOString(),
      socketPath,
      pid: process.pid,
    };
    writeFileSync(metaPathFor(sessionDir), `${JSON.stringify(meta)}\n`, { mode: 0o600 });
    try {
      chmodSync(metaPathFor(sessionDir), 0o600);
    } catch {}
    writeFileSync(pidPathFor(sessionDir), `${process.pid}\n`, { mode: 0o600 });

    const idleMs = this.options.idleMs ?? Number(process.env.PASSAGE_HOLDER_IDLE_MS ?? 24 * 60 * 60 * 1000);
    // Ref'd on purpose: supervision is what keeps the holder process alive.
    // (Bun does not keep the loop alive for the listening Unix socket, and
    // every other timer here is unref'd, so an unref'd idle timer lets the
    // holder exit the moment it finishes booting.)
    if (idleMs > 0) {
      this.idleTimer = setInterval(() => this.checkIdle(idleMs), Math.min(60_000, Math.max(5_000, idleMs / 24)));
    } else {
      this.idleTimer = setInterval(() => {}, 60_000);
    }
    log(agentId, "holder.started", { generation, socketPath, pid: process.pid });
  }

  private spawnPi(): void {
    const { sessionDir, sessionId, cwd, executable, executableArgs, model, disableTools } = this.options;
    const pi = executable ?? process.env.PASSAGE_PI_PATH ?? Bun.which("pi");
    if (!pi) throw new Error("Pi CLI was not found; set PASSAGE_PI_PATH");
    const command = executable ? [executable, ...(executableArgs ?? [])] : [pi];
    if (model) command.push("--model", model);
    command.push(
      "--mode", "rpc",
      "--session-dir", sessionDir,
      "--session-id", sessionId,
      "--no-prompt-templates", "--no-themes", "--no-context-files", "--no-approve",
    );
    if (disableTools) command.push("--no-tools");
    this.child = Bun.spawn(command, {
      cwd,
      env: { ...process.env, PI_CODING_AGENT_DIR: piAgentDirectory() },
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
    });
    log(this.options.agentId, "pi.process_started", { generation: this.options.generation });
    const maxRecordBytes = this.options.maxRecordBytes ?? 8 * 1024 * 1024;
    const parser = new LfJsonlParser<unknown>(
      () => {},
      maxRecordBytes,
      (line) => this.captureStderr(encoder.encode(`${line}\n`)),
    );
    // Re-frame stdout as raw lines (verbatim proxy): split on LF ourselves
    // so the holder never parses Pi semantics — malformed lines still
    // forward (and land in stderr capture via the parser hook above is
    // bypassed; instead capture via raw path below).
    void this.drainStdout(parser);
    void this.drainStderr();
    void this.child.exited.then((code) => this.onPiExit(code));
  }

  private async drainStdout(parser: LfJsonlParser<unknown>): Promise<void> {
    const reader = this.child.stdout.getReader();
    let carry = "";
    try {
      while (true) {
        const result = await reader.read();
        if (result.done) break;
        // Feed the shared parser only for malformed-line stderr capture;
        // the authoritative path is the raw LF split below (verbatim).
        try {
          parser.push(result.value);
        } catch {
          this.captureStderr(result.value);
        }
        carry += decoder.decode(result.value, { stream: true });
        let newline: number;
        while ((newline = carry.indexOf("\n")) !== -1) {
          const raw = carry.slice(0, newline + 1);
          carry = carry.slice(newline + 1);
          this.onPiLine(raw);
        }
      }
      carry += decoder.decode();
      if (carry.length > 0) this.onPiLine(`${carry}\n`);
    } catch (error) {
      log(this.options.agentId, "holder.stdout_error", { error: String(error) });
    } finally {
      reader.releaseLock();
    }
  }

  private async drainStderr(): Promise<void> {
    const reader = this.child.stderr.getReader();
    try {
      while (true) {
        const result = await reader.read();
        if (result.done) return;
        this.captureStderr(result.value);
      }
    } catch {}
    finally {
      reader.releaseLock();
    }
  }

  private onPiLine(rawLine: string): void {
    this.lastPiOutput = Date.now();
    const bytes = encoder.encode(rawLine).byteLength;
    this.latestSeq += 1;
    this.lines.push({ seq: this.latestSeq, line: rawLine, bytes });
    this.bufferBytes += bytes;
    while (this.bufferBytes > this.maxEventBytes && this.lines.length > 0) {
      const removed = this.lines.shift()!;
      this.bufferBytes -= removed.bytes;
    }
    for (const socket of this.daemons) {
      try {
        socket.write(rawLine);
      } catch {}
    }
  }

  private captureStderr(chunk: Uint8Array): void {
    const keep = Math.max(0, this.maxStderrBytes - this.stderrBytes);
    const part = chunk.slice(0, keep);
    if (part.byteLength > 0) {
      this.stderrParts.push(decoder.decode(part, { stream: true }));
      this.stderrBytes += part.byteLength;
    }
    if (chunk.byteLength > keep) this.stderrTruncated = true;
  }

  private onConnection(socket: Socket): void {
    this.daemons.add(socket);
    this.buffers.set(socket, "");
    this.lastDaemonActivity = Date.now();
    log(this.options.agentId, "holder.attached", { daemons: this.daemons.size });
    socket.on("data", (chunk) => this.onDaemonData(socket, chunk));
    socket.on("close", () => {
      this.daemons.delete(socket);
      this.buffers.delete(socket);
      log(this.options.agentId, "holder.detached", { daemons: this.daemons.size });
    });
    socket.on("error", () => {
      try {
        socket.destroy();
      } catch {}
    });
  }

  private onDaemonData(socket: Socket, chunk: Buffer | string): void {
    this.lastDaemonActivity = Date.now();
    const buffered = (this.buffers.get(socket) ?? "") + chunk.toString("utf8");
    const parts = buffered.split("\n");
    this.buffers.set(socket, parts.pop() ?? "");
    for (const part of parts) {
      const line = part.replace(/\r$/, "");
      if (!line.trim()) continue;
      let record: unknown;
      try {
        record = JSON.parse(line);
      } catch {
        continue;
      }
      if (isHolderControlFrame(record)) {
        this.onControl(socket, record);
      } else {
        // Data frame: verbatim forward to pi stdin (last writer wins).
        if (this.piAlive && this.child.exitCode === null) {
          try {
            this.child.stdin.write(`${line}\n`);
          } catch {}
        }
      }
    }
    if (encoder.encode(this.buffers.get(socket) ?? "").byteLength > (this.options.maxRecordBytes ?? 8 * 1024 * 1024)) {
      try {
        socket.destroy();
      } catch {}
      this.daemons.delete(socket);
      this.buffers.delete(socket);
    }
  }

  private onControl(socket: Socket, record: { type: string } & Record<string, unknown>): void {
    const send = (value: unknown): void => {
      try {
        socket.write(`${JSON.stringify(value)}\n`);
      } catch {}
    };
    switch (record.type) {
      case "passage_hello": {
        const after = typeof record.after === "number" ? record.after : 0;
        const ack: HolderHelloAck = {
          type: "passage_hello_ack",
          agentId: this.options.agentId,
          holderVersion: HOLDER_VERSION,
          generation: this.options.generation,
          piAlive: this.piAlive,
          ...(this.piExitCode === undefined ? {} : { piExitCode: this.piExitCode }),
          latestSeq: this.latestSeq,
        };
        send(ack);
        for (const buffered of this.lines) {
          if (buffered.seq > after) {
            try {
              socket.write(buffered.line.endsWith("\n") ? buffered.line : `${buffered.line}\n`);
            } catch {}
          }
        }
        send({ type: "passage_stderr", stderr: [...this.stderrParts], stderrTruncated: this.stderrTruncated });
        break;
      }
      case "passage_replay": {
        const after = typeof record.after === "number" ? record.after : 0;
        for (const buffered of this.lines) {
          if (buffered.seq > after) {
            try {
              socket.write(buffered.line.endsWith("\n") ? buffered.line : `${buffered.line}\n`);
            } catch {}
          }
        }
        break;
      }
      case "passage_ping":
        send({ type: "passage_pong" });
        break;
      case "passage_status":
        send({
          type: "passage_status",
          piAlive: this.piAlive,
          ...(this.piExitCode === undefined ? {} : { piExitCode: this.piExitCode }),
          daemonCount: this.daemons.size,
          uptimeMs: Date.now() - this.startedAt,
          generation: this.options.generation,
          holderVersion: HOLDER_VERSION,
        });
        break;
      case "passage_stop":
        send({ type: "passage_status", piAlive: this.piAlive, daemonCount: this.daemons.size, uptimeMs: Date.now() - this.startedAt, generation: this.options.generation, holderVersion: HOLDER_VERSION });
        void this.gracefulStop();
        break;
      default:
        break;
    }
  }

  private onPiExit(code: number): void {
    if (this.exited) return;
    this.piAlive = false;
    this.piExitCode = code;
    const tail = decoder.decode();
    if (tail) this.captureStderr(encoder.encode(tail));
    log(this.options.agentId, code === 0 ? "pi.process_stopped" : "pi.process_crashed", {
      generation: this.options.generation,
      exitCode: code,
    });
    if (this.stopping) return;
    // Self-exit: reap, keep the bounded exit/stderr record briefly for the
    // next daemon to collect, then exit.
    const lingerMs = this.options.exitLingerMs ?? Number(process.env.PASSAGE_HOLDER_EXIT_LINGER_MS ?? 30_000);
    // Ref'd: the linger window must actually last (see idle timer note).
    this.lingerTimer = setTimeout(() => void this.shutdown(0), Math.max(0, lingerMs));
  }

  private checkIdle(idleMs: number): void {
    if (this.stopping || this.exited) return;
    const idleFor = Date.now() - Math.max(this.lastDaemonActivity, this.lastPiOutput);
    const noDaemons = this.daemons.size === 0;
    // Never while streaming: in-flight pi output keeps lastPiOutput fresh,
    // so a busy run cannot trip this even with no daemon attached.
    if (noDaemons && idleFor >= idleMs) {
      log(this.options.agentId, "holder.idle_timeout", { idleMs });
      void this.gracefulStop();
    }
  }

  async gracefulStop(): Promise<void> {
    if (this.stopping) return;
    this.stopping = true;
    if (this.idleTimer) clearInterval(this.idleTimer);
    if (this.lingerTimer) clearTimeout(this.lingerTimer);
    const graceMs = this.options.stopGraceMs ?? 2_000;
    try {
      this.child.stdin.end();
    } catch {}
    const deadline = new Promise((resolve) => setTimeout(resolve, graceMs));
    await Promise.race([this.child.exited, deadline]);
    if (this.child.exitCode === null) {
      try {
        this.child.kill("SIGTERM");
      } catch {}
      const killDeadline = new Promise((resolve) => setTimeout(resolve, 2_000));
      await Promise.race([this.child.exited, killDeadline]);
    }
    if (this.child.exitCode === null) {
      try {
        this.child.kill("SIGKILL");
      } catch {}
      await this.child.exited.catch(() => undefined);
    }
    await this.shutdown(0);
  }

  private async shutdown(code: number): Promise<void> {
    if (this.exited) return;
    this.exited = true;
    if (this.idleTimer) clearInterval(this.idleTimer);
    if (this.lingerTimer) clearTimeout(this.lingerTimer);
    for (const socket of this.daemons) {
      try {
        socket.end();
      } catch {}
    }
    try {
      this.server.close();
    } catch {}
    const { sessionDir, socketPath } = this.options;
    for (const path of [socketPath, pidPathFor(sessionDir), metaPathFor(sessionDir)]) {
      try {
        unlinkSync(path);
      } catch {}
    }
    log(this.options.agentId, "holder.stopped", { code });
    if (this.options.onExit) this.options.onExit(code);
    else process.exit(code);
  }
}
