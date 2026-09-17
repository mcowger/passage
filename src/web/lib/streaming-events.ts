import type { AgentHistory, TimelineItem, ToolActivity } from "../../shared/domain/agents.ts";
import type { JsonValue } from "../../shared/protocol/index.ts";
import { extractToolResultText } from "./tool-display.ts";

export function applyStreamEvent(
  prev: AgentHistory | undefined,
  envelope: unknown
): AgentHistory | undefined {
  if (!envelope || typeof envelope !== "object") return prev;
  const { type, payload } = envelope as { type?: string; payload?: Record<string, unknown> };
  if (!type || !payload) return prev;

  let base: AgentHistory = prev
    ? { ...prev, timeline: [...prev.timeline] }
    : {
        sessionId: "",
        revision: { mtimeMs: Date.now(), size: 0, contentHash: "" },
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
      };

  const usage = payload.usage as
    | {
        input?: number;
        output?: number;
        cacheRead?: number;
        cacheWrite?: number;
        totalTokens?: number;
        cost?: { total?: number };
      }
    | undefined;

  const nextUsage = usage
    ? {
        input: usage.input ?? base.usage.input,
        output: usage.output ?? base.usage.output,
        cacheRead: usage.cacheRead ?? base.usage.cacheRead,
        cacheWrite: usage.cacheWrite ?? base.usage.cacheWrite,
        totalTokens: usage.totalTokens ?? base.usage.totalTokens,
        cost: usage.cost?.total ?? base.usage.cost,
      }
    : base.usage;

  // Streaming usage is per-message, so its total is the live context size. Pi's
  // `message_update` records may report zero until the provider finalizes usage,
  // so only a positive count may replace the last known context occupancy.
  // Overwriting it with zero would flicker/unmount the composer context pill on
  // every response.
  const streamedContextTokens = usage
    ? usage.totalTokens && usage.totalTokens > 0
      ? usage.totalTokens
      : (usage.input ?? 0) + (usage.output ?? 0) + (usage.cacheRead ?? 0) + (usage.cacheWrite ?? 0)
    : 0;
  base = {
    ...base,
    usage: nextUsage,
    contextUsage: streamedContextTokens > 0 ? { tokens: streamedContextTokens } : base.contextUsage,
  };

  const event = payload.assistantMessageEvent as
    | {
        type?: string;
        delta?: string;
        content?: string;
        id?: string;
        toolName?: string;
        toolCall?: { id?: string; name?: string; arguments?: JsonValue };
      }
    | undefined;

  const delta =
    (event?.type === "text_delta" && typeof event.delta === "string" ? event.delta : undefined) ??
    (typeof payload.delta === "string" ? payload.delta : undefined);

  if (delta) {
    const timeline = [...base.timeline];
    let found = false;
    for (let index = timeline.length - 1; index >= 0; index -= 1) {
      const item = timeline[index];
      if (item && item.kind === "user") break;
      if (item && item.kind === "assistant") {
        timeline[index] = { ...item, text: item.text + delta };
        found = true;
        break;
      }
    }
    if (!found) {
      timeline.push({ kind: "assistant", id: `assistant-${Date.now()}`, text: delta });
    }
    return { ...base, timeline, usage: nextUsage };
  }

  const thinkingDelta =
    (event?.type === "thinking_delta" && typeof event.delta === "string" ? event.delta : undefined) ??
    (typeof payload.thinkingDelta === "string" ? payload.thinkingDelta : undefined);

  if (thinkingDelta) {
    const timeline = [...base.timeline];
    const index = timeline.length - 1;
    if (timeline[index]?.kind === "thinking") {
      const item = timeline[index] as { kind: "thinking"; id: string; text: string; lazy?: boolean; error?: string };
      timeline[index] = { ...item, text: item.text + thinkingDelta };
    } else {
      timeline.push({ kind: "thinking", id: `thinking-${Date.now()}`, text: thinkingDelta });
    }
    return { ...base, timeline, usage: nextUsage };
  }

  // Full assistant message update (or full text from payload.text)
  const messageObj = payload.message as
    | { role?: string; content?: string | Array<{ type?: string; text?: string }> }
    | undefined;
  const fullTextFromMsg =
    typeof messageObj?.content === "string"
      ? messageObj.content
      : Array.isArray(messageObj?.content)
      ? messageObj.content
          .map((c) => (c && typeof c === "object" && "text" in c ? String(c.text) : ""))
          .join("")
      : undefined;

  const fullText =
    (messageObj && (messageObj.role === "assistant" || !messageObj.role) ? fullTextFromMsg : undefined) ??
    (typeof payload.text === "string" ? payload.text : undefined);

  if (fullText !== undefined && fullText.length > 0) {
    const timeline = [...base.timeline];
    let found = false;
    for (let index = timeline.length - 1; index >= 0; index -= 1) {
      const item = timeline[index];
      if (item && item.kind === "user") break;
      if (item && item.kind === "assistant") {
        timeline[index] = { ...item, text: fullText };
        found = true;
        break;
      }
    }
    if (!found) {
      timeline.push({ kind: "assistant", id: `assistant-${Date.now()}`, text: fullText });
    }
    return { ...base, timeline, usage: nextUsage };
  }

  // Tool call events from assistant message stream
  if (
    event?.type === "toolcall_start" ||
    event?.type === "toolcall_delta" ||
    event?.type === "toolcall_end"
  ) {
    const toolCall = event.toolCall && typeof event.toolCall === "object" ? event.toolCall : undefined;
    const toolCallId = String(event.id ?? toolCall?.id ?? "").trim();
    const toolName = String(event.toolName ?? toolCall?.name ?? "").trim() || "tool";
    const timeline = [...base.timeline];

    let existingIndex = -1;
    if (toolCallId) {
      existingIndex = timeline.findIndex((item) => item.kind === "tool" && item.id === toolCallId);
    }
    if (existingIndex < 0) {
      // Check if the last item is a running tool in this turn
      const last = timeline.at(-1);
      if (last?.kind === "tool" && last.status === "running") {
        existingIndex = timeline.length - 1;
      }
    }

    const resolvedId = toolCallId || (existingIndex >= 0 ? timeline[existingIndex].id : `tool-${Date.now()}`);

    if (event.type === "toolcall_end") {
      const input = (toolCall?.arguments ?? {}) as JsonValue;
      if (existingIndex >= 0) {
        const current = timeline[existingIndex];
        if (current?.kind === "tool") {
          timeline[existingIndex] = {
            ...current,
            id: resolvedId,
            name: toolName !== "tool" ? toolName : current.name,
            input,
            status: "running",
          };
        }
      } else {
        timeline.push({
          kind: "tool",
          id: resolvedId,
          name: toolName,
          input,
          status: "running",
          significant: true,
        });
      }
    } else if (event.type === "toolcall_delta" && typeof event.delta === "string") {
      const current = existingIndex >= 0 ? timeline[existingIndex] : undefined;
      const rawInput =
        current?.kind === "tool" &&
        current.input &&
        typeof current.input === "object" &&
        !Array.isArray(current.input) &&
        typeof current.input.rawInput === "string"
          ? current.input.rawInput
          : "";

      const nextTool: ToolActivity = {
        kind: "tool",
        id: resolvedId,
        name: current?.kind === "tool" && current.name !== "tool" ? current.name : toolName,
        input: { rawInput: rawInput + event.delta },
        status: "running",
        significant: true,
      };
      if (existingIndex >= 0) timeline[existingIndex] = nextTool;
      else timeline.push(nextTool);
    } else if (existingIndex < 0) {
      timeline.push({
        kind: "tool",
        id: resolvedId,
        name: toolName,
        input: { rawInput: "" },
        status: "running",
        significant: true,
      });
    }
    return { ...base, timeline, usage: nextUsage };
  }

  // Tool execution start event from daemon/Pi
  if (type === "tool_call" || type === "tool_start" || type === "tool_execution_start") {
    const rawToolCallId = String(payload.toolCallId ?? payload.id ?? "").trim();
    const rawToolName = String(payload.toolName ?? payload.name ?? "").trim();
    const args = (payload.args ?? payload.input ?? {}) as JsonValue;
    const timeline = [...base.timeline];

    let existingIndex = -1;
    if (rawToolCallId) {
      existingIndex = timeline.findIndex((item) => item.kind === "tool" && item.id === rawToolCallId);
    }
    if (existingIndex < 0) {
      for (let i = timeline.length - 1; i >= 0; i--) {
        const item = timeline[i];
        if (item.kind === "user") break;
        if (item.kind === "tool" && item.status === "running") {
          existingIndex = i;
          break;
        }
      }
    }

    if (existingIndex >= 0) {
      const current = timeline[existingIndex] as ToolActivity;
      timeline[existingIndex] = {
        ...current,
        id: rawToolCallId || current.id,
        name: rawToolName && rawToolName !== "tool" ? rawToolName : current.name,
        input: Object.keys(args as object).length > 0 ? args : current.input,
        status: "running",
      };
    } else {
      timeline.push({
        kind: "tool",
        id: rawToolCallId || `tool-${Date.now()}`,
        name: rawToolName || "tool",
        input: args,
        status: "running",
        significant: true,
      });
    }
    return { ...base, timeline, usage: nextUsage };
  }

  // Tool execution progress (streaming output)
  if (type === "tool_execution_update") {
    const rawToolCallId = String(payload.toolCallId ?? payload.id ?? "").trim();
    const rawResult = payload.partialResult !== undefined ? payload.partialResult : payload.result;
    const result = extractToolResultText(rawResult);

    if (result !== undefined) {
      let updated = false;
      const timeline = base.timeline.map((item) => {
        if (item.kind === "tool" && (item.id === rawToolCallId || (!rawToolCallId && item.status === "running"))) {
          updated = true;
          return { ...item, result };
        }
        return item;
      });

      if (!updated && base.timeline.length > 0) {
        for (let i = timeline.length - 1; i >= 0; i--) {
          const item = timeline[i];
          if (item.kind === "tool" && item.status === "running") {
            timeline[i] = { ...item, result };
            break;
          }
        }
      }

      return { ...base, timeline, usage: nextUsage };
    }
    return { ...base, usage: nextUsage };
  }

  if (type === "tool_execution_end") {
    const toolCallId = String(payload.toolCallId ?? payload.id ?? "").trim();
    const rawResult = payload.result !== undefined ? payload.result : payload.partialResult;
    const result = extractToolResultText(rawResult);
    const isError = Boolean(payload.isError);

    let updated = false;
    const timeline = base.timeline.map((item) => {
      if (item.kind === "tool" && (item.id === toolCallId || (!toolCallId && item.status === "running"))) {
        updated = true;
        return {
          ...item,
          status: (isError ? "error" : "complete") as "error" | "complete",
          ...(result !== undefined ? { result } : {}),
          ...(isError ? { error: result || "Tool failed" } : {}),
        };
      }
      return item;
    });

    if (!updated && base.timeline.length > 0) {
      for (let i = timeline.length - 1; i >= 0; i--) {
        const item = timeline[i];
        if (item.kind === "tool" && item.status === "running") {
          timeline[i] = {
            ...item,
            status: (isError ? "error" : "complete") as "error" | "complete",
            ...(result !== undefined ? { result } : {}),
            ...(isError ? { error: result || "Tool failed" } : {}),
          };
          break;
        }
      }
    }

    return { ...base, timeline, usage: nextUsage };
  }

  if (usage) {
    return { ...base, usage: nextUsage };
  }

  return base;
}
