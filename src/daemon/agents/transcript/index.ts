import type { AgentHistory, AgentUsage, TimelineItem, ToolActivity, UserImageRef } from "../../../shared/domain/agents.ts";
import type { JsonValue } from "../../../shared/protocol/index.ts";

/**
 * The daemon's single authoritative projection of an agent's transcript.
 *
 * This exists to fix a class of bugs where the browser reconstructed the
 * timeline twice -- once from the live Pi event stream (ordered by arrival,
 * matched by best-effort id heuristics) and once from a full re-parse of the
 * session journal (ordered by journal position, replacing the entire array on
 * every reload/reconnect/settle). The two projections used different
 * identities and orderings, so switching between them mid-stream reordered,
 * duplicated, or remounted rows and made autoscroll fight itself.
 *
 * `TranscriptState` is now the only projector. A row's id is assigned once,
 * the first time it is seen, and its position in `rows` never changes after
 * that -- only its fields mutate in place. The browser client applies each
 * emitted row as an upsert-by-id and never reorders or replaces the array
 * wholesale, so there is exactly one path for timeline mutation regardless of
 * whether a row arrived live or was replayed after a reconnect.
 *
 * Text/thinking blocks streamed live do not have a journal id yet (the
 * journal entry does not exist until Pi flushes the message), so they get a
 * synthetic id scoped to this in-memory instance. That id is permanent for
 * the lifetime of this `TranscriptState` -- it is never reconciled against or
 * swapped for the journal's own id, which would just reintroduce an identity
 * mismatch. Tool rows use Pi's real toolCallId directly, which already
 * matches the journal's id, so they need no synthetic handling.
 */

const MAX_ROWS = 20_000;

function zeroUsage(): AgentUsage {
  return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: 0 };
}

function string(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function object(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

export type TranscriptSnapshot = {
  timeline: TimelineItem[];
  usage: AgentUsage;
  contextUsage: { tokens: number | null };
  currentModel?: { provider: string; modelId: string };
  currentThinkingLevel?: string;
  sessionName?: string;
  agentErrorCount: number;
};

let syntheticCounter = 0;
/** Process-wide counter so synthetic ids never collide across agents or across a reseeded instance. */
function nextSyntheticId(prefix: string): string {
  syntheticCounter += 1;
  return `live:${prefix}:${syntheticCounter}`;
}

export class TranscriptState {
  private rows: TimelineItem[] = [];
  private readonly positions = new Map<string, number>();
  private usage: AgentUsage = zeroUsage();
  private contextTokens: number | null = null;
  private currentModel?: { provider: string; modelId: string };
  private currentThinkingLevel?: string;
  private sessionName?: string;
  private agentErrorCount = 0;

  /** The text/thinking row currently receiving deltas, if any. */
  private openKind?: "assistant" | "thinking";
  private openRowId?: string;

  snapshot(): TranscriptSnapshot {
    return {
      timeline: this.rows.slice(),
      usage: { ...this.usage },
      contextUsage: { tokens: this.contextTokens },
      currentModel: this.currentModel,
      currentThinkingLevel: this.currentThinkingLevel,
      sessionName: this.sessionName,
      agentErrorCount: this.agentErrorCount,
    };
  }

  get rowCount(): number {
    return this.rows.length;
  }

  /** Bulk-loads a freshly parsed journal projection. Only valid on a brand
   *  new instance (cold start / daemon restart) -- never call this on an
   *  instance that has already applied live events, since journal ids do not
   *  match the synthetic ids already assigned to in-flight rows. */
  seed(history: Pick<AgentHistory, "timeline" | "usage" | "contextUsage" | "currentModel" | "currentThinkingLevel" | "sessionName" | "agentErrorCount">): void {
    this.rows = history.timeline.slice(0, MAX_ROWS);
    this.positions.clear();
    this.rows.forEach((row, index) => this.positions.set(row.id, index));
    this.usage = { ...history.usage };
    this.contextTokens = history.contextUsage?.tokens ?? null;
    this.currentModel = history.currentModel;
    this.currentThinkingLevel = history.currentThinkingLevel;
    this.sessionName = history.sessionName;
    this.agentErrorCount = history.agentErrorCount;
  }

  private upsert(row: TimelineItem): TimelineItem {
    const index = this.positions.get(row.id);
    if (index === undefined) {
      if (this.rows.length >= MAX_ROWS) return row;
      this.positions.set(row.id, this.rows.length);
      this.rows.push(row);
    } else {
      this.rows[index] = row;
    }
    return row;
  }

  private get(id: string): TimelineItem | undefined {
    const index = this.positions.get(id);
    return index === undefined ? undefined : this.rows[index];
  }

  private closeOpenBlock(): void {
    this.openKind = undefined;
    this.openRowId = undefined;
  }

  /** A user message always starts a new turn: any in-flight text/thinking
   *  block from the previous turn is closed (a late delta for it would be a
   *  protocol bug, not a continuation) and the message is appended. There is
   *  no journal id available yet (the entry does not exist until Pi writes
   *  it), so this gets a permanent synthetic id like every other live row;
   *  `refreshFromJournal` deliberately never re-syncs user rows, so this id
   *  is never at risk of colliding with or being superseded by a journal id. */
  addUserMessage(text: string, images?: UserImageRef[]): TimelineItem {
    this.closeOpenBlock();
    return this.upsert({ kind: "user", id: nextSyntheticId("user"), text, ...(images?.length ? { images } : {}) });
  }

  setModel(provider: string, modelId: string): void {
    this.currentModel = { provider, modelId };
  }

  /** Appends a daemon-level failure (crash, RPC error, permission denial) as
   *  a real chronological row instead of leaving it only as agent status. */
  appendError(text: string): TimelineItem {
    this.closeOpenBlock();
    return this.upsert({ kind: "error", id: nextSyntheticId("error"), text });
  }

  private applyUsage(payload: Record<string, unknown>): void {
    const usage = object(payload.usage) as
      | { input?: number; output?: number; cacheRead?: number; cacheWrite?: number; totalTokens?: number; cost?: { total?: number } }
      | undefined;
    if (!usage) return;
    this.usage = {
      input: usage.input ?? this.usage.input,
      output: usage.output ?? this.usage.output,
      cacheRead: usage.cacheRead ?? this.usage.cacheRead,
      cacheWrite: usage.cacheWrite ?? this.usage.cacheWrite,
      totalTokens: usage.totalTokens ?? this.usage.totalTokens,
      cost: usage.cost?.total ?? this.usage.cost,
    };
    // Streaming usage is per-message, so its total is the live context size.
    // `message_update` records may report zero until the provider finalizes
    // usage, so only a positive count may replace the last known occupancy --
    // overwriting it with zero would flicker the composer's context pill.
    const streamed = usage.totalTokens && usage.totalTokens > 0
      ? usage.totalTokens
      : (usage.input ?? 0) + (usage.output ?? 0) + (usage.cacheRead ?? 0) + (usage.cacheWrite ?? 0);
    if (streamed > 0) this.contextTokens = streamed;
  }

  private openTextRow(kind: "assistant" | "thinking"): TimelineItem {
    if (this.openKind === kind && this.openRowId) {
      const existing = this.get(this.openRowId);
      if (existing) return existing;
    }
    const id = nextSyntheticId(kind);
    this.openKind = kind;
    this.openRowId = id;
    return this.upsert({ kind, id, text: "" });
  }

  private appendDelta(kind: "assistant" | "thinking", delta: string): TimelineItem {
    const row = this.openTextRow(kind);
    return this.upsert({ ...row, kind, text: (row as { text: string }).text + delta } as TimelineItem);
  }

  private replaceFullText(kind: "assistant" | "thinking", text: string): TimelineItem {
    const row = this.openTextRow(kind);
    return this.upsert({ ...row, kind, text } as TimelineItem);
  }

  private findToolRow(toolCallId: string): TimelineItem | undefined {
    return toolCallId ? this.get(toolCallId) : undefined;
  }

  private upsertTool(toolCallId: string, patch: Partial<ToolActivity> & { name?: string }): TimelineItem | undefined {
    if (!toolCallId) return undefined;
    const existing = this.findToolRow(toolCallId);
    const base: ToolActivity = existing && existing.kind === "tool"
      ? existing
      : { kind: "tool", id: toolCallId, name: patch.name || "tool", input: null, status: "running" };
    const next: ToolActivity = {
      ...base,
      ...patch,
      name: patch.name && patch.name !== "tool" ? patch.name : base.name,
    };
    return this.upsert(next);
  }

  /** Applies one normalized daemon event (the same sanitized payload shape
   *  already sent to clients) and returns the rows that changed, in order,
   *  for the caller to emit as `row_upsert` deltas. */
  applyEvent(type: string, payload: Record<string, unknown>): TimelineItem[] {
    const changed: TimelineItem[] = [];
    const note = (row: TimelineItem | undefined) => { if (row) changed.push(row); };

    this.applyUsage(payload);

    if (type === "thinking_level_changed" && typeof payload.level === "string") {
      this.currentThinkingLevel = payload.level;
    }

    if (["error", "prompt_error", "extension_error"].includes(type)) {
      const message = string(payload.error) ?? string((object(payload.message) as { text?: unknown } | undefined)?.text) ?? "Agent error";
      this.agentErrorCount += 1;
      note(this.appendError(message));
      return changed;
    }

    const event = object(payload.assistantMessageEvent) as
      | { type?: string; delta?: string; content?: string; id?: string; toolName?: string; toolCall?: { id?: string; name?: string; arguments?: JsonValue } }
      | undefined;

    const textDelta = (event?.type === "text_delta" && typeof event.delta === "string" ? event.delta : undefined)
      ?? (typeof payload.delta === "string" ? payload.delta : undefined);
    if (textDelta) {
      note(this.appendDelta("assistant", textDelta));
      return changed;
    }

    const thinkingDelta = (event?.type === "thinking_delta" && typeof event.delta === "string" ? event.delta : undefined)
      ?? (typeof payload.thinkingDelta === "string" ? payload.thinkingDelta : undefined);
    if (thinkingDelta) {
      note(this.appendDelta("thinking", thinkingDelta));
      return changed;
    }

    const messageObj = object(payload.message) as { role?: string; content?: string | Array<{ type?: string; text?: string }> } | undefined;
    const fullTextFromMessage = typeof messageObj?.content === "string"
      ? messageObj.content
      : Array.isArray(messageObj?.content)
        ? messageObj.content.map((c) => (c && typeof c === "object" && "text" in c ? String(c.text) : "")).join("")
        : undefined;
    const fullText = (messageObj && (messageObj.role === "assistant" || !messageObj.role) ? fullTextFromMessage : undefined)
      ?? (typeof payload.text === "string" ? payload.text : undefined);
    if (fullText !== undefined && fullText.length > 0) {
      note(this.replaceFullText("assistant", fullText));
      return changed;
    }

    if (event?.type === "toolcall_start" || event?.type === "toolcall_delta" || event?.type === "toolcall_end") {
      this.closeOpenBlock();
      const toolCall = event.toolCall && typeof event.toolCall === "object" ? event.toolCall : undefined;
      const toolCallId = string(event.id ?? toolCall?.id ?? "")?.trim() ?? "";
      const toolName = string(event.toolName ?? toolCall?.name ?? "")?.trim() || "tool";
      if (!toolCallId) return changed;
      if (event.type === "toolcall_end") {
        note(this.upsertTool(toolCallId, { name: toolName, input: (toolCall?.arguments ?? {}) as JsonValue, status: "running" }));
      } else if (event.type === "toolcall_delta" && typeof event.delta === "string") {
        const existing = this.findToolRow(toolCallId);
        const rawInput = existing?.kind === "tool" && existing.input && typeof existing.input === "object" && !Array.isArray(existing.input)
          && typeof (existing.input as Record<string, unknown>).rawInput === "string"
          ? (existing.input as Record<string, unknown>).rawInput as string
          : "";
        note(this.upsertTool(toolCallId, { name: toolName, input: { rawInput: rawInput + event.delta }, status: "running" }));
      } else if (!this.findToolRow(toolCallId)) {
        note(this.upsertTool(toolCallId, { name: toolName, input: { rawInput: "" }, status: "running" }));
      }
      return changed;
    }

    if (type === "tool_call" || type === "tool_start" || type === "tool_execution_start") {
      this.closeOpenBlock();
      const toolCallId = string(payload.toolCallId ?? payload.id ?? "")?.trim() ?? "";
      const toolName = string(payload.toolName ?? payload.name ?? "")?.trim() ?? "";
      const args = (payload.args ?? payload.input ?? {}) as JsonValue;
      if (!toolCallId) return changed;
      const hasArgs = args && typeof args === "object" && !Array.isArray(args) && Object.keys(args).length > 0;
      const existing = this.findToolRow(toolCallId);
      note(this.upsertTool(toolCallId, {
        name: toolName || undefined,
        input: hasArgs ? args : existing?.kind === "tool" ? existing.input : args,
        status: "running",
      }));
      return changed;
    }

    if (type === "tool_execution_update") {
      const toolCallId = string(payload.toolCallId ?? payload.id ?? "")?.trim() ?? "";
      const result = extractResultText(payload.partialResult !== undefined ? payload.partialResult : payload.result);
      if (!toolCallId || result === undefined || !this.findToolRow(toolCallId)) return changed;
      note(this.upsertTool(toolCallId, { result }));
      return changed;
    }

    if (type === "tool_execution_end") {
      const toolCallId = string(payload.toolCallId ?? payload.id ?? "")?.trim() ?? "";
      if (!toolCallId || !this.findToolRow(toolCallId)) return changed;
      const result = extractResultText(payload.result !== undefined ? payload.result : payload.partialResult);
      const isError = Boolean(payload.isError);
      note(this.upsertTool(toolCallId, {
        status: isError ? "error" : "complete",
        ...(result !== undefined ? { result } : {}),
        ...(isError ? { error: result || "Tool failed" } : {}),
      }));
      return changed;
    }

    return changed;
  }

  /** Re-syncs tool rows from a freshly parsed journal read. Tool row ids come
   *  straight from Pi's toolCallId in both the live stream and the journal,
   *  so this is always an id-matched, idempotent refresh -- it captures the
   *  final untruncated result even if a live update was wire-truncated, and
   *  never risks duplicating a row the way reconciling text rows would.
   *  Also refreshes the metadata fields the journal is authoritative for. */
  refreshFromJournal(history: Pick<AgentHistory, "timeline" | "usage" | "contextUsage" | "currentModel" | "currentThinkingLevel" | "sessionName" | "agentErrorCount">): TimelineItem[] {
    const changed: TimelineItem[] = [];
    for (const item of history.timeline) {
      if (item.kind !== "tool") continue;
      const existing = this.get(item.id);
      if (existing && JSON.stringify(existing) === JSON.stringify(item)) continue;
      changed.push(this.upsert(item));
    }
    this.usage = { ...history.usage };
    if (history.contextUsage?.tokens != null) this.contextTokens = history.contextUsage.tokens;
    if (history.currentModel) this.currentModel = history.currentModel;
    if (history.currentThinkingLevel) this.currentThinkingLevel = history.currentThinkingLevel;
    if (history.sessionName) this.sessionName = history.sessionName;
    this.agentErrorCount = Math.max(this.agentErrorCount, history.agentErrorCount);
    return changed;
  }
}

function extractResultText(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value === "string") return value;
  if (Array.isArray(value)) {
    return value
      .map((entry) => (entry && typeof entry === "object" && "text" in entry ? String((entry as { text?: unknown }).text ?? "") : ""))
      .filter(Boolean)
      .join("\n");
  }
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    if (typeof record.text === "string") return record.text;
    if (Array.isArray(record.content)) return extractResultText(record.content);
  }
  return "";
}

const MAX_WIRE_ROW_BYTES = 32 * 1024;
const encoder = new TextEncoder();

/** Bounds a row for the WS envelope (48KB payload ceiling). The in-memory
 *  row keeps its full content regardless -- this only truncates the copy put
 *  on the wire, so a huge tool result grows in place instead of vanishing or
 *  silently dropping the row's status change. Full content is always
 *  available from the next HTTP transcript fetch. */
export function truncateRowForWire(row: TimelineItem, maxBytes = MAX_WIRE_ROW_BYTES): TimelineItem {
  if (row.kind !== "tool" || typeof row.result !== "string") return row;
  const bytes = encoder.encode(row.result);
  if (bytes.byteLength <= maxBytes) return row;
  const decoder = new TextDecoder();
  const truncated = decoder.decode(bytes.slice(0, maxBytes));
  return { ...row, result: `${truncated}\n\n[truncated for live view -- reload to see the full output]` };
}
