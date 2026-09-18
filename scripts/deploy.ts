#!/usr/bin/env bun
/** Deploy: compile the binary -> stop the service -> copy the binary ->
 *  start the service. Nothing else -- no drain handshake, no health
 *  check, no rollback, no polling. `systemctl stop`/`start` already
 *  block until the unit reports the requested state (or the unit's own
 *  `TimeoutStopSec` forces it), so no extra waiting is needed here.
 *
 *  Set PASSAGE_DEPLOY_UNIT to override the systemd --user unit name
 *  (default "passage").
 */
import { homedir } from "node:os";
import { join } from "node:path";

const unit = process.env.PASSAGE_DEPLOY_UNIT?.trim() || "passage";
const installed = join(homedir(), ".local", "bin", "passage");

function run(command: string[]): void {
  const result = Bun.spawnSync(command, { stdin: "inherit", stdout: "inherit", stderr: "inherit" });
  if (result.exitCode !== 0) {
    console.error(`deploy: ${command.join(" ")} failed with exit ${result.exitCode}`);
    process.exit(result.exitCode ?? 1);
  }
}

run([process.execPath, "run", "package"]);
run(["systemctl", "--user", "stop", unit]);
run(["cp", "-f", "./dist/passage", installed]);
run(["systemctl", "--user", "start", unit]);
console.log("deploy: done.");
