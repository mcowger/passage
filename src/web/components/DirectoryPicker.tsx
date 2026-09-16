import { useEffect, useRef, useState } from "react";
import { Command, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList } from "./ui/command.tsx";
import type { WorkspaceApi } from "../api.ts";
import type { DirectorySuggestEntry } from "../../shared/protocol/workspace.ts";

const DEBOUNCE_MS = 150;
const SUGGESTION_LIMIT = 20;

type DirectoryPickerProps = {
  api: WorkspaceApi;
  name: string;
  defaultValue?: string;
  placeholder?: string;
  autoFocus?: boolean;
  onOpenChange?: (open: boolean) => void;
};

/**
 * Directory path field with live daemon-backed suggestions. The daemon
 * splits the typed partial path into a base directory plus a prefix and
 * fuzzy-matches child directories server-side; this component only renders
 * the bounded snapshot. Selecting a suggestion fills the input so typing
 * can continue deeper (a trailing `/` lists that directory's children).
 * `CommandInput` renders the real named input, so the parent form still
 * submits via `FormData` unchanged and cmdk owns arrow/Enter navigation.
 */
export function DirectoryPicker({ api, name, defaultValue = "", placeholder, autoFocus, onOpenChange }: DirectoryPickerProps) {
  const [value, setValue] = useState(defaultValue);
  const [entries, setEntries] = useState<DirectorySuggestEntry[]>([]);
  const [truncated, setTruncated] = useState(false);
  const [loading, setLoading] = useState(false);
  const [open, setOpenState] = useState(false);
  const requestId = useRef(0);

  const setOpen = (next: boolean) => {
    setOpenState(next);
    onOpenChange?.(next);
  };

  // The parent dialog reads suggestion visibility for Escape handling;
  // reset it if this component unmounts while open.
  useEffect(() => () => { onOpenChange?.(false); }, [onOpenChange]);

  useEffect(() => {
    if (!open) return;
    const id = ++requestId.current;
    setLoading(true);
    const timer = setTimeout(() => {
      void api.suggestDirectories(value, SUGGESTION_LIMIT).then(
        (result) => {
          if (requestId.current !== id) return;
          setEntries(result.entries);
          setTruncated(result.truncated);
          setLoading(false);
        },
        () => {
          if (requestId.current !== id) return;
          setEntries([]);
          setTruncated(false);
          setLoading(false);
        },
      );
    }, DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [api, open, value]);

  const select = (path: string) => {
    requestId.current += 1;
    setValue(path);
    setEntries([]);
    setTruncated(false);
    setLoading(false);
    setOpen(false);
  };

  return (
    <Command
      shouldFilter={false}
      label="Directory path"
      // Restyle the internal CommandInput wrapper to match a plain form
      // field (ui/input): the palette styling (bottom-border-only row on a
      // filled box) otherwise renders a double frame that overflows the
      // dialog grid. The inner input is taller (h-10) than its row (h-9),
      // so pin it to h-9 as well; twMerge keeps our conflicting classes.
      className="relative min-w-0 overflow-visible bg-transparent [&_[data-slot=command-input-wrapper]]:h-9 [&_[data-slot=command-input-wrapper]]:min-w-0 [&_[data-slot=command-input-wrapper]]:rounded-sm [&_[data-slot=command-input-wrapper]]:border [&_[data-slot=command-input-wrapper]]:border-input [&_[data-slot=command-input-wrapper]]:bg-transparent"
    >
      <CommandInput
        name={name}
        required
        value={value}
        onValueChange={(next) => {
          setValue(next);
          setOpen(true);
        }}
        placeholder={placeholder}
        autoFocus={autoFocus}
        autoComplete="off"
        spellCheck={false}
        onFocus={() => setOpen(true)}
        onBlur={() => setOpen(false)}
        onKeyDown={(event) => {
          // With suggestions visible, Escape dismisses only the list. The
          // parent dialog skips its own Escape dismissal while the parent
          // is told the list is open, since Radix listens in capture phase
          // and input-level stopPropagation cannot preempt it.
          if (event.key === "Escape" && open && (loading || entries.length > 0)) setOpen(false);
        }}
        className="h-9 min-w-0 flex-1 rounded-none border-0! bg-transparent! shadow-none"
      />
      {open && (loading || entries.length > 0) && (
        <div className="absolute inset-x-0 top-full z-50 mt-1 overflow-hidden rounded-md border bg-popover shadow-md">
          <CommandList>
            {loading && entries.length === 0 ? (
              <div className="px-3 py-2 text-xs text-muted-foreground">Searching directories…</div>
            ) : (
              <>
                <CommandEmpty>No matching directories</CommandEmpty>
                <CommandGroup onMouseDown={(event) => event.preventDefault()}>
                  {entries.map((entry) => (
                    <CommandItem
                      key={entry.path}
                      value={entry.path}
                      keywords={[entry.name]}
                      onSelect={() => select(entry.path)}
                      className="flex-col items-start gap-0.5"
                    >
                      <span className="text-xs font-medium">{entry.name}</span>
                      <span className="max-w-full truncate text-[11px] text-muted-foreground">{entry.path}</span>
                    </CommandItem>
                  ))}
                </CommandGroup>
                {truncated && (
                  <div className="border-t px-3 py-1.5 text-[11px] text-muted-foreground">
                    Showing the first {entries.length} matches — keep typing to narrow down.
                  </div>
                )}
              </>
            )}
          </CommandList>
        </div>
      )}
    </Command>
  );
}
