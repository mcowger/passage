/** Daemon-side holder lifecycle: self command, spawn, attach helpers, sweep,
 * shutdown-holders, and pi-status. The holder itself never imports this file
 * (it must stay dependency-light); only the daemon uses it.
 */
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, unlinkSync } from "node:fs";
import { readdir } from "node:fs/promises";
import { connect, type Socket } from "node:net";
import { join } from "node:path";
import { errorFields, logger } from "../../logging.ts";
import {
  HOLDER_ARGV,
  isHolderControlFrame,
  metaPathFor,
  parseHolderMeta,
  pidPathFor,
  scopeUnitFor,
  socketPathFor,
  validateAgentId,
  type HolderHelloAck,
  type HolderMeta,
} from "./protocol.ts";
import type { PiRpcOptions } from "../rpc/index.ts";

const log = () => logger("pi-holder");
const encoder = new TextEncoder();

/** Same artifact, subcommand dispatch: standalone binary vs `bun run` dev. */
export function getSelfCommand(): string[] {
  const execPath = process.execPath;
  if ((Bun as { isStandaloneExecutable?: boolean }).isStandaloneExecutable === true) {
    return [execPath];
  }
  // Dev: re-invoke the daemon entrypoint through bun.
  return [execPath, join(import.meta.dir, "..", "..", "index.ts")];
}

export type HolderSpawnOptions = {
  agentId: string;
  sessionsRoot: string;
  sessionId: string;
  cwd: string;
  generation: number;
  pi?: Omit<PiRpcOptions, "cwd" | "sessionDir" | "sessionId">;
  socketTimeoutMs?: number;
};

function holderArgs(options: HolderSpawnOptions, socketPath: string, sessionDir: string): string[] {
  const args: string[] = [
    HOLDER_ARGV,
    options.agentId,
    "--session-dir", sessionDir,
    "--session-id", options.sessionId,
    "--cwd", options.cwd,
    "--socket", socketPath,
    "--generation", String(options.generation),
  ];
  if (options.pi?.executable) args.push("--pi-path", options.pi.executable);
  for (const arg of options.pi?.executableArgs ?? []) args.push("--pi-arg", arg);
  if (options.pi?.model) args.push("--model", options.pi.model);
  if (options.pi?.disableTools) args.push("--no-tools");
  if (options.pi?.maxEventBytes) args.push("--max-event-bytes", String(options.pi.maxEventBytes));
  if (options.pi?.maxStderrBytes) args.push("--max-stderr-bytes", String(options.pi.maxStderrBytes));
  return args;
}

function systemdRunAvailable(): boolean {
  if (process.env.PASSAGE_HOLDER_NO_SYSTEMD === "1") return false;
  try {
    const probe = Bun.spawnSync(["systemd-run", "--user", "--help"], { stdout: "ignore", stderr: "ignore" });
    return probe.exitCode === 0;
  } catch {
    return false;
  }
}

/** Spawn (or reuse) the detached holder for an agent; resolves once the
 * socket accepts a hello. Returns the hello_ack from the holder. */
export async function ensureHolder(options: HolderSpawnOptions): Promise<HolderHelloAck> {
  const agentId = validateAgentId(options.agentId);
  const sessionDir = join(options.sessionsRoot, agentId);
  mkdirSync(sessionDir, { recursive: true, mode: 0o700 });
  try {
    chmodSync(sessionDir, 0o700);
  } catch {}
  const socketPath = socketPathFor(sessionDir);

  // Fast path: live holder already listening.
  const existing = await tryHello(socketPath, agentId, 0, options.socketTimeoutMs ?? 2_000).catch(() => undefined);
  if (existing) return existing;

  // Stale socket file with nothing listening → remove (same as crashed pi).
  try {
    unlinkSync(socketPath);
  } catch {}
  // Stale pid/meta without a live process → remove.
  removeStaleMeta(sessionDir);

  const [self, ...prefix] = getSelfCommand();
  const args = [...prefix, ...holderArgs(options, socketPath, sessionDir)];
  const useSystemd = systemdRunAvailable();
  // NB: `systemd-run --scope` stays in the foreground until the scope
  // exits, so it must NEVER be awaited with spawnSync: a blocking wait
  // hangs the daemon's event loop forever (no timer ever fires). Launch
  // async + unref; the hello wait loop below is the readiness signal, and
  // systemd-run's stderr is captured to a file for post-mortem.
  const scopeStderrPath = join(sessionDir, "systemd-run.err");
  if (useSystemd) {
    const unit = scopeUnitFor(agentId);
    // Clear a stale scope with the same name (previous holder that died
    // without cleanup); ignore failures — the fresh start is authoritative.
    try {
      Bun.spawnSync(["systemctl", "--user", "stop", unit], { stdout: "ignore", stderr: "ignore", stdin: "ignore" });
    } catch {}
    try {
      const proc = Bun.spawn(
        ["systemd-run", "--user", "--scope", "--unit", unit, self, ...args],
        { cwd: sessionDir, env: process.env, stdin: "ignore", stdout: "ignore", stderr: "pipe" },
      );
      void drainToFile(proc, scopeStderrPath);
      proc.unref();
      log().info("Holder spawning in transient scope", { event: "holder.spawned", agentId, unit });
    } catch (error) {
      log().warn("systemd-run holder spawn failed, falling back to setsid", {
        event: "holder.systemd_fallback", agentId, ...errorFields(error),
      });
      spawnDetached(self, args, sessionDir);
    }
  } else {
    spawnDetached(self, args, sessionDir);
  }

  // Wait for the socket (holder boot + pi spawn).
  const deadlineMs = options.socketTimeoutMs ?? 15_000;
  const start = Date.now();
  let lastError: unknown;
  while (Date.now() - start < deadlineMs) {
    try {
      const ack = await tryHello(socketPath, agentId, 0, 2_000);
      return ack;
    } catch (error) {
      lastError = error;
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
  }
  // Surface the scope launcher's stderr tail when the holder never came up.
  let detail = "";
  try {
    const { readFileSync: readErr } = await import("node:fs");
    detail = readErr(scopeStderrPath, "utf8").trim().slice(-512);
  } catch {}
  const cause = lastError instanceof Error ? `: ${lastError.message}` : "";
  throw new Error(`holder did not become ready${cause}${detail ? `; launcher: ${detail}` : ""}`);
}

/** Drain a fire-and-forget child's stderr into a file (post-mortem for
 * scope spawns). Completes when the child exits; never rejects. */
async function drainToFile(proc: Bun.Subprocess, path: string): Promise<void> {
  try {
    const writer = Bun.file(path).writer();
    const reader = (proc.stderr as ReadableStream<Uint8Array>).getReader();
    try {
      while (true) {
        const result = await reader.read();
        if (result.done) break;
        writer.write(result.value);
      }
    } catch {}
    finally {
      reader.releaseLock();
      try {
        await writer.end();
      } catch {}
    }
  } catch {}
}

function spawnDetached(command: string, args: string[], sessionDir: string): void {
  // Fallback when systemd is unavailable: setsid-detached child of the
  // daemon. Survives `bun --watch` reloads; on systemd with
  // KillMode=control-group a daemon restart would still kill it (documented
  // in ORHPANS.md — prefer transient scopes in production).
  const child = Bun.spawn([command, ...args], {
    cwd: sessionDir,
    env: process.env,
    stdin: "ignore",
    stdout: "ignore",
    stderr: "ignore",
    detached: true,
  });
  child.unref();
  log().info("Holder spawned detached", { event: "holder.spawned", pid: child.pid });
}

function removeStaleMeta(sessionDir: string): void {
  const meta = readMeta(sessionDir);
  if (!meta) return;
  let alive = false;
  try {
    process.kill(meta.pid, 0);
    alive = true;
  } catch {
    alive = false;
  }
  if (!alive) {
    try {
      unlinkSync(pidPathFor(sessionDir));
    } catch {}
    try {
      unlinkSync(metaPathFor(sessionDir));
    } catch {}
  }
}

export function readMeta(sessionDir: string): HolderMeta | undefined {
  try {
    return parseHolderMeta(JSON.parse(readFileSync(metaPathFor(sessionDir), "utf8")));
  } catch {
    return undefined;
  }
}

export function readGeneration(sessionDir: string): number {
  return readMeta(sessionDir)?.generation ?? 0;
}

/** Single hello/handshake against a holder socket. Resolves hello_ack. */
export function tryHello(socketPath: string, agentId: string, after = 0, timeoutMs = 5_000): Promise<HolderHelloAck> {
  return new Promise((resolve, reject) => {
    let done = false;
    let buffer = "";
    const finish = (error?: Error, ack?: HolderHelloAck): void => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      try {
        socket.destroy();
      } catch {}
      if (error) reject(error);
      else resolve(ack!);
    };
    const timer = setTimeout(() => finish(new Error("holder hello timed out")), timeoutMs);
    let socket: Socket;
    try {
      socket = connect(socketPath);
    } catch (error) {
      finish(error instanceof Error ? error : new Error(String(error)));
      return;
    }
    socket.on("connect", () => {
      try {
        socket.write(`${JSON.stringify({ type: "passage_hello", agentId, after })}\n`);
      } catch (error) {
        finish(error instanceof Error ? error : new Error(String(error)));
      }
    });
    socket.on("data", (chunk) => {
      buffer += chunk.toString("utf8");
      let newline: number;
      while ((newline = buffer.indexOf("\n")) !== -1) {
        const line = buffer.slice(0, newline).replace(/\r$/, "");
        buffer = buffer.slice(newline + 1);
        if (!line.trim()) continue;
        let record: unknown;
        try {
          record = JSON.parse(line);
        } catch {
          continue;
        }
        if (
          typeof record === "object" && record !== null &&
          (record as { type?: unknown }).type === "passage_hello_ack"
        ) {
          finish(undefined, record as HolderHelloAck);
          return;
        }
      }
      if (encoder.encode(buffer).byteLength > 1024 * 1024) finish(new Error("holder hello response too large"));
    });
    socket.on("error", (error) => finish(error instanceof Error ? error : new Error(String(error))));
    socket.on("close", () => finish(new Error("holder socket closed before hello_ack")));
  });
}

export async function pingHolder(sessionsRoot: string, agentId: string, timeoutMs = 3_000): Promise<boolean> {
  const socketPath = socketPathFor(join(sessionsRoot, agentId));
  try {
    await tryHello(socketPath, agentId, 0, timeoutMs);
    return true;
  } catch {
    return false;
  }
}

export type SweepDecision = "keep" | "kill-stale" | "kill-archived" | "kill-unknown" | "respawn";

export type SweepCandidate = {
  agentId: string;
  sessionDir: string;
  socketAlive: boolean;
  meta?: HolderMeta;
  knownAgent: boolean;
  archived: boolean;
};

/** Pure decision matrix (unit-tested): live agent + live holder → keep;
 * archived + live holder → kill; live agent + dead socket → respawn;
 * unknown socket → kill. */
export function decideSweep(candidate: SweepCandidate): SweepDecision {
  if (!candidate.knownAgent) return candidate.socketAlive ? "kill-unknown" : "kill-unknown";
  if (candidate.archived) return candidate.socketAlive ? "kill-archived" : "kill-stale";
  if (candidate.socketAlive) return "keep";
  return "respawn";
}

export type SweepResult = { kept: string[]; killed: string[]; respawned: string[] };

/** Orphan sweep on daemon boot: join rpc.sock entries against agent records
 * + holder liveness. Kills anything with no live, unarchived agent. */
export async function sweepHolders(
  sessionsRoot: string,
  lookup: (agentId: string) => { archived: boolean } | undefined,
  stopAgent: (agentId: string) => Promise<void>,
): Promise<SweepResult> {
  const result: SweepResult = { kept: [], killed: [], respawned: [] };
  let entries: string[] = [];
  try {
    entries = await readdir(sessionsRoot);
  } catch {
    return result;
  }
  for (const agentId of entries) {
    if (!/^[A-Za-z0-9_-]{1,128}$/.test(agentId)) continue;
    const sessionDir = join(sessionsRoot, agentId);
    const socketPath = socketPathFor(sessionDir);
    const hasSocketFile = existsSync(socketPath);
    const meta = readMeta(sessionDir);
    const socketAlive = hasSocketFile && await pingHolder(sessionsRoot, agentId, 1_500).catch(() => false);
    if (!hasSocketFile && !meta) continue;
    const record = lookup(agentId);
    const decision = decideSweep({
      agentId,
      sessionDir,
      socketAlive,
      ...(meta ? { meta } : {}),
      knownAgent: record !== undefined,
      archived: record?.archived === true,
    });
    if (decision === "keep") {
      result.kept.push(agentId);
    } else if (decision === "respawn") {
      result.respawned.push(agentId);
      // Respawn is lazy: remove the dead socket so ensureProcess starts a
      // fresh holder on next use (same as a crashed pi today).
      try {
        unlinkSync(socketPath);
      } catch {}
    } else {
      try {
        await stopAgent(agentId);
      } catch (error) {
        log().warn("Sweep kill failed", { event: "holder.swept", agentId, decision, ...errorFields(error) });
      }
      // Belt and braces: remove files even if stopAgent already did.
      for (const path of [socketPath, pidPathFor(sessionDir), metaPathFor(sessionDir)]) {
        try {
          unlinkSync(path);
        } catch {}
      }
      log().info("Swept orphan holder", { event: "holder.swept", agentId, decision });
      result.killed.push(agentId);
    }
  }
  return result;
}

/** Send passage_stop to one holder and wait for the socket to go away. */
export async function stopHolder(sessionsRoot: string, agentId: string, timeoutMs = 10_000): Promise<boolean> {
  const socketPath = socketPathFor(join(sessionsRoot, agentId));
  const stopped = await new Promise<boolean>((resolve) => {
    let socket: Socket;
    try {
      socket = connect(socketPath);
    } catch {
      resolve(false);
      return;
    }
    const timer = setTimeout(() => {
      try {
        socket.destroy();
      } catch {}
      resolve(false);
    }, timeoutMs);
    socket.on("connect", () => {
      try {
        socket.write(`${JSON.stringify({ type: "passage_stop" })}\n`);
      } catch {
        clearTimeout(timer);
        resolve(false);
      }
    });
    socket.on("data", () => {});
    socket.on("error", () => {
      clearTimeout(timer);
      resolve(false);
    });
    socket.on("close", () => {
      clearTimeout(timer);
      resolve(true);
    });
  });
  // Wait for socket/pid/meta removal (holder exits after tearing down pi).
  const start = Date.now();
  const sessionDir = join(sessionsRoot, agentId);
  while (Date.now() - start < timeoutMs) {
    if (!existsSync(socketPathFor(sessionDir)) && !existsSync(pidPathFor(sessionDir))) return true;
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  return stopped;
}

/** Global kill: passage_stop each holder, SIGKILL stragglers after deadline. */
export async function shutdownHolders(sessionsRoot: string, timeoutMs = 15_000): Promise<{ stopped: string[]; killed: string[] }> {
  const stopped: string[] = [];
  const killed: string[] = [];
  let entries: string[] = [];
  try {
    entries = await readdir(sessionsRoot);
  } catch {
    return { stopped, killed };
  }
  await Promise.all(entries.map(async (agentId) => {
    if (!/^[A-Za-z0-9_-]{1,128}$/.test(agentId)) return;
    const sessionDir = join(sessionsRoot, agentId);
    if (!existsSync(socketPathFor(sessionDir)) && !existsSync(pidPathFor(sessionDir))) return;
    const ok = await stopHolder(sessionsRoot, agentId, Math.min(8_000, timeoutMs)).catch(() => false);
    if (ok) {
      stopped.push(agentId);
      return;
    }
    // Straggler: SIGKILL the holder PID, then remove files.
    const meta = readMeta(sessionDir);
    if (meta) {
      try {
        process.kill(meta.pid, "SIGKILL");
        killed.push(agentId);
        log().warn("Holder SIGKILLed", { event: "holder.sigkill", agentId, pid: meta.pid });
      } catch {}
    }
    for (const path of [socketPathFor(sessionDir), pidPathFor(sessionDir), metaPathFor(sessionDir)]) {
      try {
        rmSync(path, { force: true });
      } catch {}
    }
  }));
  return { stopped, killed };
}

/** Debug helper for `passage pi-status [agentId]`. */
export async function holderStatus(sessionsRoot: string, agentId: string): Promise<Record<string, unknown>> {
  const sessionDir = join(sessionsRoot, agentId);
  const meta = readMeta(sessionDir);
  const alive = await pingHolder(sessionsRoot, agentId, 2_000).catch(() => false);
  return {
    agentId,
    transport: alive ? "holder" : "none",
    holderVersion: meta?.holderVersion,
    generation: meta?.generation,
    socketAlive: alive,
    pid: meta?.pid,
    startedAt: meta?.startedAt,
  };
}
