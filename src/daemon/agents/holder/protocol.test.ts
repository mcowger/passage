import { expect, test } from "bun:test";
import {
  decideSweep,
  type SweepCandidate,
} from "./spawn.ts";
import {
  HOLDER_VERSION,
  metaPathFor,
  parseHolderMeta,
  pidPathFor,
  scopeUnitFor,
  socketPathFor,
  validateAgentId,
} from "./protocol.ts";

test("agent IDs are validated for socket paths and scope names", () => {
  expect(validateAgentId("agt_123-ABC")).toBe("agt_123-ABC");
  expect(() => validateAgentId("")).toThrow("invalid agentId");
  expect(() => validateAgentId("a/b")).toThrow("invalid agentId");
  expect(() => validateAgentId("../x")).toThrow("invalid agentId");
  expect(() => validateAgentId("a".repeat(129))).toThrow("invalid agentId");
  expect(scopeUnitFor("agt_1")).toBe("passage-pi-agt_1.scope");
  expect(() => scopeUnitFor("a;b")).toThrow("invalid agentId");
});

test("per-agent file layout stays under the sessions root", () => {
  expect(socketPathFor("/data/sessions/agt_1")).toBe("/data/sessions/agt_1/rpc.sock");
  expect(pidPathFor("/data/sessions/agt_1")).toBe("/data/sessions/agt_1/holder.pid");
  expect(metaPathFor("/data/sessions/agt_1")).toBe("/data/sessions/agt_1/holder.json");
  expect(HOLDER_VERSION).toBe(1);
});

test("holder meta round-trips and rejects garbage", () => {
  const meta = {
    agentId: "agt_1",
    sessionId: "pi_1",
    generation: 3,
    holderVersion: HOLDER_VERSION,
    startedAt: new Date().toISOString(),
    socketPath: "/x/rpc.sock",
    pid: 1234,
  };
  expect(parseHolderMeta(meta)).toEqual(meta);
  expect(parseHolderMeta(null)).toBeUndefined();
  expect(parseHolderMeta({ ...meta, generation: "3" })).toBeUndefined();
  expect(parseHolderMeta({ agentId: "agt_1" })).toBeUndefined();
});

test("sweep decision matrix", () => {
  const base: SweepCandidate = {
    agentId: "agt_1",
    sessionDir: "/s/agt_1",
    socketAlive: true,
    knownAgent: true,
    archived: false,
  };
  // Live agent + live holder → keep.
  expect(decideSweep(base)).toBe("keep");
  // Archived + live holder → kill.
  expect(decideSweep({ ...base, archived: true })).toBe("kill-archived");
  // Archived + dead socket → kill-stale (files still removed).
  expect(decideSweep({ ...base, archived: true, socketAlive: false })).toBe("kill-stale");
  // Live agent + dead socket → respawn (lazy, on next use).
  expect(decideSweep({ ...base, socketAlive: false })).toBe("respawn");
  // Unknown socket → kill whether or not anything listens.
  expect(decideSweep({ ...base, knownAgent: false })).toBe("kill-unknown");
  expect(decideSweep({ ...base, knownAgent: false, socketAlive: false })).toBe("kill-unknown");
});
