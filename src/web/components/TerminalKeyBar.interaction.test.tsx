import { describe, expect, test, mock } from "bun:test";
import React from "react";
import { fireEvent, render } from "@testing-library/react";
import { setupDomTests } from "../test-utils/dom.ts";
import { TerminalKeyBar, useStickyModifiers } from "./TerminalKeyBar.tsx";

setupDomTests();

function Harness({ onSend }: { onSend: (data: string) => void }) {
  const sticky = useStickyModifiers();
  return (
    <TerminalKeyBar
      mods={sticky.mods}
      onTapModifier={sticky.tapModifier}
      onSendKey={(raw) => onSend(sticky.consume(raw))}
    />
  );
}

describe("TerminalKeyBar", () => {
  test("exposes the core keys on the main row", () => {
    const { getByRole } = render(<Harness onSend={() => {}} />);
    for (const name of ["Tab", "Control C", "Control D", "Left arrow", "Up arrow", "Down arrow", "Right arrow", "Escape"]) {
      expect(getByRole("button", { name })).toBeDefined();
    }
  });

  test("direct keys send without the sticky path", () => {
    const onSend = mock((_data: string) => {});
    const { getByRole } = render(<Harness onSend={onSend} />);
    fireEvent.click(getByRole("button", { name: "Control C" }));
    fireEvent.click(getByRole("button", { name: "Tab" }));
    expect(onSend).toHaveBeenCalledTimes(2);
    expect(onSend.mock.calls[0][0]).toBe("\x03");
    expect(onSend.mock.calls[1][0]).toBe("\t");
  });

  test("tapping Ctrl then Left arrow sends word-left and disarms", () => {
    const onSend = mock((_data: string) => {});
    const { getByRole } = render(<Harness onSend={onSend} />);
    const ctrl = getByRole("button", { name: "Ctrl modifier" });
    expect(ctrl.getAttribute("aria-pressed")).toBe("false");
    fireEvent.click(ctrl);
    expect(ctrl.getAttribute("aria-pressed")).toBe("true");
    fireEvent.click(getByRole("button", { name: "Left arrow" }));
    expect(onSend).toHaveBeenCalledTimes(1);
    expect(onSend.mock.calls[0][0]).toBe("\x1b[1;5D");
    // One-shot: the arm clears after the next key.
    expect(ctrl.getAttribute("aria-pressed")).toBe("false");
  });

  test("double-tapping Ctrl locks it across keys", () => {
    const onSend = mock((_data: string) => {});
    const { getByRole } = render(<Harness onSend={onSend} />);
    const ctrl = getByRole("button", { name: "Ctrl modifier" });
    fireEvent.click(ctrl);
    fireEvent.click(ctrl);
    fireEvent.click(getByRole("button", { name: "Left arrow" }));
    fireEvent.click(getByRole("button", { name: "Right arrow" }));
    expect(onSend.mock.calls[0][0]).toBe("\x1b[1;5D");
    expect(onSend.mock.calls[1][0]).toBe("\x1b[1;5C");
    expect(ctrl.getAttribute("aria-pressed")).toBe("true");
  });

  test("expanded rows expose Home and extra Ctrl combos", () => {
    const onSend = mock((_data: string) => {});
    const { getByRole, queryByRole } = render(<Harness onSend={onSend} />);
    expect(queryByRole("button", { name: "Home" })).toBeNull();
    fireEvent.click(getByRole("button", { name: "Show more keys" }));
    fireEvent.click(getByRole("button", { name: "Home" }));
    expect(onSend.mock.calls[0][0]).toBe("\x1b[H");
    fireEvent.click(getByRole("button", { name: "Control Z" }));
    expect(onSend.mock.calls[1][0]).toBe("\x1a");
  });
});
