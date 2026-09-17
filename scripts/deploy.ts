/** Deploy: build → copy binary → `systemctl --user restart passage`.
 *
 * Plain `deploy` = holders survive the upgrade (new goal: agents keep
 * working straight through the restart; the new daemon sweeps and
 * re-attaches). `deploy --stop-agents` = old behavior for when you want a
 * clean slate (shutdown-holders before the restart).
 */
import { homedir } from "node:os";
import { join } from "node:path";
import { parseArgs } from "node:util";

const { values } = parseArgs({
  args: Bun.argv.slice(2),
  options: { "stop-agents": { type: "boolean", default: false } },
  strict: true,
});

function run(command: string[], env?: Record<string, string | undefined>): void {
  const result = Bun.spawnSync(command, { stdin: "inherit", stdout: "inherit", stderr: "inherit", env: { ...process.env, ...env } });
  if (result.exitCode !== 0) {
    console.error(`deploy: ${command.join(" ")} failed with exit ${result.exitCode}`);
    process.exit(result.exitCode ?? 1);
  }
}

run([process.execPath, "run", "package"]);

const installed = join(homedir(), ".local", "bin", "passage");
if (values["stop-agents"]) {
  // Clean slate with the CURRENT build (same pinned LF-JSONL framing, so
  // either build can drive the shutdown).
  const stop = Bun.spawnSync([installed, "shutdown-holders"], { stdout: "inherit", stderr: "inherit" });
  if (stop.exitCode !== 0) {
    console.error("deploy: shutdown-holders failed");
    process.exit(stop.exitCode ?? 1);
  }
}

run(["cp", "-f", "./dist/passage", installed]);
run(["systemctl", "--user", "restart", "passage"]);
console.log(`deploy: restarted passage${values["stop-agents"] ? " (agents stopped)" : " (holders survive)"}`);
