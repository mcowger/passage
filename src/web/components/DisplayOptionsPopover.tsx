import { memo, useState } from "react";
import { SlidersHorizontal, RotateCcw } from "lucide-react";
import type {
  BaselineTool,
  ExpandMode,
  ShellOutputMode,
  TimelineExpansionSettings,
} from "../../shared/domain/settings.ts";
import { baselineTools } from "../../shared/domain/settings.ts";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
  PopoverHeader,
  PopoverTitle,
  PopoverDescription,
} from "./ui/popover.tsx";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "./ui/select.tsx";
import { Button } from "./ui/button.tsx";
import { Label } from "./ui/label.tsx";

const TOOL_LABELS: Record<BaselineTool, string> = {
  read: "Read",
  write: "Write",
  edit: "Edit",
  bash: "Bash / Command",
  find: "Find Files",
  grep: "Grep Search",
  ls: "List Directory",
  ask: "Ask User",
};

export interface DisplayOptionsPopoverProps {
  expansion: TimelineExpansionSettings;
  onExpansionChange: (next: TimelineExpansionSettings) => void;
  onResetDefaults: () => void;
  isOverridden?: boolean;
}

export const DisplayOptionsPopover = memo(function DisplayOptionsPopover({
  expansion,
  onExpansionChange,
  onResetDefaults,
  isOverridden,
}: DisplayOptionsPopoverProps) {
  const [open, setOpen] = useState(false);

  const handleThinkingChange = (mode: ExpandMode) => {
    onExpansionChange({
      ...expansion,
      thinking: mode,
    });
  };

  const handleToolChange = (tool: BaselineTool, mode: ExpandMode) => {
    onExpansionChange({
      ...expansion,
      tools: {
        ...expansion.tools,
        [tool]: mode,
      },
    });
  };

  const handleSetAllTools = (mode: ExpandMode) => {
    const nextTools = { ...expansion.tools };
    for (const tool of baselineTools) {
      nextTools[tool] = mode;
    }
    onExpansionChange({
      ...expansion,
      tools: nextTools,
      otherTools: mode,
    });
  };

  const handleOtherToolsChange = (mode: ExpandMode) => {
    onExpansionChange({
      ...expansion,
      otherTools: mode,
    });
  };

  const handleShellOutputChange = (mode: ShellOutputMode) => {
    onExpansionChange({
      ...expansion,
      shellOutput: mode,
    });
  };

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          className="composer-icon-btn relative"
          title="Display options (session only)"
          aria-label="Display options (session only)"
        >
          <SlidersHorizontal size={14} aria-hidden="true" />
          {isOverridden && (
            <span
              className="absolute top-1 right-1 w-1.5 h-1.5 rounded-full bg-primary"
              aria-hidden="true"
            />
          )}
        </button>
      </PopoverTrigger>
      <PopoverContent
        side="top"
        align="end"
        sideOffset={8}
        collisionPadding={12}
        className="w-80 max-w-[calc(100vw-2rem)] max-h-[min(28rem,calc(100dvh-8rem))] p-0 shadow-lg border border-border bg-popover flex flex-col overflow-hidden"
      >
        <PopoverHeader className="flex-none px-3 pt-3 pb-2 border-b border-border">
          <div className="flex items-center justify-between">
            <PopoverTitle className="text-sm font-semibold">
              Display Options
            </PopoverTitle>
            {isOverridden && (
              <Button
                variant="ghost"
                size="xs"
                className="h-6 px-2 text-[11px] text-muted-foreground hover:text-foreground"
                onClick={onResetDefaults}
                title="Reset session overrides to workspace defaults"
              >
                <RotateCcw size={11} className="mr-1" />
                Reset
              </Button>
            )}
          </div>
          <PopoverDescription className="text-[11px] text-muted-foreground">
            Valid for this session only
          </PopoverDescription>
        </PopoverHeader>

        <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain p-3">
          <div className="flex flex-col gap-3 text-xs">
            {/* Thinking */}
            <div className="flex items-center justify-between gap-2">
              <Label htmlFor="session-thinking" className="text-xs font-medium">
                Thinking
              </Label>
              <Select
                value={expansion.thinking}
                onValueChange={(val) => handleThinkingChange(val as ExpandMode)}
              >
                <SelectTrigger id="session-thinking" className="h-7 w-28 text-xs">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="always">Always</SelectItem>
                  <SelectItem value="latest">Latest</SelectItem>
                  <SelectItem value="none">None</SelectItem>
                </SelectContent>
              </Select>
            </div>

            {/* Tools header & batch actions */}
            <div className="pt-2 border-t border-border flex items-center justify-between">
              <span className="text-xs font-semibold text-foreground">Tools</span>
              <div className="flex items-center gap-1">
                <span className="text-[10px] text-muted-foreground mr-0.5">All:</span>
                <Button
                  variant="outline"
                  size="xs"
                  className="h-5 px-1.5 text-[10px]"
                  onClick={() => handleSetAllTools("always")}
                >
                  Always
                </Button>
                <Button
                  variant="outline"
                  size="xs"
                  className="h-5 px-1.5 text-[10px]"
                  onClick={() => handleSetAllTools("latest")}
                >
                  Latest
                </Button>
                <Button
                  variant="outline"
                  size="xs"
                  className="h-5 px-1.5 text-[10px]"
                  onClick={() => handleSetAllTools("none")}
                >
                  None
                </Button>
              </div>
            </div>

            {/* Baseline tools list */}
            <div className="flex flex-col gap-2 pl-1">
              {baselineTools.map((tool) => (
                <div
                  key={tool}
                  className="flex items-center justify-between gap-2"
                >
                  <Label
                    htmlFor={`session-tool-${tool}`}
                    className="text-xs text-muted-foreground font-normal"
                  >
                    {TOOL_LABELS[tool]}
                  </Label>
                  <Select
                    value={expansion.tools[tool] ?? expansion.otherTools}
                    onValueChange={(val) => handleToolChange(tool, val as ExpandMode)}
                  >
                    <SelectTrigger
                      id={`session-tool-${tool}`}
                      className="h-7 w-28 text-xs"
                    >
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="always">Always</SelectItem>
                      <SelectItem value="latest">Latest</SelectItem>
                      <SelectItem value="none">None</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
              ))}
            </div>

            {/* Shell output default */}
            <div className="pt-2 border-t border-border flex items-center justify-between gap-2">
              <Label
                htmlFor="session-shell-output"
                className="text-xs font-medium"
                title="Default bash output in open rows: last-lines preview or full text. Per-row Show all/less still overrides."
              >
                Shell output
              </Label>
              <Select
                value={expansion.shellOutput ?? "preview"}
                onValueChange={(val) => handleShellOutputChange(val as ShellOutputMode)}
              >
                <SelectTrigger
                  id="session-shell-output"
                  className="h-7 w-28 text-xs"
                >
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="preview">Preview</SelectItem>
                  <SelectItem value="full">Full</SelectItem>
                </SelectContent>
              </Select>
            </div>

            {/* Other tools */}
            <div className="pt-2 border-t border-border flex items-center justify-between gap-2">
              <Label
                htmlFor="session-tool-other"
                className="text-xs font-medium"
              >
                Other Tools (MCP)
              </Label>
              <Select
                value={expansion.otherTools}
                onValueChange={(val) => handleOtherToolsChange(val as ExpandMode)}
              >
                <SelectTrigger
                  id="session-tool-other"
                  className="h-7 w-28 text-xs"
                >
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="always">Always</SelectItem>
                  <SelectItem value="latest">Latest</SelectItem>
                  <SelectItem value="none">None</SelectItem>
                </SelectContent>
              </Select>
            </div>
          </div>
        </div>
      </PopoverContent>
    </Popover>
  );
});
