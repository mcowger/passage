#!/usr/bin/env bun
// Stable per-worktree dev port picker for the 3000-3999 range.
//
// Prints a single port number on STDOUT (nothing else); diagnostics go to
// STDERR so the output composes with command substitution:
//
//   PORT="$(bun scripts/dev-port.ts)" bun --watch run src/daemon/index.ts
//
// Stability comes from hashing the canonical worktree root, so each checkout
// keeps its own port across restarts. Every candidate is occupancy-checked
// (TCP connect to 127.0.0.1) and bumped until a free port is found.
//
// Two modes:
// - Manual (`bun run dev`): precedence for the starting candidate is explicit
//   PORT, then PASEO_PORT (set by the Paseo worktree runner, which routes
//   traffic to it), then the stable hash.
// - Paseo portScript (`worktree.servicePorts.portScript` in paseo.json):
//   Paseo executes this file directly (shebang, no shell) with four
//   positional args -- service name, workspace ID, branch name (empty when
//   unknown), worktree path -- plus PASEO_* env vars. In this mode PORT /
//   PASEO_PORT are ignored because Paseo has not assigned this service a
//   port yet; the hash is taken over the worktree path Paseo passes in.

import { realpathSync } from "node:fs";

const RANGE_LO = 3000;
const RANGE_HI = 3999;
const RANGE_SIZE = RANGE_HI - RANGE_LO + 1;
const MAX_PROBES = 1000;
const CONNECT_TIMEOUT_MS = 300;

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

async function isOccupied(port: number): Promise<boolean> {
  try {
    const socket = await Promise.race([
      // NB: Bun.connect requires at least a data/drain handler, otherwise it
      // rejects even when the TCP connect succeeds (and every port would
      // look free).
      Bun.connect({ hostname: "127.0.0.1", port, socket: { data() {} } }),
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error("connect timeout")), CONNECT_TIMEOUT_MS)),
    ]);
    try {
      socket.end();
    } catch {
      // Already closed; the successful connect is what matters.
    }
    return true;
  } catch {
    return false;
  }
}

export function resolveStart(env: Record<string, string | undefined>): { start: number; wrap: boolean } {
  for (const key of ["PORT", "PASEO_PORT"] as const) {
    const raw = env[key]?.trim();
    if (raw === undefined || raw === "") continue;
    const parsed = Number(raw);
    if (Number.isInteger(parsed) && parsed > 0 && parsed < 65536) {
      return { start: parsed, wrap: parsed >= RANGE_LO && parsed <= RANGE_HI };
    }
    console.error(`dev-port: ignoring invalid ${key}=${JSON.stringify(raw)}`);
  }
  return { start: stableBasePort(worktreeRoot()), wrap: true };
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

if (import.meta.main) {
  const scriptWorktree = portScriptWorktreePath(Bun.argv, process.env);
  const { start, wrap } = scriptWorktree === null
    ? resolveStart(process.env)
    : { start: stableBasePort(scriptWorktree), wrap: true };
  for (let attempt = 0; attempt < MAX_PROBES; attempt += 1) {
    const port = wrap ? RANGE_LO + ((start - RANGE_LO + attempt) % RANGE_SIZE) : start + attempt;
    if (!(await isOccupied(port))) {
      console.log(port);
      process.exit(0);
    }
  }
  console.error("dev-port: no free port found");
  process.exit(1);
}
