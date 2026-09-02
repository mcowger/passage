import { z } from "zod";

export const TERMINAL_PROTOCOL_VERSION = 1;
export const FIXED_HEADER_BYTES = 11;
export const MAX_SUBJECT_BYTES = 65_535;

export type BinaryFrame = {
  subjectId: string;
  sequence: number;
  payload: Uint8Array;
};

export function encodeBinaryFrame(frame: BinaryFrame): Uint8Array {
  const subject = new TextEncoder().encode(frame.subjectId);
  if (subject.byteLength > MAX_SUBJECT_BYTES) throw new Error("subject ID is too long");
  if (!Number.isSafeInteger(frame.sequence) || frame.sequence < 0) {
    throw new Error("sequence must be a non-negative safe integer");
  }

  const encoded = new Uint8Array(FIXED_HEADER_BYTES + subject.byteLength + frame.payload.byteLength);
  const view = new DataView(encoded.buffer);
  view.setUint8(0, TERMINAL_PROTOCOL_VERSION);
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
  if (view.getUint8(0) !== TERMINAL_PROTOCOL_VERSION) {
    throw new Error("unsupported terminal frame version");
  }
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

export const clientTerminalMessageSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("input"),
    data: z.string(),
  }).strict(),
  z.object({
    type: z.literal("resize"),
    cols: z.number().int().min(10).max(500),
    rows: z.number().int().min(3).max(200),
  }).strict(),
  z.object({
    type: z.literal("lease"),
    take: z.boolean(),
  }).strict(),
  z.object({
    type: z.literal("replay_ack"),
    lastSequence: z.number().int().nonnegative(),
  }).strict(),
]);
export type ClientTerminalMessage = z.infer<typeof clientTerminalMessageSchema>;

export const serverTerminalControlSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("attached"),
    terminalId: z.string(),
    cols: z.number().int(),
    rows: z.number().int(),
    hasSizeLease: z.boolean(),
    lastSequence: z.number().int(),
  }).strict(),
  z.object({
    type: z.literal("lease_change"),
    hasSizeLease: z.boolean(),
  }).strict(),
  z.object({
    type: z.literal("resized"),
    cols: z.number().int(),
    rows: z.number().int(),
  }).strict(),
  z.object({
    type: z.literal("exit"),
    exitCode: z.number().int().nullable(),
  }).strict(),
  z.object({
    type: z.literal("error"),
    message: z.string(),
  }).strict(),
]);
export type ServerTerminalControl = z.infer<typeof serverTerminalControlSchema>;
