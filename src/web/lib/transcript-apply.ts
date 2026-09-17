import type { AgentHistory, TimelineItem, UserImageRef } from "../../shared/domain/agents.ts";

const emptyHistory = (): AgentHistory => ({
  sessionId: "",
  revision: { mtimeMs: Date.now(), size: 0, contentHash: "" },
  transcriptEpoch: 0,
  timeline: [],
  branches: [],
  usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: 0 },
  contextUsage: { tokens: null },
  unknownRecordCount: 0,
  agentErrorCount: 0,
  malformedRecordCount: 0,
  partialTail: false,
  invalidUtf8Count: 0,
  rewritten: false,
});

/** The client's optimistic pre-echo of a just-submitted message. It always
 *  occupies this one fixed slot (never a timestamp-based id) so it can be
 *  cleanly dropped the moment the daemon's real `row_upsert` for that message
 *  arrives, instead of lingering as a permanent duplicate. */
export const OPTIMISTIC_USER_ROW_ID = "optimistic-pending";

export function addOptimisticUserMessage(history: AgentHistory | undefined, text: string, images?: UserImageRef[]): AgentHistory {
  const base = history ?? emptyHistory();
  return { ...base, timeline: [...base.timeline, { kind: "user", id: OPTIMISTIC_USER_ROW_ID, text, ...(images?.length ? { images } : {}) }] };
}

/**
 * Applies one `row_upsert` delta: replace the row in place if its id is
 * already rendered, otherwise append it. The daemon guarantees a row's id and
 * position are assigned once and never reused for a different row, so this
 * can never reorder or duplicate -- unlike the two-projector reducer this
 * replaces, there are no id-matching heuristics here to get wrong.
 */
export function applyRowUpsert(history: AgentHistory | undefined, row: TimelineItem): AgentHistory {
  const base = history ?? emptyHistory();
  const timeline = row.kind === "user" && row.id !== OPTIMISTIC_USER_ROW_ID
    ? base.timeline.filter((item) => item.id !== OPTIMISTIC_USER_ROW_ID)
    : base.timeline;
  const index = timeline.findIndex((item) => item.id === row.id);
  const next = index < 0 ? [...timeline, row] : timeline.map((item, i) => (i === index ? row : item));
  return { ...base, timeline: next };
}

/** Applies the usage/context-window fields carried by non-`row_upsert`
 *  passthrough events (e.g. raw message_update events also used for the live
 *  token/sec readout). Never touches `timeline` -- that is `applyRowUpsert`'s
 *  job alone, so there remains exactly one path that can mutate it. */
export function applyUsageEvent(history: AgentHistory | undefined, payload: Record<string, unknown> | undefined): AgentHistory | undefined {
  if (!history || !payload) return history;
  const usage = payload.usage as
    | { input?: number; output?: number; cacheRead?: number; cacheWrite?: number; totalTokens?: number; cost?: { total?: number } }
    | undefined;
  if (!usage) return history;
  const nextUsage = {
    input: usage.input ?? history.usage.input,
    output: usage.output ?? history.usage.output,
    cacheRead: usage.cacheRead ?? history.usage.cacheRead,
    cacheWrite: usage.cacheWrite ?? history.usage.cacheWrite,
    totalTokens: usage.totalTokens ?? history.usage.totalTokens,
    cost: usage.cost?.total ?? history.usage.cost,
  };
  // Streaming usage is per-message, so its total is the live context size.
  // `message_update` records may report zero until the provider finalizes
  // usage, so only a positive count may replace the last known context
  // occupancy -- overwriting it with zero would flicker the composer's
  // context pill on every response.
  const streamed = usage.totalTokens && usage.totalTokens > 0
    ? usage.totalTokens
    : (usage.input ?? 0) + (usage.output ?? 0) + (usage.cacheRead ?? 0) + (usage.cacheWrite ?? 0);
  return {
    ...history,
    usage: nextUsage,
    contextUsage: streamed > 0 ? { tokens: streamed } : history.contextUsage,
  };
}
