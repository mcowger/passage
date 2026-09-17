import { describe, expect, test } from "bun:test";
import { formatCompactTokens } from "./utils.ts";

describe("formatCompactTokens", () => {
  test("leaves small counts unchanged", () => {
    expect(formatCompactTokens(0)).toBe("0");
    expect(formatCompactTokens(5)).toBe("5");
    expect(formatCompactTokens(999)).toBe("999");
  });

  test("compacts thousands", () => {
    expect(formatCompactTokens(3_950)).toBe("4K");
    expect(formatCompactTokens(18_973)).toBe("19K");
    expect(formatCompactTokens(50_025)).toBe("50K");
    expect(formatCompactTokens(416_194)).toBe("416.2K");
  });

  test("compacts millions with two fraction digits", () => {
    expect(formatCompactTokens(1_048_576)).toBe("1.05M");
    expect(formatCompactTokens(2_511_226)).toBe("2.51M");
    expect(formatCompactTokens(2_000_000)).toBe("2M");
  });

  test("falls back to zero for non-finite values", () => {
    expect(formatCompactTokens(Number.NaN)).toBe("0");
    expect(formatCompactTokens(-5)).toBe("0");
  });
});
