import { describe, expect, test } from "bun:test";
import {
  AgentKeepAliveStore,
  KEEP_ALIVE_CACHE_MAX,
  KEEP_ALIVE_DESKTOP_LIMIT,
  KEEP_ALIVE_MOBILE_LIMIT,
  keepAliveLimit,
  type KeepAliveHandOff,
} from "./agentKeepAlive.ts";
import type { AgentSocket, AgentSocketState } from "./agentSocket.ts";
import type { AgentHistory, AgentSummary } from "../shared/domain/agents.ts";

type SubscribeFn = typeof import("./agentSocket.ts").subscribeAgent;

type RecordedSub = {
  agentId: string;
  afterSequence: number;
  closed: boolean;
  onMessage: Parameters<SubscribeFn>[1];
  onReconcile: () => Promise<void>;
};

function fakeSubscribeHost() {
  const subs: RecordedSub[] = [];
  const subscribe: SubscribeFn = (agentId, onMessage, onReconcile, _health, initialSequence = 0) => {
    const sub: RecordedSub = {
      agentId,
      afterSequence: initialSequence,
      closed: false,
      onMessage,
      onReconcile,
    };
    subs.push(sub);
    const socket: AgentSocket = { close: () => { sub.closed = true; } };
    return socket;
  };
  return { subs, subscribe };
}

function summary(id: string, workspaceId = "ws-1", status = "idle"): AgentSummary {
  return { id, workspaceId, title: `Agent ${id}`, status } as unknown as AgentSummary;
}

function handoff(id: string, overrides: Partial<KeepAliveHandOff> = {}): KeepAliveHandOff {
  return {
    agent: summary(id),
    history: undefined,
    capabilities: undefined,
    nextBefore: undefined,
    sequence: 0,
    ...overrides,
  };
}

function liveState(sequence: number, status?: AgentSocketState["status"]): AgentSocketState {
  return { sequence, connected: true, snapshotRequired: false, ...(status ? { status } : {}) };
}

describe("keepAliveLimit", () => {
  test("desktop keeps 8 background agents, mobile keeps 3", () => {
    expect(KEEP_ALIVE_DESKTOP_LIMIT).toBe(8);
    expect(KEEP_ALIVE_MOBILE_LIMIT).toBe(3);
    expect(keepAliveLimit(false)).toBe(8);
    expect(keepAliveLimit(true)).toBe(3);
  });
});

describe("AgentKeepAliveStore handoff/take", () => {
  test("handOff opens a socket from the handoff sequence; take closes it and returns the snapshot", () => {
    const host = fakeSubscribeHost();
    const store = new AgentKeepAliveStore(host.subscribe);
    store.handOff("agt-1", handoff("agt-1", { sequence: 4 }), 8);
    expect(host.subs).toHaveLength(1);
    expect(host.subs[0]!.afterSequence).toBe(4);
    expect(store.liveCount()).toBe(1);

    const taken = store.take("agt-1");
    expect(taken?.sequence).toBe(4);
    expect(taken?.agent.id).toBe("agt-1");
    expect(host.subs[0]!.closed).toBe(true);
    expect(store.liveCount()).toBe(0);
    expect(store.take("agt-1")).toBeUndefined();
    expect(store.take("missing")).toBeUndefined();
  });

  test("background row_upsert deltas accumulate into the cached timeline", () => {
    const host = fakeSubscribeHost();
    const store = new AgentKeepAliveStore(host.subscribe);
    store.handOff("agt-1", handoff("agt-1"), 8);
    const sub = host.subs[0]!;
    sub.onMessage(
      { type: "row_upsert", payload: { row: { kind: "assistant", id: "r1", text: "hello" } } },
      liveState(1),
    );
    sub.onMessage(
      { type: "row_upsert", payload: { row: { kind: "assistant", id: "r2", text: "world" } } },
      liveState(2),
    );
    const kept = store.peek("agt-1");
    expect(kept?.sequence).toBe(2);
    expect(kept?.history?.timeline.map((row) => row.id)).toEqual(["r1", "r2"]);
    // The take snapshot carries the warmed rows for instant panel hydration.
    expect(store.take("agt-1")?.history?.timeline).toHaveLength(2);
  });

  test("invalid rows never poison the cache", () => {
    const host = fakeSubscribeHost();
    const store = new AgentKeepAliveStore(host.subscribe);
    store.handOff("agt-1", handoff("agt-1"), 8);
    host.subs[0]!.onMessage({ type: "row_upsert", payload: { row: { kind: "assistant" } } }, liveState(1));
    expect(store.peek("agt-1")?.history).toBeUndefined();
  });
});

describe("AgentKeepAliveStore budget", () => {
  test("oldest live socket is parked first when over budget, data is retained", () => {
    const host = fakeSubscribeHost();
    const store = new AgentKeepAliveStore(host.subscribe);
    store.handOff("a", handoff("a"), 2);
    store.handOff("b", handoff("b"), 2);
    store.handOff("c", handoff("c"), 2);
    expect(store.liveCount()).toBe(2);
    expect(host.subs[0]!.closed).toBe(true); // a parked
    expect(host.subs[1]!.closed).toBe(false);
    expect(host.subs[2]!.closed).toBe(false);
    // Parked data is still available for instant paint + REST reconcile.
    expect(store.peek("a")).toBeDefined();
    expect(store.ids()).toEqual(["a", "b", "c"]);
  });

  test("limit zero keeps data only, no sockets", () => {
    const host = fakeSubscribeHost();
    const store = new AgentKeepAliveStore(host.subscribe);
    const history = { timeline: [{ kind: "assistant", id: "r1", text: "hi" }] } as unknown as AgentHistory;
    store.handOff("a", handoff("a", { history }), 0);
    expect(host.subs).toHaveLength(0);
    expect(store.take("a")?.history?.timeline).toHaveLength(1);
  });

  test("retained snapshots are capped", () => {
    const host = fakeSubscribeHost();
    const store = new AgentKeepAliveStore(host.subscribe);
    for (let i = 0; i < KEEP_ALIVE_CACHE_MAX + 1; i += 1) {
      store.handOff(`agt-${i}`, handoff(`agt-${i}`), 0);
    }
    expect(store.ids()).toHaveLength(KEEP_ALIVE_CACHE_MAX);
    expect(store.peek("agt-0")).toBeUndefined();
    expect(store.peek(`agt-${KEEP_ALIVE_CACHE_MAX}`)).toBeDefined();
  });
});

describe("AgentKeepAliveStore background summary forwarding", () => {
  test("status transitions forward once; repeats are silent", () => {
    const host = fakeSubscribeHost();
    const store = new AgentKeepAliveStore(host.subscribe);
    const seen: AgentSummary[] = [];
    store.handOff("agt-1", handoff("agt-1", { onAgentChanged: (next) => seen.push(next) }), 8);
    const sub = host.subs[0]!;
    sub.onMessage({ type: "message_update", payload: { status: "running" } }, liveState(1, "running"));
    sub.onMessage({ type: "message_update", payload: { status: "running" } }, liveState(2, "running"));
    expect(seen).toHaveLength(1);
    expect(seen[0]!.status).toBe("running");
    expect(store.peek("agt-1")?.agent.status).toBe("running");
  });

  test("attention sets pendingUiRequest; settle clears it and marks stale", () => {
    const host = fakeSubscribeHost();
    const store = new AgentKeepAliveStore(host.subscribe);
    const seen: AgentSummary[] = [];
    store.handOff("agt-1", handoff("agt-1", { onAgentChanged: (next) => seen.push(next) }), 8);
    const sub = host.subs[0]!;
    sub.onMessage({ type: "attention", payload: { id: "dlg-1" } }, liveState(1, "needs-attention"));
    expect(store.peek("agt-1")?.agent.pendingUiRequest).toMatchObject({ id: "dlg-1" });
    const forwardsAfterAttention = seen.length;
    // Repeating the same attention dialog does not re-render the list.
    sub.onMessage({ type: "attention", payload: { id: "dlg-1" } }, liveState(2, "needs-attention"));
    expect(seen).toHaveLength(forwardsAfterAttention);
    sub.onMessage({ type: "settled", payload: {} }, liveState(3, "idle"));
    expect(store.peek("agt-1")?.agent.pendingUiRequest).toBeUndefined();
    expect(store.peek("agt-1")?.stale).toBe(true);
  });

  test("title updates stay cache-only; replay gaps mark stale for foreground reconcile", async () => {
    const host = fakeSubscribeHost();
    const store = new AgentKeepAliveStore(host.subscribe);
    const seen: AgentSummary[] = [];
    store.handOff("agt-1", handoff("agt-1", { onAgentChanged: (next) => seen.push(next) }), 8);
    const sub = host.subs[0]!;
    sub.onMessage({ type: "title", payload: { title: "New title" } }, liveState(1));
    expect(store.peek("agt-1")?.agent.title).toBe("New title");
    // Forwarding would run the unmounted panel's render closure against a
    // stale layout; the tab label re-syncs on the next visit instead.
    expect(seen).toHaveLength(0);
    await sub.onReconcile();
    expect(store.peek("agt-1")?.stale).toBe(true);
  });

  test("terminal statuses clear a stale run start", () => {
    const host = fakeSubscribeHost();
    const store = new AgentKeepAliveStore(host.subscribe);
    const seen: AgentSummary[] = [];
    const agent = { ...summary("agt-1", "ws-1", "running"), runStartedAt: 123 } as AgentSummary;
    store.handOff("agt-1", handoff("agt-1", { agent, onAgentChanged: (next) => seen.push(next) }), 8);
    // A non-terminal transition keeps the run start.
    host.subs[0]!.onMessage({ type: "status", payload: { status: "stopping" } }, liveState(1, "stopping"));
    expect(store.peek("agt-1")?.agent.runStartedAt).toBe(123);
    // Settling clears it, mirroring the daemon's endRun conditions.
    host.subs[0]!.onMessage({ type: "settled", payload: {} }, liveState(2, "idle"));
    expect(store.peek("agt-1")?.agent.runStartedAt).toBeUndefined();
    expect(seen.at(-1)?.status).toBe("idle");
  });
});

describe("AgentKeepAliveStore workspace generation guard", () => {
  test("late handoffs from a pruned workspace are refused", () => {
    const host = fakeSubscribeHost();
    const store = new AgentKeepAliveStore(host.subscribe);
    store.handOff("a", { ...handoff("a"), agent: summary("a", "ws-1") }, 8);
    expect(host.subs).toHaveLength(1);
    // Workspace switch prunes the old entry and arms the guard.
    store.prune("ws-2");
    expect(store.ids()).toEqual([]);
    expect(host.subs[0]!.closed).toBe(true);
    // The old panel unmounting late must not resurrect its socket.
    store.handOff("a", { ...handoff("a"), agent: summary("a", "ws-1") }, 8);
    expect(store.ids()).toEqual([]);
    expect(host.subs).toHaveLength(1);
    // The new workspace is unaffected and accepted.
    store.handOff("b", { ...handoff("b"), agent: summary("b", "ws-2") }, 8);
    expect(store.ids()).toEqual(["b"]);
    expect(host.subs).toHaveLength(2);
    expect(host.subs[1]!.closed).toBe(false);
  });
});

describe("AgentKeepAliveStore workspace isolation", () => {
  test("handOff drops cross-workspace entries; prune clears on switch", () => {
    const host = fakeSubscribeHost();
    const store = new AgentKeepAliveStore(host.subscribe);
    store.handOff("a", { ...handoff("a"), agent: summary("a", "ws-1") }, 8);
    store.handOff("b", { ...handoff("b"), agent: summary("b", "ws-2") }, 8);
    // The ws-2 handoff already pruned the ws-1 entry.
    expect(store.ids()).toEqual(["b"]);
    expect(host.subs[0]!.closed).toBe(true);

    store.handOff("c", { ...handoff("c"), agent: summary("c", "ws-2") }, 8);
    store.prune("ws-1");
    expect(store.ids()).toEqual([]);
    expect(store.liveCount()).toBe(0);
  });
});
