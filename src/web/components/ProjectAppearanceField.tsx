import { useState } from "react";
import { Check, ChevronsUpDown } from "lucide-react";
import { PROJECT_COLORS, PROJECT_ICON_NAMES } from "../../shared/domain/workspaces.ts";
import { cn } from "../lib/utils.ts";
import { Button } from "./ui/button.tsx";
import { Checkbox } from "./ui/checkbox.tsx";
import { Label } from "./ui/label.tsx";
import { Popover, PopoverContent, PopoverTrigger } from "./ui/popover.tsx";
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "./ui/command.tsx";
import { PROJECT_ICON_COMPONENTS, ProjectIconBadge } from "./ProjectIcon.tsx";

export type ProjectAppearance = {
  iconName: string | null;
  iconColor: string | null;
};

function normalizeColor(value?: string | null): string | null {
  if (!value) return null;
  const trimmed = value.trim();
  return /^#[0-9a-fA-F]{6}$/.test(trimmed) ? trimmed : null;
}

export function ProjectAppearanceField({
  icon,
  color,
  onIconChange,
  onColorChange,
  idPrefix = "project-appearance",
  useProjectIcon = false,
  onUseProjectIconChange,
  detectedIconUrl,
}: {
  icon: string | null;
  color: string | null;
  onIconChange: (icon: string | null) => void;
  onColorChange: (color: string | null) => void;
  idPrefix?: string;
  /** "Use project icon" toggle state. The toggle itself only renders when
   *  onUseProjectIconChange is provided (editing an existing project). */
  useProjectIcon?: boolean;
  onUseProjectIconChange?: (value: boolean) => void;
  /** Daemon URL for the detected favicon; shown in the preview when the
   *  toggle is on. Falls back to the lucide icon when nothing is found. */
  detectedIconUrl?: string | null;
}) {
  const [iconOpen, setIconOpen] = useState(false);
  const activeColor = normalizeColor(color);
  const customIsPreset = activeColor
    ? (PROJECT_COLORS as readonly string[]).includes(activeColor.toLowerCase()) ||
      (PROJECT_COLORS as readonly string[]).includes(activeColor)
    : true;

  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-start gap-3">
        <div
          className="flex items-center justify-center w-10 h-10 rounded-md border border-border/60 bg-muted/30 shrink-0 overflow-hidden"
          aria-hidden="true"
        >
          <ProjectIconBadge iconName={icon} color={color} size={20} imageSrc={useProjectIcon ? (detectedIconUrl ?? null) : null} />
        </div>
        <div className="flex flex-col gap-1 min-w-0 flex-1">
          <Label htmlFor={`${idPrefix}-icon`} className="text-xs">
            Project icon &amp; color
          </Label>
          <p className="text-[11px] text-muted-foreground">
            The icon shows in the sidebar tinted with your exact color.
          </p>
        </div>
      </div>

      {onUseProjectIconChange && (
        <label htmlFor={`${idPrefix}-use-project-icon`} className="flex items-start gap-2 cursor-pointer">
          <Checkbox
            id={`${idPrefix}-use-project-icon`}
            checked={useProjectIcon}
            onCheckedChange={(checked) => onUseProjectIconChange(checked === true)}
            className="mt-0.5"
          />
          <span className="flex flex-col gap-0.5 min-w-0">
            <span className="text-xs font-medium">Use project icon</span>
            <span className="text-[11px] text-muted-foreground">
              Automatically use the project&apos;s favicon or app icon when one is found; otherwise the icon below is used.
            </span>
          </span>
        </label>
      )}

      <div className="flex flex-col gap-1.5">
        <span className="text-xs font-medium" id={`${idPrefix}-icon-label`}>
          Icon
        </span>
        <Popover open={iconOpen} onOpenChange={setIconOpen}>
          <PopoverTrigger asChild>
            <Button
              id={`${idPrefix}-icon`}
              type="button"
              variant="outline"
              role="combobox"
              aria-expanded={iconOpen}
              aria-labelledby={`${idPrefix}-icon-label ${idPrefix}-icon`}
              className="w-full justify-between h-8 text-xs font-normal"
            >
              <span className="flex items-center gap-2 min-w-0">
                <ProjectIconBadge iconName={icon} color={color} size={14} imageSrc={useProjectIcon ? (detectedIconUrl ?? null) : null} />
                <span className="truncate">{icon ?? "Folder"}</span>
              </span>
              <ChevronsUpDown className="w-3.5 h-3.5 shrink-0 opacity-50" />
            </Button>
          </PopoverTrigger>
          <PopoverContent className="w-[var(--radix-popover-trigger-width)] max-w-[calc(100vw-2rem)] p-0 z-[60]" align="start">
            <Command>
              <CommandInput placeholder="Search icons..." className="h-9 text-xs" />
              <CommandList className="max-h-[260px]">
                <CommandEmpty className="py-6 text-center text-xs">No icons found.</CommandEmpty>
                <CommandGroup>
                  {PROJECT_ICON_NAMES.map((name) => {
                    const Icon = PROJECT_ICON_COMPONENTS[name];
                    const selected = icon === name || (!icon && name === "Folder");
                    return (
                      <CommandItem
                        key={name}
                        value={name}
                        onSelect={() => {
                          onIconChange(name === "Folder" ? null : name);
                          setIconOpen(false);
                        }}
                        className="text-xs"
                      >
                        <span style={activeColor ? { color: activeColor } : undefined} className="inline-flex">
                          <Icon className="w-4 h-4" aria-hidden="true" />
                        </span>
                        <span className="flex-1 truncate">{name}</span>
                        {selected && <Check className="w-3.5 h-3.5 shrink-0" aria-hidden="true" />}
                      </CommandItem>
                    );
                  })}
                </CommandGroup>
              </CommandList>
            </Command>
          </PopoverContent>
        </Popover>
      </div>

      <div className="flex flex-col gap-1.5">
        <div className="flex items-center justify-between gap-2">
          <span className="text-xs font-medium" id={`${idPrefix}-color-label`}>
            Color
          </span>
          {activeColor && (
            <button
              type="button"
              className="text-[11px] text-muted-foreground hover:text-foreground transition-colors cursor-pointer"
              onClick={() => onColorChange(null)}
            >
              Reset
            </button>
          )}
        </div>
        <div
          className="grid grid-cols-14 gap-1.5"
          role="group"
          aria-labelledby={`${idPrefix}-color-label`}
          style={{ gridTemplateColumns: "repeat(14, minmax(0, 1fr))" }}
        >
          {PROJECT_COLORS.map((preset) => {
            const selected =
              activeColor?.toLowerCase() === preset.toLowerCase();
            return (
              <button
                key={preset}
                type="button"
                title={preset}
                aria-label={`Color ${preset}`}
                aria-pressed={selected}
                onClick={() => onColorChange(preset)}
                className={cn(
                  "w-6 h-6 rounded-full border border-black/10 cursor-pointer transition-transform hover:scale-110",
                  selected && "ring-2 ring-offset-2 ring-offset-background ring-foreground/60"
                )}
                style={{ backgroundColor: preset }}
              />
            );
          })}
        </div>
        <div className="flex items-center gap-2 pt-1">
          <input
            id={`${idPrefix}-color-custom`}
            type="color"
            aria-label="Custom color"
            value={activeColor ?? "#3b82f6"}
            onChange={(e) => onColorChange(e.target.value)}
            className="w-8 h-8 p-0.5 rounded border border-border/60 bg-transparent cursor-pointer shrink-0"
          />
          <label htmlFor={`${idPrefix}-color-custom`} className="text-[11px] text-muted-foreground flex items-center gap-1.5 min-w-0">
            <span className="shrink-0">Custom</span>
            <code className="font-mono text-[11px] truncate">
              {activeColor ?? "default"}
              {!customIsPreset && activeColor ? " (custom)" : ""}
            </code>
          </label>
        </div>
      </div>
    </div>
  );
}
