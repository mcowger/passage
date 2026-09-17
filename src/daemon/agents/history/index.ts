import { open } from "node:fs/promises";
import { protocolPayloadSchema, type JsonValue } from "../../../shared/protocol/index.ts";
import type {
  AgentBranchEntry,
  AgentHistory,
  AgentHistoryRevision,
  AgentUsage,
  TimelineItem,
  ToolActivity,
} from "../../../shared/domain/agents.ts";

export type HistoryLimits = {
  maxBytes?: number;
  maxRecords?: number;
  maxRecordBytes?: number;
};

export type HistoryPage = {
  history: AgentHistory;
  nextBefore?: number;
};

type ObjectValue = Record<string, unknown>;
type ParsedSession = {
  header: ObjectValue;
  entries: ObjectValue[];
  malformedRecordCount: number;
  partialTail: boolean;
  invalidUtf8Count: number;
};

const DEFAULT_MAX_BYTES = 16 * 1024 * 1024;
const DEFAULT_MAX_RECORDS = 20_000;
const DEFAULT_MAX_RECORD_BYTES = 1024 * 1024;
const encoder = new TextEncoder();

function object(value: unknown): ObjectValue | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as ObjectValue
    : undefined;
}

function string(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function number(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function contentText(value: unknown): string {
  if (typeof value === "string") return value;
  if (value && typeof value === "object") {
    if (Array.isArray(value)) {
      return value.map((item) => {
        const block = object(item);
        if (block?.type === "text") return string(block.text) ?? "";
        return block?.content !== undefined ? contentText(block.content) : "";
      }).filter(Boolean).join("\n");
    }
    const rec = object(value);
    if (rec?.type === "text" && typeof rec.text === "string") return rec.text;
    if (rec?.content !== undefined) return contentText(rec.content);
  }
  return "";
}

function safeJson(value: unknown): JsonValue {
  const parsed = protocolPayloadSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

function usageFrom(value: unknown): AgentUsage {
  const usage = object(value);
  const cost = object(usage?.cost);
  return {
    input: number(usage?.input),
    output: number(usage?.output),
    cacheRead: number(usage?.cacheRead),
    cacheWrite: number(usage?.cacheWrite),
    totalTokens: number(usage?.totalTokens),
    cost: number(cost?.total),
  };
}

function addUsage(total: AgentUsage, value: unknown): void {
  const usage = usageFrom(value);
  total.input += usage.input;
  total.output += usage.output;
  total.cacheRead += usage.cacheRead;
  total.cacheWrite += usage.cacheWrite;
  total.totalTokens += usage.totalTokens || usage.input + usage.output + usage.cacheRead + usage.cacheWrite;
  total.cost += usage.cost;
}

function usageTotalTokens(value: unknown): number {
  const usage = usageFrom(value);
  return usage.totalTokens || usage.input + usage.output + usage.cacheRead + usage.cacheWrite;
}

/** True for the tombstone of a run Pi aborted in order to compact: an
 *  assistant message with an abort stop reason that a compaction entry
 *  directly parented. The abort was Pi's own doing on the compact path,
 *  not a failure the user needs an error card for -- the compaction
 *  summary row covers it. User-initiated stops ("Request was aborted")
 *  keep their gentle notice, genuine model errors are untouched, and
 *  tombstones retaining unexecuted tool calls are kept so their tool rows
 *  still resolve against the journal. */
function isCompactAbortedRun(entry: ObjectValue, compactedParents: Set<string>): boolean {
  const message = object(entry.message);
  if (string(message?.role) !== "assistant") return false;
  if (string(message?.stopReason) !== "aborted") return false;
  const error = string(message?.errorMessage);
  if (!error || error === "Request was aborted") return false;
  if (!compactedParents.has(string(entry.id) ?? "")) return false;
  const blocks = Array.isArray(message?.content) ? message.content : [];
  return !blocks.some((value) => object(value)?.type === "toolCall");
}

function activeEntryIds(entries: ObjectValue[], leafId?: string): Set<string> {
  const byId = new Map(entries.map((entry) => [string(entry.id), entry]).filter((pair): pair is [string, ObjectValue] => pair[0] !== undefined));
  const active = new Set<string>();
  let id = leafId ?? string(entries.at(-1)?.id);
  while (id && !active.has(id)) {
    const entry = byId.get(id);
    if (!entry) break;
    active.add(id);
    id = string(entry.parentId);
  }
  return active;
}

function project(entries: ObjectValue[], leafId?: string): Omit<AgentHistory, "sessionId" | "parentSession" | "revision" | "malformedRecordCount" | "partialTail" | "invalidUtf8Count" | "rewritten" | "transcriptEpoch"> {
  const activeIds = activeEntryIds(entries, leafId);
  let activeEntries = entries.filter((entry) => {
    const id = string(entry.id);
    return id !== undefined && activeIds.has(id);
  });

  // Context occupancy is the latest assistant turn's prompt-plus-output token
  // count, matching Pi's own getContextUsage() base. The cumulative `usage`
  // below grows with every turn and must never be used for the context meter.
  // Use original file order so a compaction that post-dates the last assistant
  // turn leaves occupancy unknown until a fresh response arrives.
  let contextTokens: number | null = null;
  let lastAssistantIndex = -1;
  let lastCompactionIndex = -1;
  activeEntries.forEach((entry, index) => {
    if (entry.type === "compaction") lastCompactionIndex = index;
    if (entry.type !== "message") return;
    const message = object(entry.message);
    if (string(message?.role) !== "assistant") return;
    const tokens = usageTotalTokens(message?.usage);
    if (tokens > 0) {
      contextTokens = tokens;
      lastAssistantIndex = index;
    }
  });
  if (lastAssistantIndex < lastCompactionIndex) contextTokens = null;

  const compactions = activeEntries.filter((entry) => entry.type === "compaction");
  const latestCompaction = compactions.at(-1);
  if (latestCompaction) {
    const firstKept = string(latestCompaction.firstKeptEntryId);
    const start = firstKept ? activeEntries.findIndex((entry) => entry.id === firstKept) : -1;
    if (start >= 0) activeEntries = [latestCompaction, ...activeEntries.slice(start).filter((entry) => entry !== latestCompaction)];
  }
  const timeline: TimelineItem[] = [];
  const tools = new Map<string, ToolActivity>();
  const usage: AgentUsage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: 0 };
  let unknownRecordCount = 0;
  let agentErrorCount = 0;
  let sessionName: string | undefined;
  let currentModel: { provider: string; modelId: string } | undefined;
  let currentThinkingLevel: string | undefined;

  for (const entry of activeEntries) {
    if (entry.type === "message") addUsage(usage, object(entry.message)?.usage);
    if (entry.type === "compaction" || entry.type === "branch_summary") addUsage(usage, entry.usage);
  }

  // Parents of compaction entries: Pi's compact aborts any in-flight run
  // first and appends the compaction entry directly onto the killed run's
  // tombstone message, so each victim is exactly its compaction's parent.
  const compactedParents = new Set<string>();
  for (const entry of activeEntries) {
    if (entry.type !== "compaction") continue;
    const parentId = string(entry.parentId);
    if (parentId) compactedParents.add(parentId);
  }

  for (const entry of activeEntries) {
    const entryId = string(entry.id) ?? "missing-id";
    const entryType = string(entry.type) ?? "unknown";
    if (entryType === "message") {
      // Suppress the tombstone of a run compact itself killed: the abort
      // was Pi's doing, not a failure, and the compaction summary row right
      // after it already tells the user what happened. Genuine model
      // errors, user-initiated stops ("Request was aborted"), and
      // tombstones retaining unexecuted tool calls are never suppressed.
      if (isCompactAbortedRun(entry, compactedParents)) continue;
      const message = object(entry.message);
      const role = string(message?.role);
      if (role === "toolResult") {
        const toolCallId = string(message?.toolCallId) ?? `${entryId}-tool`;
        const result = contentText(message?.content);
        const tool = tools.get(toolCallId);
        if (tool) {
          tool.result = result;
          tool.status = message?.isError === true ? "error" : "complete";
          if (tool.status === "error") tool.error = result || "Tool failed";
        } else {
          const name = string(message?.toolName) ?? "tool";
          timeline.push({
            kind: "tool",
            id: toolCallId,
            name,
            input: null,
            result,
            status: message?.isError === true ? "error" : "complete",
            ...(message?.isError === true ? { error: result || "Tool failed" } : {}),
          });
        }
        continue;
      }

      const blocks = Array.isArray(message?.content)
        ? message.content
        : [{ type: "text", text: message?.content }];
      let assistantContent = false;
      const error = role === "assistant" ? string(message?.errorMessage) : undefined;
      let errorInserted = false;
      const insertError = () => {
        if (!error || errorInserted) return;
        timeline.push({ kind: "assistant", id: `${entryId}:terminal`, text: error, error });
        errorInserted = true;
        agentErrorCount += 1;
      };
      for (const [index, value] of blocks.entries()) {
        const block = object(value);
        if (!block) continue;
        const blockId = `${entryId}:${index}`;
        if (block.type === "text" && (role === "user" || role === "assistant")) {
          timeline.push({ kind: role, id: blockId, text: string(block.text) ?? "" });
          if (role === "assistant") assistantContent = true;
        } else if (block.type === "thinking" && role === "assistant") {
          timeline.push({ kind: "thinking", id: blockId, text: string(block.thinking) ?? "" });
          assistantContent = true;
        } else if (block.type === "toolCall" && role === "assistant") {
          // Pi emits the terminal error before a retained, unexecuted tool call.
          // Keep that order when rebuilding the timeline from JSONL.
          insertError();
          const toolId = string(block.id) ?? `${entryId}:tool:${index}`;
          const name = string(block.name) ?? "tool";
          const tool: ToolActivity = {
            kind: "tool",
            id: toolId,
            name,
            input: safeJson(block.arguments),
            status: "running",
          };
          tools.set(toolId, tool);
          timeline.push(tool);
          assistantContent = true;
        }
      }
      if (role === "assistant") {
        if (error) insertError();
        else if (!assistantContent) timeline.push({ kind: "assistant", id: `${entryId}:terminal`, text: "" });
        const provider = string(message?.provider);
        const modelId = string(message?.model);
        if (provider && modelId) currentModel = { provider, modelId };
      }
      continue;
    }

    if (entryType === "compaction" || entryType === "branch_summary") {
      const summary: Extract<TimelineItem, { kind: "summary" }> = {
        kind: "summary",
        id: entryId,
        summaryType: entryType === "compaction" ? "compaction" : "branch",
        text: string(entry.summary) ?? "",
      };
      if (entryType === "compaction") {
        if (typeof entry.tokensBefore === "number" && Number.isFinite(entry.tokensBefore) && entry.tokensBefore > 0) {
          summary.tokensBefore = Math.floor(entry.tokensBefore);
        }
        const reason = string(object(entry.details)?.reason);
        if (reason !== undefined) summary.compactionReason = reason === "manual" ? "manual" : "auto";
      }
      timeline.push(summary);
    } else if (entryType === "model_change") {
      const provider = string(entry.provider);
      const modelId = string(entry.modelId);
      if (provider && modelId) currentModel = { provider, modelId };
    } else if (entryType === "thinking_level_change") {
      currentThinkingLevel = string(entry.thinkingLevel) ?? currentThinkingLevel;
    } else if (entryType === "session_info") {
      sessionName = string(entry.name) ?? sessionName;
    } else if (entryType === "custom_message") {
      if (entry.display !== false) timeline.push({ kind: "assistant", id: entryId, text: contentText(entry.content) });
    } else if (!new Set(["custom", "label"]).has(entryType)) {
      unknownRecordCount += 1;
      timeline.push({ kind: "unknown", id: entryId, entryType });
    }
  }

  const branches: AgentBranchEntry[] = entries.map((entry) => ({
    id: string(entry.id) ?? "missing-id",
    parentId: string(entry.parentId) ?? null,
    type: string(entry.type) ?? "unknown",
    ...(string(entry.timestamp) ? { timestamp: string(entry.timestamp) } : {}),
    ...(string(entry.fromId) ? { fromId: string(entry.fromId) } : {}),
    active: activeIds.has(string(entry.id) ?? ""),
  }));

  return {
    timeline,
    branches,
    usage,
    contextUsage: { tokens: contextTokens },
    unknownRecordCount,
    agentErrorCount,
    sessionName,
    currentModel,
    currentThinkingLevel,
  };
}

function parseRecords(source: string, limits: Required<HistoryLimits>): ParsedSession {
  if (encoder.encode(source).byteLength > limits.maxBytes) throw new Error("Pi JSONL exceeds byte limit");
  const lines = source.split("\n");
  const tail = lines.pop() ?? "";
  let partialTail = false;
  let malformedRecordCount = 0;
  const records: ObjectValue[] = [];

  const parseLine = (line: string, tailLine = false) => {
    const clean = line.endsWith("\r") ? line.slice(0, -1) : line;
    if (!clean.trim()) return;
    if (encoder.encode(clean).byteLength > limits.maxRecordBytes) throw new Error("Pi JSONL record exceeds byte limit");
    try {
      const record = object(JSON.parse(clean));
      if (record) records.push(record);
      else malformedRecordCount += 1;
    } catch {
      if (tailLine) partialTail = true;
      else malformedRecordCount += 1;
    }
    if (records.length > limits.maxRecords) throw new Error("Pi JSONL exceeds record limit");
  };

  for (const line of lines) parseLine(line);
  parseLine(tail, true);
  const [header, ...entries] = records;
  if (header?.type !== "session" || typeof header.id !== "string") throw new Error("Pi JSONL has no valid session header");
  return { header, entries, malformedRecordCount, partialTail, invalidUtf8Count: 0 };
}

function contentHash(bytes: Uint8Array): string {
  return new Bun.CryptoHasher("sha256").update(bytes).digest("hex");
}

export function parsePiJsonl(source: string, revision: AgentHistoryRevision, options: HistoryLimits & { leafId?: string; invalidUtf8Count?: number } = {}): AgentHistory {
  const limits = {
    maxBytes: options.maxBytes ?? DEFAULT_MAX_BYTES,
    maxRecords: options.maxRecords ?? DEFAULT_MAX_RECORDS,
    maxRecordBytes: options.maxRecordBytes ?? DEFAULT_MAX_RECORD_BYTES,
  };
  const parsed = parseRecords(source, limits);
  const inferred = options.leafId === undefined;
  const leafId = options.leafId ?? string(parsed.entries.at(-1)?.id);
  const projection = project(parsed.entries, leafId);
  return {
    sessionId: parsed.header.id as string,
    ...(leafId ? { leafId } : {}),
    ...(inferred ? { leafInferred: true } : {}),
    ...(typeof parsed.header.parentSession === "string" ? { parentSession: parsed.header.parentSession } : {}),
    revision,
    // Journal parsing has no notion of the daemon's in-memory transcript
    // epoch; callers that surface this over the wire (AgentService) stamp
    // the real value on. 0 is only observed by callers that read a raw
    // parse directly (history/fixture and their tests).
    transcriptEpoch: 0,
    ...projection,
    malformedRecordCount: parsed.malformedRecordCount,
    partialTail: parsed.partialTail,
    invalidUtf8Count: options.invalidUtf8Count ?? parsed.invalidUtf8Count,
    rewritten: false,
  };
}

export async function readPiHistory(path: string, options: HistoryLimits & { previousRevision?: AgentHistoryRevision; leafId?: string } = {}): Promise<AgentHistory> {
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;
  const file = await open(path, "r");
  try {
    const before = await file.stat();
    if (!before.isFile()) throw new Error("Pi history path is not a file");
    if (before.size > maxBytes) throw new Error("Pi JSONL exceeds byte limit");
    const bytes = new Uint8Array(before.size);
    const { bytesRead } = await file.read(bytes, 0, before.size, 0);
    const after = await file.stat();
    if (bytesRead !== before.size || after.size !== before.size || after.mtimeMs !== before.mtimeMs) {
      throw new Error("Pi JSONL changed while being read");
    }

    const fullHash = contentHash(bytes);
    const revision = { mtimeMs: after.mtimeMs, size: after.size, contentHash: fullHash };
    const decoded = new TextDecoder("utf-8").decode(bytes);
    const invalidUtf8Count = (decoded.match(/\uFFFD/g) ?? []).length;
    const history = parsePiJsonl(decoded, revision, { ...options, invalidUtf8Count });
    const previous = options.previousRevision;
    if (previous) {
      history.rewritten = previous.size > bytes.byteLength
        || contentHash(bytes.slice(0, Math.min(previous.size, bytes.byteLength))) !== previous.contentHash;
    }
    return history;
  } finally {
    await file.close();
  }
}

export function pageHistory(history: AgentHistory, before = history.timeline.length, limit = 100): HistoryPage {
  if (!Number.isSafeInteger(before) || before < 0 || before > history.timeline.length) throw new Error("Invalid history cursor");
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 500) throw new Error("Invalid history page limit");
  const start = Math.max(0, before - limit);
  return {
    history: { ...history, timeline: history.timeline.slice(start, before) },
    ...(start > 0 ? { nextBefore: start } : {}),
  };
}
