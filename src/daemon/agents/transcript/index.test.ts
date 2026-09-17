import { describe, expect, test } from "bun:test";
import { TranscriptState, truncateRowForWire } from "./index.ts";
import type { TimelineItem } from "../../../shared/domain/agents.ts";

function toolCallStartEvent(id: string, name: string) {
  return { assistantMessageEvent: { type: "toolcall_end", id, toolName: name, toolCall: { id, name, arguments: {} } } };
}

describe("TranscriptState", () => {
  test("interleaved concurrent tool calls never cross-contaminate or reorder", () => {
    const state = new TranscriptState();
    state.applyEvent("tool_call", { toolCallId: "a", toolName: "bash", args: { command: "one" } });
    state.applyEvent("tool_call", { toolCallId: "b", toolName: "bash", args: { command: "two" } });
    state.applyEvent("tool_execution_end", { toolCallId: "a", result: "result-a", isError: false });
    state.applyEvent("tool_execution_end", { toolCallId: "b", result: "result-b", isError: false });

    const { timeline } = state.snapshot();
    expect(timeline.map((i) => i.id)).toEqual(["a", "b"]);
    const [a, b] = timeline as Extract<TimelineItem, { kind: "tool" }>[];
    expect(a.result).toBe("result-a");
    expect(a.status).toBe("complete");
    expect(b.result).toBe("result-b");
    expect(b.status).toBe("complete");
  });

  test("tool events with an id never fall back to hijacking the last running row", () => {
    const state = new TranscriptState();
    state.applyEvent("tool_call", { toolCallId: "a", toolName: "bash", args: {} });
    state.applyEvent("tool_call", { toolCallId: "b", toolName: "read", args: {} });
    // "a" finishes last, but its id is explicit -- must never land on "b".
    state.applyEvent("tool_execution_end", { toolCallId: "b", result: "b-done", isError: false });
    state.applyEvent("tool_execution_end", { toolCallId: "a", result: "a-done", isError: false });

    const { timeline } = state.snapshot();
    const a = timeline.find((i) => i.id === "a") as Extract<TimelineItem, { kind: "tool" }>;
    const b = timeline.find((i) => i.id === "b") as Extract<TimelineItem, { kind: "tool" }>;
    expect(a.result).toBe("a-done");
    expect(b.result).toBe("b-done");
  });

  test("an update/end event for an unknown tool id is dropped, not misapplied", () => {
    const state = new TranscriptState();
    state.applyEvent("tool_call", { toolCallId: "a", toolName: "bash", args: {} });
    const changed = state.applyEvent("tool_execution_end", { toolCallId: "unknown", result: "x", isError: false });
    expect(changed).toEqual([]);
    const { timeline } = state.snapshot();
    expect((timeline[0] as Extract<TimelineItem, { kind: "tool" }>).status).toBe("running");
  });

  test("text, tool call, then text again produces two separate ordered assistant rows", () => {
    const state = new TranscriptState();
    state.applyEvent("message_update", { delta: "First block." });
    state.applyEvent("tool_call", { toolCallId: "t1", toolName: "bash", args: {} });
    state.applyEvent("tool_execution_end", { toolCallId: "t1", result: "ok", isError: false });
    state.applyEvent("message_update", { delta: "Second block." });

    const { timeline } = state.snapshot();
    expect(timeline.map((i) => i.kind)).toEqual(["assistant", "tool", "assistant"]);
    expect((timeline[0] as { text: string }).text).toBe("First block.");
    expect((timeline[2] as { text: string }).text).toBe("Second block.");
    // Row identity is permanent: a later delta of the same run never moves or merges into an earlier row.
    expect(timeline[0].id).not.toBe(timeline[2].id);
  });

  test("consecutive deltas of the same kind accumulate onto one row", () => {
    const state = new TranscriptState();
    state.applyEvent("message_update", { delta: "Hello " });
    state.applyEvent("message_update", { delta: "world." });
    const { timeline } = state.snapshot();
    expect(timeline).toHaveLength(1);
    expect((timeline[0] as { text: string }).text).toBe("Hello world.");
  });

  test("thinking and assistant deltas interleave into separate ordered rows", () => {
    const state = new TranscriptState();
    state.applyEvent("message_update", { thinkingDelta: "Considering options." });
    state.applyEvent("message_update", { delta: "Here is the answer." });
    const { timeline } = state.snapshot();
    expect(timeline.map((i) => i.kind)).toEqual(["thinking", "assistant"]);
  });

  test("a user message closes any open streaming block", () => {
    const state = new TranscriptState();
    state.applyEvent("message_update", { delta: "Partial answer" });
    const userRow = state.addUserMessage("Follow-up question");
    state.applyEvent("message_update", { delta: "New answer" });
    const { timeline } = state.snapshot();
    expect(timeline.map((i) => i.kind)).toEqual(["assistant", "user", "assistant"]);
    expect(timeline[1]).toEqual(userRow);
    expect(timeline[0].id).not.toBe(timeline[2].id);
  });

  test("error events append a chronological, non-journaled row", () => {
    const state = new TranscriptState();
    state.applyEvent("message_update", { delta: "working" });
    const changed = state.applyEvent("error", { error: "Pi process exited (1)" });
    expect(changed).toHaveLength(1);
    const { timeline, agentErrorCount } = state.snapshot();
    expect(timeline.map((i) => i.kind)).toEqual(["assistant", "error"]);
    expect((timeline[1] as { text: string }).text).toBe("Pi process exited (1)");
    expect(agentErrorCount).toBe(1);
  });

  test("appendError positions and reports the row like any other event", () => {
    const state = new TranscriptState();
    const row = state.appendError("Pi process is not running");
    expect(row.kind).toBe("error");
    expect(state.snapshot().timeline).toEqual([row]);
  });

  test("seeding from a journal read preserves row ids and positions, and later live rows append after", () => {
    const state = new TranscriptState();
    const seeded: TimelineItem[] = [
      { kind: "user", id: "u1", text: "hi" },
      { kind: "tool", id: "write-1", name: "write", input: null, status: "complete", significant: true, result: "done" },
    ];
    state.seed({
      timeline: seeded,
      usage: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0, totalTokens: 3, cost: 0 },
      contextUsage: { tokens: 3 },
      agentErrorCount: 0,
    });
    state.applyEvent("message_update", { delta: "more" });
    const { timeline } = state.snapshot();
    expect(timeline.slice(0, 2)).toEqual(seeded);
    expect(timeline).toHaveLength(3);
    expect(timeline[2].kind).toBe("assistant");
  });

  test("refreshFromJournal upserts tool rows by their stable toolCallId and is idempotent", () => {
    const state = new TranscriptState();
    state.applyEvent("tool_call", { toolCallId: "write-1", toolName: "write", args: { path: "a.md" } });
    state.applyEvent("tool_execution_end", { toolCallId: "write-1", result: "truncated-live-result", isError: false });

    const journalTimeline: TimelineItem[] = [
      { kind: "tool", id: "write-1", name: "write", input: { path: "a.md" }, status: "complete", significant: true, result: "full-untruncated-result" },
    ];
    const changed = state.refreshFromJournal({
      timeline: journalTimeline,
      usage: { input: 5, output: 5, cacheRead: 0, cacheWrite: 0, totalTokens: 10, cost: 0 },
      contextUsage: { tokens: 10 },
      agentErrorCount: 0,
    });
    expect(changed).toHaveLength(1);
    expect((state.snapshot().timeline[0] as Extract<TimelineItem, { kind: "tool" }>).result).toBe("full-untruncated-result");

    const secondPass = state.refreshFromJournal({
      timeline: journalTimeline,
      usage: { input: 5, output: 5, cacheRead: 0, cacheWrite: 0, totalTokens: 10, cost: 0 },
      contextUsage: { tokens: 10 },
      agentErrorCount: 0,
    });
    expect(secondPass).toEqual([]);
  });

  test("refreshFromJournal never touches assistant/thinking rows, avoiding the identity mismatch that caused duplication", () => {
    const state = new TranscriptState();
    state.applyEvent("message_update", { delta: "live text" });
    const liveId = state.snapshot().timeline[0].id;
    state.refreshFromJournal({
      timeline: [{ kind: "assistant", id: "journal:a1:0", text: "live text" }],
      usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: 0 },
      contextUsage: { tokens: null },
      agentErrorCount: 0,
    });
    const { timeline } = state.snapshot();
    expect(timeline).toHaveLength(1);
    expect(timeline[0].id).toBe(liveId);
  });

  test("usage and context tokens update without a positive total not clobbering the last known value", () => {
    const state = new TranscriptState();
    state.applyEvent("message_update", { usage: { input: 100, output: 50, totalTokens: 150 } });
    state.applyEvent("message_update", { usage: { input: 0, output: 0, totalTokens: 0 } });
    expect(state.snapshot().contextUsage.tokens).toBe(150);
  });
});

describe("truncateRowForWire", () => {
  test("leaves small tool results untouched", () => {
    const row: TimelineItem = { kind: "tool", id: "t1", name: "bash", input: null, status: "complete", significant: true, result: "short" };
    expect(truncateRowForWire(row)).toEqual(row);
  });

  test("truncates oversized tool results for the wire without touching the row identity", () => {
    const huge = "x".repeat(100_000);
    const row: TimelineItem = { kind: "tool", id: "t1", name: "bash", input: null, status: "complete", significant: true, result: huge };
    const wire = truncateRowForWire(row, 1024);
    expect(wire.kind === "tool" && wire.result!.length).toBeLessThan(huge.length);
    expect(wire.id).toBe("t1");
    expect(wire.kind === "tool" && wire.status).toBe("complete");
  });

  test("leaves non-tool rows untouched regardless of size", () => {
    const row: TimelineItem = { kind: "assistant", id: "a1", text: "x".repeat(100_000) };
    expect(truncateRowForWire(row, 10)).toEqual(row);
  });
});
