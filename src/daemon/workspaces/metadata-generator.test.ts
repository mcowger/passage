import { describe, expect, it } from "bun:test";
import { deterministicSlugSuggestion, MetadataGenerator, worktreeSuggestionSchema } from "./metadata-generator.ts";

const piScript = `let buffer = ""; process.stdin.on("data", (chunk) => { buffer += chunk; const lines = buffer.split("\\n"); buffer = lines.pop() ?? ""; for (const line of lines) { if (!line) continue; const request = JSON.parse(line); if (request.type === "get_state") { process.stdout.write(JSON.stringify({ type: "response", id: request.id, command: "get_state", success: true }) + "\\n"); continue; } if (request.type !== "prompt") continue; process.stdout.write(JSON.stringify({ type: "response", id: request.id, command: "prompt", success: true }) + "\\n"); process.stdout.write(JSON.stringify({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "{\\\"label\\\":\\\"Webhook retries\\\",\\\"branch\\\":\\\"fix/webhook-retries\\\"," } }) + "\\n"); process.stdout.write(JSON.stringify({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "{\\\"label\\\":\\\"Webhook retries\\\",\\\"branch\\\":\\\"fix/webhook-retries\\\",\\\"folder\\\":\\\"webhook-retries--wk_abcd\\\"}" }] } }) + "\\n"); process.stdout.write(JSON.stringify({ type: "agent_settled" }) + "\\n"); } });`;

describe("MetadataGenerator", () => {
  it("generates deterministic slug fallback correctly", () => {
    const suggestion = deterministicSlugSuggestion("Fix invoice retry calculation in payment flow");
    expect(suggestion.label).toBe("Fix invoice retry calculation in payment flow");
    expect(suggestion.branch).toMatch(/^feature\/fix-invoice-retry-calculation-in/);
    expect(suggestion.folder).toMatch(/^fix-invoice-retry-calculation-in--wk_[a-z0-9]{4}$/);
    expect(worktreeSuggestionSchema.safeParse(suggestion).success).toBe(true);
  });

  it("handles empty or special character purposes safely in fallback", () => {
    const empty = deterministicSlugSuggestion("");
    expect(empty.label).toBe("New worktree");
    expect(empty.branch).toBe("feature/worktree");
    expect(empty.folder).toMatch(/^worktree--wk_[a-z0-9]{4}$/);

    const special = deterministicSlugSuggestion("### [Bug] !!! @@@ Fix (123) crash ???");
    expect(special.label.length).toBeGreaterThan(0);
    expect(special.branch).toMatch(/^feature\/bug-fix-123-crash/);
    expect(worktreeSuggestionSchema.safeParse(special).success).toBe(true);
  });

  it("reads the finalized assistant message from Pi RPC events", async () => {
    const generator = new MetadataGenerator(1_000, { executable: process.execPath, executableArgs: ["-e", piScript] });
    const result = await generator.suggest("Refactor websocket client reconnect loop", "/tmp", "test/model");
    expect(result).toEqual({
      label: "Webhook retries",
      branch: "fix/webhook-retries",
      folder: "webhook-retries--wk_abcd",
    });
  });

  it("uses the fallback when Pi is unavailable", async () => {
    const generator = new MetadataGenerator(50, { executable: "/does/not/exist" });
    const result = await generator.suggest("Refactor websocket client reconnect loop");
    expect(result.label).toBeDefined();
    expect(result.branch).toBeDefined();
    expect(result.folder).toBeDefined();
    expect(worktreeSuggestionSchema.safeParse(result).success).toBe(true);
  });
});
