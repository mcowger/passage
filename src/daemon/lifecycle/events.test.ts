import { describe, expect, test } from "bun:test";
import { DaemonEventHub } from "./events.ts";

describe("DaemonEventHub", () => {
  test("returns empty replay for current sequence without triggering snapshot-required", () => {
    const hub = new DaemonEventHub();
    expect(hub.subscribe(0, () => {}).replay).toEqual({ kind: "replay", events: [] });
  });

  test("buffers live events until replay is delivered, then delivers in order", () => {
    const hub = new DaemonEventHub();
    const received: number[] = [];
    hub.emit({ reason: "drain-begin" });
    const subscription = hub.subscribe(0, (event) => received.push(event.sequence));
    hub.emit({ reason: "readiness-changed" });
    expect(received).toEqual([]);
    expect(subscription.replay.kind).toBe("replay");
    if (subscription.replay.kind !== "replay") throw new Error("expected replay");
    for (const event of subscription.replay.events) received.push(event.sequence);
    subscription.activate();
    expect(received).toEqual([1, 2]);
  });

  test("a stale sequence beyond the bounded replay buffer forces snapshot-required", () => {
    const hub = new DaemonEventHub({ replay: { maxEntries: 2 } });
    hub.emit({ reason: "drain-begin" });
    hub.emit({ reason: "readiness-changed" });
    hub.emit({ reason: "readiness-changed" });
    expect(hub.subscribe(0, () => {}).replay.kind).toBe("snapshot-required");
    expect(hub.subscribe(2, () => {}).replay.kind).toBe("replay");
  });

  test("drops an invalid payload without throwing", () => {
    const hub = new DaemonEventHub();
    // @ts-expect-error intentionally invalid reason for the runtime check
    expect(hub.emit({ reason: "not-a-real-reason" })).toBeNull();
    expect(hub.currentSequence()).toBe(0);
  });

  test("listener errors are isolated from each other", () => {
    const hub = new DaemonEventHub();
    const throwing = hub.subscribe(0, () => { throw new Error("x"); });
    let seen: number | undefined;
    const receiving = hub.subscribe(0, (event) => { seen = event.sequence; });
    throwing.activate();
    receiving.activate();
    hub.emit({ reason: "drain-cancel" });
    expect(seen).toBe(1);
  });

  test("dispose stops delivering and rejects further subscribe calls", () => {
    const hub = new DaemonEventHub();
    hub.dispose();
    expect(hub.emit({ reason: "drain-begin" })).toBeNull();
    expect(() => hub.subscribe(0, () => {})).toThrow("disposed");
  });
});
