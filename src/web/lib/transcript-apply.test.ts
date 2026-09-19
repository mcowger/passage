import { describe, expect, test } from "bun:test";
import { addOptimisticUserMessage, applyRowUpsert, applyUsageEvent, OPTIMISTIC_USER_ROW_ID } from "./transcript-apply.ts";
import type { AgentHistory, TimelineItem } from "../../shared/domain/agents.ts";

const tool = (id: string, status: "running" | "complete" | "error" = "running"): TimelineItem => ({
  kind: "tool",
  id,
  name: "bash",
  input: null,
  status,
});

describe("applyRowUpsert", () => {
  test("appends an unknown id and never reorders existing rows", () => {
    let history: AgentHistory | undefined;
    history = applyRowUpsert(history, tool("a"));
    history = applyRowUpsert(history, tool("b"));
    expect(history.timeline.map((i) => i.id)).toEqual(["a", "b"]);
  });

  test("updates an existing id in place at its original position", () => {
    let history: AgentHistory | undefined;
    history = applyRowUpsert(history, tool("a"));
    history = applyRowUpsert(history, tool("b"));
    history = applyRowUpsert(history, tool("a", "complete"));
    expect(history.timeline.map((i) => i.id)).toEqual(["a", "b"]);
    expect((history.timeline[0] as { status: string }).status).toBe("complete");
  });

  test("repeated upserts of the same id are idempotent in position", () => {
    let history: AgentHistory | undefined;
    for (let i = 0; i < 5; i += 1) history = applyRowUpsert(history, tool("a", i === 4 ? "complete" : "running"));
    expect(history!.timeline).toHaveLength(1);
    expect((history!.timeline[0] as { status: string }).status).toBe("complete");
  });

  test("a real user row_upsert drops the optimistic placeholder instead of duplicating it", () => {
    let history: AgentHistory | undefined = addOptimisticUserMessage(undefined, "Hello there");
    expect(history.timeline).toEqual([{ kind: "user", id: OPTIMISTIC_USER_ROW_ID, text: "Hello there" }]);

    history = applyRowUpsert(history, { kind: "user", id: "live:user:1", text: "Hello there" });
    expect(history.timeline).toEqual([{ kind: "user", id: "live:user:1", text: "Hello there" }]);
  });

  test("an optimistic user message can carry image previews", () => {
    const previews = [{ hash: "", mimeType: "image/png" as const, name: "shot.png", previewUrl: "data:image/png;base64,AAA" }];
    let history: AgentHistory | undefined = addOptimisticUserMessage(undefined, "Attached image", previews);
    expect(history.timeline).toEqual([{ kind: "user", id: OPTIMISTIC_USER_ROW_ID, text: "Attached image", images: previews }]);

    history = applyRowUpsert(history, { kind: "user", id: "live:user:1", text: "Attached image", images: [{ hash: "a".repeat(64), mimeType: "image/png", name: "shot.png" }] });
    expect(history.timeline).toHaveLength(1);
    expect(history.timeline[0]).toMatchObject({ id: "live:user:1" });
  });

  test("an unrelated row_upsert arriving before the real user row leaves the optimistic row alone", () => {
    let history: AgentHistory | undefined = addOptimisticUserMessage(undefined, "Hello there");
    history = applyRowUpsert(history, tool("a"));
    expect(history.timeline.map((i) => i.id)).toEqual([OPTIMISTIC_USER_ROW_ID, "a"]);
  });
});

describe("applyUsageEvent", () => {
  const base: AgentHistory = {
    sessionId: "s",
    revision: { mtimeMs: 0, size: 0, contentHash: "" },
    transcriptEpoch: 0,
    timeline: [],
    branches: [],
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: 0 },
    contextUsage: { tokens: null },
    unknownRecordCount: 0,
    agentErrorCount: 0,
    malformedRecordCount: 0,
    partialTail: false,
    invalidUtf8Count: 0,
    rewritten: false,
  };

  test("updates usage and context tokens from a positive total", () => {
    const next = applyUsageEvent(base, { usage: { input: 10, output: 5, totalTokens: 15 } });
    expect(next?.usage.totalTokens).toBe(15);
    expect(next?.contextUsage?.tokens).toBe(15);
  });

  test("a zero total does not clobber the last known context occupancy", () => {
    const withUsage = { ...base, contextUsage: { tokens: 150 } };
    const next = applyUsageEvent(withUsage, { usage: { input: 0, output: 0, totalTokens: 0 } });
    expect(next?.contextUsage?.tokens).toBe(150);
  });

  test("nested per-turn usage advances context only, never session totals", () => {
    const next = applyUsageEvent(base, { message: { role: "assistant", usage: { input: 100, output: 50, totalTokens: 150, cost: { total: 0.01 } } } });
    expect(next?.contextUsage?.tokens).toBe(150);
    expect(next?.usage).toMatchObject({ input: 0, output: 0, totalTokens: 0, cost: 0 });
  });

  test("session totals follow top-level cumulative usage, not nested per-turn usage", () => {
    const afterFirst = applyUsageEvent(base, { usage: { input: 100, output: 50, totalTokens: 150, cost: { total: 0.01 } } });
    expect(afterFirst?.usage).toMatchObject({ input: 100, output: 50, totalTokens: 150, cost: 0.01 });
    const afterSecond = applyUsageEvent(afterFirst, { message: { role: "assistant", usage: { input: 200, output: 100, totalTokens: 300, cost: { total: 0.02 } } } });
    expect(afterSecond?.contextUsage?.tokens).toBe(300);
    expect(afterSecond?.usage).toMatchObject({ input: 100, output: 50, totalTokens: 150, cost: 0.01 });
  });

  test("a zero top-level placeholder does not hide nested finalized usage", () => {
    const next = applyUsageEvent(base, { usage: { input: 0, output: 0, totalTokens: 0 }, message: { role: "assistant", usage: { input: 100, output: 50, totalTokens: 150 } } });
    expect(next?.contextUsage?.tokens).toBe(150);
    expect(next?.usage).toMatchObject({ input: 0, output: 0, totalTokens: 0, cost: 0 });
  });

  test("a zero or missing in-flight cost never clobbers the last known cost", () => {
    const withCost = { ...base, usage: { ...base.usage, cost: 0.01 } };
    expect(applyUsageEvent(withCost, { usage: { input: 1, output: 1, totalTokens: 2, cost: { total: 0 } } })?.usage.cost).toBe(0.01);
    expect(applyUsageEvent(withCost, { usage: { input: 1, output: 1, totalTokens: 2 } })?.usage.cost).toBe(0.01);
    expect(applyUsageEvent(withCost, { usage: { input: 1, output: 1, totalTokens: 2, cost: { total: 0.02 } } })?.usage.cost).toBe(0.02);
  });

  test("never touches timeline", () => {
    const withRows = { ...base, timeline: [tool("a")] };
    const next = applyUsageEvent(withRows, { usage: { totalTokens: 5 } });
    expect(next?.timeline).toBe(withRows.timeline);
  });

  test("passes through unchanged without a usage field", () => {
    expect(applyUsageEvent(base, { status: "running" })).toBe(base);
  });
});
