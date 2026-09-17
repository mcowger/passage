import { describe, expect, test } from "bun:test";
import { deriveStreamPhase, STREAM_PHASE_LABELS, type StreamPhase } from "./stream-activity.ts";

const assistant = (type: string) => ({ assistantMessageEvent: { type } });

describe("deriveStreamPhase", () => {
  test("classifies assistant message subtypes", () => {
    expect(deriveStreamPhase("message_update", assistant("thinking_start"))).toBe("thinking");
    expect(deriveStreamPhase("message_update", assistant("thinking_delta"))).toBe("thinking");
    expect(deriveStreamPhase("message_update", assistant("text_delta"))).toBe("responding");
    expect(deriveStreamPhase("message_update", assistant("toolcall_start"))).toBe("composing-tool-call");
    expect(deriveStreamPhase("message_update", assistant("toolcall_delta"))).toBe("composing-tool-call");
    expect(deriveStreamPhase("message_update", assistant("toolcall_end"))).toBe("running-tool");
  });

  test("classifies tool execution frames", () => {
    expect(deriveStreamPhase("tool_execution_start", {})).toBe("running-tool");
    expect(deriveStreamPhase("tool_execution_update", {})).toBe("receiving-tool-result");
  });

  test("leaves the phase unchanged for frames that are not content", () => {
    expect(deriveStreamPhase("message_update", assistant("text_end"))).toBeNull();
    expect(deriveStreamPhase("message_update", assistant("thinking_end"))).toBeNull();
    expect(deriveStreamPhase("tool_execution_end", {})).toBeNull();
    expect(deriveStreamPhase("row_upsert", { row: {} })).toBeNull();
    expect(deriveStreamPhase("status", {})).toBeNull();
    expect(deriveStreamPhase("agent_start", {})).toBeNull();
    expect(deriveStreamPhase("message_update", undefined)).toBeNull();
    expect(deriveStreamPhase("message_update", { assistantMessageEvent: null })).toBeNull();
  });

  test("labels every phase", () => {
    const phases: StreamPhase[] = ["thinking", "responding", "composing-tool-call", "running-tool", "receiving-tool-result"];
    for (const phase of phases) expect(STREAM_PHASE_LABELS[phase]).toBeTruthy();
  });
});
