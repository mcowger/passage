import {
  PROTOCOL_VERSION,
  WORKSPACES_SNAPSHOT_SUBJECT,
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

export { WORKSPACES_SNAPSHOT_SUBJECT };

const RECONNECT_DELAY_MS = 800;

export type WorkspaceSocketState = {
  sequence: number;
  connected: boolean;
  snapshotRequired: boolean;
};

export function parseWorkspaceMessage(value: unknown, state: WorkspaceSocketState, workspaceId: string): WorkspaceSocketState {
  const snapshot = snapshotRequiredSchema.safeParse(value);
  if (snapshot.success && snapshot.data.stream === "workspace" && snapshot.data.subjectId === workspaceId) {
    const sequence = Number(snapshot.data.metadata.sequence);
    return {
      ...state,
      sequence: Number.isSafeInteger(sequence) && sequence >= 0 ? sequence : state.sequence,
      snapshotRequired: true,
    };
  }

  const event = eventEnvelopeSchema.safeParse(value);
  if (!event.success || event.data.stream !== "workspace" || event.data.subjectId !== workspaceId) return state;
  if (event.data.sequence <= state.sequence) return state;
  return {
    ...state,
    sequence: event.data.sequence,
    snapshotRequired: state.snapshotRequired || event.data.sequence > state.sequence + 1,
  };
}

export function subscribeEnvelope(workspaceId: string, afterSequence: number) {
  return commandEnvelopeSchema.parse({
    version: PROTOCOL_VERSION,
    requestId: generateRequestId(),
    channel: "workspace",
    type: "subscribe",
    payload: { workspaceId, afterSequence },
  });
}

export function unsubscribeEnvelope(workspaceId: string) {
  return commandEnvelopeSchema.parse({
    version: PROTOCOL_VERSION,
    requestId: generateRequestId(),
    channel: "workspace",
    type: "unsubscribe",
    payload: { workspaceId },
  });
}

export type WorkspaceSocket = { close: () => void };

/** Subscribe to `workspaces-changed` list invalidations on the well-known
 *  workspace-list subject. `onInvalidate` fires for live events (refetch
 *  `GET /api/workspaces/snapshot`); `onReconcile` fires when the client
 *  fell behind, reconnected, or returned from suspension. Only
 *  `workspaces-changed` events are forwarded; other types on the shared
 *  subject are ignored. */
export function subscribeWorkspaces(
  onInvalidate: (value: EventEnvelope) => void,
  onReconcile: () => Promise<void>,
  onHealthChange?: (health: ConnectionHealth) => void,
): WorkspaceSocket {
  return subscribeWorkspace(
    WORKSPACES_SNAPSHOT_SUBJECT,
    (event) => {
      if (event.type !== "workspaces-changed") return;
      onInvalidate(event);
    },
    onReconcile,
    onHealthChange,
  );
}

/** Subscribe to `files-changed` invalidations for a workspace over the shared
 *  `/ws` multiplex. `onInvalidate` fires for live events (refetch the
 *  affected snapshot); `onReconcile` fires when the client fell behind,
 *  reconnected, or returned from suspension (reload authoritative state). */
export function subscribeWorkspace(
  workspaceId: string,
  onInvalidate: (value: EventEnvelope) => void,
  onReconcile: () => Promise<void>,
  onHealthChange?: (health: ConnectionHealth) => void,
): WorkspaceSocket {
  let socket: WebSocket | undefined;
  let reconnectTimer: ReturnType<typeof setTimeout> | undefined;
  let stopped = false;
  let reconciling = false;
  let generation = 0;
  let state: WorkspaceSocketState = { sequence: 0, connected: false, snapshotRequired: false };

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
      current.send(JSON.stringify(subscribeEnvelope(workspaceId, state.sequence)));
      heartbeat.start();
    });
    current.addEventListener("message", (message) => {
      if (generation !== myGeneration) return;
      try {
        const value = JSON.parse(String(message.data));
        heartbeat.handleMessage(value);
        if (reconciling) return;
        const next = parseWorkspaceMessage(value, state, workspaceId);
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
      if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify(unsubscribeEnvelope(workspaceId)));
      socket?.close();
    },
  };
}
