import { describe, expect, mock, test } from "bun:test";
import React, { act } from "react";
import { render } from "@testing-library/react";
import type { AgentHistory, AgentSummary } from "../../shared/domain/agents.ts";
import type { GitStatus } from "../../shared/domain/git.ts";
import type { WorkspaceApi } from "../api.ts";
import { setupDomTests } from "../test-utils/dom.ts";

// Regression proof: after a browser refresh the live `git-status-changed` WS
// invalidations that normally keep the composer's git buttons fresh were never
// received, so the buttons sat hidden on a stale snapshot. Every history load
// now bumps a refresh key that re-checks git status, so the buttons recover
// without waiting for the next invalidation. Sockets are stubbed because the
// reconnect path (`loadWithRetry`) is not under test -- only the mount +
// history-load fetch sequence is.
//
// NOTE: use render-bound queries, never the `screen` global -- screen binds
// to document at import time, before setupDomTests' beforeAll registers
// happy-dom.
setupDomTests();

mock.module("../agentSocket.ts", () => ({
  subscribeAgent: (_agentId: string, _onMessage: unknown, _onReconcile: unknown) => ({ close: () => {} }),
}));

mock.module("../workspaceSocket.ts", () => ({
  subscribeWorkspace: (_workspaceId: string, _onInvalidate: unknown, _onReconcile: unknown) => ({ close: () => {} }),
}));

const { AgentSessionPanel } = await import("./AgentSessionPanel.tsx");

const summary: AgentSummary = {
  id: "agt-1",
  workspaceId: "wsp-1",
  title: "Test agent",
  status: "idle",
  modelPreference: null,
  thinkingPreference: null,
  live: true,
  persisted: true,
};

function emptyHistory(): AgentHistory {
  return {
    sessionId: "sess-1",
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
  };
}

function dirtyStatus(): GitStatus {
  return {
    checkoutRoot: "/work/wsp-1",
    mainCheckoutRoot: "/work/main",
    repositoryRoot: "/work/main",
    branchRef: "feature",
    detached: false,
    ahead: 0,
    behind: 0,
    aheadOfMain: 1,
    behindMain: 0,
    hasUpstream: false,
    dirty: true,
    conflicted: false,
    truncated: false,
    files: [
      { path: "a.txt", kind: "modified", staged: false, workingTree: true, binary: false, submodule: false },
    ],
  };
}

describe("AgentSessionPanel git refresh on history load (happy-dom)", () => {
  test("history load re-checks git status so composer git buttons recover", async () => {
    const gitStatusCalls: string[] = [];
    const api = {
      agent: async () => summary,
      history: async () => ({ history: emptyHistory() }),
      capabilities: async (): Promise<never> => {
        throw new Error("capabilities unavailable");
      },
      gitStatus: async (workspaceId: string) => {
        gitStatusCalls.push(workspaceId);
        return dirtyStatus();
      },
    } as unknown as WorkspaceApi;

    // Mount fetch (1) plus the history-load-triggered refresh (2). Without
    // the fix the count stays at 1: the mount fetch alone, which a missed
    // WS invalidation leaves stale/hidden. Each poll sits in its own `act`
    // scope because React only flushes effects/updates when a scope exits.
    let getByRole!: ReturnType<typeof render>["getByRole"];
    await act(async () => {
      ({ getByRole } = render(React.createElement(AgentSessionPanel, { agent: summary, api })));
    });
    const deadline = Date.now() + 5000;
    while (gitStatusCalls.length < 2 && Date.now() < deadline) {
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 25));
      });
    }
    expect(gitStatusCalls).toEqual(["wsp-1", "wsp-1"]);
    // The refreshed dirty status surfaces the git affordance in the composer.
    expect(getByRole("button", { name: /git options for feature/i })).toBeInTheDocument();
  });
});
