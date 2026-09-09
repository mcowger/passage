const PROTOCOL_VERSION = 1;
const FIXED_HEADER_BYTES = 11;
const MAX_SUBJECT_BYTES = 65_535;

type SocketData = { subjectId: string };
type Socket = Bun.ServerWebSocket<SocketData>;

export type SendOutcome = "sent" | "backpressure" | "dropped";

export type BinaryFrame = {
  subjectId: string;
  sequence: number;
  payload: Uint8Array;
};

export function encodeBinaryFrame(frame: BinaryFrame): Uint8Array {
  const subject = new TextEncoder().encode(frame.subjectId);
  if (subject.byteLength > MAX_SUBJECT_BYTES) throw new Error("subject ID is too long");
  if (!Number.isSafeInteger(frame.sequence) || frame.sequence < 0) throw new Error("sequence must be a non-negative safe integer");

  const encoded = new Uint8Array(FIXED_HEADER_BYTES + subject.byteLength + frame.payload.byteLength);
  const view = new DataView(encoded.buffer);
  view.setUint8(0, PROTOCOL_VERSION);
  view.setUint16(1, subject.byteLength);
  view.setBigUint64(3, BigInt(frame.sequence));
  encoded.set(subject, FIXED_HEADER_BYTES);
  encoded.set(frame.payload, FIXED_HEADER_BYTES + subject.byteLength);
  return encoded;
}

export function decodeBinaryFrame(encoded: ArrayBuffer | Uint8Array): BinaryFrame {
  const bytes = encoded instanceof Uint8Array ? encoded : new Uint8Array(encoded);
  if (bytes.byteLength < FIXED_HEADER_BYTES) throw new Error("terminal frame is truncated");

  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (view.getUint8(0) !== PROTOCOL_VERSION) throw new Error("unsupported terminal frame version");
  const subjectLength = view.getUint16(1);
  const payloadOffset = FIXED_HEADER_BYTES + subjectLength;
  if (payloadOffset > bytes.byteLength) throw new Error("terminal frame subject is truncated");

  const sequence = Number(view.getBigUint64(3));
  if (!Number.isSafeInteger(sequence)) throw new Error("terminal frame sequence is unsafe");
  return {
    subjectId: new TextDecoder().decode(bytes.slice(FIXED_HEADER_BYTES, payloadOffset)),
    sequence,
    payload: bytes.slice(payloadOffset),
  };
}

export function classifySend(status: Bun.ServerWebSocketSendStatus): SendOutcome {
  if (status > 0) return "sent";
  return status === -1 ? "backpressure" : "dropped";
}

export function createSocketServer(port = 0) {
  const clients = new Map<string, Socket>();
  const server = Bun.serve<SocketData>({
    port,
    fetch(request, server) {
      const subjectId = new URL(request.url).searchParams.get("subject");
      if (!subjectId) return new Response("subject is required", { status: 400 });
      if (server.upgrade(request, { data: { subjectId } })) return;
      return new Response("upgrade failed", { status: 400 });
    },
    websocket: {
      open(socket) {
        clients.set(socket.data.subjectId, socket);
      },
      message() {},
      close(socket) {
        if (clients.get(socket.data.subjectId) === socket) clients.delete(socket.data.subjectId);
      },
    },
  });

  const socketFor = (subjectId: string): Socket => {
    const socket = clients.get(subjectId);
    if (!socket) throw new Error(`no WebSocket client for ${subjectId}`);
    return socket;
  };

  return {
    server,
    clients,
    sendBinary(subjectId: string, sequence: number, payload: Uint8Array): SendOutcome {
      return classifySend(socketFor(subjectId).sendBinary(encodeBinaryFrame({ subjectId, sequence, payload })));
    },
    sendControl(subjectId: string, sequence: number, value: unknown): SendOutcome {
      return classifySend(socketFor(subjectId).sendText(JSON.stringify({ subjectId, sequence, value })));
    },
  };
}
