import { describe, expect, test } from "bun:test";
import type { AgentCapabilities, AgentHistory, AgentSummary } from "../../shared/domain/agents.ts";
import { loadAgentSession, type AgentSessionLoader } from "./AgentSessionPanel.tsx";

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
    await loadAgentSession(loader);
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
    await loadAgentSession(loader);
    expect(calls).toEqual(["error:history unavailable", "settled"]);
  });

  test("ignores results once the load is superseded", async () => {
    const { calls, loader } = recordedLoader({ isCurrent: () => false });
    await loadAgentSession(loader);
    expect(calls).toEqual([]);
  });
});
