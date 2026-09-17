import { describe, expect, test } from "bun:test";
import type { AgentCapabilities, AgentHistory, AgentSummary } from "../../shared/domain/agents.ts";
import { loadAgentSession, loadAgentSessionWithRetry, mergeAgentHistory, type AgentSessionLoadResult, type AgentSessionLoader } from "./AgentSessionPanel.tsx";

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

describe("mergeAgentHistory", () => {
  test("retains a live turn when an older history snapshot arrives", () => {
    const current = {
      ...history,
      revision: { mtimeMs: 2, size: 2, contentHash: "live" },
      usage: { input: 2, output: 3, cacheRead: 0, cacheWrite: 0, totalTokens: 5, cost: 0 },
      timeline: [
        { kind: "user", id: "u1", text: "First request" },
        { kind: "thinking", id: "t1", text: "First thought" },
        { kind: "assistant", id: "a1", text: "First answer" },
        { kind: "user", id: "u2", text: "Second request" },
        { kind: "thinking", id: "t2", text: "Second thought" },
      ],
    } as AgentHistory;
    const stale = {
      ...current,
      revision: { mtimeMs: 1, size: 1, contentHash: "stale" },
      usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: 0 },
      timeline: current.timeline.slice(0, 3),
    } as AgentHistory;
    const running = { ...summary, status: "running" } as AgentSummary;

    expect(mergeAgentHistory(running, current, stale)).toMatchObject({
      revision: stale.revision,
      timeline: current.timeline,
      usage: current.usage,
    });
  });

  test("uses durable history once the agent has settled", () => {
    const current = { ...history, timeline: [{ kind: "user", id: "u1", text: "Live request" }] } as AgentHistory;
    const incoming = { ...history, timeline: [{ kind: "user", id: "u1", text: "Durable request" }] } as AgentHistory;
    const idle = { ...summary, status: "idle" } as AgentSummary;

    expect(mergeAgentHistory(idle, current, incoming)).toBe(incoming);
  });

  test("uses a longer durable snapshot while the agent is running", () => {
    const current = { ...history, timeline: [{ kind: "user", id: "u1", text: "Live request" }] } as AgentHistory;
    const incoming = {
      ...history,
      timeline: [
        { kind: "user", id: "u1", text: "Live request" },
        { kind: "thinking", id: "t1", text: "Durable thought" },
      ],
    } as AgentHistory;
    const running = { ...summary, status: "running" } as AgentSummary;

    expect(mergeAgentHistory(running, current, incoming)).toBe(incoming);
  });

  test("retains live history when the stale summary reports idle", () => {
    const current = {
      ...history,
      usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: 0 },
      timeline: [
        { kind: "user", id: "u1", text: "Durable request" },
        { kind: "assistant", id: "a1", text: "Durable answer" },
        { kind: "user", id: "u2", text: "Live request" },
        { kind: "thinking", id: "t2", text: "Live thought" },
      ],
    } as AgentHistory;
    const stale = {
      ...history,
      usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: 0 },
      timeline: current.timeline.slice(0, 2),
    } as AgentHistory;
    const liveStatus = { ...summary, status: "running" } as AgentSummary;

    expect(mergeAgentHistory(liveStatus, current, stale)?.timeline).toBe(current.timeline);
  });
});
