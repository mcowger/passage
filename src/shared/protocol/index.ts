import { z } from "zod";

export const PROTOCOL_VERSION = 1 as const;
export const MAX_OPAQUE_ID_LENGTH = 256;
export const MAX_SNAPSHOT_METADATA_ENTRIES = 32;
export const MAX_SNAPSHOT_METADATA_KEY_LENGTH = 128;
export const MAX_SNAPSHOT_METADATA_VALUE_LENGTH = 512;
export const MAX_PROTOCOL_PAYLOAD_BYTES = 48 * 1024;
export const MAX_PROTOCOL_PAYLOAD_DEPTH = 32;
export const MAX_PROTOCOL_PAYLOAD_NODES = 4096;

export type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };

function isBoundedJsonValue(value: unknown): value is JsonValue {
  const stack: Array<{ value: unknown; depth: number }> = [{ value, depth: 0 }];
  const objects = new WeakSet<object>();
  let nodes = 0;
  while (stack.length > 0) {
    const current = stack.pop()!;
    nodes += 1;
    if (nodes > MAX_PROTOCOL_PAYLOAD_NODES || current.depth > MAX_PROTOCOL_PAYLOAD_DEPTH) return false;
    if (current.value === null || typeof current.value === "string" || typeof current.value === "boolean") continue;
    if (typeof current.value === "number") {
      if (!Number.isFinite(current.value)) return false;
      continue;
    }
    if (typeof current.value !== "object" || objects.has(current.value)) return false;
    objects.add(current.value);
    if (Array.isArray(current.value)) {
      for (const item of current.value) stack.push({ value: item, depth: current.depth + 1 });
      continue;
    }
    const prototype = Object.getPrototypeOf(current.value);
    if (prototype !== Object.prototype && prototype !== null) return false;
    for (const item of Object.values(current.value)) stack.push({ value: item, depth: current.depth + 1 });
  }
  return new TextEncoder().encode(JSON.stringify(value)).byteLength <= MAX_PROTOCOL_PAYLOAD_BYTES;
}

export const channelSchema = z.enum(["pi", "workspace", "terminal", "daemon"]);
export const streamSchema = channelSchema;
export const opaqueIdSchema = z.string().min(1).max(MAX_OPAQUE_ID_LENGTH);
export const protocolPayloadSchema = z.custom<JsonValue>(isBoundedJsonValue, "Payload must be bounded JSON data");
const boundedMetadata = z.record(z.string().max(MAX_SNAPSHOT_METADATA_KEY_LENGTH), z.string().max(MAX_SNAPSHOT_METADATA_VALUE_LENGTH)).refine(
  (value) => Object.keys(value).length <= MAX_SNAPSHOT_METADATA_ENTRIES,
);

export const commandEnvelopeSchema = z.object({
  version: z.literal(PROTOCOL_VERSION), requestId: opaqueIdSchema,
  channel: channelSchema, type: z.string().min(1).max(128), payload: protocolPayloadSchema,
}).strict();
export const eventEnvelopeSchema = z.object({
  version: z.literal(PROTOCOL_VERSION), stream: streamSchema, subjectId: opaqueIdSchema,
  sequence: z.number().int().positive().safe(), type: z.string().min(1).max(128), payload: protocolPayloadSchema,
}).strict();

export const acknowledgementSchema = z.object({
  version: z.literal(PROTOCOL_VERSION), requestId: opaqueIdSchema, ok: z.literal(true),
}).strict();
export const protocolErrorSchema = z.object({
  version: z.literal(PROTOCOL_VERSION), requestId: opaqueIdSchema, ok: z.literal(false),
  error: z.object({ code: z.string().min(1).max(128), message: z.string().min(1).max(1024) }).strict(),
}).strict();
export const snapshotRequiredSchema = z.object({
  version: z.literal(PROTOCOL_VERSION), stream: streamSchema, subjectId: opaqueIdSchema,
  kind: z.literal("snapshot-required"), metadata: boundedMetadata,
}).strict();
export const snapshotMetadataSchema = boundedMetadata;
export const responseSchema = z.union([acknowledgementSchema, protocolErrorSchema, snapshotRequiredSchema]);

export type Channel = z.infer<typeof channelSchema>;
export type Stream = z.infer<typeof streamSchema>;
export type OpaqueId = z.infer<typeof opaqueIdSchema>;
export type CommandEnvelope = z.infer<typeof commandEnvelopeSchema>;
export type EventEnvelope = z.infer<typeof eventEnvelopeSchema>;
export type Acknowledgement = z.infer<typeof acknowledgementSchema>;
export type ProtocolError = z.infer<typeof protocolErrorSchema>;
export type SnapshotRequired = z.infer<typeof snapshotRequiredSchema>;
export type SnapshotMetadata = z.infer<typeof snapshotMetadataSchema>;
export type Response = z.infer<typeof responseSchema>;

export const passageCommandSchema = commandEnvelopeSchema;
export const passageEventSchema = eventEnvelopeSchema;
export type PassageCommandEnvelope = CommandEnvelope;
export type PassageEventEnvelope = EventEnvelope;

export * from "./agents.ts";
export * from "./terminals.ts";
export * from "./workspace.ts";
export * from "./previews.ts";
