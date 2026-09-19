#!/usr/bin/env bun
/** Deploy: build -> compile the binary -> install it atomically -> schedule
 *  a detached `systemctl restart` after this process has exited.
 *
 *  The old stop/copy/start sequence could not survive running from inside
 *  passage itself: `systemctl stop` kills the daemon, which kills the PTY
 *  hosting this script, so `cp`/`start` never ran and the service was left
 *  half stopped. This version never stops the daemon synchronously. It
 *  installs the new binary while the old daemon is still running (copy to
 *  `<bin>.new` + atomic rename, so no ETXTBSY on the running executable),
 *  then fires a reparented, stdio-detached restarter with a short delay
 *  and exits 0 immediately -- the restart lands after our PTY output has
 *  already flushed.
 *
 *  Env:
 *    PASSAGE_DEPLOY_UNIT     systemd --user unit name (default "passage").
 *    PASSAGE_DEPLOY_DELAY_S  seconds before the detached restart fires
 *                            (default "2").
 *    PASSAGE_DEPLOY_NO_RESTART=1  stage the binary but skip the restart.
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
const staged = `${installed}.new`;
const delaySec = Math.min(Math.max(Number(process.env.PASSAGE_DEPLOY_DELAY_S ?? 2) || 2, 0.5), 60);
const noRestart = (process.env.PASSAGE_DEPLOY_NO_RESTART ?? "").trim() === "1";

function run(command: string[]): void {
  const result = Bun.spawnSync(command, { stdin: "inherit", stdout: "inherit", stderr: "inherit" });
  if (result.exitCode !== 0) {
    console.error(`deploy: ${command.join(" ")} failed with exit ${result.exitCode}`);
    process.exit(result.exitCode ?? 1);
  }
}

// 1-2. Build first: a build failure leaves the running service untouched.
run([process.execPath, "run", "build"]);
run([process.execPath, "run", "package"]);

// 3. Atomic install while the old daemon is still running.
copyFileSync("./dist/passage", staged);
chmodSync(staged, 0o755);
renameSync(staged, installed);
console.log(`deploy: installed ${installed}`);

if (noRestart) {
  console.log("deploy: staged (PASSAGE_DEPLOY_NO_RESTART=1, not restarting).");
  process.exit(0);
}

// 4. Detached restart: reparented via setsid, stdio detached, delayed so
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
process.exit(0);
