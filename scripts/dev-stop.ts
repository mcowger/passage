#!/usr/bin/env bun
import { existsSync, readFileSync, unlinkSync } from "node:fs";
import { dirname, isAbsolute, join } from "node:path";
import { readRecordedPort } from "./dev-port.ts";

const DEFAULT_PID_FILE = join(import.meta.dir, "..", ".data", "dev.pid");
/** No automatic kill deadline here mirrors the daemon itself (safe drain
 *  waits for an idle boundary; see AGENTS.md Pi process ownership): this is only how long the CLI blocks
 *  before reporting incomplete maintenance. It never escalates to a
 *  signal on its own -- that requires --force. */
const SAFE_WAIT_MS = 30_000;
const FORCE_WAIT_MS = 6_000;
const SIGNAL_ESCALATION_WAIT_MS = 2_000;

export function resolvePidFile(env: Record<string, string | undefined> = process.env): string {
  const custom = env.PASSAGE_PID_FILE?.trim();
  if (custom) {
    return isAbsolute(custom) ? custom : join(process.cwd(), custom);
  }
  return DEFAULT_PID_FILE;
}

export function portFileForPidFile(pidFile: string): string {
  return join(dirname(pidFile), "dev.port");
}

// Removes the pidfile and its sibling recorded-port file, ignoring errors.
export function removePidArtifacts(pidFile: string): void {
  try { unlinkSync(pidFile); } catch {}
  try { unlinkSync(portFileForPidFile(pidFile)); } catch {}
}

export function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function requestDaemonShutdown(port: number, body: { force?: boolean }): Promise<{ ok: boolean; status: number }> {
  const response = await fetch(`http://127.0.0.1:${port}/api/daemon/shutdown`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  return { ok: response.ok, status: response.status };
}

async function waitForExit(pid: number, pidFile: string, timeoutMs: number): Promise<{ stopped: boolean; pid: number; message: string }> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!isProcessAlive(pid)) {
      removePidArtifacts(pidFile);
      return { stopped: true, pid, message: `Stopped dev server (PID ${pid}).` };
    }
    await Bun.sleep(100);
  }
  return { stopped: false, pid, message: `Dev server (PID ${pid}) did not stop within ${timeoutMs}ms. It may be waiting on active agent work to drain; pass --force for an explicit forced stop.` };
}

export type StopDevServerOptions = { force?: boolean; timeoutMs?: number };

/** Default stop uses the daemon's own lifecycle API (safe shutdown:
 *  a safe request that waits for an idle boundary before actually
 *  exiting, with no automatic kill deadline on the daemon's side. `--force`
 *  is a separate, explicit decision -- it asks the lifecycle API for a
 *  forced/interrupting stop and, only if that is unreachable or does not
 *  finish in time, falls back to signal escalation (SIGTERM, then SIGKILL)
 *  the way this script always used to behave unconditionally. */
export async function stopDevServer(pidFile = resolvePidFile(), options: StopDevServerOptions = {}): Promise<{ stopped: boolean; pid?: number; message: string }> {
  if (!existsSync(pidFile)) {
    return { stopped: false, message: "Dev server is not running (no pidfile found)." };
  }

  let raw = "";
  try {
    raw = readFileSync(pidFile, "utf8").trim();
  } catch (error) {
    return { stopped: false, message: `Failed to read pidfile: ${String(error)}` };
  }

  const pid = Number(raw);
  if (!Number.isInteger(pid) || pid <= 0) {
    removePidArtifacts(pidFile);
    return { stopped: false, message: "Removed invalid pidfile." };
  }

  if (!isProcessAlive(pid)) {
    removePidArtifacts(pidFile);
    return { stopped: false, pid, message: `Dev server (PID ${pid}) is not running (cleaned up stale pidfile).` };
  }

  // Resolve the dev server's actual port the way dev-port.ts itself does
  // (the port it recorded on boot for this live pid) -- never an inherited
  // PORT/PASEO_PORT, which commonly leaks in from a different worktree's
  // shell.
  const port = readRecordedPort(pidFile);

  if (options.force) {
    if (port !== null) {
      // Only wait on the lifecycle API if the request actually reached it
      // -- an unresolved port has nothing to wait for.
      try {
        await requestDaemonShutdown(port, { force: true });
        const afterApi = await waitForExit(pid, pidFile, options.timeoutMs ?? FORCE_WAIT_MS);
        if (afterApi.stopped) return afterApi;
      } catch {}
    }
    try { process.kill(pid, "SIGTERM"); } catch (error) { return { stopped: false, pid, message: `Failed to signal process ${pid}: ${String(error)}` }; }
    const afterTerm = await waitForExit(pid, pidFile, SIGNAL_ESCALATION_WAIT_MS);
    if (afterTerm.stopped) return { ...afterTerm, message: `Force stopped dev server (PID ${pid}) via SIGTERM.` };
    try { process.kill(pid, "SIGKILL"); } catch {}
    const afterKill = await waitForExit(pid, pidFile, SIGNAL_ESCALATION_WAIT_MS);
    return afterKill.stopped
      ? { ...afterKill, message: `Force stopped dev server (PID ${pid}) via SIGKILL.` }
      : { stopped: false, pid, message: `Process ${pid} did not terminate.` };
  }

  if (port === null) {
    return { stopped: false, pid, message: `Could not resolve the dev server's port (missing or stale ${portFileForPidFile(pidFile)}); refusing to guess. Pass --force for a signal-based stop.` };
  }
  try {
    const response = await requestDaemonShutdown(port, {});
    if (!response.ok) {
      return { stopped: false, pid, message: `Dev server rejected the stop request (HTTP ${response.status}). Pass --force for an explicit forced stop.` };
    }
  } catch (error) {
    return { stopped: false, pid, message: `Could not reach the dev server's lifecycle API on port ${port}: ${String(error)}. Pass --force for a signal-based stop.` };
  }
  return await waitForExit(pid, pidFile, options.timeoutMs ?? SAFE_WAIT_MS);
}

if (import.meta.main) {
  const force = process.argv.includes("--force") || process.argv.includes("-f");
  const result = await stopDevServer(resolvePidFile(), { force });
  console.log(result.message);
  process.exit(result.stopped || !result.pid ? 0 : 1);
}
