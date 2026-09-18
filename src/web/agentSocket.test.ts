import { describe, expect, test } from "bun:test";
import { PROTOCOL_VERSION } from "../shared/protocol/index.ts";
import { parseAgentMessage, subscribeEnvelope, unsubscribeEnvelope, type AgentSocketState } from "./agentSocket.ts";

const initial: AgentSocketState = { sequence: 0, connected: true, snapshotRequired: false };

describe("agent socket protocol", () => {
  test("builds strict Pi subscription envelopes", () => {
    expect(subscribeEnvelope("agent-1", 4)).toMatchObject({
      version: PROTOCOL_VERSION,
      channel: "pi",
      type: "subscribe",
      payload: { agentId: "agent-1", afterSequence: 4 },
    });
    expect(unsubscribeEnvelope("agent-1")).toMatchObject({
      channel: "pi",
      type: "unsubscribe",
      payload: { agentId: "agent-1" },
    });
  });

  test("accepts only ordered events for the selected agent", () => {
    const event = {
      version: PROTOCOL_VERSION,
      stream: "pi",
      subjectId: "agent-1",
      sequence: 1,
      type: "status",
      payload: { status: "running" },
    };
    expect(parseAgentMessage(event, initial, "agent-1")).toMatchObject({ sequence: 1, status: "running" });
    expect(parseAgentMessage(event, initial, "other-agent")).toBe(initial);
    expect(parseAgentMessage({ ...event, sequence: 0 }, initial, "agent-1")).toBe(initial);
  });

  test("marks gaps and snapshot requirements for authoritative reload", () => {
    const gap = parseAgentMessage({
      version: PROTOCOL_VERSION,
      stream: "pi",
      subjectId: "agent-1",
      sequence: 3,
      type: "settled",
      payload: { status: "idle" },
    }, initial, "agent-1");
    expect(gap.snapshotRequired).toBe(true);
    const snapshot = parseAgentMessage({
      version: PROTOCOL_VERSION,
      stream: "pi",
      subjectId: "agent-1",
      kind: "snapshot-required",
      metadata: { snapshotUrl: "/api/agents/agent-1", sequence: "9" },
    }, gap, "agent-1");
    expect(snapshot).toMatchObject({ sequence: 9, snapshotRequired: true });
  });

  // Once a reconcile clears snapshotRequired at sequence 9 (see
  // subscribeAgent), the very next contiguous event must resume normal
  // delivery -- a daemon restart mid-session must not leave the client
  // stuck re-requesting snapshots forever.
  test("resumes ordered delivery immediately after a snapshot clears at a fresh sequence", () => {
    const reconciled: AgentSocketState = { sequence: 9, connected: true, snapshotRequired: false };
    const next = parseAgentMessage({
      version: PROTOCOL_VERSION,
      stream: "pi",
      subjectId: "agent-1",
      sequence: 10,
      type: "status",
      payload: { status: "running" },
    }, reconciled, "agent-1");
    expect(next).toMatchObject({ sequence: 10, snapshotRequired: false, status: "running" });
  });

  // An event that arrived and was dropped while a reconcile was already in
  // flight (subscribeAgent ignores messages while `reconciling` is true)
  // leaves a gap right after the reconcile clears. That gap must still be
  // detected so the client re-requests a snapshot instead of silently
  // resuming with a hole in its timeline.
  test("a gap immediately after a snapshot clears still forces another snapshot", () => {
    const reconciled: AgentSocketState = { sequence: 9, connected: true, snapshotRequired: false };
    const next = parseAgentMessage({
      version: PROTOCOL_VERSION,
      stream: "pi",
      subjectId: "agent-1",
      sequence: 11,
      type: "status",
      payload: { status: "running" },
    }, reconciled, "agent-1");
    expect(next).toMatchObject({ sequence: 11, snapshotRequired: true });
  });
});
