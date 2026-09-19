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
// snapshot sticks commit/send-it onto a clean tree (a brand-new worktree
// shows both buttons with no changes) until the next invalidation. Only the
// latest request may write state; older resolutions are dropped.
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

    expect(tree.queryByRole("button", { name: /auto-commit/i })).toBeNull();
    expect(tree.container.textContent ?? "").not.toContain("Send It");
  });

  test("mobile with send-it collapses a lone option into the git menu", async () => {
    let resolveReq!: (status: GitStatus) => void;
    const api = {
      gitStatus: () =>
        new Promise<GitStatus>((resolve) => {
          resolveReq = resolve;
        }),
    } as unknown as WorkspaceApi;

    // Dirty tree on a feature branch with nothing ahead/behind: Send It plus
    // a lone Commit option. On mobile the Commit must collapse into the menu.
    let tree!: ReturnType<typeof render>;
    await act(async () => {
      tree = render(React.createElement(ComposerMergeButton, { workspaceId: "wsp-1", api, settled: true, hideIcons: true }));
    });
    await act(async () => {
      resolveReq(statusFor(true));
    });
    await flush();

    // Send It stays a direct button; the lone Commit collapses into the menu
    // trigger instead of rendering as a second direct button.
    expect(tree.getByRole("button", { name: /merge into main/i })).toBeInTheDocument();
    expect(tree.getByRole("button", { name: /git options for feature/i })).toBeInTheDocument();
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

    // Dirty tree on a feature branch: Send It plus the standalone Commit button.
    expect(tree.getAllByRole("button", { name: /auto-commit 1 changed/i })).toHaveLength(2);
  });
});
