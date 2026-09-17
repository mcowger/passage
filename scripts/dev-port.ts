#!/usr/bin/env bun
// Stable per-worktree dev port picker for the 3000-3999 range.
//
// Prints a single port number on STDOUT (nothing else); diagnostics go to
// STDERR so the output composes with command substitution:
//
//   PORT="$(bun scripts/dev-port.ts)" bun --watch run src/daemon/index.ts
//
// Stability comes from hashing the canonical worktree root, so each checkout
// keeps its own port across restarts.
//
// The port is NEVER bumped. If the intended port already has a listener:
// - when the listener is owned by the live PID recorded in the dev server
//   pidfile (.data/dev.pid, or PASSAGE_PID_FILE), the dev server is already
//   running and the same port is printed;
// - otherwise a CRITICAL error is printed to both STDOUT and STDERR and the
//   script exits non-zero. A foreign listener on the intended port means
//   something is wrong; the agent must stop and ask the user for help rather
//   than pick a different port.
//
// Discovery order when run to print this worktree's port:
// 1. the port recorded in `.data/dev.port` by the running dev server
//    (authoritative; immune to PORT/PASEO_PORT leaking in from another
//    checkout, since each worktree has its own dedicated port);
// 2. the port the pidfile's live process is actually LISTENing on;
// 3. the intended port below (PASEO_PORT when the runner set it for this
//    worktree, otherwise the stable hash), with listener checks.
//
// Two modes:
// - Manual (`bun run dev`): the intended port is the stable hash of the
//   worktree root. PASEO_PORT (set by the Paseo worktree runner, which routes
//   traffic to it) takes precedence when present. The generic PORT variable
//   is deliberately ignored: it is commonly inherited from a shell or parent
//   process belonging to a different worktree, so honoring it would break
//   per-worktree isolation.
// - Paseo portScript (`worktree.servicePorts.portScript` in paseo.json):
//   Paseo executes this file directly (shebang, no shell) with four
//   positional args -- service name, workspace ID, branch name (empty when
//   unknown), worktree path -- plus PASEO_* env vars. In this mode PORT /
//   PASEO_PORT are ignored because Paseo has not assigned this service a
//   port yet; the hash is taken over the worktree path Paseo passes in.

import { existsSync, readdirSync, readFileSync, readlinkSync, realpathSync } from "node:fs";
import { dirname, isAbsolute, join } from "node:path";

const RANGE_LO = 3000;
const RANGE_HI = 3999;
const RANGE_SIZE = RANGE_HI - RANGE_LO + 1;
const LISTEN_STATE = "0A";

const DEFAULT_PID_FILE = join(import.meta.dir, "..", ".data", "dev.pid");

export function fnv1a32(input: string): number {
  let hash = 0x811c9dc5;
  for (const byte of new TextEncoder().encode(input)) {
    hash ^= byte;
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

export function stableBasePort(worktreeRoot: string): number {
  return RANGE_LO + (fnv1a32(worktreeRoot) % RANGE_SIZE);
}

export function worktreeRoot(cwd: string = process.cwd()): string {
  try {
    const result = Bun.spawnSync(["git", "rev-parse", "--show-toplevel"], {
      cwd,
      stdout: "pipe",
      stderr: "ignore",
    });
    if (result.exitCode === 0) {
      const root = result.stdout.toString().trim();
      if (root.length > 0) return realpathSync(root);
    }
  } catch {
    // Fall through to the cwd fallback below.
  }
  try {
    return realpathSync(cwd);
  } catch {
    return cwd;
  }
}

export function resolveStart(env: Record<string, string | undefined>): number {
  const raw = env.PASEO_PORT?.trim();
  if (raw !== undefined && raw !== "") {
    const parsed = Number(raw);
    if (Number.isInteger(parsed) && parsed > 0 && parsed < 65536) return parsed;
    console.error(`dev-port: ignoring invalid PASEO_PORT=${JSON.stringify(raw)}`);
  }
  return stableBasePort(worktreeRoot());
}

// Detect Paseo portScript invocation: extra positional args past the runtime
// and script path (Bun.argv[0..1]). Returns the worktree path to hash, or
// null for manual mode. PASEO_WORKTREE_PATH is preferred when set because it
// is canonical; the argv worktree path is the fallback.
export function portScriptWorktreePath(
  argv: readonly string[],
  env: Record<string, string | undefined>,
): string | null {
  if (argv.length <= 2) return null;
  return env.PASEO_WORKTREE_PATH?.trim() || argv[5]?.trim() || null;
}

// Mirrors scripts/dev-stop.ts so both agree on where the dev server records
// its PID.
export function resolvePidFile(env: Record<string, string | undefined> = process.env): string {
  const custom = env.PASSAGE_PID_FILE?.trim();
  if (custom) {
    return isAbsolute(custom) ? custom : join(process.cwd(), custom);
  }
  return DEFAULT_PID_FILE;
}

// Sibling of the pidfile recording the port the running dev server actually
// bound. Unlike PORT/PASEO_PORT in the shell (which often leak in from a
// different checkout), this file is written by the server itself on boot, so
// it is immune to cross-worktree env contamination.
export function portFileForPidFile(pidFile: string): string {
  return join(dirname(pidFile), "dev.port");
}

// Returns the recorded port when the pidfile's process is still alive and the
// record holds a valid port. Stale records (dead pid, missing or invalid
// file) return null so callers fall through to live discovery.
export function readRecordedPort(pidFile: string): number | null {
  if (readLivePid(pidFile) === null) return null;
  let raw = "";
  try {
    raw = readFileSync(portFileForPidFile(pidFile), "utf8").trim();
  } catch {
    return null;
  }
  const port = Number(raw);
  if (!Number.isInteger(port) || port <= 0 || port >= 65536) return null;
  return port;
}

// Returns the pid recorded in the pidfile when that process is still alive,
// otherwise null.
export function readLivePid(pidFile: string): number | null {
  if (!existsSync(pidFile)) return null;
  let raw = "";
  try {
    raw = readFileSync(pidFile, "utf8").trim();
  } catch {
    return null;
  }
  const pid = Number(raw);
  if (!Number.isInteger(pid) || pid <= 0) return null;
  try {
    process.kill(pid, 0);
  } catch {
    return null;
  }
  return pid;
}

// Parses /proc/net/tcp (or tcp6) content and returns the socket inodes
// LISTENing on the given port.
export function parseListeningInodes(procNetTcp: string, port: number): Set<string> {
  const inodes = new Set<string>();
  const hexPort = port.toString(16).toUpperCase().padStart(4, "0");
  for (const line of procNetTcp.split("\n")) {
    const parts = line.trim().split(/\s+/);
    if (parts.length < 10) continue;
    const localAddress = parts[1];
    const state = parts[3];
    if (state !== LISTEN_STATE) continue;
    if (!localAddress?.endsWith(`:${hexPort}`)) continue;
    const inode = parts[9];
    if (inode && inode !== "0") inodes.add(inode);
  }
  return inodes;
}

export function listeningInodesForPort(port: number): Set<string> {
  const inodes = new Set<string>();
  for (const path of ["/proc/net/tcp", "/proc/net/tcp6"]) {
    try {
      for (const inode of parseListeningInodes(readFileSync(path, "utf8"), port)) {
        inodes.add(inode);
      }
    } catch {
      // Missing or unreadable /proc file; treat as no listeners there.
    }
  }
  return inodes;
}

// Parses /proc/net/tcp (or tcp6) content and returns every LISTEN socket as
// an inode -> port mapping.
export function parseListeningPorts(procNetTcp: string): Map<string, number> {
  const ports = new Map<string, number>();
  for (const line of procNetTcp.split("\n")) {
    const parts = line.trim().split(/\s+/);
    if (parts.length < 10) continue;
    const localAddress = parts[1];
    if (!localAddress || parts[3] !== LISTEN_STATE) continue;
    const separator = localAddress.lastIndexOf(":");
    if (separator < 0) continue;
    const port = Number.parseInt(localAddress.slice(separator + 1), 16);
    const inode = parts[9];
    if (!Number.isInteger(port) || port <= 0 || !inode || inode === "0") continue;
    ports.set(inode, port);
  }
  return ports;
}

export function listeningPorts(): Map<string, number> {
  const merged = new Map<string, number>();
  for (const path of ["/proc/net/tcp", "/proc/net/tcp6"]) {
    try {
      for (const [inode, port] of parseListeningPorts(readFileSync(path, "utf8"))) {
        if (!merged.has(inode)) merged.set(inode, port);
      }
    } catch {
      // Missing or unreadable /proc file; treat as no listeners there.
    }
  }
  return merged;
}

// Returns the distinct ports the given process is LISTENing on. Used to
// report the port this worktree's dev server actually bound, even when the
// shell's PORT/PASEO_PORT leaked in from a different checkout and no port
// record exists yet.
export function pidListeningPorts(pid: number): Set<number> {
  const byInode = listeningPorts();
  if (byInode.size === 0) return new Set();
  let fds: string[];
  try {
    fds = readdirSync(`/proc/${pid}/fd`);
  } catch {
    return new Set();
  }
  const found = new Set<number>();
  for (const fd of fds) {
    let target: string;
    try {
      target = readlinkSync(`/proc/${pid}/fd/${fd}`);
    } catch {
      continue;
    }
    const match = /^socket:\[(\d+)\]$/.exec(target);
    const port = match ? byInode.get(match[1]) : undefined;
    if (port !== undefined) found.add(port);
  }
  return found;
}

// Checks whether the given process holds at least one of the socket inodes.
export function pidOwnsSocketInode(pid: number, inodes: ReadonlySet<string>): boolean {
  if (inodes.size === 0) return false;
  let fds: string[];
  try {
    fds = readdirSync(`/proc/${pid}/fd`);
  } catch {
    return false;
  }
  for (const fd of fds) {
    let target: string;
    try {
      target = readlinkSync(`/proc/${pid}/fd/${fd}`);
    } catch {
      continue;
    }
    const match = /^socket:\[(\d+)\]$/.exec(target);
    if (match && inodes.has(match[1])) return true;
  }
  return false;
}

if (import.meta.main) {
  const pidFile = resolvePidFile(process.env);

  // A running dev server's recorded port is authoritative: it reflects the
  // port the server actually bound, regardless of what PORT/PASEO_PORT this
  // shell inherited (those often leak in from a different checkout, and each
  // worktree has its own dedicated port).
  const recorded = readRecordedPort(pidFile);
  if (recorded !== null) {
    console.error(`dev-port: using recorded port ${recorded} for this worktree's running dev server`);
    console.log(recorded);
    process.exit(0);
  }

  // No record (e.g. the server predates port files): fall back to the port
  // the pidfile's live process is actually listening on, when unambiguous.
  const livePid = readLivePid(pidFile);
  if (livePid !== null) {
    const owned = pidListeningPorts(livePid);
    if (owned.size === 1) {
      const actual = [...owned][0]!;
      console.error(`dev-port: dev server (PID ${livePid}) is listening on ${actual}; using it`);
      console.log(actual);
      process.exit(0);
    }
  }

  const scriptWorktree = portScriptWorktreePath(Bun.argv, process.env);
  const root = worktreeRoot();
  const stable = stableBasePort(root);
  const port = scriptWorktree === null ? resolveStart(process.env) : stableBasePort(scriptWorktree);

  if (scriptWorktree === null) {
    const rawPaseo = process.env.PASEO_PORT?.trim();
    const parsedPaseo = rawPaseo === undefined || rawPaseo === "" ? NaN : Number(rawPaseo);
    if (Number.isInteger(parsedPaseo) && parsedPaseo > 0 && parsedPaseo < 65536 && parsedPaseo !== stable) {
      console.error(
        `dev-port: warning: PASEO_PORT=${JSON.stringify(rawPaseo)} differs from this worktree's stable port ${stable} ` +
        `(worktree: ${root}). It may have leaked in from a different checkout; using PASEO_PORT anyway for routing.`,
      );
    }
  }

  const listeners = listeningInodesForPort(port);
  if (listeners.size > 0) {
    const pid = readLivePid(pidFile);
    if (pid !== null && pidOwnsSocketInode(pid, listeners)) {
      console.error(`dev-port: dev server (PID ${pid}) is already running on port ${port}`);
      console.log(port);
      process.exit(0);
    }
    const staleEnv = process.env.PASEO_PORT?.trim()
      ? ` PORT/PASEO_PORT in this shell (PASEO_PORT=${JSON.stringify(process.env.PASEO_PORT.trim())}) may be inherited from a different checkout;` : "";
    const message =
      `CRITICAL: dev-port: port ${port} is occupied by a process other than this worktree's dev server ` +
      `(worktree: ${root}, stable port: ${stable}, pidfile: ${pidFile}).${staleEnv}` +
      ` Each worktree has its own dedicated port -- never reuse one from another checkout. ` +
      `Do NOT bump to another port or start a second server. Stop and ask the user for help.`;
    console.error(message);
    console.log(message);
    process.exit(1);
  }

  console.log(port);
}
