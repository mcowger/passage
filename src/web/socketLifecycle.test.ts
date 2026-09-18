import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { PROTOCOL_VERSION } from "../shared/protocol/index.ts";
import { createHeartbeat, pingEnvelope, watchForegroundResume } from "./socketLifecycle.ts";

// Bun's test environment has no DOM; install minimal fakes for exactly the
// globals socketLifecycle.ts touches (document.visibilityState +
// visibilitychange, window pageshow/online), and restore them afterward so
// other test files in the same run are unaffected.
type Listener = () => void;
function fakeEventTarget() {
  const listeners = new Map<string, Set<Listener>>();
  return {
    addEventListener(type: string, listener: Listener) {
      if (!listeners.has(type)) listeners.set(type, new Set());
      listeners.get(type)!.add(listener);
    },
    removeEventListener(type: string, listener: Listener) {
      listeners.get(type)?.delete(listener);
    },
    dispatch(type: string) {
      for (const listener of listeners.get(type) ?? []) listener();
    },
    listenerCount(type: string) {
      return listeners.get(type)?.size ?? 0;
    },
  };
}

let fakeDocument: ReturnType<typeof fakeEventTarget> & { visibilityState: "visible" | "hidden" };
let fakeWindow: ReturnType<typeof fakeEventTarget>;
let originalDocument: unknown;
let originalWindow: unknown;
let originalNavigator: unknown;

beforeEach(() => {
  originalDocument = (globalThis as Record<string, unknown>).document;
  originalWindow = (globalThis as Record<string, unknown>).window;
  originalNavigator = (globalThis as Record<string, unknown>).navigator;
  fakeDocument = Object.assign(fakeEventTarget(), { visibilityState: "visible" as const });
  fakeWindow = fakeEventTarget();
  (globalThis as Record<string, unknown>).document = fakeDocument;
  (globalThis as Record<string, unknown>).window = fakeWindow;
  (globalThis as Record<string, unknown>).navigator = { onLine: true };
});

afterEach(() => {
  (globalThis as Record<string, unknown>).document = originalDocument;
  (globalThis as Record<string, unknown>).window = originalWindow;
  (globalThis as Record<string, unknown>).navigator = originalNavigator;
});

describe("pingEnvelope", () => {
  test("builds a strict daemon/ping command usable on any /ws socket", () => {
    expect(pingEnvelope("req-1")).toEqual({
      version: PROTOCOL_VERSION,
      requestId: "req-1",
      channel: "daemon",
      type: "ping",
      payload: {},
    });
  });
});

// Real short timers rather than fake-clock machinery, matching this repo's
// existing async test style (src/daemon/lifecycle/index.test.ts).
describe("createHeartbeat", () => {
  test("sends an immediate probe on start and reports alive on a matching ack", async () => {
    const sent: string[] = [];
    const alive: number[] = [];
    const dead: number[] = [];
    const heartbeat = createHeartbeat({
      sendPing: (id) => sent.push(id),
      onAlive: () => alive.push(1),
      onDead: () => dead.push(1),
      intervalMs: 1000,
      timeoutMs: 50,
    });
    heartbeat.start();
    expect(sent).toHaveLength(1);
    heartbeat.handleMessage({ version: PROTOCOL_VERSION, requestId: sent[0], ok: true });
    expect(alive).toHaveLength(1);
    await Bun.sleep(80);
    expect(dead).toHaveLength(0); // the ack cleared the deadline
    heartbeat.stop();
  });

  test("declares the connection dead when no ack arrives within the deadline", async () => {
    const dead: number[] = [];
    const heartbeat = createHeartbeat({
      sendPing: () => {},
      onAlive: () => {},
      onDead: () => dead.push(1),
      intervalMs: 1000,
      timeoutMs: 30,
    });
    heartbeat.start();
    await Bun.sleep(60);
    expect(dead).toHaveLength(1);
    heartbeat.stop();
  });

  test("a stale ack from a probe superseded by probeNow cannot satisfy the current one", () => {
    const sent: string[] = [];
    const alive: number[] = [];
    const heartbeat = createHeartbeat({
      sendPing: (id) => sent.push(id),
      onAlive: () => alive.push(1),
      onDead: () => {},
      intervalMs: 1000,
      timeoutMs: 500,
    });
    heartbeat.start();
    const firstId = sent[0];
    heartbeat.probeNow(); // supersedes the first probe before it's acked
    expect(sent).toHaveLength(2);
    heartbeat.handleMessage({ version: PROTOCOL_VERSION, requestId: firstId, ok: true });
    expect(alive).toHaveLength(0);
    heartbeat.stop();
  });

  test("stop cancels pending timers so no late dead/alive callback fires", async () => {
    const dead: number[] = [];
    const heartbeat = createHeartbeat({
      sendPing: () => {},
      onAlive: () => {},
      onDead: () => dead.push(1),
      intervalMs: 1000,
      timeoutMs: 20,
    });
    heartbeat.start();
    heartbeat.stop();
    await Bun.sleep(40);
    expect(dead).toHaveLength(0);
  });

  test("probeNow sends a fresh probe immediately with its own deadline", async () => {
    const sent: string[] = [];
    const dead: number[] = [];
    const heartbeat = createHeartbeat({
      sendPing: (id) => sent.push(id),
      onAlive: () => {},
      onDead: () => dead.push(1),
      intervalMs: 1000,
      timeoutMs: 500,
    });
    heartbeat.start();
    expect(sent).toHaveLength(1);
    heartbeat.probeNow(20);
    expect(sent).toHaveLength(2);
    await Bun.sleep(40);
    expect(dead).toHaveLength(1); // the shorter probeNow deadline fired, not the 500ms default
    heartbeat.stop();
  });

  test("probeNow is a no-op before start (never probes a socket that isn't connecting)", () => {
    const sent: string[] = [];
    const heartbeat = createHeartbeat({ sendPing: (id) => sent.push(id), onAlive: () => {}, onDead: () => {} });
    heartbeat.probeNow();
    expect(sent).toHaveLength(0);
  });
});

describe("watchForegroundResume", () => {
  test("fires on a visible visibilitychange", async () => {
    const calls: number[] = [];
    const dispose = watchForegroundResume(() => calls.push(1));
    fakeDocument.visibilityState = "visible";
    fakeDocument.dispatch("visibilitychange");
    await Bun.sleep(0);
    expect(calls).toHaveLength(1);
    dispose();
  });

  test("does not fire on a hidden visibilitychange", async () => {
    const calls: number[] = [];
    const dispose = watchForegroundResume(() => calls.push(1));
    fakeDocument.visibilityState = "hidden";
    fakeDocument.dispatch("visibilitychange");
    await Bun.sleep(0);
    expect(calls).toHaveLength(0);
    dispose();
  });

  test("fires on pageshow (covers bfcache restore, which may skip visibilitychange)", async () => {
    const calls: number[] = [];
    const dispose = watchForegroundResume(() => calls.push(1));
    fakeWindow.dispatch("pageshow");
    await Bun.sleep(0);
    expect(calls).toHaveLength(1);
    dispose();
  });

  test("fires on online", async () => {
    const calls: number[] = [];
    const dispose = watchForegroundResume(() => calls.push(1));
    fakeWindow.dispatch("online");
    await Bun.sleep(0);
    expect(calls).toHaveLength(1);
    dispose();
  });

  test("a burst of visibilitychange, pageshow, and online in one tick coalesces into a single call", async () => {
    const calls: number[] = [];
    const dispose = watchForegroundResume(() => calls.push(1));
    fakeDocument.visibilityState = "visible";
    fakeDocument.dispatch("visibilitychange");
    fakeWindow.dispatch("pageshow");
    fakeWindow.dispatch("online");
    await Bun.sleep(0); // let the coalescing microtask flush
    expect(calls).toHaveLength(1);
    dispose();
  });

  test("dispose removes every listener; no further onResume calls", () => {
    const calls: number[] = [];
    const dispose = watchForegroundResume(() => calls.push(1));
    dispose();
    expect(fakeDocument.listenerCount("visibilitychange")).toBe(0);
    expect(fakeWindow.listenerCount("pageshow")).toBe(0);
    expect(fakeWindow.listenerCount("online")).toBe(0);
    fakeDocument.dispatch("visibilitychange");
    fakeWindow.dispatch("pageshow");
    fakeWindow.dispatch("online");
    expect(calls).toHaveLength(0);
  });
});
