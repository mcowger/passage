import { describe, expect, test } from "bun:test";
import { withNullModelHarness } from "./nullmodel-harness.ts";

describe("NullModel harness personas", () => {
  test("tool_calls persona returns function-call payloads for offline renderer coverage", async () => {
    await withNullModelHarness(async ({ port }) => {
      const response = await fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          model: "null-gpt",
          messages: [{ role: "user", content: "What is the weather?" }],
          tools: [{ type: "function", function: { name: "get_weather" } }],
          _persona: "tool_calls",
        }),
      });
      expect(response.ok).toBe(true);
      const payload = (await response.json()) as {
        choices: Array<{ message: { tool_calls?: Array<{ function: { name: string; arguments: string } }> }; finish_reason: string }>;
      };
      const toolCalls = payload.choices[0]?.message.tool_calls ?? [];
      expect(toolCalls.length).toBeGreaterThan(0);
      expect(typeof toolCalls[0]?.function.name).toBe("string");
    }, { persona: "tool_calls" });
  }, 15_000);
});
