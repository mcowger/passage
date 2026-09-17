import { describe, expect, test } from "bun:test";
import type { AgentCapabilities, AgentHistory, AgentSummary } from "../../shared/domain/agents.ts";
import { loadAgentSession, loadAgentSessionWithRetry, mergeLoadedHistory, type AgentSessionLoadResult, type AgentSessionLoader } from "./AgentSessionPanel.tsx";
import type { TimelineItem } from "../../shared/domain/agents.ts";

const summary = { id: "agt-1" } as unknown as AgentSummary;
const history = { timeline: [] } as unknown as AgentHistory;
const capabilities = { models: [] } as unknown as AgentCapabilities;

function recordedLoader(overrides: Partial<AgentSessionLoader> = {}) {
  const calls: string[] = [];
  const loader: AgentSessionLoader = {
    agentId: "agt-1",
    api: {
      agent: async () => summary,
      history: async () => ({ history }),
      capabilities: async () => capabilities,
    },
    isCurrent: () => true,
    onSummary: () => calls.push("summary"),
    onHistory: () => calls.push("history"),
    onCapabilities: () => calls.push("capabilities"),
    onError: (message) => { if (message) calls.push(`error:${message}`); },
    onSettled: () => calls.push("settled"),
    ...overrides,
  };
  return { calls, loader };
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("loadAgentSession", () => {
  test("renders history without waiting for capabilities to resolve", async () => {
    const { calls, loader } = recordedLoader({
      api: {
        agent: async () => summary,
        history: async () => ({ history }),
        capabilities: () => new Promise<AgentCapabilities>(() => {}),
      },
    });

    void loadAgentSession(loader);
    await flush();

    expect(calls).toEqual(["summary", "history", "settled"]);
  });

  test("applies capabilities after history settles", async () => {
    const { calls, loader } = recordedLoader();
    expect(await loadAgentSession(loader)).toBe("loaded");
    expect(calls).toEqual(["summary", "history", "settled", "capabilities"]);
  });

  test("settles with an error when history fails", async () => {
    const { calls, loader } = recordedLoader({
      api: {
        agent: async () => summary,
        history: async () => {
          throw new Error("history unavailable");
        },
        capabilities: async () => capabilities,
      },
    });
    expect(await loadAgentSession(loader)).toBe("failed");
    expect(calls).toEqual(["error:history unavailable", "settled"]);
  });

  test("ignores results once the load is superseded", async () => {
    const { calls, loader } = recordedLoader({ isCurrent: () => false });
    expect(await loadAgentSession(loader)).toBe("superseded");
    expect(calls).toEqual([]);
  });
});

describe("mergeLoadedHistory", () => {
  const baseline = (overrides: Partial<AgentHistory> = {}): AgentHistory => ({
    sessionId: "agt-1",
    revision: { mtimeMs: 0, size: 0, contentHash: "" },
    transcriptEpoch: 1,
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
    ...overrides,
  });
  const row = (id: string): TimelineItem => ({ kind: "assistant", id, text: id });

  test("a missing fetch result keeps whatever is currently rendered", () => {
    const current = baseline({ timeline: [row("a")] });
    expect(mergeLoadedHistory(current, undefined)).toBe(current);
  });

  test("first load (no current history) accepts the fetch wholesale", () => {
    const loaded = baseline({ timeline: [row("a")] });
    expect(mergeLoadedHistory(undefined, loaded)).toBe(loaded);
  });

  test("same epoch: keeps the live row-upsert-built timeline and refreshes only other fields", () => {
    const current = baseline({ transcriptEpoch: 7, timeline: [row("a"), row("b")], agentErrorCount: 0 });
    const loaded = baseline({ transcriptEpoch: 7, timeline: [row("a")], agentErrorCount: 3 });
    const merged = mergeLoadedHistory(current, loaded);
    // Timeline is NOT replaced -- row_upsert is the sole source of timeline
    // mutations while the epoch is unchanged, even though the fetch's own
    // timeline looks "stale" (e.g. it raced a live delta the client already applied).
    expect(merged?.timeline).toEqual([row("a"), row("b")]);
    expect(merged?.agentErrorCount).toBe(3);
  });

  test("different epoch (restart or compaction reset): replaces the timeline wholesale", () => {
    const current = baseline({ transcriptEpoch: 7, timeline: [row("stale-live-id")] });
    const loaded = baseline({ transcriptEpoch: 8, timeline: [row("fresh-journal-id")] });
    const merged = mergeLoadedHistory(current, loaded);
    expect(merged).toBe(loaded);
    expect(merged?.timeline).toEqual([row("fresh-journal-id")]);
  });
});

describe("loadAgentSessionWithRetry", () => {
  test("retries once after a failed attempt", async () => {
    const results: AgentSessionLoadResult[] = ["failed", "loaded"];
    const attempts: boolean[] = [];
    await loadAgentSessionWithRetry(async (isInitial) => {
      attempts.push(isInitial);
      return results.shift()!;
    }, true);
    expect(attempts).toEqual([true, false]);
  });

  test("does not retry a loaded or superseded attempt", async () => {
    for (const result of ["loaded", "superseded"] as const) {
      let attempts = 0;
      await loadAgentSessionWithRetry(async () => { attempts += 1; return result; }, false);
      expect(attempts).toBe(1);
    }
  });
});


