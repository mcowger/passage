import { describe, expect, it } from "bun:test";
import { deterministicSlugSuggestion, MetadataGenerator, worktreeSuggestionSchema } from "./metadata-generator.ts";

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

  it("suggests metadata using fallback when Pi process is mocked/unavailable", async () => {
    const generator = new MetadataGenerator(50);
    const result = await generator.suggest("Refactor websocket client reconnect loop");
    expect(result.label).toBeDefined();
    expect(result.branch).toBeDefined();
    expect(result.folder).toBeDefined();
    expect(worktreeSuggestionSchema.safeParse(result).success).toBe(true);
  });
});
