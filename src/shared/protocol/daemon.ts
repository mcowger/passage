import { z } from "zod";

/** Well-known subject for the daemon channel. There is exactly one daemon
 *  per Passage instance, so -- like `WORKSPACES_SNAPSHOT_SUBJECT` -- this
 *  is a single global subject rather than a per-resource one. The channel
 *  is presence/health only: the server answers each fresh subscribe with
 *  `snapshot-required` and never emits further daemon events. */
export const DAEMON_SNAPSHOT_SUBJECT = "daemon" as const;

/** `subscribe`/`unsubscribe` payload on the `daemon` WS channel. There is
 *  only ever one subject (`DAEMON_SNAPSHOT_SUBJECT`), so unlike `pi`/
 *  `workspace` there is no subject id to carry. */
export const daemonSubscriptionPayloadSchema = z.object({
  afterSequence: z.number().int().nonnegative().safe().default(0),
}).strict();
export type DaemonSubscriptionPayload = z.infer<typeof daemonSubscriptionPayloadSchema>;
