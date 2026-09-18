#!/usr/bin/env bun
/** Deploy: build -> hold a drain until ready -> stop via systemd -> install
 *  -> start -> health-check (docs/BACKTOSQUAREONE.md step 6).
 *
 * A build failure leaves the running daemon untouched. The old daemon and
 * installed binary stay intact unless a validated commit, the systemd stop,
 * the install, and the new daemon's health check all succeed -- there is
 * never a window with two daemons running against the same port, and a
 * cancelled/failed drain never touches the installed binary.
 *
 * Requires PASSAGE_DEPLOY_PORT (or PORT/PASEO_PORT) set to the target
 * daemon's port; this script refuses to guess it. Set PASSAGE_DEPLOY_UNIT
 * to override the systemd --user unit name (default "passage").
 */
import { homedir } from "node:os";
import { join } from "node:path";
import { parseArgs } from "node:util";

export const DEFAULT_SYSTEMD_UNIT = "passage";
const DRAIN_POLL_MS = 1000;
/** No automatic kill deadline on the daemon's own drain (see
 *  BACKTOSQUAREONE.md step 6); this only bounds how long this CLI polls
 *  before giving up and leaving the old daemon running untouched. */
const DEFAULT_DRAIN_WAIT_MS = 10 * 60 * 1000;
const PROCESS_EXIT_WAIT_MS = 30_000;
const PROCESS_EXIT_POLL_MS = 300;
const HEALTH_POLL_MS = 500;
const HEALTH_WAIT_MS = 30_000;

export type FetchJson = (url: string, init?: RequestInit) => Promise<{ ok: boolean; status: number; body: unknown }>;

export async function fetchJson(url: string, init?: RequestInit): Promise<{ ok: boolean; status: number; body: unknown }> {
  const response = await fetch(url, init);
  let body: unknown;
  try { body = await response.json(); } catch { body = undefined; }
  return { ok: response.ok, status: response.status, body };
}

export function resolveDeployPort(env: Record<string, string | undefined> = process.env): number | null {
  const raw = env.PASSAGE_DEPLOY_PORT ?? env.PORT ?? env.PASEO_PORT;
  if (!raw) return null;
  const parsed = Number(raw);
  return Number.isInteger(parsed) && parsed > 0 && parsed < 65536 ? parsed : null;
}

export type DrainIdentity = { instanceId: string; drainId: string };

/** Begins a held drain. Never throws on an HTTP-level failure -- returns
 *  null so the caller can report and exit without a half-drained daemon
 *  left behind (beginDrain() itself is idempotent, so a retry is safe). */
export async function beginHeldDrain(baseUrl: string, fetchJsonImpl: FetchJson = fetchJson): Promise<DrainIdentity | null> {
  const begin = await fetchJsonImpl(`${baseUrl}/api/daemon/drain`, { method: "POST" });
  if (!begin.ok) return null;
  const body = begin.body as { instanceId?: unknown; drainId?: unknown };
  if (typeof body.instanceId !== "string" || typeof body.drainId !== "string") return null;
  return { instanceId: body.instanceId, drainId: body.drainId };
}

export type WaitForReadyResult =
  | { outcome: "ready"; readinessRevision: number }
  | { outcome: "cancelled" }
  | { outcome: "superseded" }
  | { outcome: "unreachable" }
  | { outcome: "timeout" };

/** Polls the daemon snapshot until it reaches `ready`, using the SAME
 *  identity the whole way: a changed instanceId/drainId means a different
 *  drain (another operator, or this one got cancelled and restarted) now
 *  owns the daemon, so this attempt must not blindly keep waiting on
 *  someone else's drain. No automatic kill deadline on the daemon's own
 *  side -- `deadlineMs` only bounds this poll loop. */
export async function waitForReady(
  baseUrl: string,
  identity: DrainIdentity,
  deadlineMs: number,
  fetchJsonImpl: FetchJson = fetchJson,
  sleep: (ms: number) => Promise<void> = (ms) => Bun.sleep(ms),
  log: (message: string) => void = console.log,
): Promise<WaitForReadyResult> {
  const deadline = Date.now() + deadlineMs;
  while (Date.now() < deadline) {
    const snapshot = await fetchJsonImpl(`${baseUrl}/api/daemon/snapshot`);
    if (!snapshot.ok) return { outcome: "unreachable" };
    const body = snapshot.body as { instanceId?: unknown; drainId?: unknown; phase?: unknown; readinessRevision?: unknown; blockedCount?: unknown };
    if (body.instanceId !== identity.instanceId || body.drainId !== identity.drainId) return { outcome: "superseded" };
    if (body.phase === "ready" && typeof body.readinessRevision === "number") {
      return { outcome: "ready", readinessRevision: body.readinessRevision };
    }
    if (body.phase === "running") return { outcome: "cancelled" };
    log(`deploy: waiting for daemon to drain (${typeof body.blockedCount === "number" ? body.blockedCount : "?"} agent(s) still active)...`);
    await sleep(DRAIN_POLL_MS);
  }
  return { outcome: "timeout" };
}

/** Validated commit against the exact drain/revision observed by
 *  waitForReady(). The daemon itself re-validates identity and re-checks
 *  blockers before actually sealing -- this call fails fast with a clear
 *  local signal instead of only a bare 409. Acknowledgement means
 *  accepted, not "already shut down"; a dropped connection right around
 *  actual exit is not proof either way. */
export async function commitShutdown(
  baseUrl: string,
  identity: DrainIdentity & { readinessRevision: number },
  fetchJsonImpl: FetchJson = fetchJson,
): Promise<boolean> {
  const commit = await fetchJsonImpl(`${baseUrl}/api/daemon/shutdown`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(identity),
  });
  return commit.ok;
}

export async function cancelDrain(baseUrl: string, fetchJsonImpl: FetchJson = fetchJson): Promise<void> {
  try { await fetchJsonImpl(`${baseUrl}/api/daemon/drain`, { method: "DELETE" }); } catch { /* best-effort */ }
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

  async function waitForUnitInactive(unit: string, deadlineMs: number): Promise<boolean> {
    const deadline = Date.now() + deadlineMs;
    while (Date.now() < deadline) {
      const status = run(["systemctl", "--user", "is-active", unit], { allowFailure: true });
      if (status.stdout.trim() !== "active") return true;
      await Bun.sleep(PROCESS_EXIT_POLL_MS);
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

  const { values } = parseArgs({
    args: Bun.argv.slice(2),
    options: { "drain-timeout-ms": { type: "string" } },
    strict: true,
  });
  const drainTimeoutMs = values["drain-timeout-ms"] ? Number(values["drain-timeout-ms"]) : DEFAULT_DRAIN_WAIT_MS;
  if (!Number.isFinite(drainTimeoutMs) || drainTimeoutMs <= 0) {
    console.error("deploy: --drain-timeout-ms must be a positive number");
    process.exit(1);
  }

  const port = resolveDeployPort();
  if (port === null) {
    console.error("deploy: set PASSAGE_DEPLOY_PORT (or PORT/PASEO_PORT) to the target daemon's port; refusing to guess.");
    process.exit(1);
  }
  const baseUrl = `http://127.0.0.1:${port}`;
  const unit = process.env.PASSAGE_DEPLOY_UNIT?.trim() || DEFAULT_SYSTEMD_UNIT;

  // A build failure leaves the running daemon untouched -- nothing below
  // has touched it yet.
  run([process.execPath, "run", "package"]);

  const identity = await beginHeldDrain(baseUrl);
  if (!identity) {
    console.error(`deploy: could not begin a drain against ${baseUrl}; old daemon and installed binary are untouched.`);
    process.exit(1);
  }

  const ready = await waitForReady(baseUrl, identity, drainTimeoutMs);
  if (ready.outcome !== "ready") {
    if (ready.outcome === "timeout" || ready.outcome === "unreachable") await cancelDrain(baseUrl, fetchJson);
    console.error(`deploy: drain did not reach ready (${ready.outcome}); old daemon and installed binary are untouched.`);
    process.exit(1);
  }

  const committed = await commitShutdown(baseUrl, { ...identity, readinessRevision: ready.readinessRevision });
  if (!committed) {
    await cancelDrain(baseUrl, fetchJson);
    console.error("deploy: commit was rejected (stale snapshot or a concurrent cancellation); old daemon and installed binary are untouched.");
    process.exit(1);
  }

  const installed = join(homedir(), ".local", "bin", "passage");
  const backup = `${installed}.previous`;

  // Suppress automatic restart during the handoff and wait for the old
  // process/cgroup to actually exit before touching the installed binary
  // -- never overlap two daemons on the same port.
  run(["systemctl", "--user", "stop", unit]);
  if (!(await waitForUnitInactive(unit, PROCESS_EXIT_WAIT_MS))) {
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
  if (!(await waitForHealth(baseUrl, HEALTH_WAIT_MS))) {
    console.error("deploy: new daemon failed its health check; rolling back to the previous binary. Do not overlap two daemons -- stopping first.");
    run(["systemctl", "--user", "stop", unit], { allowFailure: true });
    await waitForUnitInactive(unit, PROCESS_EXIT_WAIT_MS);
    run(["cp", "-f", backup, installed], { allowFailure: true });
    run(["systemctl", "--user", "start", unit], { allowFailure: true });
    process.exit(1);
  }

  console.log("deploy: passage restarted safely; all agent work finished naturally before the handoff.");
}
