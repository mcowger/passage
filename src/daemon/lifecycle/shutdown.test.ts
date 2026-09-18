import { describe, expect, test } from "bun:test";
import { DaemonLifecycle } from "./index.ts";
import { runSafeShutdown } from "./shutdown.ts";
import type { DaemonBlocker } from "../../shared/protocol/index.ts";

function controlledBlockers() {
  let resolve: (value: DaemonBlocker[]) => void = () => {};
  let calls = 0;
  const fn = () => {
    calls += 1;
    return new Promise<DaemonBlocker[]>((r) => { resolve = r; });
  };
  return { fn, resolveWith: (value: DaemonBlocker[]) => resolve(value), get calls() { return calls; } };
}

/** Resolves immediately with whatever the test last `set()`, so a
 *  multi-step choreography (recompute, then commit's own recheck, ...)
 *  does not need to track how many internal calls are pending. */
function mutableBlockers(initial: DaemonBlocker[]) {
  let value = initial;
  let calls = 0;
  return { fn: async () => { calls += 1; return value; }, set: (next: DaemonBlocker[]) => { value = next; }, get calls() { return calls; } };
}

describe("runSafeShutdown", () => {
  test("begins a drain, waits for ready, and commits with no blockers", async () => {
    const lifecycle = new DaemonLifecycle({ listQuickBlockers: () => [], listBlockers: async () => [] });
    const result = await runSafeShutdown(lifecycle);
    expect(result).toEqual({ committed: true });
    expect(lifecycle.currentPhase).toBe("stopping");
  });

  test("joins an already in-flight drain instead of restarting it", async () => {
    const blockers = mutableBlockers([]);
    const lifecycle = new DaemonLifecycle({ listQuickBlockers: () => [], listBlockers: blockers.fn });
    lifecycle.beginDrain();
    const drainId = lifecycle.drainId;
    const result = await runSafeShutdown(lifecycle);
    expect(result).toEqual({ committed: true });
    expect(lifecycle.drainId).toBe(drainId);
  });

  test("waits out late activity (draining -> ready revoked -> draining -> ready) before committing", async () => {
    const blockers = mutableBlockers([{ agentId: "agt_1", reason: "running" }]);
    const lifecycle = new DaemonLifecycle({ listQuickBlockers: () => [], listBlockers: blockers.fn });
    const shutdown = runSafeShutdown(lifecycle);
    // The initial recompute (from beginDrain) finds a blocker; phase stays
    // draining, so runSafeShutdown is parked on waitForNextPhaseChange().
    await Bun.sleep(0);
    expect(lifecycle.currentPhase).toBe("draining");
    // Activity settles; the next recompute finds nothing and reaches ready,
    // which is what actually wakes the parked waiter.
    blockers.set([]);
    lifecycle.onActivity();
    expect(await shutdown).toEqual({ committed: true });
  });

  test("resolves cancelled if the drain is cancelled before commit, without sealing", async () => {
    const blockers = controlledBlockers();
    const lifecycle = new DaemonLifecycle({ listQuickBlockers: () => [], listBlockers: blockers.fn });
    const shutdown = runSafeShutdown(lifecycle);
    lifecycle.cancelDrain();
    expect(await shutdown).toEqual({ committed: false, reason: "cancelled" });
    expect(lifecycle.currentPhase).toBe("running");
  });

  test("resolves cancelled, not committed, if a fresh drain supersedes this attempt's drainId", async () => {
    const blockers = controlledBlockers();
    const lifecycle = new DaemonLifecycle({ listQuickBlockers: () => [], listBlockers: blockers.fn });
    const shutdown = runSafeShutdown(lifecycle);
    const firstDrainId = lifecycle.drainId;
    lifecycle.cancelDrain();
    lifecycle.beginDrain();
    expect(lifecycle.drainId).not.toBe(firstDrainId);
    expect(await shutdown).toEqual({ committed: false, reason: "cancelled" });
  });

  test("does not commit a stale ready reached after cancellation raced the commit call itself", async () => {
    // Reach ready, then have cancelDrain() land in the gap between commit()
    // observing `ready` and its internal blocker recheck resolving.
    const blockers = controlledBlockers();
    const lifecycle = new DaemonLifecycle({ listQuickBlockers: () => [], listBlockers: blockers.fn });
    const shutdown = runSafeShutdown(lifecycle);
    blockers.resolveWith([]);
    await Bun.sleep(0);
    expect(lifecycle.currentPhase).toBe("ready");
    // commit()'s internal recheck call is now pending; cancel before it resolves.
    lifecycle.cancelDrain();
    blockers.resolveWith([]);
    expect(await shutdown).toEqual({ committed: false, reason: "cancelled" });
    expect(lifecycle.currentPhase).toBe("running");
  });

  describe("timeoutMs (operator override of the plan's default no-deadline behavior)", () => {
    test("resolves timeout without touching the phase when nothing ever reaches ready", async () => {
      const blockers = controlledBlockers();
      const lifecycle = new DaemonLifecycle({ listQuickBlockers: () => [], listBlockers: blockers.fn });
      const shutdown = runSafeShutdown(lifecycle, { timeoutMs: 20 });
      // Never resolve blockers.fn(): the drain never reaches ready.
      expect(await shutdown).toEqual({ committed: false, reason: "timeout" });
      expect(lifecycle.currentPhase).toBe("draining");
    });

    test("commits normally when ready is reached before the deadline", async () => {
      const lifecycle = new DaemonLifecycle({ listQuickBlockers: () => [], listBlockers: async () => [] });
      const result = await runSafeShutdown(lifecycle, { timeoutMs: 5000 });
      expect(result).toEqual({ committed: true });
      expect(lifecycle.currentPhase).toBe("stopping");
    });

    test("an already-elapsed deadline (0ms) still lets an already-ready commit land first", async () => {
      // Guards against an off-by-one that would report timeout even though
      // commit() itself never got a chance to run.
      const lifecycle = new DaemonLifecycle({ listQuickBlockers: () => [], listBlockers: async () => [] });
      lifecycle.beginDrain();
      await Bun.sleep(0);
      expect(lifecycle.currentPhase).toBe("ready");
      const result = await runSafeShutdown(lifecycle, { timeoutMs: 0 });
      expect(result).toEqual({ committed: true });
    });

    test("omitting timeoutMs still waits indefinitely (manually held drain, no shutdown request behind it)", async () => {
      const blockers = mutableBlockers([{ agentId: "agt_1", reason: "running" }]);
      const lifecycle = new DaemonLifecycle({ listQuickBlockers: () => [], listBlockers: blockers.fn });
      let settled = false;
      const shutdown = runSafeShutdown(lifecycle).then((result) => { settled = true; return result; });
      await Bun.sleep(20);
      expect(settled).toBe(false);
      expect(lifecycle.currentPhase).toBe("draining");
      blockers.set([]);
      lifecycle.onActivity();
      expect(await shutdown).toEqual({ committed: true });
    });
  });
});
