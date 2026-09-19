import {
  decodeBinaryFrame,
  serverTerminalControlSchema,
  type ServerTerminalControl,
} from "../shared/protocol/terminals.ts";

function generateClientId(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    try {
      return `client_${crypto.randomUUID()}`;
    } catch {}
  }
  return `client_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`;
}

export type TerminalSocketCallbacks = {
  onData: (data: Uint8Array) => void;
  onControl: (control: ServerTerminalControl) => void;
  onOpen?: () => void;
  onClose?: () => void;
  onError?: (err: Event) => void;
};

export type TerminalSocket = {
  clientId: string;
  sendInput: (data: string) => void;
  sendResize: (cols: number, rows: number) => void;
  takeLease: () => void;
  close: () => void;
};

export function connectTerminalSocket(
  terminalId: string,
  callbacks: TerminalSocketCallbacks,
): TerminalSocket {
  const clientId = generateClientId();
  const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
  const url = `${protocol}//${window.location.host}/api/terminals/${encodeURIComponent(terminalId)}/ws?clientId=${encodeURIComponent(clientId)}`;

  let ws: WebSocket | null = new WebSocket(url);
  ws.binaryType = "arraybuffer";
  let isClosed = false;
  let isOpen = false;
  // Messages sent before the socket opens (notably the first fit-driven
  // resize) would otherwise be silently dropped, leaving the PTY at its
  // creation default regardless of the actual pane size. Queue them and
  // flush on open. Only the latest resize matters, so coalesce those.
  const pending: string[] = [];
  let pendingResize: string | null = null;

  function sendText(text: string, isResize = false) {
    if (ws && isOpen && ws.readyState === WebSocket.OPEN) {
      ws.send(text);
      return;
    }
    if (isClosed) return;
    if (isResize) {
      pendingResize = text;
    } else {
      pending.push(text);
    }
  }

  function flushPending() {
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    // Size first so any queued input is processed at the right dimensions.
    if (pendingResize) {
      const text = pendingResize;
      pendingResize = null;
      try {
        ws.send(text);
      } catch {}
    }
    for (const text of pending.splice(0)) {
      try {
        ws.send(text);
      } catch {}
    }
  }

  ws.onopen = () => {
    if (isClosed) {
      ws?.close();
      return;
    }
    isOpen = true;
    flushPending();
    callbacks.onOpen?.();
  };

  ws.onmessage = (event) => {
    if (event.data instanceof ArrayBuffer) {
      try {
        const frame = decodeBinaryFrame(event.data);
        callbacks.onData(frame.payload);
      } catch (err) {
        console.error("Failed to decode terminal binary frame", err);
      }
    } else if (typeof event.data === "string") {
      try {
        const parsed = serverTerminalControlSchema.safeParse(JSON.parse(event.data));
        if (parsed.success) {
          callbacks.onControl(parsed.data);
        }
      } catch (err) {
        console.error("Failed to parse terminal control frame", err);
      }
    }
  };

  ws.onclose = () => {
    if (!isClosed) callbacks.onClose?.();
  };

  ws.onerror = (event) => {
    callbacks.onError?.(event);
  };

  return {
    clientId,
    sendInput(data: string) {
      sendText(JSON.stringify({ type: "input", data }));
    },
    sendResize(cols: number, rows: number) {
      sendText(JSON.stringify({ type: "resize", cols, rows }), true);
    },
    takeLease() {
      sendText(JSON.stringify({ type: "lease", take: true }));
    },
    close() {
      isClosed = true;
      if (ws) {
        try {
          ws.close();
        } catch {}
        ws = null;
      }
    },
  };
}
