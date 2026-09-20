#!/usr/bin/env bun
/** Deploy: build -> compile the binary -> install it atomically -> schedule
 *  a detached `systemctl restart` -> verify the new build is serving.
 *
 *  The old stop/copy/start sequence could not survive running from inside
 *  passage itself: `systemctl stop` kills the daemon, which kills the PTY
 *  hosting this script, so `cp`/`start` never ran and the service was left
 *  half stopped. This version never stops the daemon synchronously. It
 *  installs the new binary while the old daemon is still running (copy to
 *  `<bin>.new` + atomic rename, so no ETXTBSY on the running executable),
 *  then fires a reparented, stdio-detached restarter with a short delay,
 *  and finally verifies the new build is serving (unless skipped).
 *
 *  Env:
 *    PASSAGE_DEPLOY_UNIT     systemd --user unit name (default "passage").
 *    PASSAGE_DEPLOY_DELAY_S  seconds before the detached restart fires
 *                            (default "2").
 *    PASSAGE_DEPLOY_NO_RESTART=1  stage the binary but skip the restart
 *                            (and the verification with it).
 *    PASSAGE_DEPLOY_PORT     health-check port (default "6666").
 *    PASSAGE_DEPLOY_VERIFY=0 skip post-restart verification (fire and
 *                            forget, like the old script).
 *
 *  Verification polls `/api/health` until the serving build's commit
 *  matches this checkout's HEAD (or at least differs from the pre-deploy
 *  build): shutdown is cancel-then-kill (~seconds) and boot warms agents,
 *  so a healthy restart lands quickly; anything else (boot crash loop,
 *  hung teardown) fails loudly here instead of silently. No rollback --
 *  a failure leaves the new binary installed and says so.
 */
import { chmodSync, copyFileSync, renameSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const unit = process.env.PASSAGE_DEPLOY_UNIT?.trim() || "passage";
if (!/^[A-Za-z0-9@_:.\-]+$/.test(unit)) {
  console.error(`deploy: refusing suspicious unit name ${JSON.stringify(unit)}`);
  process.exit(1);
}
const installed = join(homedir(), ".local", "bin", "passage");
const verifyEnabled = (process.env.PASSAGE_DEPLOY_VERIFY ?? "").trim() !== "0";
const staged = `${installed}.new`;
const delaySec = Math.min(Math.max(Number(process.env.PASSAGE_DEPLOY_DELAY_S ?? 2) || 2, 0.5), 60);
const noRestart = (process.env.PASSAGE_DEPLOY_NO_RESTART ?? "").trim() === "1";

export function resolveVerifyPort(env: Record<string, string | undefined> = process.env): number | null {
  const port = Number(env.PASSAGE_DEPLOY_PORT ?? 6666);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    console.error(`deploy: invalid PASSAGE_DEPLOY_PORT ${JSON.stringify(env.PASSAGE_DEPLOY_PORT)}; skipping verification.`);
    return null;
  }
  return port;
}

export async function readBuildCommit(port: number): Promise<string | undefined> {
  try {
    const response = await fetch(`http://127.0.0.1:${port}/api/health`, { signal: AbortSignal.timeout(5000) });
    if (!response.ok) return undefined;
    const body = (await response.json()) as { build?: { commit?: unknown } };
    return typeof body.build?.commit === "string" ? body.build.commit : undefined;
  } catch {
    return undefined;
  }
}

export function readHeadCommit(): string | undefined {
  try {
    const result = Bun.spawnSync(["git", "rev-parse", "HEAD"], { stdout: "pipe", stderr: "ignore" });
    if (result.exitCode !== 0) return undefined;
    const head = new TextDecoder().decode(result.stdout).trim();
    return /^[0-9a-f]{4,40}$/i.test(head) ? head : undefined;
  } catch {
    return undefined;
  }
}

/** Poll until the serving build is identifiably new: it matches this
 *  checkout's HEAD, or (when HEAD is unknown) at least differs from the
 *  pre-deploy build. Placeholder commits (`dev`, `unknown`) never count
 *  -- a crash-looping unit serves nothing or the old binary, never those. */
export async function verifyRestarted(port: number, oldCommit: string | undefined, headCommit: string | undefined, timeoutMs: number, intervalMs = 2000): Promise<string | undefined> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const commit = await readBuildCommit(port);
    if (commit !== undefined && commit !== "dev" && commit !== "unknown" && (commit === headCommit || (oldCommit !== undefined && commit !== oldCommit))) {
      return commit;
    }
    if (Date.now() >= deadline) return undefined;
    await Bun.sleep(intervalMs);
  }
}

function run(command: string[]): void {
  const result = Bun.spawnSync(command, { stdin: "inherit", stdout: "inherit", stderr: "inherit" });
  if (result.exitCode !== 0) {
    console.error(`deploy: ${command.join(" ")} failed with exit ${result.exitCode}`);
    process.exit(result.exitCode ?? 1);
  }
}

async function main(): Promise<void> {
  // Pre-deploy build commit for post-restart verification (best-effort: the
  // service may already be down, in which case any real commit counts).
  const verifyPort = resolveVerifyPort();
  const oldCommit = verifyPort === null ? undefined : await readBuildCommit(verifyPort);

  // 1-3. Install deps (frozen) then build: a failure leaves the running service untouched.
  run([process.execPath, "install", "--frozen-lockfile"]);
  run([process.execPath, "run", "build"]);
  run([process.execPath, "run", "package"]);

  // 4. Atomic install while the old daemon is still running.
  copyFileSync("./dist/passage", staged);
  chmodSync(staged, 0o755);
  renameSync(staged, installed);
  console.log(`deploy: installed ${installed}`);

  if (noRestart) {
    console.log("deploy: staged (PASSAGE_DEPLOY_NO_RESTART=1, not restarting).");
    process.exit(0);
  }

  // 5. Detached restart: reparented via setsid, stdio detached, delayed so
  //    this script (and its PTY output) is gone before the daemon dies.
  //    argv passing (not string interpolation) keeps the unit name safe.
  try {
    const child = Bun.spawn(
      ["setsid", "bash", "-c", 'sleep "$1"; exec systemctl --user restart "$2"', "passage-deploy", String(delaySec), unit],
      { stdin: "ignore", stdout: "ignore", stderr: "ignore" },
    );
    child.unref();
  } catch (error) {
    console.error(`deploy: failed to schedule detached restart: ${String(error)}`);
    console.error(`deploy: binary is staged at ${installed}; restart manually with: systemctl --user restart ${unit}`);
    process.exit(1);
  }
  console.log(`deploy: done, restarting ${unit} in ${delaySec}s (reconnect after).`);
  if (verifyPort !== null && verifyEnabled) {
    // Wait out the delayed restart, then poll until the serving build is
    // identifiably new (up to ~90s: stop + RestartSec + boot warming).
    await Bun.sleep(delaySec * 1000 + 1000);
    const commit = await verifyRestarted(verifyPort, oldCommit, readHeadCommit(), 90_000);
    if (commit === undefined) {
      console.error(`deploy: restart of ${unit} did not serve the new build within 90s. The new binary is installed; check journalctl --user -u ${unit} (possible boot crash loop).`);
      process.exit(1);
    }
    console.log(`deploy: verified ${unit} serving ${commit}.`);
  }
  process.exit(0);
}

if (import.meta.main) {
  await main();
}
