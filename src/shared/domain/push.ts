import { z } from "zod";

/** Web Push subscription as sent by the browser (Push API). Endpoint is the
 *  push service URL (e.g. https://web.push.apple.com/...). Keys are
 *  base64url-encoded per the Push API. */
export const pushSubscriptionSchema = z.object({
  endpoint: z.string().url().max(2048),
  keys: z.object({
    p256dh: z.string().min(1).max(256),
    auth: z.string().min(1).max(256),
  }).strict(),
  label: z.string().trim().min(1).max(128).optional(),
}).strict();
export type PushSubscription = z.infer<typeof pushSubscriptionSchema>;

/** Stored row adds server-side metadata. */
export const storedPushSubscriptionSchema = pushSubscriptionSchema.extend({
  createdAt: z.string().min(1),
  userAgent: z.string().max(512).optional(),
});
export type StoredPushSubscription = z.infer<typeof storedPushSubscriptionSchema>;

/** Payload the daemon sends through the push service. Must stay small
 *  (<4KB) and visible: Apple requires every push to surface a notification.
 *  `url` is opened/focused on tap for deep-linking to the agent. */
export const pushPayloadSchema = z.object({
  title: z.string().min(1).max(128),
  body: z.string().min(1).max(512),
  tag: z.string().max(128).optional(),
  url: z.string().max(2048).optional(),
  workspaceId: z.string().max(128).optional(),
  agentId: z.string().max(128).optional(),
}).strict();
export type PushPayload = z.infer<typeof pushPayloadSchema>;
