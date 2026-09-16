import { useEffect, useRef, useState } from "react";
import type { SlashCommand } from "../../shared/domain/agents.ts";
import type { FileSearchEntry } from "../../shared/protocol/workspace.ts";
import type { WorkspaceApi } from "../api.ts";

export type ComposerTriggerKind = "@" | "/";
export type ComposerTrigger = {
  kind: ComposerTriggerKind;
  /** Raw query token after the trigger char (may be ""). */
  query: string;
  /** Index of the trigger char in the draft. */
  start: number;
  /** Caret position the trigger was detected at (exclusive end of the token). */
  end: number;
};

export const MAX_TRIGGER_QUERY_LENGTH = 64;
const TOKEN_CHAR = /^[^\s]$/;

/**
 * Anywhere-position trigger parser for `@` file mentions and `/` commands.
 *
 * Fires at start-of-line or after whitespace, with a bounded query token.
 * Returns null when dismissed conditions apply (email addresses, code spans,
 * over-long tokens). Pure and testable; caret is a UTF-16 offset matching
 * `HTMLTextAreaElement.selectionStart`.
 */
export function detectTrigger(draft: string, caret: number): ComposerTrigger | null {
  if (!Number.isSafeInteger(caret) || caret < 0 || caret > draft.length) return null;
  const before = draft.slice(0, caret);

  // Direct case: caret sits inside/after `@query` or `/query` with no
  // intervening whitespace. Walk back over the token chars.
  let tokenEnd = caret;
  let tokenStart = caret;
  while (tokenStart > 0 && TOKEN_CHAR.test(before[tokenStart - 1]!)) {
    tokenStart -= 1;
    if (caret - tokenStart > MAX_TRIGGER_QUERY_LENGTH + 1) return null;
  }
  const first = before[tokenStart];
  if (first === "@" || first === "/") {
    const prev = tokenStart > 0 ? before[tokenStart - 1]! : "\n";
    if (prev === "\n" || prev === "\r" || /\s/.test(prev)) {
      const query = before.slice(tokenStart + 1, tokenEnd);
      if (query.length <= MAX_TRIGGER_QUERY_LENGTH) return { kind: first, query, start: tokenStart, end: tokenEnd };
      return null;
    }
    return null;
  }

  // Space-after-empty-trigger case: `@ |` (trigger + single space) still
  // shows the unfiltered list.
  if (caret > 1 && before[caret - 1] === " ") {
    const maybeTrigger = before[caret - 2]!;
    if (maybeTrigger === "@" || maybeTrigger === "/") {
      const prev = caret - 3 >= 0 ? before[caret - 3]! : "\n";
      if (prev === "\n" || prev === "\r" || /\s/.test(prev)) {
        return { kind: maybeTrigger, query: "", start: caret - 2, end: caret };
      }
    }
  }
  return null;
}

/** Replace `@query` with a backticked file ref plus trailing space. */
export function applyFileInsert(
  draft: string,
  trigger: ComposerTrigger,
  path: string,
): { value: string; caret: number } {
  const insertion = `@\`${path}\` `;
  const value = draft.slice(0, trigger.start) + insertion + draft.slice(trigger.end);
  return { value, caret: trigger.start + insertion.length };
}

/** Replace `/query` with a slash-command template, preserving surroundings. */
export function applySlashInsert(
  draft: string,
  trigger: ComposerTrigger,
  template: string,
): { value: string; caret: number } {
  const insertion = template.endsWith(" ") ? template : `${template} `;
  const value = draft.slice(0, trigger.start) + insertion + draft.slice(trigger.end);
  return { value, caret: trigger.start + insertion.length };
}

/** Case-insensitive substring filter over command name + description. */
export function filterSlashCommands(commands: SlashCommand[], query: string): SlashCommand[] {
  const needle = query.toLowerCase();
  if (!needle) return [...commands];
  return commands.filter(
    (command) =>
      command.name.toLowerCase().includes(needle) ||
      command.description.toLowerCase().includes(needle),
  );
}

const SEARCH_DEBOUNCE_MS = 150;

export type ComposerAutocompleteState = {
  trigger: ComposerTrigger | null;
  files: FileSearchEntry[];
  filesLoading: boolean;
  filesError: string;
  activeIndex: number;
  setActiveIndex: (index: number) => void;
  moveSelection: (delta: 1 | -1, itemCount: number) => void;
  dismiss: () => void;
  dismissed: boolean;
};

/**
 * Anywhere-position token parser + debounced file search + keyboard
 * controller for the composer autocomplete popover.
 *
 * Typing never blocks: search is debounced ~150ms and cancelled on each
 * keystroke; on search failure the client falls back to filtering a bounded
 * root listing, and on total failure surfaces an error row while the draft
 * stays editable.
 */
export function useComposerTrigger(options: {
  draft: string;
  caret: number | null;
  workspaceId: string;
  api: WorkspaceApi;
}): ComposerAutocompleteState {
  const { draft, caret, workspaceId, api } = options;
  const [dismissed, setDismissed] = useState<{ start: number; query: string } | null>(null);
  const [files, setFiles] = useState<FileSearchEntry[]>([]);
  const [filesLoading, setFilesLoading] = useState(false);
  const [filesError, setFilesError] = useState("");
  const [activeIndex, setActiveIndex] = useState(0);
  const generationRef = useRef(0);

  const detected = caret === null ? null : detectTrigger(draft, caret);
  // Dismissal suppresses only the exact dismissed token: any retyping
  // (new query text or a new trigger position) re-opens the popover.
  const isDismissed =
    detected !== null &&
    dismissed !== null &&
    dismissed.start === detected.start &&
    dismissed.query === detected.query;
  const trigger = isDismissed ? null : detected;
  const dismissedActive = isDismissed;

  // A new trigger position (or trigger gone) clears the dismissal so retyping
  // re-opens the popover.
  useEffect(() => {
    if (detected === null || dismissed === null) return;
    if (detected.start !== dismissed.start || detected.query !== dismissed.query) {
      setDismissed(null);
    }
  }, [detected, dismissed]);

  const query = trigger?.kind === "@" ? trigger.query : null;

  useEffect(() => {
    if (query === null) {
      setFiles([]);
      setFilesLoading(false);
      setFilesError("");
      return;
    }
    const generation = ++generationRef.current;
    setFilesLoading(true);
    const timer = setTimeout(() => {
      void (async () => {
        try {
          const result = await api.searchFiles(workspaceId, query);
          if (generationRef.current !== generation) return;
          setFiles(result.entries);
          setFilesError("");
        } catch {
          // Fallback: filter the last bounded root listing client-side.
          try {
            const listing = await api.listFiles(workspaceId, ".");
            if (generationRef.current !== generation) return;
            const needle = query.toLowerCase();
            const entries: FileSearchEntry[] = listing.entries
              .filter((entry) => (entry.kind === "file" || entry.kind === "directory"))
              .filter((entry) =>
                !needle ||
                entry.name.toLowerCase().startsWith(needle) ||
                entry.path.toLowerCase().includes(needle),
              )
              .slice(0, 20)
              .map((entry) => ({ path: entry.path, kind: entry.kind }));
            setFiles(entries);
            setFilesError("");
          } catch {
            if (generationRef.current !== generation) return;
            setFiles([]);
            setFilesError("File search unavailable");
          }
        } finally {
          if (generationRef.current === generation) setFilesLoading(false);
        }
      })();
    }, SEARCH_DEBOUNCE_MS);
    return () => {
      clearTimeout(timer);
      generationRef.current += 1;
    };
  }, [api, workspaceId, query]);

  // Reset the highlighted row whenever the result set identity changes.
  useEffect(() => {
    setActiveIndex(0);
  }, [query, trigger?.kind]);

  return {
    trigger,
    files,
    filesLoading,
    filesError,
    activeIndex,
    setActiveIndex,
    moveSelection: (delta, itemCount) => {
      if (itemCount <= 0) return;
      setActiveIndex((current) => (current + delta + itemCount) % itemCount);
    },
    dismiss: () => {
      if (detected) setDismissed({ start: detected.start, query: detected.query });
    },
    dismissed: dismissedActive,
  };
}
