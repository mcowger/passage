import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import React, { useState } from "react";
import { act, fireEvent, render } from "@testing-library/react";
import { RootErrorBoundary } from "./RootErrorBoundary.tsx";
import { resetRootErrorDedupeForTests } from "../root-error.ts";
import { setupDomTests } from "../test-utils/dom.ts";

setupDomTests();

function ImmediateBomb(): React.JSX.Element {
  throw new Error("initial-boom-marker");
}

function UpdateBomb(): React.JSX.Element {
  const [armed, setArmed] = useState(false);
  if (armed) throw new Error("update-boom-marker");
  return (
    <button type="button" onClick={() => setArmed(true)}>
      arm the bomb
    </button>
  );
}

function readHistoryMessages(): string[] {
  try {
    const raw = sessionStorage.getItem("passage.root-error-history.v1");
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.map((entry) => String((entry as { message?: unknown }).message ?? ""));
  } catch {
    return [];
  }
}

beforeEach(() => {
  resetRootErrorDedupeForTests();
  try {
    sessionStorage.clear();
  } catch {
    // Storage unavailable — tests below that need it will show it.
  }
});

afterEach(() => {
  try {
    sessionStorage.clear();
  } catch {
    // Ignore.
  }
});

describe("RootErrorBoundary", () => {
  test("shows the fallback when the initial render throws, and retains diagnostics", () => {
    const { getByRole, container } = render(
      React.createElement(RootErrorBoundary, null, React.createElement(ImmediateBomb)),
    );

    getByRole("heading", { name: "Passage encountered an error" });
    getByRole("button", { name: "Reload app" });
    getByRole("button", { name: "Copy diagnostics" });
    // The failed component's output is gone; the boundary owns the tree.
    expect(container.textContent).not.toContain("initial-boom-marker-fixture-child");

    // Diagnostic details expose the failure metadata (message + context).
    const details = container.querySelector("details");
    expect(details).not.toBeNull();
    const text = details?.textContent ?? "";
    for (const label of [
      "initial-boom-marker",
      "timestamp:",
      "pageInstanceId:",
      "build:",
      "userAgent:",
      "display:",
      "componentStack:",
    ]) {
      expect(text).toContain(label);
    }

    // Diagnostics survive a reload in the same session via bounded history.
    expect(readHistoryMessages()).toContain("initial-boom-marker");
  });

  test("shows the fallback when a later update throws", () => {
    const { getByRole, getByText } = render(
      React.createElement(RootErrorBoundary, null, React.createElement(UpdateBomb)),
    );

    // Healthy first render — no fallback yet.
    getByRole("button", { name: "arm the bomb" });

    fireEvent.click(getByRole("button", { name: "arm the bomb" }));

    getByRole("heading", { name: "Passage encountered an error" });
    getByText(/update-boom-marker/);
    expect(readHistoryMessages()).toContain("update-boom-marker");
  });

  test("reload button explicitly reloads once, with no automatic reload", () => {
    const calls: string[] = [];
    const location = window.location as unknown as Record<string, unknown>;
    const originalReload = location.reload;
    Object.defineProperty(window.location, "reload", {
      configurable: true,
      writable: true,
      value: () => {
        calls.push("reload");
      },
    });
    try {
      const { getByRole } = render(
        React.createElement(RootErrorBoundary, null, React.createElement(ImmediateBomb)),
      );

      // Rendering the fallback must not reload on its own.
      expect(calls).toHaveLength(0);

      fireEvent.click(getByRole("button", { name: "Reload app" }));
      expect(calls).toHaveLength(1);
    } finally {
      Object.defineProperty(window.location, "reload", {
        configurable: true,
        writable: true,
        value: originalReload,
      });
    }
  });

  test("still shows the fallback when diagnostic storage throws", () => {
    const storage = sessionStorage as unknown as Record<string, unknown>;
    const originalSetItem = storage.setItem;
    storage.setItem = () => {
      throw new Error("storage denied");
    };
    try {
      const { getByRole, container } = render(
        React.createElement(RootErrorBoundary, null, React.createElement(ImmediateBomb)),
      );

      getByRole("heading", { name: "Passage encountered an error" });
      getByRole("button", { name: "Reload app" });
      expect(container.querySelector("details")).not.toBeNull();
    } finally {
      storage.setItem = originalSetItem;
    }
  });

  test("copy diagnostics handles clipboard failure gracefully", async () => {
    const { getByRole, container } = render(
      React.createElement(RootErrorBoundary, null, React.createElement(ImmediateBomb)),
    );

    // The copy handler awaits before its final setState, so flush it in act.
    await act(async () => {
      fireEvent.click(getByRole("button", { name: "Copy diagnostics" }));
    });

    // Either outcome is fine; the UI must acknowledge it instead of hanging.
    expect(container.textContent).toMatch(/Copied to clipboard|Copy failed/);
  });
});
