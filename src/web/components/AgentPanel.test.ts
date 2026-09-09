import { describe, expect, test } from "bun:test";
import { formatDuration, resolveActiveQuestionRequest } from "./AgentPanel.tsx";
import type { AgentSummary, TimelineItem } from "../../shared/domain/agents.ts";

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

  test("returns null when neither pendingUiRequest nor running question tool exists", () => {
    expect(resolveActiveQuestionRequest(baseAgent, [])).toBeNull();
  });
});
