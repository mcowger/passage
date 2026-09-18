#!/usr/bin/env bun
/** Deploy: build -> stop via systemd -> install -> start -> (optional)
 *  health-check.
 *
 * A build failure leaves the running daemon untouched. No port is
 * required and no daemon-side drain/shutdown handshake is used --
 * `runSafeShutdown()`'s "shutdown completed" has been observed to log
 * successfully while the underlying process still needed an external
 * SIGKILL (root cause not yet found; see the investigation notes for this
 * date). Until that's understood, this script relies entirely on the
 * systemd unit's own stop timeout (`TimeoutStopSec`, set short in the
 * unit file) to bound how long a stuck old process can block the
 * install -- it does not attempt to negotiate a graceful stop itself.
 *
 * Set PASSAGE_DEPLOY_UNIT to override the systemd --user unit name
 * (default "passage"). Set PASSAGE_DEPLOY_PORT (or PORT/PASEO_PORT) to
 * additionally health-check the new daemon over HTTP after starting it;
 * without a port, success means only that systemd reports the unit
 * active.
 */
import { homedir } from "node:os";
import { join } from "node:path";

export const DEFAULT_SYSTEMD_UNIT = "passage";
const PROCESS_EXIT_WAIT_MS = 30_000;
const PROCESS_ACTIVE_WAIT_MS = 30_000;
const POLL_MS = 300;
const HEALTH_POLL_MS = 500;
const HEALTH_WAIT_MS = 30_000;

export type FetchJson = (url: string, init?: RequestInit) => Promise<{ ok: boolean; status: number; body: unknown }>;

export async function fetchJson(url: string, init?: RequestInit): Promise<{ ok: boolean; status: number; body: unknown }> {
  const response = await fetch(url, init);
  let body: unknown;
  try { body = await response.json(); } catch { body = undefined; }
  return { ok: response.ok, status: response.status, body };
}

/** Optional: only used to additionally health-check over HTTP after
 *  start. Unlike the old drain-based flow, a missing/invalid value is not
 *  an error -- it just skips the HTTP health check. */
export function resolveDeployPort(env: Record<string, string | undefined> = process.env): number | null {
  const raw = env.PASSAGE_DEPLOY_PORT ?? env.PORT ?? env.PASEO_PORT;
  if (!raw) return null;
  const parsed = Number(raw);
  return Number.isInteger(parsed) && parsed > 0 && parsed < 65536 ? parsed : null;
}

if (import.meta.main) {
  function run(command: string[], options?: { allowFailure?: boolean }): { exitCode: number; stdout: string } {
    const result = Bun.spawnSync(command, { stdin: "inherit", stdout: "pipe", stderr: "inherit" });
    const stdout = result.stdout?.toString() ?? "";
    if (stdout) process.stdout.write(stdout);
    if (result.exitCode !== 0 && !options?.allowFailure) {
      console.error(`deploy: ${command.join(" ")} failed with exit ${result.exitCode}`);
      process.exit(result.exitCode ?? 1);
    }
    return { exitCode: result.exitCode ?? 1, stdout };
  }

  async function waitForUnitState(unit: string, wantActive: boolean, deadlineMs: number): Promise<boolean> {
    const deadline = Date.now() + deadlineMs;
    while (Date.now() < deadline) {
      const status = run(["systemctl", "--user", "is-active", unit], { allowFailure: true });
      const active = status.stdout.trim() === "active";
      if (active === wantActive) return true;
      await Bun.sleep(POLL_MS);
    }
    return false;
  }

  async function waitForHealth(baseUrl: string, deadlineMs: number): Promise<boolean> {
    const deadline = Date.now() + deadlineMs;
    while (Date.now() < deadline) {
      try {
        const health = await fetchJson(`${baseUrl}/api/health`);
        if (health.ok && (health.body as { ok?: unknown } | undefined)?.ok === true) return true;
      } catch { /* keep polling */ }
      await Bun.sleep(HEALTH_POLL_MS);
    }
    return false;
  }

  const port = resolveDeployPort();
  const baseUrl = port === null ? null : `http://127.0.0.1:${port}`;
  const unit = process.env.PASSAGE_DEPLOY_UNIT?.trim() || DEFAULT_SYSTEMD_UNIT;

  // A build failure leaves the running daemon untouched -- nothing below
  // has touched it yet.
  run([process.execPath, "run", "package"]);

  const installed = join(homedir(), ".local", "bin", "passage");
  const backup = `${installed}.previous`;

  // No drain/handshake: stop the unit directly and rely on its own
  // TimeoutStopSec to bound how long a stuck old process can block this.
  // Suppress automatic restart during the handoff and wait for the old
  // process/cgroup to actually exit before touching the installed binary
  // -- never overlap two daemons on the same port.
  run(["systemctl", "--user", "stop", unit]);
  if (!(await waitForUnitState(unit, false, PROCESS_EXIT_WAIT_MS))) {
    console.error(`deploy: ${unit} did not report inactive after stop; refusing to install over a possibly-still-running daemon.`);
    process.exit(1);
  }

  run(["cp", "-f", installed, backup], { allowFailure: true });
  const install = run(["cp", "-f", "./dist/passage", installed], { allowFailure: true });
  if (install.exitCode !== 0) {
    console.error("deploy: install failed; restoring the previous binary.");
    run(["cp", "-f", backup, installed], { allowFailure: true });
    run(["systemctl", "--user", "start", unit], { allowFailure: true });
    process.exit(1);
  }

  run(["systemctl", "--user", "start", unit]);
  if (!(await waitForUnitState(unit, true, PROCESS_ACTIVE_WAIT_MS))) {
    console.error("deploy: new daemon did not report active; rolling back to the previous binary.");
    run(["systemctl", "--user", "stop", unit], { allowFailure: true });
    await waitForUnitState(unit, false, PROCESS_EXIT_WAIT_MS);
    run(["cp", "-f", backup, installed], { allowFailure: true });
    run(["systemctl", "--user", "start", unit], { allowFailure: true });
    process.exit(1);
  }

  if (baseUrl !== null && !(await waitForHealth(baseUrl, HEALTH_WAIT_MS))) {
    console.error("deploy: new daemon failed its health check; rolling back to the previous binary. Do not overlap two daemons -- stopping first.");
    run(["systemctl", "--user", "stop", unit], { allowFailure: true });
    await waitForUnitState(unit, false, PROCESS_EXIT_WAIT_MS);
    run(["cp", "-f", backup, installed], { allowFailure: true });
    run(["systemctl", "--user", "start", unit], { allowFailure: true });
    process.exit(1);
  }

  console.log("deploy: passage restarted.");
}
