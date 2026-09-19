import { useMemo, type KeyboardEvent } from "react";
import type { AgentCapabilities, SlashCommand } from "../../shared/domain/agents.ts";
import { currentViewportIsMobileComposer } from "./ComposerEditor.tsx";
import {
  applyFileInsert,
  applySlashInsert,
  filterSlashCommands,
  useComposerTrigger,
} from "./useComposerTrigger.ts";
import type { WorkspaceApi } from "../api.ts";

export type ComposerSuggestionDeps = {
  draft: string;
  updateDraft: (value: string) => void;
  caret: number | null;
  placeCaret: (position: number) => void;
  workspaceId: string;
  api: WorkspaceApi;
  capabilities?: AgentCapabilities;
  /** Compact is an action command: it needs confirmation, never raw insert. */
  onCompactRequest: () => void;
  running: boolean;
  stopping: boolean;
  loading: boolean;
  busy: boolean;
  onSubmit: (kind: "prompt" | "steer" | "followUp") => void;
};

/**
 * @/file and //command autocomplete over the draft: trigger detection,
 * suggestion derivation, accept paths, and the editor key handling
 * (navigate/dismiss/accept/Enter-to-send). Insertions flow back through
 * updateDraft/placeCaret; compact routes to confirmation instead.
 */
export function useComposerSuggestions({
  draft,
  updateDraft,
  caret,
  placeCaret,
  workspaceId,
  api,
  capabilities,
  onCompactRequest,
  running,
  stopping,
  loading,
  busy,
  onSubmit,
}: ComposerSuggestionDeps) {
  const autocomplete = useComposerTrigger({ draft, caret, workspaceId, api });
  const slashCommands = useMemo(
    () => capabilities?.slashCommands ?? [],
    [capabilities?.slashCommands],
  );
  const filteredCommands = useMemo(
    () =>
      autocomplete.trigger?.kind === "/"
        ? filterSlashCommands(slashCommands, autocomplete.trigger.query)
        : [],
    [autocomplete.trigger, slashCommands],
  );
  const suggestionOpen = autocomplete.trigger !== null;
  const suggestionCount =
    autocomplete.trigger?.kind === "@" ? autocomplete.files.length : filteredCommands.length;
  const activeValue = (() => {
    if (!autocomplete.trigger) return "";
    if (autocomplete.trigger.kind === "@") {
      const entry = autocomplete.files[autocomplete.activeIndex];
      return entry ? `file:${entry.path}` : "";
    }
    const command = filteredCommands[autocomplete.activeIndex];
    return command ? `cmd:${command.name}` : "";
  })();

  const acceptFile = (path: string) => {
    const trigger = autocomplete.trigger;
    if (!trigger || trigger.kind !== "@") return;
    const next = applyFileInsert(draft, trigger, path);
    updateDraft(next.value);
    placeCaret(next.caret);
  };

  const acceptCommand = (command: SlashCommand) => {
    const trigger = autocomplete.trigger;
    if (!trigger || trigger.kind !== "/") return;
    if (command.kind === "action") {
      // Action kinds never send raw Pi JSON: compact routes through the
      // typed compact endpoint after explicit confirmation.
      if (command.name === "compact") onCompactRequest();
      return;
    }
    const next = applySlashInsert(draft, trigger, `/${command.name}`);
    updateDraft(next.value);
    placeCaret(next.caret);
  };

  const acceptActiveSuggestion = (): boolean => {
    const trigger = autocomplete.trigger;
    if (!trigger) return false;
    if (trigger.kind === "@") {
      const entry = autocomplete.files[autocomplete.activeIndex];
      if (!entry) return false;
      acceptFile(entry.path);
      return true;
    }
    const command = filteredCommands[autocomplete.activeIndex];
    if (!command) return false;
    acceptCommand(command);
    return true;
  };

  const handleActiveValueChange = (value: string) => {
    if (autocomplete.trigger?.kind === "@") {
      const index = autocomplete.files.findIndex((entry) => `file:${entry.path}` === value);
      if (index >= 0) autocomplete.setActiveIndex(index);
    } else {
      const index = filteredCommands.findIndex((command) => `cmd:${command.name}` === value);
      if (index >= 0) autocomplete.setActiveIndex(index);
    }
  };

  const handleEditorKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (suggestionOpen && autocomplete.trigger) {
      if (event.key === "ArrowDown" || event.key === "ArrowUp") {
        event.preventDefault();
        autocomplete.moveSelection(event.key === "ArrowDown" ? 1 : -1, suggestionCount);
        return;
      }
      if (event.key === "Escape") {
        // Dismiss only: the draft keeps the raw trigger token and the
        // caret stays where it was. Retyping re-opens.
        event.preventDefault();
        event.stopPropagation();
        autocomplete.dismiss();
        return;
      }
      if ((event.key === "Tab" || event.key === "Enter") && suggestionCount > 0 && !event.shiftKey) {
        event.preventDefault();
        acceptActiveSuggestion();
        return;
      }
    }
    if (event.key === "Enter" && !event.shiftKey) {
      // Mobile plain-Enter inserts a newline (handled in
      // ComposerEditor); only Cmd/Ctrl+Enter submits there.
      if (currentViewportIsMobileComposer() && !event.metaKey && !event.ctrlKey) return;
      event.preventDefault();
      if (stopping || loading) return;
      if (running) onSubmit("steer");
      else if (!busy && !loading) onSubmit("prompt");
    }
  };

  return {
    autocomplete,
    filteredCommands,
    suggestionOpen,
    suggestionCount,
    activeValue,
    acceptFile,
    acceptCommand,
    handleActiveValueChange,
    handleEditorKeyDown,
  };
}
