import { describe, expect, test } from "bun:test";
import React from "react";
import ReactDOMServer from "react-dom/server";
import { QuestionCard, type QuestionRequest } from "./QuestionCard.tsx";

const respond = async () => {};

function singleRequest(): QuestionRequest {
  return {
    id: "q-1",
    method: "select",
    questions: [
      {
        question: "Pick a color",
        header: "Color",
        options: [
          { label: "Red", description: "Warm and bold" },
          { label: "Blue (Recommended)", description: "Calm and cool" },
        ],
      },
    ],
  };
}

describe("QuestionCard", () => {
  test("single-select renders a radiogroup with options", () => {
    const html = ReactDOMServer.renderToString(
      React.createElement(QuestionCard, { request: singleRequest(), onRespond: respond })
    );
    expect(html).toContain('role="radiogroup"');
    expect(html).toContain("Pick a color");
    expect(html).toContain("Red");
    expect(html).toContain("recommended");
    expect(html).toContain("Submit answer");
    expect(html).toContain("Dismiss");
  });

  test("renders all options, descriptions, and previews", () => {
    const request: QuestionRequest = {
      id: "q-all",
      questions: [
        {
          question: "Which option should we focus on next?",
          header: "Next topic",
          options: [
            { label: "Project status", description: "Get a concise update on the workspace." },
            { label: "Code review", description: "Review files and run tests." },
            { label: "Documentation", description: "Plan and refine guides." },
            { label: "New idea", description: "Brainstorm something new.", preview: "ASCII diagram here" },
          ],
        },
      ],
    };
    const html = ReactDOMServer.renderToString(
      React.createElement(QuestionCard, { request, onRespond: respond })
    );
    expect(html).toContain("Project status");
    expect(html).toContain("Get a concise update on the workspace.");
    expect(html).toContain("Code review");
    expect(html).toContain("Review files and run tests.");
    expect(html).toContain("Documentation");
    expect(html).toContain("Plan and refine guides.");
    expect(html).toContain("New idea");
    expect(html).toContain("Brainstorm something new.");
    expect(html).toContain("ASCII diagram here");
    expect(html).toContain("Submit answer");
    expect(html).toContain("Dismiss");
    expect(html).toContain("Other…");
  });

  test("multi-select renders checkboxes", () => {
    const request: QuestionRequest = {
      id: "q-2",
      questions: [
        {
          question: "Pick toppings",
          options: [{ label: "Cheese" }, { label: "Pepperoni" }],
          multiple: true,
        },
      ],
    };
    const html = ReactDOMServer.renderToString(
      React.createElement(QuestionCard, { request, onRespond: respond })
    );
    expect(html).toContain('role="checkbox"');
    expect(html).not.toContain('role="radiogroup"');
    expect(html).toContain("Select multiple options");
  });

  test("multi-question renders tab navigation plus summary tab", () => {
    const request: QuestionRequest = {
      id: "q-3",
      questions: [
        { question: "First?", header: "One", options: [{ label: "Yes" }, { label: "No" }] },
        { question: "Second?", header: "Two", options: [{ label: "A" }, { label: "B" }] },
      ],
    };
    const html = ReactDOMServer.renderToString(
      React.createElement(QuestionCard, { request, onRespond: respond })
    );
    expect(html).toContain('role="tablist"');
    expect(html).toContain("Summary");
    expect(html).toContain("First?");
  });

  test("input method renders a textarea for custom answers", () => {
    const request: QuestionRequest = {
      id: "q-4",
      method: "input",
      questions: [{ question: "Your name?", header: "Name", options: [] }],
    };
    const html = ReactDOMServer.renderToString(
      React.createElement(QuestionCard, { request, onRespond: respond })
    );
    expect(html).toContain("<textarea");
    expect(html).toContain("Other");
  });
});
