import { agentStatusSchema, type AgentStatus } from "../shared/domain/agents.ts";
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
): AgentSocket {
  let socket: WebSocket | undefined;
  let reconnectTimer: ReturnType<typeof setTimeout> | undefined;
  let stopped = false;
  let reconciling = false;
  let state: AgentSocketState = { sequence: 0, connected: false, snapshotRequired: false };

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
      socket?.send(JSON.stringify(subscribeEnvelope(agentId, state.sequence)));
    });
    socket.addEventListener("message", (message) => {
      try {
        const value = JSON.parse(String(message.data));
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
      if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify(unsubscribeEnvelope(agentId)));
      socket?.close();
    },
  };
}
