import { describe, expect, test } from "bun:test";
import React from "react";
import ReactDOMServer from "react-dom/server";
import { formatDuration, isComposerLocked, resolveActiveQuestionRequest, resolveCurrentModel, resolveCurrentThinking, resolveStreamActive, TimelineRow } from "./AgentPanel.tsx";
import type { AgentCapabilities, AgentSummary, TimelineItem } from "../../shared/domain/agents.ts";

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

describe("TimelineRow", () => {
  test("renders a Pi abort as a labeled alert instead of assistant prose", () => {
    const html = ReactDOMServer.renderToStaticMarkup(
      React.createElement(TimelineRow, {
        concise: false,
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

  test("renders thinking block with open attribute when expanded", () => {
    const htmlOpen = ReactDOMServer.renderToStaticMarkup(
      React.createElement(TimelineRow, {
        concise: false,
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
          },
          otherTools: "latest",
        },
        latestIds: { latestThinkingId: "think-2", latestToolIds: {} },
      }),
    );
    expect(htmlOpen).toContain("<details class=\"thinking-row\" open=\"\"");

    const htmlClosed = ReactDOMServer.renderToStaticMarkup(
      React.createElement(TimelineRow, {
        concise: false,
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
          },
          otherTools: "latest",
        },
        latestIds: { latestThinkingId: "think-2", latestToolIds: {} },
      }),
    );
    expect(htmlClosed).not.toContain("open=\"\"");
  });

  test("renders process card with open attribute when an activity is expanded", () => {
    const htmlProcessOpen = ReactDOMServer.renderToStaticMarkup(
      React.createElement(TimelineRow, {
        concise: false,
        item: {
          kind: "process",
          id: "proc-1",
          activities: [
            {
              kind: "tool",
              id: "act-read-1",
              name: "read",
              input: null,
              status: "complete",
              significant: false,
            },
          ],
        },
        expansion: {
          thinking: "latest",
          tools: {
            read: "always",
            write: "latest",
            edit: "latest",
            bash: "latest",
            find: "latest",
            grep: "latest",
            ls: "latest",
          },
          otherTools: "latest",
        },
        latestIds: { latestToolIds: {} },
      }),
    );
    expect(htmlProcessOpen).toContain("<details class=\"timeline-row process\" open=\"\"");

    const htmlProcessClosed = ReactDOMServer.renderToStaticMarkup(
      React.createElement(TimelineRow, {
        concise: false,
        item: {
          kind: "process",
          id: "proc-1",
          activities: [
            {
              kind: "tool",
              id: "act-read-1",
              name: "read",
              input: null,
              status: "complete",
              significant: false,
            },
          ],
        },
        expansion: {
          thinking: "latest",
          tools: {
            read: "none",
            write: "latest",
            edit: "latest",
            bash: "latest",
            find: "latest",
            grep: "latest",
            ls: "latest",
          },
          otherTools: "latest",
        },
        latestIds: { latestToolIds: {} },
      }),
    );
    expect(htmlProcessClosed).not.toContain("open=\"\"");
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

  test("resolves structured questions from pendingUiRequest", () => {
    const agent: AgentSummary = {
      ...baseAgent,
      pendingUiRequest: {
        id: "prompt-1",
        questions: [
          {
            question: "Which destination?",
            header: "Destination",
            options: [
              { label: "A floating city", description: "Above clouds" },
              { label: "An underground library", description: "Beneath mountain" },
            ],
            multiple: false,
          },
        ],
      },
    };

    const req = resolveActiveQuestionRequest(agent);
    expect(req).not.toBeNull();
    expect(req?.id).toBe("prompt-1");
    expect(req?.questions).toHaveLength(1);
    expect(req?.questions[0].header).toBe("Destination");
    expect(req?.questions[0].options).toHaveLength(2);
    expect(req?.questions[0].options[0].label).toBe("A floating city");
  });

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

  test("resolves question tool from timeline when tool is running", () => {
    const timeline: TimelineItem[] = [
      {
        kind: "tool",
        id: "call-1",
        name: "ask_user_question",
        status: "running",
        significant: true,
        input: {
          questions: [
            {
              question: "Pick a fruit",
              header: "Fruit",
              options: [{ label: "Apple" }, { label: "Banana" }],
            },
          ],
        },
      },
    ];

    const req = resolveActiveQuestionRequest(baseAgent, timeline);
    expect(req).not.toBeNull();
    expect(req?.id).toBe("call-1");
    expect(req?.questions[0].question).toBe("Pick a fruit");
    expect(req?.questions[0].header).toBe("Fruit");
    expect(req?.questions[0].options).toHaveLength(2);
  });

  test("resolves flat tool input arguments from timeline", () => {
    const timeline: TimelineItem[] = [
      {
        kind: "tool",
        id: "call-flat",
        name: "ask_user_question",
        status: "running",
        significant: true,
        input: {
          question: "Which option should we focus on next?",
          header: "Next topic",
          options: [
            { label: "Project status", description: "Get a concise update." },
            { label: "Code review", description: "Review files and tests." },
            { label: "Documentation", description: "Refine docs." },
            { label: "New idea", description: "Brainstorm new ideas." },
          ],
        },
      },
    ];

    const req = resolveActiveQuestionRequest(baseAgent, timeline);
    expect(req).not.toBeNull();
    expect(req?.id).toBe("call-flat");
    expect(req?.questions[0].header).toBe("Next topic");
    expect(req?.questions[0].question).toBe("Which option should we focus on next?");
    expect(req?.questions[0].options).toHaveLength(4);
    expect(req?.questions[0].options.map((o) => o.label)).toEqual([
      "Project status",
      "Code review",
      "Documentation",
      "New idea",
    ]);
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
  });

  test("returns null when neither pendingUiRequest nor running question tool exists", () => {
    expect(resolveActiveQuestionRequest(baseAgent, [])).toBeNull();
  });
});
