import { describe, expect, test } from "bun:test";
import { diagnosticEventSchema } from "../../shared/domain/diagnostics.ts";
import {
  buildSnapshot,
  estimateHistoryChars,
  estimateTimelineRowChars,
  noteHistoryBaseline,
  noteSocketEvent,
  noteTranscriptRow,
  recordHighlight,
  reportBackgroundAgents,
  resetFlightRecorderForTests,
  setForegroundAgent,
} from "./flightRecorder.ts";

describe("flight recorder estimators", () => {
  test("estimateTimelineRowChars counts text without serializing", () => {
    expect(estimateTimelineRowChars({ kind: "user", text: "hello" })).toBe(5);
    expect(estimateTimelineRowChars({ kind: "tool", name: "bash", result: "ok" })).toBe(6);
    expect(estimateTimelineRowChars({ kind: "unknown" })).toBe(0);
  });

  test("estimateHistoryChars sums rows", () => {
    expect(estimateHistoryChars([{ kind: "user" }, { kind: "assistant" }])).toBe(0);
    expect(estimateHistoryChars(undefined)).toBe(0);
  });
});

describe("flight recorder snapshot", () => {
  test("aggregates incremental counters and validates against the wire schema", () => {
    resetFlightRecorderForTests();
    try {
      setForegroundAgent("agent-1", true);
      noteHistoryBaseline("agent-1", 10, 500);
      noteTranscriptRow("agent-1", 100);
      noteTranscriptRow("agent-1", 900);
      setForegroundAgent("agent-2", true);
      noteTranscriptRow("agent-2", 50);
      reportBackgroundAgents(["agent-9"]);
      noteSocketEvent("agent", "open");
      noteSocketEvent("daemon", "reconnect");
      recordHighlight(12.5, false);
      recordHighlight(0, true);

      const snapshot = buildSnapshot();
      expect(snapshot.kind).toBe("snapshot");
      expect(diagnosticEventSchema.safeParse(snapshot).success).toBe(true);
      const payload = snapshot.payload!;
      expect(payload.fgAgents).toBe(2);
      expect(payload.fgRows).toBe(13);
      expect(payload.fgLargestRow).toBe(900);
      expect(payload.bgAgents).toBe(1);
      expect(payload.hlCount).toBe(2);
      expect(payload.hlCacheHits).toBe(1);
      expect(payload.hlMaxMs).toBe(12.5);
      expect(payload.ws_agent_opens).toBe(1);
      expect(payload.ws_daemon_reconnects).toBe(1);
      // Opaque ids only -- no text, prompts, or tool output anywhere.
      expect(JSON.stringify(payload)).not.toMatch(/hello|secret|prompt/);
      expect(payload.fgAgentIds).toBe("agent-1,agent-2");
    } finally {
      resetFlightRecorderForTests();
    }
  });

  test("unmounting clears foreground membership", () => {
    resetFlightRecorderForTests();
    try {
      setForegroundAgent("agent-1", true);
      setForegroundAgent("agent-1", false);
      const snapshot = buildSnapshot();
      expect(snapshot.payload!.fgAgents).toBe(0);
      expect(snapshot.payload!.fgAgentIds).toBeUndefined();
    } finally {
      resetFlightRecorderForTests();
    }
  });

  test("sequence numbers increase monotonically", () => {
    resetFlightRecorderForTests();
    try {
      const first = buildSnapshot();
      const second = buildSnapshot();
      expect(second.seq).toBe(first.seq + 1);
    } finally {
      resetFlightRecorderForTests();
    }
  });
});
