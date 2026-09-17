#!/usr/bin/env bun
import { existsSync, readFileSync, unlinkSync } from "node:fs";
import { dirname, isAbsolute, join } from "node:path";

const DEFAULT_PID_FILE = join(import.meta.dir, "..", ".data", "dev.pid");

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

export async function stopDevServer(pidFile = resolvePidFile()): Promise<{ stopped: boolean; pid?: number; message: string }> {
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

  try {
    process.kill(pid, "SIGTERM");
  } catch (error) {
    return { stopped: false, pid, message: `Failed to signal process ${pid}: ${String(error)}` };
  }

  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    if (!isProcessAlive(pid)) {
      removePidArtifacts(pidFile);
      return { stopped: true, pid, message: `Stopped dev server (PID ${pid}).` };
    }
    await Bun.sleep(50);
  }

  try {
    process.kill(pid, "SIGKILL");
  } catch {}

  const killDeadline = Date.now() + 1000;
  while (Date.now() < killDeadline) {
    if (!isProcessAlive(pid)) {
      removePidArtifacts(pidFile);
      return { stopped: true, pid, message: `Force stopped dev server (PID ${pid}).` };
    }
    await Bun.sleep(50);
  }

  return { stopped: false, pid, message: `Process ${pid} did not terminate.` };
}

if (import.meta.main) {
  const result = await stopDevServer();
  console.log(result.message);
  process.exit(result.stopped || !result.pid ? 0 : 1);
}
