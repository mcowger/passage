import { useEffect, useRef, useState } from "react";
import { Popover, PopoverAnchor, PopoverContent } from "./ui/popover.tsx";
import { Input } from "./ui/input.tsx";
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
 * Directory path input with daemon-backed live suggestions. Composes
 * the standard shadcn `Input` with Radix `PopoverAnchor` and `PopoverContent`:
 * the input element is the anchor with zero outer wrappers or extra borders,
 * matching neighboring dialog inputs 1:1.
 */
export function DirectoryPicker({
  api,
  name,
  defaultValue = "",
  placeholder,
  autoFocus,
  onOpenChange,
}: DirectoryPickerProps) {
  const [value, setValue] = useState(defaultValue);
  const [entries, setEntries] = useState<DirectorySuggestEntry[]>([]);
  const [truncated, setTruncated] = useState(false);
  const [loading, setLoading] = useState(false);
  const [open, setOpenState] = useState(false);
  const [selectedIndex, setSelectedIndex] = useState(-1);
  const requestId = useRef(0);
  const listRef = useRef<HTMLDivElement>(null);

  const setOpen = (next: boolean) => {
    setOpenState(next);
    onOpenChange?.(next);
    if (!next) setSelectedIndex(-1);
  };

  useEffect(() => () => { onOpenChange?.(false); }, [onOpenChange]);

  useEffect(() => {
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
  }, [api, value]);

  const select = (path: string) => {
    requestId.current += 1;
    setValue(path);
    setEntries([]);
    setTruncated(false);
    setLoading(false);
    setOpen(false);
  };

  const handleKeyDown = (event: React.KeyboardEvent<HTMLInputElement>) => {
    if (!open || entries.length === 0) {
      if (event.key === "ArrowDown" && entries.length > 0) {
        event.preventDefault();
        setOpen(true);
        setSelectedIndex(0);
      }
      return;
    }

    if (event.key === "ArrowDown") {
      event.preventDefault();
      setSelectedIndex((prev) => {
        const next = prev < entries.length - 1 ? prev + 1 : 0;
        scrollIntoView(next);
        return next;
      });
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      setSelectedIndex((prev) => {
        const next = prev > 0 ? prev - 1 : entries.length - 1;
        scrollIntoView(next);
        return next;
      });
    } else if (event.key === "Enter") {
      if (selectedIndex >= 0 && selectedIndex < entries.length) {
        event.preventDefault();
        select(entries[selectedIndex]!.path);
      }
    } else if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      setOpen(false);
    }
  };

  const scrollIntoView = (index: number) => {
    const item = listRef.current?.children[index] as HTMLElement | undefined;
    item?.scrollIntoView({ block: "nearest" });
  };

  const showPopup = open && (loading || entries.length > 0);

  return (
    <Popover open={showPopup} onOpenChange={setOpen}>
      <PopoverAnchor asChild>
        <Input
          name={name}
          required
          value={value}
          placeholder={placeholder}
          autoFocus={autoFocus}
          autoComplete="off"
          spellCheck={false}
          role="combobox"
          aria-autocomplete="list"
          aria-expanded={showPopup}
          aria-controls="directory-suggest-list"
          onChange={(event) => {
            setValue(event.target.value);
            setSelectedIndex(-1);
            setOpen(true);
          }}
          onFocus={() => {
            if (entries.length > 0) setOpen(true);
          }}
          onKeyDown={handleKeyDown}
        />
      </PopoverAnchor>
      <PopoverContent
        id="directory-suggest-list"
        role="listbox"
        className="w-[var(--radix-popper-anchor-width)] p-1 max-h-60 overflow-y-auto z-50 shadow-md"
        align="start"
        side="bottom"
        sideOffset={4}
        onOpenAutoFocus={(event) => event.preventDefault()}
      >
        {loading && entries.length === 0 ? (
          <div className="px-3 py-2 text-xs text-muted-foreground">Searching directories…</div>
        ) : (
          <div ref={listRef} className="flex flex-col gap-0.5">
            {entries.map((entry, index) => {
              const isSelected = index === selectedIndex;
              return (
                <div
                  key={entry.path}
                  role="option"
                  aria-selected={isSelected}
                  onMouseDown={(e) => {
                    // Prevent input from losing focus before click resolves
                    e.preventDefault();
                  }}
                  onClick={() => select(entry.path)}
                  onMouseEnter={() => setSelectedIndex(index)}
                  className={`flex flex-col items-start gap-0.5 px-2 py-1.5 rounded-sm cursor-pointer select-none text-left transition-colors ${
                    isSelected
                      ? "bg-accent text-accent-foreground"
                      : "hover:bg-accent/50 text-foreground"
                  }`}
                >
                  <span className="text-xs font-medium">{entry.name}</span>
                  <span className="max-w-full truncate text-[11px] text-muted-foreground">
                    {entry.path}
                  </span>
                </div>
              );
            })}
          </div>
        )}
        {truncated && (
          <div className="border-t px-2 py-1.5 mt-1 text-[11px] text-muted-foreground">
            Showing first {entries.length} matches — keep typing to narrow down.
          </div>
        )}
      </PopoverContent>
    </Popover>
  );
}
