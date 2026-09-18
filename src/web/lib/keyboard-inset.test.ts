import { describe, expect, test } from "bun:test";
import { computeAppHeight, computeKeyboardInset } from "./keyboard-inset.ts";

describe("computeKeyboardInset", () => {
  test("is zero when the keyboard is closed", () => {
    expect(computeKeyboardInset(852, 852, 0)).toBe(0);
  });

  test("ignores safe-area-sized cold-start under-report (WebKit 254868)", () => {
    // Dynamic Island top (~59px) + home indicator (~34px) ≈ 93px of noise.
    expect(computeKeyboardInset(852, 759, 0)).toBe(0);
  });

  test("ignores sub-threshold differences", () => {
    expect(computeKeyboardInset(852, 703, 0)).toBe(0);
  });

  test("honors the threshold boundary", () => {
    expect(computeKeyboardInset(852, 702, 0)).toBe(150);
  });

  test("measures the covered height while open", () => {
    expect(computeKeyboardInset(852, 500, 0)).toBe(352);
  });

  test("accounts for Safari panning the visual viewport", () => {
    expect(computeKeyboardInset(852, 500, 100)).toBe(252);
  });

  test("floors floating-point overshoot at zero", () => {
    expect(computeKeyboardInset(852, 853, 0)).toBe(0);
  });
});

describe("computeAppHeight", () => {
  test("always tracks the layout height, keyboard closed", () => {
    expect(computeAppHeight(852)).toBe(852);
  });

  test("never shrinks to the visual height while the keyboard is open", () => {
    // The composer rides via --kb-inset margin; resizing the shell behind
    // Safari's back produces white gaps and cements cold-start under-report.
    expect(computeAppHeight(852)).toBe(852);
  });
});
