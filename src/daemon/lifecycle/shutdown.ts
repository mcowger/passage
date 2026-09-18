import type { DaemonLifecycle } from "./index.ts";
import type { DaemonPhase } from "../../shared/protocol/index.ts";

export type SafeShutdownResult = { committed: true } | { committed: false; reason: "cancelled" | "timeout" };

/** Drives a `DaemonLifecycle` through the safe-shutdown path
 *  (docs/BACKTOSQUAREONE.md step 6): begin (or join an already in-flight)
 *  drain, wait for `ready`, and commit.
 *
 *  If the drain is cancelled (phase returns to `running`) or superseded by
 *  a fresh drain (a different `drainId`) before commit succeeds, this
 *  resolves `{ committed: false, reason: "cancelled" }` instead of
 *  committing a stale attempt -- an operator who cancelled maintenance
 *  must not have the daemon exit out from under them moments later.
 *
 *  `options.timeoutMs`, when supplied, bounds the overall wait: on
 *  expiry this resolves `{ committed: false, reason: "timeout" }` without
 *  committing or touching the phase itself -- the caller (the daemon's
 *  shutdown handler) decides whether that means escalating to an explicit
 *  force. Omitted, this waits indefinitely (no deadline of its own),
 *  matching a manually held drain with no shutdown request behind it. */
export async function runSafeShutdown(lifecycle: DaemonLifecycle, options?: { timeoutMs?: number }): Promise<SafeShutdownResult> {
  lifecycle.beginDrain();
  const drainId = lifecycle.drainId;
  const deadline = options?.timeoutMs !== undefined ? Date.now() + options.timeoutMs : undefined;
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
    if (deadline === undefined) {
      await lifecycle.waitForNextPhaseChange();
      continue;
    }
    const remaining = deadline - Date.now();
    if (remaining <= 0) return { committed: false, reason: "timeout" };
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timedOut = await Promise.race([
      lifecycle.waitForNextPhaseChange().then(() => false),
      new Promise<boolean>((resolve) => { timer = setTimeout(() => resolve(true), remaining); }),
    ]);
    clearTimeout(timer);
    if (timedOut) return { committed: false, reason: "timeout" };
  }
}
