import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { PROTOCOL_VERSION, acknowledgementSchema } from "../shared/protocol/index.ts";
import { parseAgentMessage, subscribeAgent, subscribeEnvelope, unsubscribeEnvelope, type AgentSocketState } from "./agentSocket.ts";
import { RESUME_PROBE_DEAD_AFTER_MS, type ConnectionHealth } from "./socketLifecycle.ts";

const initial: AgentSocketState = { sequence: 0, connected: true, snapshotRequired: false };

describe("agent socket protocol", () => {
  test("builds strict Pi subscription envelopes", () => {
    expect(subscribeEnvelope("agent-1", 4)).toMatchObject({
      version: PROTOCOL_VERSION,
      channel: "pi",
      type: "subscribe",
      payload: { agentId: "agent-1", afterSequence: 4 },
    });
    expect(unsubscribeEnvelope("agent-1")).toMatchObject({
      channel: "pi",
      type: "unsubscribe",
      payload: { agentId: "agent-1" },
    });
  });

  test("accepts only ordered events for the selected agent", () => {
    const event = {
      version: PROTOCOL_VERSION,
      stream: "pi",
      subjectId: "agent-1",
      sequence: 1,
      type: "status",
      payload: { status: "running" },
    };
    expect(parseAgentMessage(event, initial, "agent-1")).toMatchObject({ sequence: 1, status: "running" });
    expect(parseAgentMessage(event, initial, "other-agent")).toBe(initial);
    expect(parseAgentMessage({ ...event, sequence: 0 }, initial, "agent-1")).toBe(initial);
  });

  test("marks gaps and snapshot requirements for authoritative reload", () => {
    const gap = parseAgentMessage({
      version: PROTOCOL_VERSION,
      stream: "pi",
      subjectId: "agent-1",
      sequence: 3,
      type: "settled",
      payload: { status: "idle" },
    }, initial, "agent-1");
    expect(gap.snapshotRequired).toBe(true);
    const snapshot = parseAgentMessage({
      version: PROTOCOL_VERSION,
      stream: "pi",
      subjectId: "agent-1",
      kind: "snapshot-required",
      metadata: { snapshotUrl: "/api/agents/agent-1", sequence: "9" },
    }, gap, "agent-1");
    expect(snapshot).toMatchObject({ sequence: 9, snapshotRequired: true });
  });

  // Once a reconcile clears snapshotRequired at sequence 9 (see
  // subscribeAgent), the very next contiguous event must resume normal
  // delivery -- a daemon restart mid-session must not leave the client
  // stuck re-requesting snapshots forever.
  test("resumes ordered delivery immediately after a snapshot clears at a fresh sequence", () => {
    const reconciled: AgentSocketState = { sequence: 9, connected: true, snapshotRequired: false };
    const next = parseAgentMessage({
      version: PROTOCOL_VERSION,
      stream: "pi",
      subjectId: "agent-1",
      sequence: 10,
      type: "status",
      payload: { status: "running" },
    }, reconciled, "agent-1");
    expect(next).toMatchObject({ sequence: 10, snapshotRequired: false, status: "running" });
  });

  // An event that arrived and was dropped while a reconcile was already in
  // flight (subscribeAgent ignores messages while `reconciling` is true)
  // leaves a gap right after the reconcile clears. That gap must still be
  // detected so the client re-requests a snapshot instead of silently
  // resuming with a hole in its timeline.
  test("a gap immediately after a snapshot clears still forces another snapshot", () => {
    const reconciled: AgentSocketState = { sequence: 9, connected: true, snapshotRequired: false };
    const next = parseAgentMessage({
      version: PROTOCOL_VERSION,
      stream: "pi",
      subjectId: "agent-1",
      sequence: 11,
      type: "status",
      payload: { status: "running" },
    }, reconciled, "agent-1");
    expect(next).toMatchObject({ sequence: 11, snapshotRequired: true });
  });
});

// Bun's test environment has no DOM/WebSocket globals wired to a real
// transport; install minimal fakes covering exactly what subscribeAgent
// touches (docs/IOSWEBSOCKETS.md step 1's fake-WebSocket/fake-clock harness).
type Listener = () => void;
function fakeEventTarget() {
  const listeners = new Map<string, Set<Listener>>();
  return {
    addEventListener(type: string, listener: Listener) { if (!listeners.has(type)) listeners.set(type, new Set()); listeners.get(type)!.add(listener); },
    removeEventListener(type: string, listener: Listener) { listeners.get(type)?.delete(listener); },
    dispatch(type: string) { for (const listener of [...(listeners.get(type) ?? [])]) listener(); },
  };
}

class FakeWebSocket {
  static readonly CONNECTING = 0; static readonly OPEN = 1; static readonly CLOSING = 2; static readonly CLOSED = 3;
  static instances: FakeWebSocket[] = [];
  readyState = FakeWebSocket.CONNECTING;
  sent: unknown[] = [];
  private listeners = new Map<string, Set<(event?: unknown) => void>>();
  constructor(readonly url: string) { FakeWebSocket.instances.push(this); }
  addEventListener(type: string, listener: (event?: unknown) => void) { if (!this.listeners.has(type)) this.listeners.set(type, new Set()); this.listeners.get(type)!.add(listener); }
  send(data: string) { this.sent.push(JSON.parse(data)); }
  close() { if (this.readyState === FakeWebSocket.CLOSED) return; this.readyState = FakeWebSocket.CLOSED; this.dispatch("close"); }
  // Test-only helpers, not part of the real WebSocket API:
  serverOpen() { this.readyState = FakeWebSocket.OPEN; this.dispatch("open"); }
  serverMessage(value: unknown) { this.dispatch("message", { data: JSON.stringify(value) }); }
  private dispatch(type: string, event?: unknown) { for (const listener of [...(this.listeners.get(type) ?? [])]) listener(event); }
  /** Every ping this fake socket has sent, decoded. */
  get pings(): { requestId: string }[] { return this.sent.filter((m): m is { channel: string; type: string; requestId: string } => (m as { channel?: string }).channel === "daemon" && (m as { type?: string }).type === "ping") as unknown as { requestId: string }[]; }
  ackLatestPing() { const ping = this.pings.at(-1); if (!ping) return; this.serverMessage(acknowledgementSchema.parse({ version: PROTOCOL_VERSION, requestId: ping.requestId, ok: true })); }
}

describe("subscribeAgent lifecycle (docs/IOSWEBSOCKETS.md)", () => {
  let fakeDocument: ReturnType<typeof fakeEventTarget> & { visibilityState: "visible" | "hidden" };
  let fakeWindow: ReturnType<typeof fakeEventTarget>;
  let originals: Record<string, unknown>;

  beforeEach(() => {
    originals = {
      document: (globalThis as Record<string, unknown>).document,
      window: (globalThis as Record<string, unknown>).window,
      navigator: (globalThis as Record<string, unknown>).navigator,
      location: (globalThis as Record<string, unknown>).location,
      WebSocket: (globalThis as Record<string, unknown>).WebSocket,
    };
    fakeDocument = Object.assign(fakeEventTarget(), { visibilityState: "visible" as const });
    fakeWindow = fakeEventTarget();
    (globalThis as Record<string, unknown>).document = fakeDocument;
    (globalThis as Record<string, unknown>).window = fakeWindow;
    (globalThis as Record<string, unknown>).navigator = { onLine: true };
    (globalThis as Record<string, unknown>).location = { protocol: "https:", host: "passage.test" };
    (globalThis as Record<string, unknown>).WebSocket = FakeWebSocket;
    FakeWebSocket.instances = [];
  });

  afterEach(() => {
    for (const key of Object.keys(originals)) (globalThis as Record<string, unknown>)[key] = originals[key];
  });

  test("reports checking then online as the socket opens and the first heartbeat probe acks", () => {
    const health: ConnectionHealth[] = [];
    const sub = subscribeAgent("agent-1", () => {}, async () => {}, (h) => health.push(h));
    expect(health).toEqual(["checking"]);
    const socket = FakeWebSocket.instances[0]!;
    socket.serverOpen();
    socket.ackLatestPing();
    expect(health).toEqual(["checking", "online"]);
    sub.close();
  });

  test("a foreground resume probes a zombie OPEN socket and replaces it without acting on its late callbacks", async () => {
    const health: ConnectionHealth[] = [];
    const messages: unknown[] = [];
    const sub = subscribeAgent("agent-1", (value) => messages.push(value), async () => {}, (h) => health.push(h));
    const zombie = FakeWebSocket.instances[0]!;
    zombie.serverOpen();
    zombie.ackLatestPing();
    expect(health).toEqual(["checking", "online"]);

    // Foreground return: the zombie still reports OPEN, so subscribeAgent
    // probes it rather than assuming it's fine.
    fakeDocument.dispatch("visibilitychange");
    await Bun.sleep(0); // let the resume watcher's coalescing microtask flush
    expect(zombie.pings).toHaveLength(2); // the resume probe, on top of the initial one
    expect(FakeWebSocket.instances).toHaveLength(1); // no replacement yet -- still waiting on the probe

    await Bun.sleep(RESUME_PROBE_DEAD_AFTER_MS + 20);
    expect(FakeWebSocket.instances).toHaveLength(2); // replaced after the probe deadline passed unanswered
    // forceReconnect reports offline, then immediately checking for the
    // replacement socket it opens in the same tick.
    expect(health.slice(-2)).toEqual(["offline", "checking"]);

    // The zombie's late open/message/close must not affect the new socket's
    // reported state -- this is the generation guard.
    zombie.serverMessage({ version: PROTOCOL_VERSION, stream: "pi", subjectId: "agent-1", sequence: 999, type: "status", payload: { status: "error" } });
    expect(messages).toHaveLength(0);

    const replacement = FakeWebSocket.instances[1]!;
    replacement.serverOpen();
    replacement.ackLatestPing();
    expect(health.at(-1)).toBe("online");
    sub.close();
  });

  test("reconnects on a real close and resubscribes from the last known sequence", async () => {
    const health: ConnectionHealth[] = [];
    const sub = subscribeAgent("agent-1", () => {}, async () => {}, (h) => health.push(h));
    const first = FakeWebSocket.instances[0]!;
    first.serverOpen();
    first.close();
    expect(health.at(-1)).toBe("offline");
    await Bun.sleep(850); // past the fixed 800ms reconnect delay
    expect(FakeWebSocket.instances).toHaveLength(2);
    sub.close();
  });

  test("resumes from a keep-alive handoff sequence instead of zero", () => {
    const sub = subscribeAgent("agent-1", () => {}, async () => {}, undefined, 7);
    const socket = FakeWebSocket.instances[0]!;
    socket.serverOpen();
    const subscribe = socket.sent.find((m) => (m as { type?: string }).type === "subscribe");
    expect(subscribe).toMatchObject({ payload: { agentId: "agent-1", afterSequence: 7 } });
    sub.close();
  });

  test("close() is terminal: no further reconnect, probe, or resume handling", async () => {
    const sub = subscribeAgent("agent-1", () => {}, async () => {});
    const socket = FakeWebSocket.instances[0]!;
    socket.serverOpen();
    sub.close();
    fakeDocument.dispatch("visibilitychange");
    fakeWindow.dispatch("pageshow");
    await Bun.sleep(50);
    expect(FakeWebSocket.instances).toHaveLength(1);
  });
});
