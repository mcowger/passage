import { expect, test, describe } from "bun:test";
import { buildTitlePrompt, fallbackAgentTitle, sanitizeAgentTitle } from "./title-suggester.ts";

describe("sanitizeAgentTitle", () => {
  test("passes through a clean 3-4 word title", () => {
    expect(sanitizeAgentTitle("Fix login retry bug")).toBe("Fix login retry bug");
  });
  test("strips quotes, markdown, and trailing periods", () => {
    expect(sanitizeAgentTitle('"Fix login retry bug."')).toBe("Fix login retry bug");
    expect(sanitizeAgentTitle("**Fix login retry bug**")).toBe("Fix login retry bug");
    expect(sanitizeAgentTitle("- Fix login retry bug")).toBe("Fix login retry bug");
    expect(sanitizeAgentTitle("Title: Fix login retry bug")).toBe("Fix login retry bug");
  });
  test("collapses newlines and truncates long output on a word boundary", () => {
    const long = "Fix the login retry bug in the payment flow\nwith extra detail that goes on forever";
    const title = sanitizeAgentTitle(long)!;
    expect(title.length).toBeLessThanOrEqual(60);
    expect(title).toStartWith("Fix the login retry bug");
  });
  test("rejects empty output and the placeholder itself", () => {
    expect(sanitizeAgentTitle("")).toBeNull();
    expect(sanitizeAgentTitle("   ")).toBeNull();
    expect(sanitizeAgentTitle("Agent")).toBeNull();
    expect(sanitizeAgentTitle('"Agent"')).toBeNull();
  });
});

describe("fallbackAgentTitle", () => {
  test("uses the first words of the first message", () => {
    expect(fallbackAgentTitle(["help me refactor the websocket client", "second"])).toBe("help me refactor the");
  });
  test("returns null with no usable input", () => {
    expect(fallbackAgentTitle([])).toBeNull();
    expect(fallbackAgentTitle(["   "])).toBeNull();
  });
});

describe("buildTitlePrompt", () => {
  test("asks for a 3-4 word title over the first messages", () => {
    const prompt = buildTitlePrompt(["first message", "second message", "third is ignored"]);
    expect(prompt).toContain("3-4 words");
    expect(prompt).toContain("first message");
    expect(prompt).toContain("second message");
    expect(prompt).not.toContain("third is ignored");
  });
});
