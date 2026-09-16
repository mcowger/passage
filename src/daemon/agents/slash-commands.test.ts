import { describe, expect, test } from "bun:test";
import { agentCapabilitiesSchema } from "../../shared/domain/agents.ts";
import { SLASH_COMMANDS_VERSION, getSlashCommands, isKnownSlashCommand } from "./slash-commands.ts";

describe("slash command allowlist", () => {
  test("is pinned to a verified version fixture", () => {
    expect(SLASH_COMMANDS_VERSION).toBe("pi-rpc-1");
    expect(getSlashCommands()).toMatchObject([
      { name: "compact", kind: "action" },
      { name: "model", kind: "prompt-text" },
      { name: "thinking", kind: "prompt-text" },
    ]);
  });

  test("untrusted workspaces get Pi built-ins only (no skill entries)", () => {
    const commands = getSlashCommands({ trusted: false });
    expect(commands.length).toBeGreaterThan(0);
    expect(commands.every((command) => ["compact", "model", "thinking"].includes(command.name))).toBe(true);
  });

  test("names are allowlist-safe and hints are bounded", () => {
    for (const command of getSlashCommands()) {
      expect(command.name).toMatch(/^[a-z0-9-]+$/);
      expect(command.hint.length).toBeLessThanOrEqual(128);
      expect(command.description.length).toBeLessThanOrEqual(256);
    }
  });

  test("capabilities carry the allowlist with skills unavailable", () => {
    const parsed = agentCapabilitiesSchema.parse({
      models: [],
      thinkingLevels: [],
      slashCommands: getSlashCommands(),
      skillsAvailable: false,
    });
    expect(parsed.slashCommands.map((c) => c.name)).toContain("compact");
    expect(parsed.skillsAvailable).toBe(false);
    expect(isKnownSlashCommand("compact")).toBe(true);
    expect(isKnownSlashCommand("unknown-command")).toBe(false);
  });

  test("unknown slash input stays plain text (no client-side execution)", () => {
    expect(isKnownSlashCommand("rm")).toBe(false);
    // Admission-time validation rejects unknown commands; the draft text is
    // sent unchanged as prompt text.
  });
});
