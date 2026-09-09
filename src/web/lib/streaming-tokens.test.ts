import { describe, expect, test } from "bun:test";
import { estimateTokens, estimateUpdatedTokens, getStreamingTokenText } from "./streaming-tokens.ts";

describe("streaming token estimates", () => {
  test("uses Pi Web's CJK and four-characters-per-token heuristic", () => {
    expect(estimateTokens("1234abcd日本語")).toBe(8 / 4 + 3);
  });

  test("updates an appended stream from the previous estimate", () => {
    const previous = { text: "The answer is", tokens: estimateTokens("The answer is") };
    expect(estimateUpdatedTokens(previous, "The answer is ready")).toBe(estimateTokens("The answer is ready"));
  });

  test("collects only the current turn's assistant, reasoning, and tool input", () => {
    const text = getStreamingTokenText([
      { kind: "assistant", id: "old", text: "old response" },
      { kind: "user", id: "user", text: "new task" },
      { kind: "thinking", id: "thinking", text: "reasoning" },
      { kind: "tool", id: "tool", name: "bash", input: { rawInput: "{\"command\":\"bun test\"}" }, status: "running", significant: true },
    ]);
    expect(text).toBe('reasoning\n{"command":"bun test"}');
  });
});
