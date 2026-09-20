import { z } from "zod";

/**
 * Flight-recorder diagnostic events (blank-screen forensics).
 *
 * The browser streams compact periodic snapshots plus page-lifecycle events
 * to the daemon over a dedicated same-origin HTTP endpoint, independent of
 * the app's agent/WebSocket lifecycle. Payloads carry numeric/boolean
 * counters and small enum strings only -- never transcript text, prompts,
 * tool output, credentials, raw error payloads, DOM HTML, screenshots, or
 * application-state dumps.
 *
 * What this deliberately does NOT report: actual browser RAM, WebKit
 * process memory, GPU memory, or CPU percentage. Safari does not expose
 * those reliably to page JavaScript, so any such field would be fiction.
 */

export const diagnosticKindSchema = z.enum(["page_started", "snapshot", "lifecycle"]);

/** One scalar metric value: numbers, booleans, and short enum strings. */
const metricValueSchema = z.union([z.number(), z.boolean(), z.string().max(256), z.null()]);

/** Compact structured metrics. Bounded key/value counts keep any single
 *  event small; the daemon's request-size limit is the hard backstop. */
const metricsSchema = z.record(z.string().min(1).max(64), metricValueSchema);

export const diagnosticEventSchema = z.object({
  /** Random id minted once per document instance (shared with root-error diagnostics). */
  pageInstanceId: z.string().min(1).max(128),
  /** Monotonically increasing per page instance; lets offline analysis spot gaps. */
  seq: z.number().int().nonnegative(),
  /** Client wall-clock ms (Date.now()) when the event was captured. */
  clientTsMs: z.number().int().positive(),
  kind: diagnosticKindSchema,
  /** Remaining numeric/boolean/enum metrics (bounded; see metricsSchema). */
  payload: metricsSchema.optional(),
}).strict();

export type DiagnosticEvent = z.infer<typeof diagnosticEventSchema>;
export type DiagnosticKind = z.infer<typeof diagnosticKindSchema>;

/** One POST carries a single event or a small batch drained from the
 *  browser's bounded pending queue. */
export const diagnosticBatchSchema = z.object({
  events: z.array(diagnosticEventSchema).min(1).max(8),
}).strict();

export type DiagnosticBatch = z.infer<typeof diagnosticBatchSchema>;
