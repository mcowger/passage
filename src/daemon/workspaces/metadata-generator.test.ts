import { describe, expect, it } from "bun:test";
import { deterministicSlugSuggestion, MetadataGenerator, sanitizeBranchName, sanitizeFolderName, sanitizeSuggestion, worktreeSuggestionSchema } from "./metadata-generator.ts";

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

  it("sanitizes model output containing spaces (regression: 'fix/bad-overlap settings-tabs')", () => {
    const fallback = deterministicSlugSuggestion("Bad Overlap on settings page tabs.");
    const result = sanitizeSuggestion(
      { label: "bad-overlap-settings-tabs", branch: "fix/bad-overlap settings-tabs", folder: "bad-overlap-settings-tabs--w0720xz" },
      fallback,
    );
    expect(result.branch).toBe("fix/bad-overlap-settings-tabs");
    expect(result.branch).not.toContain(" ");
    expect(worktreeSuggestionSchema.safeParse(result).success).toBe(true);
  });

  it("sanitizes branch and folder names without spaces", () => {
    expect(sanitizeBranchName("fix/bad-overlap settings-tabs")).toBe("fix/bad-overlap-settings-tabs");
    expect(sanitizeBranchName("Feature/My New Thing!")).toBe("feature/my-new-thing");
    expect(sanitizeBranchName("")).toBe("");
    expect(sanitizeFolderName("My Folder/Name Here")).not.toContain(" ");
    expect(sanitizeFolderName("My Folder/Name Here")).not.toContain("/");
  });
});

describe("MetadataGenerator thinking level", () => {
  it("sends set_thinking_level before prompting", async () => {
    const piScriptWithThinking = `let buffer = ""; let level = "none"; process.stdin.on("data", (chunk) => { buffer += chunk; const lines = buffer.split("\\n"); buffer = lines.pop() ?? ""; for (const line of lines) { if (!line) continue; const request = JSON.parse(line); if (request.type === "get_state") { process.stdout.write(JSON.stringify({ type: "response", id: request.id, command: "get_state", success: true }) + "\\n"); continue; } if (request.type === "set_thinking_level") { level = request.level; process.stdout.write(JSON.stringify({ type: "response", id: request.id, command: "set_thinking_level", success: true }) + "\\n"); continue; } if (request.type !== "prompt") continue; process.stdout.write(JSON.stringify({ type: "response", id: request.id, command: "prompt", success: true }) + "\\n"); process.stdout.write(JSON.stringify({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "{\\"label\\":\\"Webhook retries\\",\\"branch\\":\\"fix/webhook-retries\\",\\"folder\\":\\"webhook-retries-" + level + "--wk_abcd\\"}" }] } }) + "\\n"); process.stdout.write(JSON.stringify({ type: "agent_settled" }) + "\\n"); } });`;
    const generator = new MetadataGenerator(1_000, { executable: process.execPath, executableArgs: ["-e", piScriptWithThinking] });
    const result = await generator.suggest("Refactor websocket client reconnect loop", "/tmp", "test/model", "high");
    expect(result.folder).toBe("webhook-retries-high--wk_abcd");
  });

  it("skips set_thinking_level when no level is configured", async () => {
    const generator = new MetadataGenerator(1_000, { executable: process.execPath, executableArgs: ["-e", piScript] });
    const result = await generator.suggest("Refactor websocket client reconnect loop", "/tmp", "test/model");
    expect(result.folder).toBe("webhook-retries--wk_abcd");
  });
});
