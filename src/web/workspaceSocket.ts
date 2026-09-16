import {
  PROTOCOL_VERSION,
  commandEnvelopeSchema,
  eventEnvelopeSchema,
  snapshotRequiredSchema,
  type EventEnvelope,
} from "../shared/protocol/index.ts";

const RECONNECT_DELAY_MS = 800;

function generateRequestId(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  if (typeof crypto !== "undefined" && typeof crypto.getRandomValues === "function") {
    const bytes = new Uint8Array(16);
    crypto.getRandomValues(bytes);
    bytes[6] = (bytes[6] & 0x0f) | 0x40;
    bytes[8] = (bytes[8] & 0x3f) | 0x80;
    const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
  }
  return "req_" + Date.now().toString(36) + "_" + Math.random().toString(36).slice(2, 10);
}

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

/** Subscribe to `files-changed` invalidations for a workspace over the shared
 *  `/ws` multiplex. `onInvalidate` fires for live events (refetch the
 *  affected snapshot); `onReconcile` fires when the client fell behind,
 *  reconnected, or returned from suspension (reload authoritative state). */
export function subscribeWorkspace(
  workspaceId: string,
  onInvalidate: (value: EventEnvelope) => void,
  onReconcile: () => Promise<void>,
): WorkspaceSocket {
  let socket: WebSocket | undefined;
  let reconnectTimer: ReturnType<typeof setTimeout> | undefined;
  let stopped = false;
  let reconciling = false;
  let state: WorkspaceSocketState = { sequence: 0, connected: false, snapshotRequired: false };

  const scheduleReconnect = () => {
    if (stopped || reconnectTimer) return;
    reconnectTimer = setTimeout(() => {
      reconnectTimer = undefined;
      connect();
    }, RECONNECT_DELAY_MS);
  };

  const connect = () => {
    if (stopped || socket?.readyState === WebSocket.OPEN || socket?.readyState === WebSocket.CONNECTING) return;
    socket = new WebSocket(`${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/ws`);
    socket.addEventListener("open", () => {
      state = { ...state, connected: true, snapshotRequired: false };
      socket?.send(JSON.stringify(subscribeEnvelope(workspaceId, state.sequence)));
    });
    socket.addEventListener("message", (message) => {
      try {
        const value = JSON.parse(String(message.data));
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
    socket.addEventListener("close", () => {
      state = { ...state, connected: false };
      socket = undefined;
      if (!stopped) {
        void onReconcile().catch(() => undefined);
        scheduleReconnect();
      }
    });
  };

  const reconnectFromBrowserState = () => {
    if (document.visibilityState === "visible" && navigator.onLine) {
      void onReconcile().catch(() => undefined);
      if (!socket || socket.readyState === WebSocket.CLOSED) connect();
    }
  };

  window.addEventListener("online", reconnectFromBrowserState);
  document.addEventListener("visibilitychange", reconnectFromBrowserState);
  connect();

  return {
    close() {
      stopped = true;
      if (reconnectTimer) clearTimeout(reconnectTimer);
      window.removeEventListener("online", reconnectFromBrowserState);
      document.removeEventListener("visibilitychange", reconnectFromBrowserState);
      if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify(unsubscribeEnvelope(workspaceId)));
      socket?.close();
    },
  };
}
