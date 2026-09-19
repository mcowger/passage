import type { AgentHistory, TimelineItem, UserFileRef, UserImageRef } from "../../shared/domain/agents.ts";

type UsageRecord = {
  input?: number; output?: number; cacheRead?: number; cacheWrite?: number; totalTokens?: number; cost?: { total?: number };
};

function liveUsageTokens(usage: UsageRecord | undefined): number {
  if (!usage || typeof usage !== "object") return 0;
  if (typeof usage.totalTokens === "number" && usage.totalTokens > 0) return usage.totalTokens;
  let total = 0;
  for (const key of ["input", "output", "cacheRead", "cacheWrite"] as const) {
    if (typeof usage[key] === "number" && (usage[key] as number) > 0) total += usage[key] as number;
  }
  return total;
}

/** Prefers the top-level record when it carries a positive count, otherwise
 *  falls back to the finalized per-turn usage nested in `message.usage`. */
function pickLiveUsage(top: UsageRecord | undefined, nested: UsageRecord | undefined): UsageRecord | undefined {
  if (top && liveUsageTokens(top) > 0) return top;
  return nested ?? top;
}

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

export function addOptimisticUserMessage(history: AgentHistory | undefined, text: string, images?: UserImageRef[], files?: UserFileRef[]): AgentHistory {
  const base = history ?? emptyHistory();
  return { ...base, timeline: [...base.timeline, { kind: "user", id: OPTIMISTIC_USER_ROW_ID, text, ...(images?.length ? { images } : {}), ...(files?.length ? { files } : {}) }] };
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

/** Applies the usage/context-window fields carried by live Pi events.
 *  `message_update` carries the latest cumulative usage top-level (often
 *  zero until the provider finalizes it); `message_end`/`turn_end` carry the
 *  finalized per-turn usage nested in `message.usage` with no top-level
 *  copy. Both must feed the pill or it only moves when the run settles.
 *  Never touches `timeline` -- that is `applyRowUpsert`'s job alone, so
 *  there remains exactly one path that can mutate it. */
export function applyUsageEvent(history: AgentHistory | undefined, payload: Record<string, unknown> | undefined): AgentHistory | undefined {
  if (!history || !payload) return history;
  const top = payload.usage as UsageRecord | undefined;
  const message = payload.message as Record<string, unknown> | undefined;
  const nested = (message !== null && typeof message === "object" && !Array.isArray(message) ? message.usage : undefined) as UsageRecord | undefined;
  const usage = pickLiveUsage(top, nested);
  if (!usage) return history;
  // Session cost is cumulative and never decreases: some providers report
  // zero (or no) cost while a turn is in flight and only finalize it on
  // completion, so a smaller incoming total must never clobber the last
  // known value -- otherwise the composer's cost pill blinks in and out as
  // the call moves through sending/waiting/completed states.
  const incomingCost = usage.cost?.total;
  const cost = typeof incomingCost === "number" && Number.isFinite(incomingCost)
    ? Math.max(history.usage.cost, incomingCost)
    : history.usage.cost;
  const nextUsage = {
    input: usage.input ?? history.usage.input,
    output: usage.output ?? history.usage.output,
    cacheRead: usage.cacheRead ?? history.usage.cacheRead,
    cacheWrite: usage.cacheWrite ?? history.usage.cacheWrite,
    totalTokens: usage.totalTokens ?? history.usage.totalTokens,
    cost,
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
