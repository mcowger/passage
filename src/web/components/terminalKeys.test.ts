import { describe, expect, test } from "bun:test";
import {
  applyStickyModifiers,
  clearArmed,
  ctrlByteFor,
  hasActiveModifier,
  nextStickyState,
  NO_MODIFIERS,
  withCsiModifiers,
  type StickyModifiers,
} from "./terminalKeys.ts";

const CTRL: StickyModifiers = { ...NO_MODIFIERS, ctrl: "armed" };
const ALT: StickyModifiers = { ...NO_MODIFIERS, alt: "armed" };
const SHIFT: StickyModifiers = { ...NO_MODIFIERS, shift: "armed" };

describe("ctrlByteFor", () => {
  test("maps letters case-insensitively to control bytes", () => {
    expect(ctrlByteFor("c")).toBe("\x03");
    expect(ctrlByteFor("C")).toBe("\x03");
    expect(ctrlByteFor("d")).toBe("\x04");
    expect(ctrlByteFor("z")).toBe("\x1a");
  });

  test("maps symbol keys and Ctrl+Space", () => {
    expect(ctrlByteFor("[")).toBe("\x1b");
    expect(ctrlByteFor(" ")).toBe("\x00");
  });

  test("returns null for unencodable input", () => {
    expect(ctrlByteFor("1")).toBeNull();
    expect(ctrlByteFor("ab")).toBeNull();
    expect(ctrlByteFor("")).toBeNull();
  });
});

describe("withCsiModifiers", () => {
  test("encodes Ctrl+Left as word-left", () => {
    expect(withCsiModifiers("\x1b[D", CTRL)).toBe("\x1b[1;5D");
  });

  test("encodes Shift+Up and keeps existing params", () => {
    expect(withCsiModifiers("\x1b[A", SHIFT)).toBe("\x1b[1;2A");
    expect(withCsiModifiers("\x1b[5~", CTRL)).toBe("\x1b[5;5~");
  });

  test("passes through without modifiers and non-CSI input", () => {
    expect(withCsiModifiers("\x1b[A", NO_MODIFIERS)).toBe("\x1b[A");
    expect(withCsiModifiers("\t", CTRL)).toBe("\t");
  });
});

describe("applyStickyModifiers", () => {
  test("passes input through when nothing is armed", () => {
    expect(applyStickyModifiers("c", NO_MODIFIERS)).toBe("c");
    expect(applyStickyModifiers("\x1b[A", NO_MODIFIERS)).toBe("\x1b[A");
  });

  test("folds Ctrl and Alt into printable keys", () => {
    expect(applyStickyModifiers("c", CTRL)).toBe("\x03");
    expect(applyStickyModifiers("x", ALT)).toBe("\x1bx");
    expect(applyStickyModifiers("c", { ...NO_MODIFIERS, ctrl: "armed", alt: "armed" })).toBe("\x1b\x03");
  });

  test("translates Shift+Tab to backtab", () => {
    expect(applyStickyModifiers("\t", SHIFT)).toBe("\x1b[Z");
  });

  test("encodes Ctrl+arrows as CSI params and Alt+Enter as ESC prefix", () => {
    expect(applyStickyModifiers("\x1b[D", CTRL)).toBe("\x1b[1;5D");
    expect(applyStickyModifiers("\r", ALT)).toBe("\x1b\r");
  });

  test("locked modifiers behave like armed ones", () => {
    expect(applyStickyModifiers("c", { ...NO_MODIFIERS, ctrl: "locked" })).toBe("\x03");
  });

  test("multi-character input passes through (pastes are never mangled)", () => {
    expect(applyStickyModifiers("hello", CTRL)).toBe("hello");
  });
});

describe("sticky state transitions", () => {
  test("tap arms, second fast tap locks, tap on locked releases", () => {
    expect(nextStickyState("off", 0)).toBe("armed");
    expect(nextStickyState("armed", 120)).toBe("locked");
    expect(nextStickyState("locked", 120)).toBe("off");
  });

  test("slow second tap on armed releases instead of locking", () => {
    expect(nextStickyState("armed", 10_000)).toBe("off");
  });

  test("clearArmed drops armed but keeps locked", () => {
    expect(clearArmed({ ctrl: "armed", alt: "locked", shift: "off" })).toEqual({
      ctrl: "off",
      alt: "locked",
      shift: "off",
    });
  });

  test("hasActiveModifier detects any live modifier", () => {
    expect(hasActiveModifier(NO_MODIFIERS)).toBe(false);
    expect(hasActiveModifier(CTRL)).toBe(true);
  });
});
