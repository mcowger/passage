import { describe, expect, mock, test } from "bun:test";
import React, { act } from "react";
import { render } from "@testing-library/react";
import type { GitStatus } from "../../shared/domain/git.ts";
import type { WorkspaceApi } from "../api.ts";
import { setupDomTests } from "../test-utils/dom.ts";

// Regression proof: git-status fetches from mount, history-load refresh,
// settle re-checks, and WS invalidations overlap freely. Without sequencing,
// the last response to *resolve* wins -- e.g. the previous workspace's dirty
// fetch landing after the new workspace's clean one -- and a stale dirty
// snapshot sticks commit/ship-it options onto a clean tree (a brand-new
// worktree shows ship-it affordances with no changes) until the next
// invalidation. Only the latest request may write state; older resolutions
// are dropped. The composer always renders exactly one Git button; options
// live inside its menu.
//
// NOTE: use render-bound queries, never the `screen` global -- screen binds
// to document at import time, before setupDomTests' beforeAll registers
// happy-dom.
setupDomTests();

mock.module("../workspaceSocket.ts", () => ({
  subscribeWorkspace: (_workspaceId: string, _onInvalidate: unknown, _onReconcile: unknown) => ({ close: () => {} }),
}));

const { ComposerMergeButton } = await import("./AgentPanel.tsx");

function statusFor(dirty: boolean): GitStatus {
  return {
    checkoutRoot: "/work/wsp",
    mainCheckoutRoot: "/work/main",
    repositoryRoot: "/work/main",
    branchRef: "feature",
    detached: false,
    ahead: 0,
    behind: 0,
    aheadOfMain: 0,
    behindMain: 0,
    hasUpstream: false,
    dirty,
    conflicted: false,
    truncated: false,
    files: dirty
      ? [{ path: "a.txt", kind: "modified", staged: false, workingTree: true, binary: false, submodule: false }]
      : [],
  };
}

async function flush() {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

describe("ComposerMergeButton stale git status (happy-dom)", () => {
  test("previous workspace's late dirty response never overwrites the new workspace's clean status", async () => {
    let resolveOld!: (status: GitStatus) => void;
    let resolveNew!: (status: GitStatus) => void;
    const api = {
      gitStatus: (workspaceId: string) =>
        workspaceId === "wsp-old"
          ? new Promise<GitStatus>((resolve) => {
              resolveOld = resolve;
            })
          : new Promise<GitStatus>((resolve) => {
              resolveNew = resolve;
            }),
    } as unknown as WorkspaceApi;

    let tree!: ReturnType<typeof render>;
    await act(async () => {
      tree = render(React.createElement(ComposerMergeButton, { workspaceId: "wsp-old", api, settled: true }));
    });
    // Switch to the brand-new (clean) worktree while the old fetch is still in flight.
    await act(async () => {
      tree.rerender(React.createElement(ComposerMergeButton, { workspaceId: "wsp-new", api, settled: true }));
    });
    // Fresh clean status lands first...
    await act(async () => {
      resolveNew(statusFor(false));
    });
    await flush();
    // ...then the stale dirty one resolves late and must be dropped.
    await act(async () => {
      resolveOld(statusFor(true));
    });
    await flush();

    // Exactly one Git button, and no ship-it affordance leaks onto the clean tree.
    expect(tree.getAllByRole("button", { name: /git options for feature/i })).toHaveLength(1);
    expect(tree.container.textContent ?? "").not.toContain("Ship It");
  });

  test("dirty tree renders one Git button (options live in the menu)", async () => {
    let resolveReq!: (status: GitStatus) => void;
    const api = {
      gitStatus: () =>
        new Promise<GitStatus>((resolve) => {
          resolveReq = resolve;
        }),
    } as unknown as WorkspaceApi;

    // Dirty tree on a feature branch with nothing ahead/behind: Ship It plus
    // a lone Commit option, both inside the single Git menu.
    let tree!: ReturnType<typeof render>;
    await act(async () => {
      tree = render(React.createElement(ComposerMergeButton, { workspaceId: "wsp-1", api, settled: true }));
    });
    await act(async () => {
      resolveReq(statusFor(true));
    });
    await flush();

    // One Git button total; Ship It and Commit live in the menu, not as
    // direct composer buttons.
    expect(tree.getAllByRole("button", { name: /git options for feature/i })).toHaveLength(1);
    expect(tree.queryByRole("button", { name: /merge into main/i })).toBeNull();
    expect(tree.queryByRole("button", { name: /stage all \+ generate message/i })).toBeNull();
  });

  test("latest dirty response still applies when it is the freshest request", async () => {
    let resolveReq!: (status: GitStatus) => void;
    const api = {
      gitStatus: () =>
        new Promise<GitStatus>((resolve) => {
          resolveReq = resolve;
        }),
    } as unknown as WorkspaceApi;

    let tree!: ReturnType<typeof render>;
    await act(async () => {
      tree = render(React.createElement(ComposerMergeButton, { workspaceId: "wsp-1", api, settled: true }));
    });
    await act(async () => {
      resolveReq(statusFor(true));
    });
    await flush();

    // Dirty tree on a feature branch: exactly one Git button; the commit
    // affordance lives in the menu, not beside the button.
    expect(tree.getAllByRole("button", { name: /git options for feature/i })).toHaveLength(1);
  });
});
