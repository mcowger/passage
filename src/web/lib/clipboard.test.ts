import { describe, expect, test } from "bun:test";
import { copyTextToClipboard } from "./clipboard.ts";

describe("copyTextToClipboard", () => {
  test("does not throw or reject when clipboard API is unavailable", async () => {
    // In Bun test environment, navigator.clipboard is undefined
    const result = await copyTextToClipboard("hello world");
    // Should safely return a boolean (false when no DOM/clipboard), never reject
    expect(typeof result).toBe("boolean");
  });
});
