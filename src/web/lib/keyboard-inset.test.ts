import { describe, expect, test } from "bun:test";
import { computeAppHeight, computeKeyboardInset } from "./keyboard-inset.ts";

describe("computeKeyboardInset", () => {
  test("is zero when the keyboard is closed", () => {
    expect(computeKeyboardInset(852, 852, 0)).toBe(0);
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
  test("uses the full layout height when the keyboard is closed", () => {
    expect(computeAppHeight(852, 852, 0)).toBe(852);
  });

  test("shrinks to the visible height while the keyboard is open", () => {
    expect(computeAppHeight(852, 500, 352)).toBe(500);
  });
});
