import { agentStatusSchema, type AgentStatus } from "../shared/domain/agents.ts";
import {
  PROTOCOL_VERSION,
  commandEnvelopeSchema,
  eventEnvelopeSchema,
  snapshotRequiredSchema,
  type EventEnvelope,
} from "../shared/protocol/index.ts";
import {
  createHeartbeat,
  generateRequestId,
  pingEnvelope,
  RESUME_PROBE_DEAD_AFTER_MS,
  watchForegroundResume,
  webSocketUrl,
  type ConnectionHealth,
} from "./socketLifecycle.ts";

const RECONNECT_DELAY_MS = 800;

export type AgentSocketState = {
  sequence: number;
  connected: boolean;
  snapshotRequired: boolean;
  status?: AgentStatus;
};

export function parseAgentMessage(value: unknown, state: AgentSocketState, agentId: string): AgentSocketState {
  const snapshot = snapshotRequiredSchema.safeParse(value);
  if (snapshot.success && snapshot.data.stream === "pi" && snapshot.data.subjectId === agentId) {
    const sequence = Number(snapshot.data.metadata.sequence);
    return {
      ...state,
      sequence: Number.isSafeInteger(sequence) && sequence >= 0 ? sequence : state.sequence,
      snapshotRequired: true,
    };
  }

  const event = eventEnvelopeSchema.safeParse(value);
  if (!event.success || event.data.stream !== "pi" || event.data.subjectId !== agentId) return state;
  if (event.data.sequence <= state.sequence) return state;
  const payload = event.data.payload !== null && typeof event.data.payload === "object" && !Array.isArray(event.data.payload)
    ? event.data.payload as Record<string, unknown>
    : {};
  const status = agentStatusSchema.safeParse(payload.status);
  return {
    ...state,
    sequence: event.data.sequence,
    snapshotRequired: state.snapshotRequired || event.data.sequence > state.sequence + 1,
    ...(status.success ? { status: status.data } : {}),
  };
}

export function subscribeEnvelope(agentId: string, afterSequence: number) {
  return commandEnvelopeSchema.parse({
    version: PROTOCOL_VERSION,
    requestId: generateRequestId(),
    channel: "pi",
    type: "subscribe",
    payload: { agentId, afterSequence },
  });
}

export function unsubscribeEnvelope(agentId: string) {
  return commandEnvelopeSchema.parse({
    version: PROTOCOL_VERSION,
    requestId: generateRequestId(),
    channel: "pi",
    type: "unsubscribe",
    payload: { agentId },
  });
}

export type AgentSocket = { close: () => void };

export function subscribeAgent(
  agentId: string,
  onMessage: (value: EventEnvelope | unknown, state: AgentSocketState) => void,
  onReconcile: () => Promise<void>,
  onHealthChange?: (health: ConnectionHealth) => void,
  initialSequence = 0,
): AgentSocket {
  const resumeFrom = Number.isSafeInteger(initialSequence) && initialSequence >= 0 ? initialSequence : 0;
  let socket: WebSocket | undefined;
  let reconnectTimer: ReturnType<typeof setTimeout> | undefined;
  let stopped = false;
  let reconciling = false;
  let generation = 0;
  // `initialSequence` lets a handoff (visible panel -> background keep-alive
  // or back) resume from the last applied sequence instead of 0, so the
  // daemon replays only the gap (or nothing) rather than the whole buffer.
  let state: AgentSocketState = { sequence: resumeFrom, connected: false, snapshotRequired: false };

  const setHealth = (health: ConnectionHealth) => onHealthChange?.(health);

  const heartbeat = createHeartbeat({
    sendPing: (requestId) => socket?.send(JSON.stringify(pingEnvelope(requestId))),
    onAlive: () => setHealth("online"),
    onDead: () => forceReconnect(),
  });

  const scheduleReconnect = () => {
    if (stopped || reconnectTimer) return;
    reconnectTimer = setTimeout(() => {
      reconnectTimer = undefined;
      connect();
    }, RECONNECT_DELAY_MS);
  };

  const connect = () => {
    if (stopped || socket?.readyState === WebSocket.OPEN || socket?.readyState === WebSocket.CONNECTING) return;
    const myGeneration = ++generation;
    setHealth("checking");
    const current = new WebSocket(webSocketUrl());
    socket = current;
    current.addEventListener("open", () => {
      if (generation !== myGeneration) return;
      state = { ...state, connected: true, snapshotRequired: false };
      current.send(JSON.stringify(subscribeEnvelope(agentId, state.sequence)));
      heartbeat.start();
    });
    current.addEventListener("message", (message) => {
      if (generation !== myGeneration) return;
      try {
        const value = JSON.parse(String(message.data));
        heartbeat.handleMessage(value);
        if (reconciling) return;
        const next = parseAgentMessage(value, state, agentId);
        const changed = next !== state;
        state = next;
        if (next.snapshotRequired) {
          const afterSequence = next.sequence;
          reconciling = true;
          void onReconcile().catch(() => undefined).finally(() => {
            reconciling = false;
            state = { ...state, sequence: afterSequence, snapshotRequired: false };
          });
          return;
        }
        if (changed) onMessage(value, next);
      } catch {}
    });
    current.addEventListener("close", () => {
      if (generation !== myGeneration) return;
      heartbeat.stop();
      state = { ...state, connected: false };
      socket = undefined;
      setHealth("offline");
      if (!stopped) {
        void onReconcile().catch(() => undefined);
        scheduleReconnect();
      }
    });
  };

  /** Replace the current connection even if it still claims `OPEN` or
   *  `CONNECTING` -- a backgrounded iOS socket can report `OPEN` while
   *  actually dead (docs/IOSWEBSOCKETS.md). Bumping `generation` first
   *  means the old socket's late open/message/close callbacks are ignored;
   *  its close is requested but never awaited. */
  const forceReconnect = () => {
    if (stopped) return;
    heartbeat.stop();
    const stale = socket;
    socket = undefined;
    setHealth("offline");
    if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = undefined; }
    connect();
    stale?.close();
  };

  // `pageshow` can fire while hidden (bfcache priming); re-check visibility
  // and online state here rather than trusting the resume watcher's cause.
  const reconnectFromBrowserState = () => {
    if (document.visibilityState !== "visible" || !navigator.onLine) return;
    void onReconcile().catch(() => undefined);
    if (!socket || socket.readyState === WebSocket.CLOSED) {
      connect();
    } else if (socket.readyState === WebSocket.OPEN) {
      // Zombie check: a socket that still claims OPEN after backgrounding
      // may be silently dead. Probe with a short deadline before tearing it
      // down, so a genuinely healthy connection isn't churned on every tab
      // switch.
      heartbeat.probeNow(RESUME_PROBE_DEAD_AFTER_MS);
    }
  };

  const disposeResumeWatcher = watchForegroundResume(reconnectFromBrowserState);
  connect();

  return {
    close() {
      stopped = true;
      generation += 1;
      heartbeat.stop();
      if (reconnectTimer) clearTimeout(reconnectTimer);
      disposeResumeWatcher();
      // Capture the current socket: the close listener clears the closure
      // variable, so reading it twice can race with the reconnect handler.
      const active = socket;
      socket = undefined;
      if (active && active.readyState === WebSocket.OPEN) active.send(JSON.stringify(unsubscribeEnvelope(agentId)));
      active?.close();
    },
  };
}
