import type { DaemonLifecycle } from "./index.ts";
import type { DaemonPhase } from "../../shared/protocol/index.ts";

export type SafeShutdownResult = { committed: true } | { committed: false; reason: "cancelled" };

/** Drives a `DaemonLifecycle` through the safe-shutdown path
 *  (docs/BACKTOSQUAREONE.md step 6): begin (or join an already in-flight)
 *  drain, wait for `ready`, and commit. No overall kill deadline -- if
 *  late activity revokes `ready`, this simply waits again; the caller
 *  decides whether to keep waiting or fall back to an explicit force.
 *
 *  If the drain is cancelled (phase returns to `running`) or superseded by
 *  a fresh drain (a different `drainId`) before commit succeeds, this
 *  resolves `{ committed: false, reason: "cancelled" }` instead of
 *  committing a stale attempt -- an operator who cancelled maintenance
 *  must not have the daemon exit out from under them moments later. */
export async function runSafeShutdown(lifecycle: DaemonLifecycle): Promise<SafeShutdownResult> {
  lifecycle.beginDrain();
  const drainId = lifecycle.drainId;
  while (true) {
    const beforeCommit: DaemonPhase = lifecycle.currentPhase;
    if (beforeCommit === "running" || lifecycle.drainId !== drainId) {
      return { committed: false, reason: "cancelled" };
    }
    if (beforeCommit === "ready") {
      const result = await lifecycle.commit({ drainId });
      if (result.committed) return { committed: true };
      const afterCommit: DaemonPhase = lifecycle.currentPhase;
      if (afterCommit === "running" || lifecycle.drainId !== drainId) {
        return { committed: false, reason: "cancelled" };
      }
      // Otherwise "not-ready": late activity was observed during the
      // commit recheck. Fall through and wait for `ready` again.
    }
    await lifecycle.waitForNextPhaseChange();
  }
}
