import type { SlashCommand } from "../../shared/domain/agents.ts";
import type { FileSearchEntry } from "../../shared/protocol/workspace.ts";
import { FileTypeIcon } from "./FileTypeIcon.tsx";
import { Popover, PopoverAnchor, PopoverContent } from "./ui/popover.tsx";
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandItem as CommandRow,
  CommandList,
} from "./ui/command.tsx";

export const COMPOSER_SUGGESTION_LIST_ID = "composer-autocomplete-list";

function directoryHint(path: string): string {
  const slash = path.lastIndexOf("/");
  if (slash <= 0) return "";
  const dir = path.slice(0, slash);
  return dir.length > 48 ? `…${dir.slice(dir.length - 47)}` : dir;
}

export type ComposerAutocompleteProps = {
  open: boolean;
  kind: "@" | "/";
  files: FileSearchEntry[];
  filesLoading: boolean;
  filesError: string;
  commands: SlashCommand[];
  skillsAvailable: boolean;
  activeIndex: number;
  activeValue: string;
  onActiveValueChange: (value: string) => void;
  onHoverIndex: (index: number) => void;
  onSelectFile: (path: string) => void;
  onSelectCommand: (command: SlashCommand) => void;
  onEscape: () => void;
  onInteractOutside: (insideComposer: boolean) => void;
};

/**
 * Single autocomplete popover for `@` files and `/` commands, anchored
 * above the composer card edge (caret anchoring was deemed costly).
 *
 * Built on shadcn `popover` + `command` primitives: Radix owns the portal,
 * outside-click dismissal, and Escape handling; cmdk owns listbox semantics
 * and row selection state. Focus never leaves the composer textarea while
 * open (auto-focus is suppressed) so typing never blocks.
 *
 * Stays a popover below 640px — never a full-screen sheet — sized within
 * the dynamic viewport so the software keyboard cannot cover it.
 */
export function ComposerAutocomplete({
  open,
  kind,
  files,
  filesLoading,
  filesError,
  commands,
  skillsAvailable,
  activeIndex,
  activeValue,
  onActiveValueChange,
  onHoverIndex,
  onSelectFile,
  onSelectCommand,
  onEscape,
  onInteractOutside,
}: ComposerAutocompleteProps) {
  void activeIndex;
  return (
    <Popover open={open} modal={false}>
      <PopoverAnchor asChild>
        <span className="composer-autocomplete-anchor" aria-hidden="true" />
      </PopoverAnchor>
      <PopoverContent
        side="top"
        align="start"
        sideOffset={8}
        avoidCollisions
        className="composer-autocomplete"
        onOpenAutoFocus={(event) => event.preventDefault()}
        onCloseAutoFocus={(event) => event.preventDefault()}
        onEscapeKeyDown={onEscape}
        onInteractOutside={(event) => {
          const target = event.target as HTMLElement | null;
          onInteractOutside(Boolean(target?.closest?.(".composer-card")));
        }}
      >
        <Command shouldFilter={false} value={activeValue} onValueChange={onActiveValueChange}>
          {kind === "@" ? (
            <>
              <div className="composer-autocomplete-header" aria-hidden="true">Files</div>
              <CommandList id={COMPOSER_SUGGESTION_LIST_ID} className="composer-autocomplete-list">
                {filesError ? (
                  <div className="composer-autocomplete-status" role="status">{filesError}</div>
                ) : files.length === 0 && !filesLoading ? (
                  <CommandEmpty>No matching files</CommandEmpty>
                ) : (
                  <CommandGroup>
                    {files.map((entry) => (
                      <CommandRow
                        key={`file:${entry.path}`}
                        id={`composer-option-file:${entry.path}`}
                        value={`file:${entry.path}`}
                        onMouseMove={() => onHoverIndex(files.indexOf(entry))}
                        onSelect={() => onSelectFile(entry.path)}
                        className="composer-autocomplete-row"
                      >
                        <FileTypeIcon path={entry.path} size={14} />
                        <span className="composer-autocomplete-path" title={entry.path}>
                          <span className="tool-path-wrap">
                            <span className="tool-path-dir">{directoryHint(entry.path) ? `${directoryHint(entry.path)}/` : ""}</span>
                            <span className="tool-path-name">{entry.path.split("/").at(-1)}</span>
                          </span>
                        </span>
                        {entry.kind === "directory" && <span className="composer-autocomplete-kind">dir</span>}
                      </CommandRow>
                    ))}
                  </CommandGroup>
                )}
                {filesLoading && <div className="composer-autocomplete-status" role="status">Searching…</div>}
              </CommandList>
            </>
          ) : (
            <>
              <div className="composer-autocomplete-header" aria-hidden="true">Commands</div>
              <CommandList id={COMPOSER_SUGGESTION_LIST_ID} className="composer-autocomplete-list">
                {commands.length === 0 ? (
                  <CommandEmpty>No matching commands</CommandEmpty>
                ) : (
                  <CommandGroup>
                    {commands.map((command) => (
                      <CommandRow
                        key={`cmd:${command.name}`}
                        id={`composer-option-cmd:${command.name}`}
                        value={`cmd:${command.name}`}
                        onMouseMove={() => onHoverIndex(commands.indexOf(command))}
                        onSelect={() => onSelectCommand(command)}
                        className="composer-autocomplete-row"
                      >
                        <span className="composer-autocomplete-slash" aria-hidden="true">/</span>
                        <span className="composer-autocomplete-path">
                          <code className="composer-command-name">{command.name}</code>
                          <span className="composer-command-desc">{command.description}</span>
                        </span>
                        <span className="composer-autocomplete-kind">{command.hint}</span>
                      </CommandRow>
                    ))}
                  </CommandGroup>
                )}
              </CommandList>
              {!skillsAvailable && (
                <div className="composer-autocomplete-footer">skills unavailable — untrusted workspace</div>
              )}
            </>
          )}
        </Command>
      </PopoverContent>
    </Popover>
  );
}
