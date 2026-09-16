import { slashCommandSchema, type SlashCommand } from "../../shared/domain/agents.ts";

/**
 * Pinned-version `/` allowlist for the Passage composer.
 *
 * Built daemon-side from the verified Pi RPC command set (see PI.md). The
 * browser never sends raw Pi JSON; `prompt-text` entries insert a `/name`
 * template into the draft, while `action` entries route through an existing
 * typed Passage HTTP route (e.g. compact) with confirmation.
 *
 * Skill-backed entries appear only in explicitly trusted workspaces. Passage
 * has no persisted workspace-trust decision yet, so every workspace is
 * treated as untrusted: Pi built-ins only, plus a footer in the UI.
 */
export const SLASH_COMMANDS_VERSION = "pi-rpc-1" as const;

const BUILT_IN_COMMANDS: SlashCommand[] = slashCommandSchema.array().parse([
  {
    name: "compact",
    description: "Compact conversation context",
    hint: "/compact",
    kind: "action",
  },
  {
    name: "model",
    description: "Change model (opens the model picker)",
    hint: "/model …",
    kind: "prompt-text",
  },
  {
    name: "thinking",
    description: "Change thinking level (opens the thinking picker)",
    hint: "/thinking …",
    kind: "prompt-text",
  },
]);

export function getSlashCommands(options?: { trusted?: boolean }): SlashCommand[] {
  void options?.trusted;
  // No skill-backed entries until an explicit persisted workspace-trust
  // decision exists. Untrusted workspaces get Pi built-ins only.
  return [...BUILT_IN_COMMANDS];
}

export function isKnownSlashCommand(name: string): boolean {
  return BUILT_IN_COMMANDS.some((command) => command.name === name);
}
