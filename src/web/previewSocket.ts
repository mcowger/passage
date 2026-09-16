import {
  previewDownstreamMessageSchema,
  previewUpstreamMessageSchema,
  type PreviewDownstreamMessage,
  type PreviewUpstreamMessage,
} from "../shared/protocol/previews.ts";

function generateClientId(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    try {
      return `client_${crypto.randomUUID()}`;
    } catch {}
  }
  return `client_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`;
}

export type PreviewSocketCallbacks = {
  onMessage: (message: PreviewUpstreamMessage) => void;
  onErrorMessage: (message: string) => void;
  onOpen?: () => void;
  /** Called when the socket closes. Receives true when the client should reconnect. */
  onClose?: (reconnect: boolean) => void;
};

export type PreviewSocket = {
  clientId: string;
  send: (message: PreviewDownstreamMessage) => void;
  ack: (seq: number) => void;
  close: () => void;
};

/** Connect to the bounded preview relay. Frames are live-only: after a
 *  reconnect the upstream sends the newest frame, so callers reconcile
 *  navigation state through the HTTP snapshot instead of replaying. */
export function connectPreviewSocket(
  previewId: string,
  callbacks: PreviewSocketCallbacks,
): PreviewSocket {
  const clientId = generateClientId();
  const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
  const url = `${protocol}//${window.location.host}/api/previews/${encodeURIComponent(previewId)}/ws?clientId=${encodeURIComponent(clientId)}`;

  let ws: WebSocket | null = new WebSocket(url);
  let closedByClient = false;

  ws.onopen = () => {
    if (closedByClient) {
      ws?.close();
      return;
    }
    // Ask for ack pacing so a stalled client never builds a stale backlog.
    ws?.send(JSON.stringify({ type: "config", pacing: "ack", maxFps: 15 }));
    callbacks.onOpen?.();
  };

  ws.onmessage = (event) => {
    if (typeof event.data !== "string") return;
    let value: unknown;
    try {
      value = JSON.parse(event.data);
    } catch {
      return;
    }
    if (
      typeof value === "object" && value !== null && "type" in value &&
      (value as { type: unknown }).type === "error"
    ) {
      const message = (value as { message?: unknown }).message;
      callbacks.onErrorMessage(typeof message === "string" ? message : "Preview stream error");
      return;
    }
    const parsed = previewUpstreamMessageSchema.safeParse(value);
    if (parsed.success) callbacks.onMessage(parsed.data);
  };

  ws.onclose = () => {
    if (!closedByClient) callbacks.onClose?.(true);
  };

  return {
    clientId,
    send(message: PreviewDownstreamMessage) {
      const parsed = previewDownstreamMessageSchema.safeParse(message);
      if (!parsed.success) return;
      if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(parsed.data));
    },
    ack(seq: number) {
      if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: "ack", seq }));
    },
    close() {
      closedByClient = true;
      if (ws) {
        try {
          ws.close();
        } catch {}
        ws = null;
      }
    },
  };
}
