import { describe, expect, test } from "bun:test";
import { AgentEventHub } from "./index.ts";
import type { AgentServiceEvent } from "../service.ts";

function source() { const listeners = new Set<(e: AgentServiceEvent) => void>(); return { subscribe(fn: (e: AgentServiceEvent) => void) { listeners.add(fn); return () => listeners.delete(fn); }, emit(e: AgentServiceEvent) { for (const fn of listeners) fn(e); } }; }
const event = (agentId: string, type: AgentServiceEvent["type"] = "status", extra: Partial<AgentServiceEvent> = {}): AgentServiceEvent => ({ agentId, type, status: "running", ...extra });

describe("AgentEventHub", () => {
  test("returns empty replay for current sequence without triggering snapshot-required", () => {
    const s = source();
    const h = new AgentEventHub(s);
    expect(h.subscribe("brand-new", 0, () => {}).replay).toEqual({ kind: "replay", events: [] });
    s.emit(event("brand-new"));
    expect(h.subscribe("brand-new", 1, () => {}).replay).toEqual({ kind: "replay", events: [] });
  });
  test("orders and isolates subjects", () => { const s = source(); const h = new AgentEventHub(s); const got: number[] = []; const a = h.subscribe("a", 0, (e) => got.push(e.sequence)); const b = h.subscribe("b", 0, () => {}); a.activate(); b.activate(); s.emit(event("a")); s.emit(event("b")); s.emit(event("a")); expect(got).toEqual([1, 2]); });
  test("replays and reports eviction", () => { const s = source(); const h = new AgentEventHub(s, { replay: { maxEntries: 2 } }); s.emit(event("a")); s.emit(event("a")); s.emit(event("a")); const r = h.subscribe("a", 0, () => {}).replay; expect(r.kind).toBe("snapshot-required"); expect(h.subscribe("a", 2, () => {}).replay.kind).toBe("replay"); });
  test("buffers live events until replay is delivered", () => {
    const s = source(); const h = new AgentEventHub(s); const received: number[] = [];
    s.emit(event("a"));
    const subscription = h.subscribe("a", 0, (item) => received.push(item.sequence));
    s.emit(event("a"));
    expect(received).toEqual([]);
    expect(subscription.replay.kind).toBe("replay");
    if (subscription.replay.kind !== "replay") throw new Error("expected replay");
    for (const item of subscription.replay.events) received.push(item.sequence);
    subscription.activate();
    expect(received).toEqual([1, 2]);
  });
  test("sanitizes payload and listener errors", () => { const s = source(); const h = new AgentEventHub(s); const throwing = h.subscribe("a", 0, () => { throw new Error("x"); }); let seen: any; const receiving = h.subscribe("a", 0, (e) => seen = e); throwing.activate(); receiving.activate(); s.emit(event("a", "attention", { generation: -1, error: "x".repeat(1000) })); expect(seen.payload.error.length).toBe(512); expect(seen.payload).not.toHaveProperty("agentId"); });
  test("disposes and only explicit removal resets sequence", () => { const s = source(); const h = new AgentEventHub(s); let n = 0; const first = h.subscribe("a", 0, (e) => n = e.sequence); first.activate(); s.emit(event("a")); h.removeSubject("a"); const second = h.subscribe("a", 0, (e) => n = e.sequence); second.activate(); s.emit(event("a")); expect(n).toBe(1); h.dispose(); s.emit(event("a")); expect(n).toBe(1); });
  // A daemon restart replaces the hub instance entirely; its sequence
  // counter and replay buffer start from zero even though a reconnecting
  // browser still remembers a high sequence from before the restart. A
  // stale cursor must never be treated as caught-up (empty replay) or
  // silently matched against the wrong run -- only an explicit
  // snapshot-required tells the client its old event stream is gone and it
  // must refetch authoritative state.
  test("a stale high sequence from before a daemon restart forces snapshot-required, not a caught-up empty replay", () => {
    const s = source();
    const freshHubAfterRestart = new AgentEventHub(s);
    expect(freshHubAfterRestart.currentSequence("agt_1")).toBe(0);
    const subscription = freshHubAfterRestart.subscribe("agt_1", 47, () => {});
    expect(subscription.replay).toEqual({ kind: "snapshot-required", stream: "pi", subjectId: "agt_1" });
  });
});
