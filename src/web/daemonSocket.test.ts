import { describe, expect, test } from "bun:test";
import { DAEMON_SNAPSHOT_SUBJECT, PROTOCOL_VERSION, type EventEnvelope } from "../shared/protocol/index.ts";
import { parseDaemonMessage, subscribeEnvelope, unsubscribeEnvelope, type DaemonSocketState } from "./daemonSocket.ts";

const initial: DaemonSocketState = { sequence: 0, connected: true, snapshotRequired: false };

describe("daemon socket protocol", () => {
  test("builds strict daemon subscription envelopes with no subject id", () => {
    expect(subscribeEnvelope(4)).toMatchObject({
      version: PROTOCOL_VERSION,
      channel: "daemon",
      type: "subscribe",
      payload: { afterSequence: 4 },
    });
    expect(unsubscribeEnvelope()).toMatchObject({
      channel: "daemon",
      type: "unsubscribe",
      payload: {},
    });
  });

  test("accepts only ordered daemon-changed events on the well-known subject", () => {
    const event: EventEnvelope = {
      version: PROTOCOL_VERSION,
      stream: "daemon",
      subjectId: DAEMON_SNAPSHOT_SUBJECT,
      sequence: 1,
      type: "daemon-changed",
      payload: { reason: "drain-begin" },
    };
    expect(parseDaemonMessage(event, initial)).toMatchObject({ sequence: 1 });
    expect(parseDaemonMessage({ ...event, sequence: 0 }, initial)).toBe(initial);
    expect(parseDaemonMessage({ ...event, stream: "workspace" }, initial)).toBe(initial);
  });

  test("marks gaps and snapshot requirements for authoritative reload", () => {
    const gap = parseDaemonMessage({
      version: PROTOCOL_VERSION,
      stream: "daemon",
      subjectId: DAEMON_SNAPSHOT_SUBJECT,
      sequence: 3,
      type: "daemon-changed",
      payload: { reason: "readiness-changed" },
    }, initial);
    expect(gap.snapshotRequired).toBe(true);
    const snapshot = parseDaemonMessage({
      version: PROTOCOL_VERSION,
      stream: "daemon",
      subjectId: DAEMON_SNAPSHOT_SUBJECT,
      kind: "snapshot-required",
      metadata: { snapshotUrl: "/api/daemon/snapshot", sequence: "9" },
    }, gap);
    expect(snapshot).toMatchObject({ sequence: 9, snapshotRequired: true });
  });
});
