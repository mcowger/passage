import { describe, expect, test } from "bun:test";
import { hasFileDrag } from "./image-drop.ts";

describe("hasFileDrag", () => {
  test("detects an OS file drag", () => {
    expect(hasFileDrag(["Files"])).toBe(true);
    expect(hasFileDrag(["Files", "application/x-moz-file"])).toBe(true);
  });

  test("ignores internal tab drags and text selections", () => {
    expect(hasFileDrag(["application/x-passage-tab"])).toBe(false);
    expect(hasFileDrag(["text/plain"])).toBe(false);
    expect(hasFileDrag([])).toBe(false);
  });

  test("handles missing type lists", () => {
    expect(hasFileDrag(null)).toBe(false);
    expect(hasFileDrag(undefined)).toBe(false);
  });
});
