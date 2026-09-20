import { describe, expect, test } from "bun:test";
import { getAgentStatusKind, getWorkspaceStatusKind } from "./agentStatus.ts";

describe("getAgentStatusKind", () => {
  test("restart-interrupted agents render grey while genuine interruptions stay red", () => {
    expect(getAgentStatusKind({ status: "interrupted", interruptedByRestart: true })).toBe("empty");
    expect(getAgentStatusKind({ status: "interrupted" })).toBe("attention");
    expect(getAgentStatusKind({ status: "interrupted", interruptedByRestart: false })).toBe("attention");
  });

  test("other statuses are unaffected", () => {
    expect(getAgentStatusKind({ status: "needs-attention" })).toBe("attention");
    expect(getAgentStatusKind({ status: "error" })).toBe("attention");
    expect(getAgentStatusKind({ status: "running" })).toBe("active");
    expect(getAgentStatusKind({ status: "stopping" })).toBe("active");
    expect(getAgentStatusKind({ status: "initializing" })).toBe("empty");
    expect(getAgentStatusKind({ status: "idle" })).toBe("idle");
  });
});

describe("getWorkspaceStatusKind", () => {
  test("only restart-interrupted agents render grey; genuine keeps red", () => {
    expect(getWorkspaceStatusKind([{ status: "interrupted", interruptedByRestart: true }])).toBe("empty");
    expect(getWorkspaceStatusKind([{ status: "interrupted" }])).toBe("attention");
    // A restart-interrupted agent alongside ready work stays ready, not red.
    expect(getWorkspaceStatusKind([
      { status: "interrupted", interruptedByRestart: true },
      { status: "idle" },
    ])).toBe("idle");
  });
});
