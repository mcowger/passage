/** Deploy: build → copy binary → `systemctl --user restart passage`.
 *
 * Passage no longer owns Pi processes through a holder that survives daemon
 * restarts (see docs/BACKTOSQUAREONE.md): every restart stops each agent's
 * `pi --mode rpc` child, interrupting any run in progress. There is no safe
 * drain yet, so this always interrupts active work.
 */
import { homedir } from "node:os";
import { join } from "node:path";

function run(command: string[], env?: Record<string, string | undefined>): void {
  const result = Bun.spawnSync(command, { stdin: "inherit", stdout: "inherit", stderr: "inherit", env: { ...process.env, ...env } });
  if (result.exitCode !== 0) {
    console.error(`deploy: ${command.join(" ")} failed with exit ${result.exitCode}`);
    process.exit(result.exitCode ?? 1);
  }
}

run([process.execPath, "run", "package"]);

const installed = join(homedir(), ".local", "bin", "passage");
run(["cp", "-f", "./dist/passage", installed]);
run(["systemctl", "--user", "restart", "passage"]);
console.log("deploy: restarted passage (active Pi runs were interrupted)");
