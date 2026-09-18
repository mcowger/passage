import {
  DAEMON_SNAPSHOT_SUBJECT,
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

export type DaemonSocketState = {
  sequence: number;
  connected: boolean;
  snapshotRequired: boolean;
};

/** There is only ever one daemon subject; unlike `parseWorkspaceMessage`
 *  this needs no subject-id match. */
export function parseDaemonMessage(value: unknown, state: DaemonSocketState): DaemonSocketState {
  const snapshot = snapshotRequiredSchema.safeParse(value);
  if (snapshot.success && snapshot.data.stream === "daemon" && snapshot.data.subjectId === DAEMON_SNAPSHOT_SUBJECT) {
    const sequence = Number(snapshot.data.metadata.sequence);
    return {
      ...state,
      sequence: Number.isSafeInteger(sequence) && sequence >= 0 ? sequence : state.sequence,
      snapshotRequired: true,
    };
  }

  const event = eventEnvelopeSchema.safeParse(value);
  if (!event.success || event.data.stream !== "daemon" || event.data.subjectId !== DAEMON_SNAPSHOT_SUBJECT) return state;
  if (event.data.sequence <= state.sequence) return state;
  return {
    ...state,
    sequence: event.data.sequence,
    snapshotRequired: state.snapshotRequired || event.data.sequence > state.sequence + 1,
  };
}

export function subscribeEnvelope(afterSequence: number) {
  return commandEnvelopeSchema.parse({
    version: PROTOCOL_VERSION,
    requestId: generateRequestId(),
    channel: "daemon",
    type: "subscribe",
    payload: { afterSequence },
  });
}

export function unsubscribeEnvelope() {
  return commandEnvelopeSchema.parse({
    version: PROTOCOL_VERSION,
    requestId: generateRequestId(),
    channel: "daemon",
    type: "unsubscribe",
    payload: {},
  });
}

export type DaemonSocket = { close: () => void };

/** Subscribe to `daemon-changed` lifecycle invalidations (drain begin/
 *  cancel, readiness changes). `onInvalidate` fires for live events
 *  (refetch `GET /api/daemon/snapshot`); `onReconcile` fires when the
 *  client fell behind, reconnected, or returned from suspension. */
export function subscribeDaemon(
  onInvalidate: (value: EventEnvelope) => void,
  onReconcile: () => Promise<void>,
  onHealthChange?: (health: ConnectionHealth) => void,
): DaemonSocket {
  let socket: WebSocket | undefined;
  let reconnectTimer: ReturnType<typeof setTimeout> | undefined;
  let stopped = false;
  let reconciling = false;
  let generation = 0;
  let state: DaemonSocketState = { sequence: 0, connected: false, snapshotRequired: false };

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
      current.send(JSON.stringify(subscribeEnvelope(state.sequence)));
      heartbeat.start();
    });
    current.addEventListener("message", (message) => {
      if (generation !== myGeneration) return;
      try {
        const value = JSON.parse(String(message.data));
        heartbeat.handleMessage(value);
        if (reconciling) return;
        const next = parseDaemonMessage(value, state);
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
        if (changed) {
          const event = eventEnvelopeSchema.safeParse(value);
          if (event.success) onInvalidate(event.data);
        }
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

  const reconnectFromBrowserState = () => {
    if (document.visibilityState !== "visible" || !navigator.onLine) return;
    void onReconcile().catch(() => undefined);
    if (!socket || socket.readyState === WebSocket.CLOSED) {
      connect();
    } else if (socket.readyState === WebSocket.OPEN) {
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
      if (active && active.readyState === WebSocket.OPEN) active.send(JSON.stringify(unsubscribeEnvelope()));
      active?.close();
    },
  };
}
