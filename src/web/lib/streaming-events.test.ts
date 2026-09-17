import { describe, expect, test } from "bun:test";
import { applyStreamEvent } from "./streaming-events.ts";
import type { AgentHistory, ToolActivity } from "../../shared/domain/agents.ts";

function createHistory(): AgentHistory {
  return {
    sessionId: "s1",
    revision: { mtimeMs: Date.now(), size: 0, contentHash: "" },
    timeline: [],
    branches: [],
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: 0 },
    unknownRecordCount: 0,
    agentErrorCount: 0,
    malformedRecordCount: 0,
    partialTail: false,
    invalidUtf8Count: 0,
    rewritten: false,
  };
}

describe("applyStreamEvent", () => {
  test("appends text delta to new assistant message without mutating prior turn", () => {
    let history = createHistory();
    // Prior turn: assistant message then user message
    history.timeline = [
      { kind: "assistant", id: "a1", text: "Previous turn answer" },
      { kind: "user", id: "u1", text: "Now read 5 random files" },
    ];

    // First streaming delta of the new turn
    history = applyStreamEvent(history, {
      type: "event",
      payload: {
        assistantMessageEvent: { type: "text_delta", delta: "Picking 5 files" },
      },
    })!;

    expect(history.timeline.length).toBe(3);
    expect(history.timeline[0]).toEqual({ kind: "assistant", id: "a1", text: "Previous turn answer" });
    expect(history.timeline[1]).toEqual({ kind: "user", id: "u1", text: "Now read 5 random files" });
    expect(history.timeline[2].kind).toBe("assistant");
    expect((history.timeline[2] as { text: string }).text).toBe("Picking 5 files");

    // Second streaming delta appends to the current assistant message
    history = applyStreamEvent(history, {
      type: "event",
      payload: {
        assistantMessageEvent: { type: "text_delta", delta: " from /tmp" },
      },
    })!;

    expect(history.timeline.length).toBe(3);
    expect((history.timeline[2] as { text: string }).text).toBe("Picking 5 files from /tmp");
  });

  test("full text replacement does not duplicate text", () => {
    let history = createHistory();
    history.timeline = [
      { kind: "user", id: "u1", text: "Hello" },
      { kind: "assistant", id: "a1", text: "Picking 5 files from /tmp." },
    ];

    // Incoming full text event from message_update
    history = applyStreamEvent(history, {
      type: "event",
      payload: {
        text: "Picking 5 files from /tmp.",
      },
    })!;

    expect(history.timeline.length).toBe(2);
    expect((history.timeline[1] as { text: string }).text).toBe("Picking 5 files from /tmp.");
  });

  test("correlates toolcall_start and tool_execution_start without creating duplicate rows", () => {
    let history = createHistory();
    history.timeline = [
      { kind: "user", id: "u1", text: "Run command" },
      { kind: "assistant", id: "a1", text: "Running command now:" },
    ];

    // 1. Toolcall start from assistant message stream
    history = applyStreamEvent(history, {
      type: "event",
      payload: {
        assistantMessageEvent: {
          type: "toolcall_start",
          id: "call_123",
          toolName: "bash",
        },
      },
    })!;

    expect(history.timeline.length).toBe(3);
    expect(history.timeline[2]).toMatchObject({
      kind: "tool",
      id: "call_123",
      name: "bash",
      status: "running",
    });

    // 2. Toolcall end with arguments
    history = applyStreamEvent(history, {
      type: "event",
      payload: {
        assistantMessageEvent: {
          type: "toolcall_end",
          id: "call_123",
          toolName: "bash",
          toolCall: { id: "call_123", name: "bash", arguments: { command: "ls /tmp" } },
        },
      },
    })!;

    // Still only 1 tool row
    expect(history.timeline.length).toBe(3);
    expect(history.timeline[2]).toMatchObject({
      kind: "tool",
      id: "call_123",
      name: "bash",
      input: { command: "ls /tmp" },
      status: "running",
    });

    // 3. tool_execution_start event arrives from daemon/Pi
    history = applyStreamEvent(history, {
      type: "tool_execution_start",
      payload: {
        toolCallId: "call_123",
        toolName: "bash",
        args: { command: "ls /tmp" },
      },
    })!;

    // MUST NOT create a second duplicate tool row!
    expect(history.timeline.length).toBe(3);
    expect(history.timeline[2]).toMatchObject({
      kind: "tool",
      id: "call_123",
      name: "bash",
      status: "running",
    });

    // 4. tool_execution_end completes the tool
    history = applyStreamEvent(history, {
      type: "tool_execution_end",
      payload: {
        toolCallId: "call_123",
        result: "file1.txt\nfile2.txt",
        isError: false,
      },
    })!;

    expect(history.timeline.length).toBe(3);
    expect(history.timeline[2]).toMatchObject({
      kind: "tool",
      id: "call_123",
      name: "bash",
      status: "complete",
      result: "file1.txt\nfile2.txt",
    });
  });

  test("extracts text from Pi RPC object result in tool_execution_end instead of [object Object]", () => {
    let history = createHistory();
    history.timeline = [
      {
        kind: "tool",
        id: "call_456",
        name: "bash",
        input: { command: "grep -rn 'port' src/" },
        status: "running",
        significant: true,
      },
    ];

    // Pi RPC emits result as { content: [{ type: "text", text: "..." }], details: {...} }
    history = applyStreamEvent(history, {
      type: "tool_execution_end",
      payload: {
        toolCallId: "call_456",
        toolName: "bash",
        result: {
          content: [
            { type: "text", text: "src/server.ts:47: port: number," },
          ],
          details: { truncation: null, fullOutputPath: null },
        },
        isError: false,
      },
    })!;

    expect(history.timeline[0]).toMatchObject({
      kind: "tool",
      id: "call_456",
      name: "bash",
      status: "complete",
      result: "src/server.ts:47: port: number,",
    });
    expect((history.timeline[0] as ToolActivity).result).not.toContain("[object Object]");
  });

  test("handles tool_execution_update streaming partial results while tool is running", () => {
    let history = createHistory();
    history.timeline = [
      {
        kind: "tool",
        id: "call_789",
        name: "bash",
        input: { command: "long-running-cmd" },
        status: "running",
        significant: true,
      },
    ];

    history = applyStreamEvent(history, {
      type: "tool_execution_update",
      payload: {
        toolCallId: "call_789",
        toolName: "bash",
        partialResult: {
          content: [
            { type: "text", text: "chunk 1\n" },
          ],
        },
      },
    })!;

    expect(history.timeline[0]).toMatchObject({
      kind: "tool",
      id: "call_789",
      status: "running",
      result: "chunk 1\n",
    });

    // Second chunk accumulates
    history = applyStreamEvent(history, {
      type: "tool_execution_update",
      payload: {
        toolCallId: "call_789",
        toolName: "bash",
        partialResult: {
          content: [
            { type: "text", text: "chunk 1\nchunk 2\n" },
          ],
        },
      },
    })!;

    expect(history.timeline[0]).toMatchObject({
      kind: "tool",
      id: "call_789",
      status: "running",
      result: "chunk 1\nchunk 2\n",
    });

    // tool_execution_end finalizes
    history = applyStreamEvent(history, {
      type: "tool_execution_end",
      payload: {
        toolCallId: "call_789",
        toolName: "bash",
        result: {
          content: [
            { type: "text", text: "chunk 1\nchunk 2\ndone" },
          ],
        },
        isError: false,
      },
    })!;

    expect(history.timeline[0]).toMatchObject({
      kind: "tool",
      id: "call_789",
      status: "complete",
      result: "chunk 1\nchunk 2\ndone",
    });
  });

  test("handles tool_execution_end with isError and extracts error text", () => {
    let history = createHistory();
    history.timeline = [
      {
        kind: "tool",
        id: "call_err",
        name: "bash",
        input: { command: "nonexistent_cmd" },
        status: "running",
        significant: true,
      },
    ];

    history = applyStreamEvent(history, {
      type: "tool_execution_end",
      payload: {
        toolCallId: "call_err",
        toolName: "bash",
        result: {
          content: [
            { type: "text", text: "bash: nonexistent_cmd: command not found" },
          ],
        },
        isError: true,
      },
    })!;

    expect(history.timeline[0]).toMatchObject({
      kind: "tool",
      id: "call_err",
      status: "error",
      result: "bash: nonexistent_cmd: command not found",
      error: "bash: nonexistent_cmd: command not found",
    });
  });

  test("keeps last known context occupancy when streaming usage is zero", () => {
    let history = createHistory();
    history.contextUsage = { tokens: 525 };

    // message_update usage may remain zero until the provider finalizes usage.
    history = applyStreamEvent(history, {
      type: "event",
      payload: {
        usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0 },
        assistantMessageEvent: { type: "text_delta", delta: "Writing" },
      },
    })!;

    expect(history.contextUsage).toEqual({ tokens: 525 });
  });

  test("updates context occupancy from positive streaming usage", () => {
    let history = createHistory();
    history.contextUsage = { tokens: 525 };

    history = applyStreamEvent(history, {
      type: "event",
      payload: {
        usage: { input: 600, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 600 },
        assistantMessageEvent: { type: "text_delta", delta: "Done" },
      },
    })!;

    expect(history.contextUsage).toEqual({ tokens: 600 });
  });

  test("derives context occupancy when streaming usage omits totalTokens", () => {
    let history = createHistory();
    history.contextUsage = { tokens: 525 };

    history = applyStreamEvent(history, {
      type: "event",
      payload: {
        usage: { input: 10, output: 5, cacheRead: 100, cacheWrite: 0 },
        assistantMessageEvent: { type: "text_delta", delta: "Done" },
      },
    })!;

    expect(history.contextUsage).toEqual({ tokens: 115 });
  });
});
