import { slashCommandSchema, type SlashCommand } from "../../shared/domain/agents.ts";
import type { PiAvailableCommand } from "./rpc/index.ts";

/**
 * Pinned-version `/` allowlist for the Passage composer.
 *
 * Built daemon-side from the verified Pi RPC command set (see PI.md). The
 * browser never sends raw Pi JSON; `prompt-text` entries insert a `/name`
 * template into the draft, while `action` entries route through an existing
 * typed Passage HTTP route (e.g. compact) with confirmation.
 *
 * `/model` and `/thinking` are intentionally excluded: Passage exposes
 * dedicated model/thinking picker controls, so those slash aliases would be
 * redundant in the composer popup.
 *
 * Skill-backed entries come from the live pi process (`get_commands`):
 * user-level skills load exactly like the pi TUI. Project-local resources
 * stay disabled via pi's `--no-approve` spawn flag until an explicit
 * persisted workspace-trust decision exists, so untrusted workspaces can
 * never execute project-controlled skills (see PI.md resource policy).
 */
export const SLASH_COMMANDS_VERSION = "pi-rpc-1" as const;

const BUILT_IN_COMMANDS: SlashCommand[] = slashCommandSchema.array().parse([
  {
    name: "compact",
    description: "Compact conversation context",
    hint: "/compact",
    kind: "action",
  },
]);

export function getSlashCommands(options?: { trusted?: boolean }): SlashCommand[] {
  void options?.trusted;
  return [...BUILT_IN_COMMANDS];
}

/**
 * Map live pi `get_commands` entries to composer slash commands.
 *
 * Only `skill` sources are surfaced: extension commands stay hidden per
 * PI.md (Passage is not a plugin manager), and prompt templates stay
 * disabled via `--no-prompt-templates`. Skill entries insert a `/skill:name`
 * template into the draft (`prompt-text`); pi expands it server-side on
 * prompt/steer/follow-up. Entries that fail validation are skipped.
 */
export function piCommandsToSlashCommands(entries: unknown): SlashCommand[] {
  if (!Array.isArray(entries)) return [];
  const commands: SlashCommand[] = [];
  for (const entry of entries) {
    const candidate = entry as Partial<PiAvailableCommand>;
    if (typeof candidate?.name !== "string" || candidate.source !== "skill") continue;
    const parsed = slashCommandSchema.safeParse({
      name: candidate.name,
      description: typeof candidate.description === "string" && candidate.description.length > 0
        ? candidate.description.slice(0, 256)
        : candidate.name,
      hint: `/${candidate.name}`.slice(0, 128),
      kind: "prompt-text",
    });
    if (parsed.success) commands.push(parsed.data);
  }
  return commands;
}

export function isKnownSlashCommand(name: string): boolean {
  return BUILT_IN_COMMANDS.some((command) => command.name === name);
}
