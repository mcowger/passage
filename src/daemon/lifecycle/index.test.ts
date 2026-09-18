import { describe, expect, test } from "bun:test";
import { DaemonLifecycle } from "./index.ts";
import type { DaemonBlocker, DaemonPhase } from "../../shared/protocol/index.ts";
import { MAX_DAEMON_BLOCKERS_LISTED } from "../../shared/protocol/index.ts";

/** A `listBlockers()` double whose resolution the test controls, so ready
 *  transitions can be observed deterministically instead of raced. */
function controlledBlockers() {
  let resolve: (value: DaemonBlocker[]) => void = () => {};
  let calls = 0;
  const fn = () => {
    calls += 1;
    return new Promise<DaemonBlocker[]>((r) => { resolve = r; });
  };
  return { fn, resolveWith: (value: DaemonBlocker[]) => resolve(value), get calls() { return calls; } };
}

describe("DaemonLifecycle", () => {
  test("starts running with admission open and no drain identity", () => {
    const lifecycle = new DaemonLifecycle({ listQuickBlockers: () => [], listBlockers: async () => [] });
    expect(lifecycle.currentPhase).toBe("running");
    expect(lifecycle.isAdmissionOpen()).toBe(true);
  });

  test("beginDrain closes admission synchronously and is idempotent", () => {
    const phases: DaemonPhase[] = [];
    const lifecycle = new DaemonLifecycle({ listQuickBlockers: () => [{ agentId: "a", reason: "running" }], listBlockers: async () => [{ agentId: "a", reason: "running" }], onPhaseChanged: (phase) => phases.push(phase) });
    lifecycle.beginDrain();
    expect(lifecycle.currentPhase).toBe("draining");
    expect(lifecycle.isAdmissionOpen()).toBe(false);
    lifecycle.beginDrain();
    expect(phases).toEqual(["draining"]);
  });

  test("cancelDrain reopens admission from draining or ready, and is a no-op while running", () => {
    const lifecycle = new DaemonLifecycle({ listQuickBlockers: () => [{ agentId: "a", reason: "running" }], listBlockers: async () => [{ agentId: "a", reason: "running" }] });
    expect(lifecycle.cancelDrain()).toBe(false);
    lifecycle.beginDrain();
    expect(lifecycle.cancelDrain()).toBe(true);
    expect(lifecycle.currentPhase).toBe("running");
    expect(lifecycle.isAdmissionOpen()).toBe(true);
  });

  test("reaches ready only once the authoritative probe confirms no blockers", async () => {
    const blockers = controlledBlockers();
    const phases: DaemonPhase[] = [];
    const lifecycle = new DaemonLifecycle({ listQuickBlockers: () => [], listBlockers: blockers.fn, onPhaseChanged: (phase) => phases.push(phase) });
    lifecycle.beginDrain();
    expect(lifecycle.currentPhase).toBe("draining");
    blockers.resolveWith([]);
    await Bun.sleep(0);
    expect(lifecycle.currentPhase).toBe("ready");
    expect(phases).toEqual(["draining", "ready"]);
  });

  test("stays draining while the authoritative probe still reports a blocker", async () => {
    const blockers = controlledBlockers();
    const lifecycle = new DaemonLifecycle({ listQuickBlockers: () => [], listBlockers: blockers.fn });
    lifecycle.beginDrain();
    blockers.resolveWith([{ agentId: "a", reason: "running" }]);
    await Bun.sleep(0);
    expect(lifecycle.currentPhase).toBe("draining");
  });

  test("onActivity revokes ready the instant new activity is observed, using only the cheap quick pass", async () => {
    const blockers = controlledBlockers();
    let quick: DaemonBlocker[] = [];
    const phases: DaemonPhase[] = [];
    const lifecycle = new DaemonLifecycle({ listQuickBlockers: () => quick, listBlockers: blockers.fn, onPhaseChanged: (phase) => phases.push(phase) });
    lifecycle.beginDrain();
    blockers.resolveWith([]);
    await Bun.sleep(0);
    expect(lifecycle.currentPhase).toBe("ready");
    quick = [{ agentId: "a", reason: "running" }];
    lifecycle.onActivity();
    // Revocation is synchronous -- no await needed to observe it.
    expect(lifecycle.currentPhase).toBe("draining");
    expect(phases).toEqual(["draining", "ready", "draining"]);
  });

  test("a burst of activity while a probe is in flight coalesces into at most one queued extra probe", async () => {
    const blockers = controlledBlockers();
    const lifecycle = new DaemonLifecycle({ listQuickBlockers: () => [{ agentId: "a", reason: "running" }], listBlockers: blockers.fn });
    lifecycle.beginDrain();
    expect(blockers.calls).toBe(1);
    lifecycle.onActivity();
    lifecycle.onActivity();
    lifecycle.onActivity();
    expect(blockers.calls).toBe(1);
    blockers.resolveWith([{ agentId: "a", reason: "running" }]);
    await Bun.sleep(0);
    expect(blockers.calls).toBe(2);
  });

  test("cancelDrain during an in-flight probe leaves the daemon running once it resolves", async () => {
    const blockers = controlledBlockers();
    const lifecycle = new DaemonLifecycle({ listQuickBlockers: () => [], listBlockers: blockers.fn });
    lifecycle.beginDrain();
    lifecycle.cancelDrain();
    expect(lifecycle.currentPhase).toBe("running");
    blockers.resolveWith([]);
    await Bun.sleep(0);
    // A stale in-flight probe from a cancelled drain must not resurrect
    // `ready` after admission has already reopened.
    expect(lifecycle.currentPhase).toBe("running");
  });

  test("readinessRevision increments on every phase-affecting change, not on idempotent no-ops", async () => {
    const blockers = controlledBlockers();
    const lifecycle = new DaemonLifecycle({ listQuickBlockers: () => [], listBlockers: blockers.fn });
    expect(lifecycle.readinessRevision).toBe(0);
    lifecycle.beginDrain();
    expect(lifecycle.readinessRevision).toBe(1);
    lifecycle.beginDrain();
    expect(lifecycle.readinessRevision).toBe(1);
    blockers.resolveWith([]);
    await Bun.sleep(0);
    expect(lifecycle.readinessRevision).toBe(2);
    lifecycle.cancelDrain();
    expect(lifecycle.readinessRevision).toBe(3);
  });

  test("snapshot caps wire blocker rows while blockedCount reflects the complete set that decided readiness", async () => {
    const full: DaemonBlocker[] = Array.from({ length: MAX_DAEMON_BLOCKERS_LISTED + 10 }, (_, index) => ({ agentId: `agt_${index}`, reason: "running" as const }));
    const lifecycle = new DaemonLifecycle({ listQuickBlockers: () => full, listBlockers: async () => full });
    lifecycle.beginDrain();
    const snapshot = await lifecycle.snapshot();
    expect(snapshot.phase).toBe("draining");
    expect(snapshot.blockedCount).toBe(full.length);
    expect(snapshot.blockers).toHaveLength(MAX_DAEMON_BLOCKERS_LISTED);
    expect(snapshot.blockersTruncated).toBe(true);
  });

  test("snapshot reports no blockers while running, without calling listBlockers", async () => {
    let calls = 0;
    const lifecycle = new DaemonLifecycle({ listQuickBlockers: () => [], listBlockers: async () => { calls += 1; return []; } });
    const snapshot = await lifecycle.snapshot();
    expect(snapshot).toMatchObject({ phase: "running", drainId: null, blockedCount: 0, blockers: [], blockersTruncated: false });
    expect(calls).toBe(0);
  });
});
