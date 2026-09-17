import { describe, expect, test } from "bun:test";
import { deriveStreamPhase, emptyStreamActivity, formatByteCount, measureEnvelopeBytes, STREAM_PHASE_LABELS, trackStreamFrame, type StreamPhase } from "./stream-activity.ts";

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

describe("stream traffic counter", () => {
  test("trackStreamFrame accumulates frames and bytes without clearing the phase on non-content frames", () => {
    const activity = emptyStreamActivity();
    trackStreamFrame(activity, 100, "running-tool");
    trackStreamFrame(activity, 250, null);
    expect(activity.frames).toBe(2);
    expect(activity.bytes).toBe(350);
    expect(activity.phase).toBe("running-tool");
    expect(activity.lastFrameAt).toBeGreaterThan(0);
  });

  test("measureEnvelopeBytes reports UTF-8 wire size", () => {
    expect(measureEnvelopeBytes({ type: "tool_execution_update" })).toBeGreaterThan(0);
    expect(measureEnvelopeBytes(undefined)).toBe(0);
  });

  test("formatByteCount stays compact for the pill", () => {
    expect(formatByteCount(0)).toBe("0 B");
    expect(formatByteCount(842)).toBe("842 B");
    expect(formatByteCount(12_800)).toBe("12.5 KB");
    expect(formatByteCount(3_200_000)).toBe("3.1 MB");
  });
});
