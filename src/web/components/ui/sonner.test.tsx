import { describe, expect, mock, test } from "bun:test";
import React from "react";
import { fireEvent, render } from "@testing-library/react";
import { setupDomTests } from "../../test-utils/dom.ts";

// NOTE: render-bound queries only -- see setupDomTests docs.
setupDomTests();

// Observe toast updates (duration switches) without mounting a Toaster.
const toastSuccess = mock((..._args: unknown[]) => {});
mock.module("sonner", () => ({ toast: { success: toastSuccess }, Toaster: () => null }));

const { COMMIT_TOAST_DURATION_MS, commitToast, commitToastDescription, summarizeCommitMessage } = await import("./sonner.tsx");

type CommitToastOptions = { id: string; duration: number; description: React.ReactNode };

function lastToastOptions() {
  return toastSuccess.mock.calls.at(-1)?.[1] as CommitToastOptions;
}

describe("summarizeCommitMessage", () => {
  test("keeps a short subject as-is", () => {
    expect(summarizeCommitMessage("fix(sdk): collapse nested usage")).toBe("fix(sdk): collapse nested usage");
  });

  test("drops the body, keeping only the first line", () => {
    const message = "fix(sdk): collapse nested usage into context-only meter\n\nThe bug was that cost and token totals flickered…";
    expect(summarizeCommitMessage(message)).toBe("fix(sdk): collapse nested usage into context-only meter");
  });

  test("truncates a very long subject with an ellipsis", () => {
    const summary = summarizeCommitMessage(`${"a".repeat(200)}\nbody`);
    expect(summary?.length).toBeLessThanOrEqual(160);
    expect(summary?.endsWith("…")).toBe(true);
    expect(summary).not.toContain("body");
  });

  test("returns undefined for a blank message", () => {
    expect(summarizeCommitMessage("  \n  ")).toBeUndefined();
  });
});

describe("commitToastDescription", () => {
  test("returns undefined for a blank message", () => {
    expect(commitToastDescription("  \n  ")).toBeUndefined();
  });

  test("a one-line message renders with no toggle", () => {
    const node = commitToastDescription("fix(sdk): collapse nested usage");
    const { getByText, queryByRole } = render(<>{node}</>);
    expect(getByText("fix(sdk): collapse nested usage")).toBeInTheDocument();
    expect(queryByRole("button")).toBeNull();
  });

  test("tapping Show more reveals the full message; Show less collapses it", () => {
    const node = commitToastDescription("fix(sdk): collapse nested usage\n\nThe bug was that cost totals flickered badly");
    const { getByRole, queryByText } = render(<>{node}</>);

    // Collapsed: only the subject line is visible.
    expect(queryByText(/flickered badly/)).toBeNull();

    fireEvent.click(getByRole("button", { name: "Show more" }));
    expect(queryByText(/flickered badly/)).not.toBeNull();
    expect(getByRole("button", { name: "Show less" })).toBeInTheDocument();

    fireEvent.click(getByRole("button", { name: "Show less" }));
    expect(queryByText(/flickered badly/)).toBeNull();
    expect(getByRole("button", { name: "Show more" })).toBeInTheDocument();
  });

  test("expanding holds the toast until closed; collapsing restores the timer", () => {
    toastSuccess.mockClear();
    commitToast("Sent feature to main", "fix(sdk): collapse nested usage\n\nThe bug was that cost totals flickered badly");
    expect(toastSuccess).toHaveBeenCalledTimes(1);
    const initial = lastToastOptions();
    expect(initial.duration).toBe(COMMIT_TOAST_DURATION_MS);

    const { getByRole } = render(<>{initial.description}</>);

    fireEvent.click(getByRole("button", { name: "Show more" }));
    expect(toastSuccess).toHaveBeenCalledTimes(2);
    const expanded = lastToastOptions();
    expect(expanded.id).toBe(initial.id);
    expect(expanded.duration).toBe(Infinity);

    fireEvent.click(getByRole("button", { name: "Show less" }));
    expect(toastSuccess).toHaveBeenCalledTimes(3);
    const collapsed = lastToastOptions();
    expect(collapsed.id).toBe(initial.id);
    expect(collapsed.duration).toBe(COMMIT_TOAST_DURATION_MS);
  });
});
