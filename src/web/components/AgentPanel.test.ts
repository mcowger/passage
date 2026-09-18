import { describe, expect, test } from "bun:test";
import React from "react";
import ReactDOMServer from "react-dom/server";
import { createQueuedFollowUp, extractLatestThinkingSummary, formatDuration, formatThinkingPreview, isComposerLocked, isComposerMergeRelevant, resolveComposerGitOptions, QueuedFollowUpList, removeQueuedFollowUp, resolveActiveQuestionRequest, resolveCurrentModel, resolveCurrentThinking, resolveStreamActive, resolveStreamStartMs, retainComposerFocusOnTap, timelineWithoutBlockingTool, TimelineRow } from "./AgentPanel.tsx";
import type { AgentCapabilities, AgentSummary, TimelineItem } from "../../shared/domain/agents.ts";
import type { WorkspaceApi } from "../api.ts";

const stubApi = { imageUrl: (id: string, hash: string) => `/api/agents/${id}/images/${hash}`, fileUrl: (id: string, hash: string) => `/api/agents/${id}/files/${hash}`, workspaceImageUrl: (workspaceId: string, path: string) => `/api/workspaces/${workspaceId}/files/raw?path=${encodeURIComponent(path)}` } as unknown as WorkspaceApi;

const modelOptions: AgentCapabilities["models"] = [
  {
    provider: "test",
    id: "old-model",
    name: "Old model",
    api: "test",
    input: ["text"],
    authenticated: true,
    supportedThinkingLevels: [],
  },
  {
    provider: "test",
    id: "new-model",
    name: "New model",
    api: "test",
    input: ["text"],
    authenticated: true,
    supportedThinkingLevels: [],
  },
];

describe("formatDuration", () => {
  test("formats sub-minute durations in seconds with one decimal", () => {
    expect(formatDuration(0)).toBe("0.0s");
    expect(formatDuration(4.24)).toBe("4.2s");
    expect(formatDuration(15.89)).toBe("15.9s");
    expect(formatDuration(59.9)).toBe("59.9s");
  });

  test("formats multi-minute durations in minutes and seconds", () => {
    expect(formatDuration(60)).toBe("1m 00s");
    expect(formatDuration(65)).toBe("1m 05s");
    expect(formatDuration(125)).toBe("2m 05s");
    expect(formatDuration(365)).toBe("6m 05s");
  });
});

describe("formatThinkingPreview", () => {
  test("follows the latest bold summary line", () => {
    expect(formatThinkingPreview("**Summary Line**\n\n**Another Summary Line**")).toBe(
      "Another Summary Line",
    );
  });

  test("tracks summaries across detail blocks and newline variations", () => {
    expect(
      formatThinkingPreview("**Thinking Summary 1**\n\nThinking detail goes here\n\n**Thinking Summary 2**\n\nMore detail"),
    ).toBe("Thinking Summary 2");
    // Back-to-back summaries, single newline.
    expect(formatThinkingPreview("**Thinking Summary 1**\n**Thinking Summary 2**")).toBe(
      "Thinking Summary 2",
    );
    // Back-to-back summaries, blank line between.
    expect(formatThinkingPreview("**Thinking Summary 1**\n\n**Thinking Summary 2**")).toBe(
      "Thinking Summary 2",
    );
  });

  test("shows a summary while its closing marker is still streaming in", () => {
    expect(formatThinkingPreview("**Thinking Summary 1**\n\nDetail\n\n**Thinking Summary 2")).toBe(
      "Thinking Summary 2",
    );
  });

  test("ignores inline bold prose and falls back to flattened text", () => {
    expect(extractLatestThinkingSummary("Thinking about **foo** here")).toBeUndefined();
    expect(formatThinkingPreview("Just plain thinking text")).toBe("Just plain thinking text");
    expect(formatThinkingPreview("**bold** and more prose")).toBe("bold and more prose");
  });

  test("supports __ markers and strips inline code in summaries", () => {
    expect(formatThinkingPreview("__Summary `one`__\n\n__Summary two__")).toBe("Summary two");
  });
});

describe("resolveCurrentModel", () => {
  test("prefers the persisted preference over stale history", () => {
    expect(resolveCurrentModel("test/new-model", { provider: "test", modelId: "old-model" }, modelOptions)).toMatchObject({
      provider: "test",
      id: "new-model",
    });
  });

  test("uses history when no model preference has been persisted", () => {
    expect(resolveCurrentModel(null, { provider: "test", modelId: "old-model" }, modelOptions)).toMatchObject({
      provider: "test",
      id: "old-model",
    });
  });
});

describe("isComposerMergeRelevant", () => {
  const base: import("../../shared/domain/git.ts").GitStatus = {
    checkoutRoot: "/wt/feature",
    mainCheckoutRoot: "/repo",
    repositoryRoot: "/repo",
    branchRef: "feature",
    detached: false,
    ahead: 0,
    behind: 0,
    aheadOfMain: 2,
    behindMain: 0,
    hasUpstream: false,
    dirty: false,
    conflicted: false,
    truncated: false,
    files: [],
  };

  test("shows only for a non-main branch ahead of main", () => {
    expect(isComposerMergeRelevant({ ...base })).toBe(true);
    expect(isComposerMergeRelevant({ ...base, aheadOfMain: 0 })).toBe(false);
    expect(isComposerMergeRelevant({ ...base, branchRef: "main" })).toBe(false);
    expect(isComposerMergeRelevant({ ...base, checkoutRoot: "/repo", mainCheckoutRoot: "/repo" })).toBe(false);
    expect(isComposerMergeRelevant(null)).toBe(false);
    expect(isComposerMergeRelevant(undefined)).toBe(false);
  });
});

describe("resolveComposerGitOptions", () => {
  const base: import("../../shared/domain/git.ts").GitStatus = {
    checkoutRoot: "/wt/feature",
    mainCheckoutRoot: "/repo",
    repositoryRoot: "/repo",
    branchRef: "feature",
    detached: false,
    ahead: 0,
    behind: 0,
    aheadOfMain: 0,
    behindMain: 0,
    hasUpstream: false,
    dirty: false,
    conflicted: false,
    truncated: false,
    files: [],
  };

  test("offers merge only when ahead of main", () => {
    expect(resolveComposerGitOptions({ ...base, aheadOfMain: 2 })).toEqual(["merge"]);
  });

  test("offers rebase only when main has diverged", () => {
    expect(resolveComposerGitOptions({ ...base, behindMain: 3 })).toEqual(["rebase"]);
  });

  test("offers push only when a remote branch exists and is behind", () => {
    expect(resolveComposerGitOptions({ ...base, hasUpstream: true, ahead: 1 })).toEqual(["push"]);
    expect(resolveComposerGitOptions({ ...base, hasUpstream: false, ahead: 1 })).toEqual([]);
    expect(resolveComposerGitOptions({ ...base, hasUpstream: true, ahead: 0 })).toEqual([]);
  });

  test("offers multiple options together in merge/rebase/push order", () => {
    expect(resolveComposerGitOptions({ ...base, aheadOfMain: 2, behindMain: 1, hasUpstream: true, ahead: 1 })).toEqual([
      "merge",
      "rebase",
      "push",
    ]);
  });

  test("hides everything on main, detached, or missing branch", () => {
    expect(resolveComposerGitOptions({ ...base, aheadOfMain: 2, branchRef: "main" })).toEqual([]);
    expect(resolveComposerGitOptions({ ...base, aheadOfMain: 2, checkoutRoot: "/repo", mainCheckoutRoot: "/repo" })).toEqual([]);
    expect(resolveComposerGitOptions({ ...base, aheadOfMain: 2, branchRef: null, detached: true })).toEqual([]);
    expect(resolveComposerGitOptions(null)).toEqual([]);
    expect(resolveComposerGitOptions(undefined)).toEqual([]);
  });
});

describe("resolveCurrentThinking", () => {
  test("prefers the persisted preference over stale history", () => {
    expect(resolveCurrentThinking("low", "high")).toBe("low");
  });

  test("uses history when no thinking preference has been persisted", () => {
    expect(resolveCurrentThinking(null, "high")).toBe("high");
  });

  test("falls back to default when neither preference nor history is known", () => {
    expect(resolveCurrentThinking(null, undefined)).toBe("default");
  });
});

describe("resolveStreamActive", () => {
  test("stops streaming stats while cancellation is in progress", () => {
    expect(resolveStreamActive("idle")).toBe(false);
    expect(resolveStreamActive("running")).toBe(true);
    expect(resolveStreamActive("stopping")).toBe(false);
  });

  test("locks the composer until cancellation is confirmed", () => {
    expect(isComposerLocked("stopping")).toBe(true);
    expect(isComposerLocked("idle")).toBe(false);
    expect(isComposerLocked("running")).toBe(false);
  });
});

describe("resolveStreamStartMs", () => {
  test("anchors to the daemon run start so a reload does not reset the timer", () => {
    const runStartedAt = 1_700_000_000_000;
    // The observed time is later (page loaded mid-run); the authoritative run
    // start must win so elapsed time and tokens/sec stay continuous.
    expect(resolveStreamStartMs(runStartedAt, runStartedAt + 30_000)).toBe(runStartedAt);
  });

  test("falls back to first observation when the daemon has no run start", () => {
    expect(resolveStreamStartMs(undefined, 1_700_000_000_000)).toBe(1_700_000_000_000);
    expect(resolveStreamStartMs(0, 1_700_000_000_000)).toBe(1_700_000_000_000);
  });
});

describe("TimelineRow", () => {
  test("renders a Pi abort as a labeled alert instead of assistant prose", () => {
    const html = ReactDOMServer.renderToStaticMarkup(
      React.createElement(TimelineRow, {
        agentId: "agt-test",
        api: stubApi,
        item: { kind: "assistant", id: "turn-1:terminal", text: "Request was aborted", error: "Request was aborted" },
      }),
    );

    expect(html).toContain('data-slot="alert"');
    expect(html).toContain('role="alert"');
    expect(html).toContain("assistant-abort-alert");
    expect(html).toContain("Agent run stopped");
    expect(html).toContain("Pi notice: Request was aborted");
    expect(html).not.toContain("assistant-prose");
  });

  test("renders a manual compaction as a divider with token counts", () => {
    const html = ReactDOMServer.renderToStaticMarkup(
      React.createElement(TimelineRow, {
        agentId: "agt-test",
        api: stubApi,
        item: { kind: "summary", id: "c1", summaryType: "compaction", text: "Long summary", tokensBefore: 119521, compactionReason: "manual" },
      }),
    );

    expect(html).toContain("compaction-divider");
    expect(html).toContain("Context manually compacted");
    expect(html).toContain("Compacted from 119,521 tokens");
    expect(html).toContain("Show summary");
    expect(html).toContain("Long summary");
    expect(html).not.toContain("Compacted context");
    expect(html).not.toContain("Pi error");
  });

  test("renders auto compactions and reason-less entries with neutral labels", () => {
    const auto = ReactDOMServer.renderToStaticMarkup(
      React.createElement(TimelineRow, {
        agentId: "agt-test",
        api: stubApi,
        item: { kind: "summary", id: "c2", summaryType: "compaction", text: "Auto", compactionReason: "auto" },
      }),
    );
    expect(auto).toContain("Context auto-compacted");
    expect(auto).not.toContain("Compacted from");

    const unknown = ReactDOMServer.renderToStaticMarkup(
      React.createElement(TimelineRow, {
        agentId: "agt-test",
        api: stubApi,
        item: { kind: "summary", id: "c3", summaryType: "compaction", text: "Legacy" },
      }),
    );
    expect(unknown).toContain("Context compacted");
    expect(unknown).not.toContain("manually");
  });

  test("keeps branch summaries on the legacy card", () => {
    const html = ReactDOMServer.renderToStaticMarkup(
      React.createElement(TimelineRow, {
        agentId: "agt-test",
        api: stubApi,
        item: { kind: "summary", id: "b1", summaryType: "branch", text: "Branch point" },
      }),
    );
    expect(html).toContain("Branch summary");
    expect(html).toContain("Branch point");
    expect(html).not.toContain("compaction-divider");
  });

  test("renders thinking block with open attribute when expanded", () => {
    const htmlOpen = ReactDOMServer.renderToStaticMarkup(
      React.createElement(TimelineRow, {
        agentId: "agt-test",
        api: stubApi,
        item: { kind: "thinking", id: "think-2", text: "Latest thinking" },
        expansion: {
          thinking: "latest",
          tools: {
            read: "latest",
            write: "latest",
            edit: "latest",
            bash: "latest",
            find: "latest",
            grep: "latest",
            ls: "latest",
            ask: "latest",
          },
          otherTools: "latest",
        },
        latestIds: { latestThinkingId: "think-2", latestToolIds: {} },
      }),
    );
    expect(htmlOpen).toContain("<details class=\"thinking-row\" open=\"\"");

    const htmlClosed = ReactDOMServer.renderToStaticMarkup(
      React.createElement(TimelineRow, {
        agentId: "agt-test",
        api: stubApi,
        item: { kind: "thinking", id: "think-1", text: "Older thinking" },
        expansion: {
          thinking: "latest",
          tools: {
            read: "latest",
            write: "latest",
            edit: "latest",
            bash: "latest",
            find: "latest",
            grep: "latest",
            ls: "latest",
            ask: "latest",
          },
          otherTools: "latest",
        },
        latestIds: { latestThinkingId: "think-2", latestToolIds: {} },
      }),
    );
    expect(htmlClosed).not.toContain("open=\"\"");
  });

  test("renders uploaded image thumbnails in the user message card", () => {
    const html = ReactDOMServer.renderToStaticMarkup(
      React.createElement(TimelineRow, {
        agentId: "agt-test",
        api: stubApi,
        item: {
          kind: "user",
          id: "u-images",
          text: "Look",
          images: [{ hash: `${"a".repeat(64)}`, mimeType: "image/png", name: "shot.png" }],
        },
      }),
    );
    expect(html).toContain("user-image-strip");
    expect(html).toContain(`/api/agents/agt-test/images/${"a".repeat(64)}`);
    expect(html).toContain("shot.png");
  });

  test("renders uploaded file chips in the user message card", () => {
    const html = ReactDOMServer.renderToStaticMarkup(
      React.createElement(TimelineRow, {
        agentId: "agt-test",
        api: stubApi,
        item: {
          kind: "user",
          id: "u-files",
          text: "Analyze",
          files: [{ hash: `${"b".repeat(64)}`, name: "data.csv", path: `/cache/${"b".repeat(64)}`, size: 12, mimeType: "text/csv" }],
        },
      }),
    );
    expect(html).toContain("user-file-strip");
    expect(html).toContain(`/api/agents/agt-test/files/${"b".repeat(64)}`);
    expect(html).toContain("data.csv");
  });

  test("renders optimistic previews from data URLs", () => {
    const html = ReactDOMServer.renderToStaticMarkup(
      React.createElement(TimelineRow, {
        agentId: "agt-test",
        api: stubApi,
        item: {
          kind: "user",
          id: "optimistic-pending",
          text: "Attached image",
          images: [{ hash: "", mimeType: "image/png", name: "shot.png", previewUrl: "data:image/png;base64,AAA" }],
        },
      }),
    );
    expect(html).toContain("user-image-strip");
    expect(html).toContain("data:image/png;base64,AAA");
  });

  test("renders a model image read with a workspace preview thumbnail", () => {
    const html = ReactDOMServer.renderToStaticMarkup(
      React.createElement(TimelineRow, {
        agentId: "agt-test",
        api: stubApi,
        workspaceId: "ws-1",
        item: { kind: "tool", id: "tool-1", name: "read", input: { path: "shots/shot.png" }, result: "", status: "complete" },
        expansion: {
          thinking: "latest",
          tools: { read: "always", write: "latest", edit: "latest", bash: "latest", find: "latest", grep: "latest", ls: "latest", ask: "latest" },
          otherTools: "latest",
        },
        latestIds: { latestToolIds: { read: "tool-1" } },
      }),
    );
    expect(html).toContain("user-image-strip");
    expect(html).toContain("/api/workspaces/ws-1/files/raw?path=shots%2Fshot.png");
    expect(html).toContain("Image read by the model");
  });

  test("renders an absolute model image read with a workspace preview thumbnail", () => {
    const html = ReactDOMServer.renderToStaticMarkup(
      React.createElement(TimelineRow, {
        agentId: "agt-test",
        api: stubApi,
        workspaceId: "ws-1",
        item: { kind: "tool", id: "tool-absolute-image", name: "read", input: { path: "/tmp/test.png" }, result: "Read image file [image/png]", status: "complete" },
        expansion: {
          thinking: "latest",
          tools: { read: "always", write: "latest", edit: "latest", bash: "latest", find: "latest", grep: "latest", ls: "latest", ask: "latest" },
          otherTools: "latest",
        },
        latestIds: { latestToolIds: { read: "tool-absolute-image" } },
      }),
    );
    expect(html).toContain("user-image-strip");
    expect(html).toContain("/api/workspaces/ws-1/files/raw?path=%2Ftmp%2Ftest.png");
  });

  test("omits the preview for non-image reads", () => {
    const html = ReactDOMServer.renderToStaticMarkup(
      React.createElement(TimelineRow, {
        agentId: "agt-test",
        api: stubApi,
        workspaceId: "ws-1",
        item: { kind: "tool", id: "tool-2", name: "read", input: { path: "src/index.ts" }, result: "export const x = 1;", status: "complete" },
        expansion: {
          thinking: "latest",
          tools: { read: "always", write: "latest", edit: "latest", bash: "latest", find: "latest", grep: "latest", ls: "latest", ask: "latest" },
          otherTools: "latest",
        },
        latestIds: { latestToolIds: { read: "tool-2" } },
      }),
    );
    expect(html).not.toContain("user-image-strip");
    expect(html).not.toContain("files/raw");
  });

  test("renders a daemon-level error as its own chronological alert row", () => {
    const html = ReactDOMServer.renderToStaticMarkup(
      React.createElement(TimelineRow, {
        agentId: "agt-test",
        api: stubApi,
        item: { kind: "error", id: "err-1", text: "Pi process exited (1)" },
        expansion: {
          thinking: "latest",
          tools: {
            read: "latest",
            write: "latest",
            edit: "latest",
            bash: "latest",
            find: "latest",
            grep: "latest",
            ls: "latest",
            ask: "latest",
          },
          otherTools: "latest",
        },
        latestIds: { latestToolIds: {} },
      }),
    );
    expect(html).toContain("Agent error");
    expect(html).toContain("Pi process exited (1)");
  });
});

describe("attached follow-up queue", () => {
  test("creates uniquely identified items that snapshot the composer images", () => {
    const images = [{ type: "image" as const, data: "AA", mimeType: "image/png" as const, name: "shot.png" }];
    const first = createQueuedFollowUp("Verify the fix", images);
    const second = createQueuedFollowUp("Verify the fix", images);
    expect(first.text).toBe("Verify the fix");
    expect(first.images).toEqual(images);
    expect(first.images).not.toBe(images);
    expect(second.id).not.toBe(first.id);
  });

  test("retract removes only the targeted item, preserving order", () => {
    const queue = [createQueuedFollowUp("one", []), createQueuedFollowUp("two", []), createQueuedFollowUp("three", [])];
    const next = removeQueuedFollowUp(queue, queue[1].id);
    expect(next.map((item) => item.text)).toEqual(["one", "three"]);
    expect(queue).toHaveLength(3);
  });

  test("renders nothing when the queue is empty", () => {
    const html = ReactDOMServer.renderToStaticMarkup(
      React.createElement(QueuedFollowUpList, { queue: [], onRetract: () => undefined, onClear: () => undefined }),
    );
    expect(html).toBe("");
  });

  test("renders attached chips with per-item retract and clear-all", () => {
    const queue = [
      createQueuedFollowUp("Verify the fix", []),
      createQueuedFollowUp("Check edge cases", [
        { type: "image" as const, data: "AA", mimeType: "image/png" as const, name: "shot.png" },
      ]),
    ];
    const html = ReactDOMServer.renderToStaticMarkup(
      React.createElement(QueuedFollowUpList, { queue, onRetract: () => undefined, onClear: () => undefined }),
    );
    expect(html).toContain("composer-queue");
    expect(html).toContain("sends when this run settles");
    expect(html).toContain("Verify the fix");
    expect(html).toContain("1 image");
    expect(html).toContain('aria-label="Retract queued follow-up 1"');
    expect(html).toContain('aria-label="Retract queued follow-up 2"');
    expect(html).toContain("Clear all");
  });

  test("omits clear-all for a single queued item", () => {
    const html = ReactDOMServer.renderToStaticMarkup(
      React.createElement(QueuedFollowUpList, {
        queue: [createQueuedFollowUp("solo", [])],
        onRetract: () => undefined,
        onClear: () => undefined,
      }),
    );
    expect(html).toContain("composer-queue");
    expect(html).not.toContain("Clear all");
  });
});

describe("resolveActiveQuestionRequest", () => {
  const baseAgent: AgentSummary = {
    id: "agent-1",
    workspaceId: "ws-1",
    title: "Test Agent",
    status: "needs-attention",
    modelPreference: null,
    thinkingPreference: null,
    live: true,
    persisted: true,
  };

  test("resolves select dialog from pendingUiRequest", () => {
    const agent: AgentSummary = {
      ...baseAgent,
      pendingUiRequest: {
        id: "select-1",
        method: "select",
        title: "Select an environment",
        options: ["Production", "Staging"],
      },
    };

    const req = resolveActiveQuestionRequest(agent);
    expect(req).not.toBeNull();
    expect(req?.id).toBe("select-1");
    expect(req?.method).toBe("select");
    expect(req?.questions[0].question).toBe("Select an environment");
    expect(req?.questions[0].options).toEqual([
      { label: "Production" },
      { label: "Staging" },
    ]);
  });

  test("resolves confirm dialog from pendingUiRequest", () => {
    const agent: AgentSummary = {
      ...baseAgent,
      pendingUiRequest: {
        id: "confirm-1",
        method: "confirm",
        title: "Delete resource?",
        message: "This cannot be undone.",
      },
    };

    const req = resolveActiveQuestionRequest(agent);
    expect(req).not.toBeNull();
    expect(req?.id).toBe("confirm-1");
    expect(req?.method).toBe("confirm");
    expect(req?.questions[0].options[0].label).toBe("Yes");
    expect(req?.questions[0].options[0].description).toBe("This cannot be undone.");
    expect(req?.questions[0].options[1].label).toBe("No");
  });

  test("resolves input dialog from pendingUiRequest", () => {
    const agent: AgentSummary = {
      ...baseAgent,
      pendingUiRequest: {
        id: "input-1",
        method: "input",
        title: "Enter branch name",
      },
    };

    const req = resolveActiveQuestionRequest(agent);
    expect(req).not.toBeNull();
    expect(req?.id).toBe("input-1");
    expect(req?.method).toBe("input");
    expect(req?.questions[0].question).toBe("Enter branch name");
    expect(req?.questions[0].options).toEqual([]);
  });

  test("resolves select dialog with formatted strings and filters sentinels", () => {
    const agent: AgentSummary = {
      ...baseAgent,
      pendingUiRequest: {
        id: "select-formatted",
        method: "select",
        title: "[Next topic] Which option should we focus on next?",
        options: [
          "1. Project status — Get a concise update on the current state of the Passage workspace.",
          "2. Code review — Review files, run tests, or check for issues in the codebase.",
          "3. Documentation — Plan, create, or refine documentation and guides.",
          "4. New idea — Brainstorm or prototype something entirely new and experimental.",
          "5. Type something.",
        ],
      },
    };

    const req = resolveActiveQuestionRequest(agent);
    expect(req).not.toBeNull();
    expect(req?.questions[0].header).toBe("Next topic");
    expect(req?.questions[0].question).toBe("Which option should we focus on next?");
    expect(req?.questions[0].options).toHaveLength(4);
    expect(req?.questions[0].options[0].label).toBe("Project status");
    expect(req?.questions[0].options[0].description).toBe(
      "Get a concise update on the current state of the Passage workspace."
    );
    expect(req?.questions[0].options[3].label).toBe("New idea");
    expect(req?.questions[0].allowOther).toBe(true);
  });

  test("uses only Pi's native dialog request, never tool call input", () => {
    expect(resolveActiveQuestionRequest(baseAgent)).toBeNull();
  });

  test("hides a blocking tool row while Pi's native dialog is open", () => {
    const timeline: TimelineItem[] = [
      { kind: "tool", id: "question-tool", name: "ask_user_question", input: {}, status: "running" },
      { kind: "tool", id: "read-tool", name: "read", input: {}, status: "running" },
      { kind: "assistant", id: "assistant", text: "Waiting for your answer" },
    ];

    expect(timelineWithoutBlockingTool(timeline, true).map((item) => item.id)).toEqual(["read-tool", "assistant"]);
    expect(timelineWithoutBlockingTool(timeline, false)).toEqual(timeline);
  });
});

describe("retainComposerFocusOnTap", () => {
  test("prevents the pointerdown default so the tap keeps editor focus", () => {
    let prevented = false;
    retainComposerFocusOnTap({ preventDefault: () => { prevented = true; } });
    expect(prevented).toBe(true);
  });
});
