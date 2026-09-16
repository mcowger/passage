import { describe, expect, test } from "bun:test";
import { PROTOCOL_VERSION, type EventEnvelope } from "../shared/protocol/index.ts";
import { parseWorkspaceMessage, subscribeEnvelope, unsubscribeEnvelope, type WorkspaceSocketState } from "./workspaceSocket.ts";

const initial: WorkspaceSocketState = { sequence: 0, connected: true, snapshotRequired: false };

describe("workspace socket protocol", () => {
  test("builds strict workspace subscription envelopes", () => {
    expect(subscribeEnvelope("wsp-1", 4)).toMatchObject({
      version: PROTOCOL_VERSION,
      channel: "workspace",
      type: "subscribe",
      payload: { workspaceId: "wsp-1", afterSequence: 4 },
    });
    expect(unsubscribeEnvelope("wsp-1")).toMatchObject({
      channel: "workspace",
      type: "unsubscribe",
      payload: { workspaceId: "wsp-1" },
    });
  });

  test("accepts only ordered files-changed events for the selected workspace", () => {
    const event: EventEnvelope = {
      version: PROTOCOL_VERSION,
      stream: "workspace",
      subjectId: "wsp-1",
      sequence: 1,
      type: "files-changed",
      payload: { workspaceId: "wsp-1", reason: "create", path: "notes.txt" },
    };
    expect(parseWorkspaceMessage(event, initial, "wsp-1")).toMatchObject({ sequence: 1 });
    expect(parseWorkspaceMessage(event, initial, "other-workspace")).toBe(initial);
    expect(parseWorkspaceMessage({ ...event, sequence: 0 }, initial, "wsp-1")).toBe(initial);
    expect(parseWorkspaceMessage({ ...event, stream: "pi", subjectId: "wsp-1" }, initial, "wsp-1")).toBe(initial);
  });

  test("marks gaps and snapshot requirements for authoritative reload", () => {
    const gap = parseWorkspaceMessage({
      version: PROTOCOL_VERSION,
      stream: "workspace",
      subjectId: "wsp-1",
      sequence: 3,
      type: "files-changed",
      payload: { workspaceId: "wsp-1", reason: "delete", path: "old.txt" },
    }, initial, "wsp-1");
    expect(gap.snapshotRequired).toBe(true);
    const snapshot = parseWorkspaceMessage({
      version: PROTOCOL_VERSION,
      stream: "workspace",
      subjectId: "wsp-1",
      kind: "snapshot-required",
      metadata: { snapshotUrl: "/api/workspaces/wsp-1/files?path=.", sequence: "9" },
    }, gap, "wsp-1");
    expect(snapshot).toMatchObject({ sequence: 9, snapshotRequired: true });
  });
});
