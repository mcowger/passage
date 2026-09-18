import { describe, expect, mock, test } from "bun:test";
import React, { act } from "react";
import { fireEvent, render } from "@testing-library/react";
import { QuestionCard, type QuestionRequest } from "./QuestionCard.tsx";
import { setupDomTests } from "../test-utils/dom.ts";

// Client-rendered proof of the happy-dom setup: real DOM and user
// interaction — neither of which ReactDOMServer.renderToString can
// exercise. Scoped via setupDomTests (not a global preload) so daemon
// and fake-global socket tests keep Bun's bare environment.
//
// NOTE: use render-bound queries (getByRole, ...), never the `screen`
// global — screen binds to document at import time, before setupDomTests'
// beforeAll registers happy-dom.
setupDomTests();

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

describe("QuestionCard interaction (happy-dom)", () => {
  test("selecting an option and submitting responds with the chosen value", async () => {
    const onRespond = mock(async (_result: unknown) => {});
    const { getByRole } = render(React.createElement(QuestionCard, { request: singleRequest(), onRespond }));

    expect(getByRole("radiogroup")).toBeInTheDocument();
    // Select first (its setState must flush before submit reads it),
    // then submit — each click's async continuation flushes inside act
    // because the handler awaits onRespond before its final setState.
    await act(async () => {
      fireEvent.click(getByRole("radio", { name: /red/i }));
    });
    await act(async () => {
      fireEvent.click(getByRole("button", { name: /submit answer/i }));
    });

    expect(onRespond).toHaveBeenCalledTimes(1);
    expect(onRespond.mock.calls[0][0]).toMatchObject({ id: "q-1", value: "Red" });
  });

  test("dismiss cancels the request", async () => {
    const onRespond = mock(async (_result: unknown) => {});
    const { getByRole } = render(React.createElement(QuestionCard, { request: singleRequest(), onRespond }));

    await act(async () => {
      fireEvent.click(getByRole("button", { name: /dismiss/i }));
    });

    expect(onRespond).toHaveBeenCalledTimes(1);
    expect(onRespond.mock.calls[0][0]).toMatchObject({ id: "q-1", cancelled: true });
  });
});
