import { z } from "zod";

export const PREVIEW_PROTOCOL_VERSION = 1;
export const MAX_PREVIEW_FRAME_BYTES = 2 * 1024 * 1024;
export const MAX_PREVIEW_MESSAGE_BYTES = 256 * 1024;
export const MAX_PREVIEW_UPSTREAM_BYTES = 4 * 1024 * 1024;
export const MAX_PREVIEW_FPS = 120;

const frameMetadataSchema = z.object({
  deviceWidth: z.number().int().positive().max(4096),
  deviceHeight: z.number().int().positive().max(4096),
  pageScaleFactor: z.number().min(0).max(16).optional(),
  offsetTop: z.number().min(-100_000).max(100_000).optional(),
  scrollOffsetX: z.number().min(-100_000).max(100_000).optional(),
  scrollOffsetY: z.number().min(-100_000).max(100_000).optional(),
  timestamp: z.number().int().nonnegative().optional(),
});

/** Agent-browser stream message types Passage relays (allowlist, per the
 *  pinned release's `references/streaming.md`). Unknown server types are
 *  dropped at the relay boundary. Frame data is base64 JPEG; sniff bytes
 *  rather than assuming a format. */
export const previewUpstreamMessageSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("frame"),
    seq: z.number().int().nonnegative(),
    data: z.string().min(1).max(MAX_PREVIEW_UPSTREAM_BYTES),
    metadata: frameMetadataSchema,
  }),
  // status/tabs/url/console travel on the ordered channel; their payloads
  // evolve across releases, so validate the type tag and bound the message.
  z.object({ type: z.literal("status") }).catchall(z.unknown()),
  z.object({ type: z.literal("tabs") }).catchall(z.unknown()),
  z.object({ type: z.literal("url") }).catchall(z.unknown()),
  z.object({ type: z.literal("console") }).catchall(z.unknown()),
]);
export type PreviewUpstreamMessage = z.infer<typeof previewUpstreamMessageSchema>;
export type PreviewFrameMessage = Extract<PreviewUpstreamMessage, { type: "frame" }>;

/** Client-to-stream messages. Input dispatches immediately upstream and also
 *  resets the daemon idle timer, so an actively driven preview stays alive. */
export const previewDownstreamMessageSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("ack"), seq: z.number().int().nonnegative() }).strict(),
  z.object({
    type: z.literal("config"),
    maxFps: z.number().int().min(0).max(MAX_PREVIEW_FPS).optional(),
    pacing: z.enum(["push", "ack"]).optional(),
  }).strict(),
  z.object({
    type: z.literal("input_mouse"),
    eventType: z.string().min(1).max(64),
    x: z.number().min(0).max(8192),
    y: z.number().min(0).max(8192),
    button: z.string().max(16).optional(),
    clickCount: z.number().int().min(0).max(10).optional(),
    deltaX: z.number().min(-10000).max(10000).optional(),
    deltaY: z.number().min(-10000).max(10000).optional(),
  }).strict(),
  z.object({
    type: z.literal("input_keyboard"),
    eventType: z.string().min(1).max(64),
    key: z.string().max(128).optional(),
    text: z.string().max(1024).optional(),
  }).strict(),
  z.object({
    type: z.literal("input_touch"),
    eventType: z.string().min(1).max(64),
    x: z.number().min(0).max(8192).optional(),
    y: z.number().min(0).max(8192).optional(),
  }).strict(),
]);
export type PreviewDownstreamMessage = z.infer<typeof previewDownstreamMessageSchema>;

export const previewNavigateInputSchema = z.object({ url: z.string().min(1).max(2048) }).strict();
