import React, { useEffect, useMemo, useState } from "react";
import type { AgentCapabilities } from "../../shared/domain/agents.ts";
import { Badge } from "./ui/badge.tsx";
import { Popover, PopoverContent, PopoverTrigger } from "./ui/popover.tsx";
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem as CommandRow,
  CommandList,
} from "./ui/command.tsx";

export interface ModelPickerProps {
  currentModelId?: string;
  currentModelName: string;
  currentThinking: string;
  capabilities?: AgentCapabilities;
  onSelectModel: (provider: string, modelId: string) => Promise<void>;
  onSelectThinking: (level: string) => Promise<void>;
  disabled?: boolean;
}

function getContextWindowLabel(m: AgentCapabilities["models"][number]): string {
  if (m.contextWindow && m.contextWindow > 0) {
    if (m.contextWindow >= 1_000_000) {
      const val = (m.contextWindow / 1_000_000).toFixed(1).replace(/\.0$/, "");
      return `${val}M`;
    }
    if (m.contextWindow >= 1_000) {
      return `${Math.round(m.contextWindow / 1_000)}K`;
    }
    return String(m.contextWindow);
  }
  const lower = `${m.id} ${m.name}`.toLowerCase();
  if (lower.includes("gemini-3") || lower.includes("gemini-2.5") || lower.includes("gemini 3") || lower.includes("gemini 2.5") || lower.includes("gemini 3.7") || lower.includes("gemini 3.5")) return "1M";
  if (lower.includes("glm-5") || lower.includes("glm 5")) return "1.3M";
  if (lower.includes("deepseek")) return "1M";
  if (lower.includes("sonnet 5") || lower.includes("opus 5") || lower.includes("opus 4") || lower.includes("sonnet 4")) return "1M";
  if (lower.includes("haiku")) return "200K";
  if (lower.includes("gpt-5") || lower.includes("terra")) return "1.1M";
  if (lower.includes("gpt-4o") || lower.includes("gpt-4")) return "128K";
  return "1M";
}

interface ModelSection {
  title: string;
  items: AgentCapabilities["models"];
  isFav?: boolean;
  isRecent?: boolean;
}

/** Signal-strength indicator for thinking effort: one bar per available level. */
function ThinkingSignalBars({ options, current }: { options: string[]; current: string }) {
  const activeIndex = Math.max(0, options.indexOf(current));
  return (
    <span className="thinking-bars" aria-hidden="true">
      {options.map((level, index) => (
        <span
          key={level}
          className={`thinking-bar${index <= activeIndex ? " filled" : ""}`}
          style={{ height: `${4 + (index * 8) / Math.max(1, options.length - 1)}px` }}
        />
      ))}
    </span>
  );
}

export function ModelPicker({
  currentModelId,
  currentModelName,
  currentThinking,
  capabilities,
  onSelectModel,
  onSelectThinking,
  disabled,
}: ModelPickerProps) {
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState("");

  const [favorites, setFavorites] = useState<string[]>(() => {
    try {
      const saved = localStorage.getItem("passage:favorite_models");
      return saved ? JSON.parse(saved) : ["plexus:gemini-3.7-flash", "plexus:claude-sonnet-5"];
    } catch {
      return ["plexus:gemini-3.7-flash"];
    }
  });

  const [recents, setRecents] = useState<string[]>(() => {
    try {
      const saved = localStorage.getItem("passage:recent_models");
      return saved ? JSON.parse(saved) : [];
    } catch {
      return [];
    }
  });

  const availableModels = useMemo(() => {
    if (!capabilities?.models) return [];
    return capabilities.models.filter((m) => m.authenticated);
  }, [capabilities]);

  const currentModelObj = useMemo(() => {
    return availableModels.find((m) => m.id === currentModelId || `${m.provider}:${m.id}` === currentModelId);
  }, [availableModels, currentModelId]);

  const thinkingOptions = useMemo(() => {
    if (currentModelObj?.supportedThinkingLevels && currentModelObj.supportedThinkingLevels.length > 0) {
      return currentModelObj.supportedThinkingLevels;
    }
    return capabilities?.thinkingLevels ?? ["minimal", "low", "medium", "high", "xhigh"];
  }, [capabilities, currentModelObj]);

  const toggleFavorite = (key: string, e: React.MouseEvent) => {
    e.stopPropagation();
    e.preventDefault();
    setFavorites((prev) => {
      const next = prev.includes(key) ? prev.filter((k) => k !== key) : [...prev, key];
      localStorage.setItem("passage:favorite_models", JSON.stringify(next));
      return next;
    });
  };

  const addRecent = (key: string) => {
    setRecents((prev) => {
      const filtered = prev.filter((k) => k !== key);
      const next = [key, ...filtered].slice(0, 5);
      localStorage.setItem("passage:recent_models", JSON.stringify(next));
      return next;
    });
  };

  // Reset search on open
  useEffect(() => {
    if (open) setSearch("");
  }, [open]);

  // Grouped sections for display (search filtering is handled by cmdk)
  const sections = useMemo<ModelSection[]>(() => {
    const favItems = availableModels.filter((m) => favorites.includes(`${m.provider}:${m.id}`) || favorites.includes(m.id));
    const recentItems = availableModels.filter((m) => (recents.includes(`${m.provider}:${m.id}`) || recents.includes(m.id)) && !favorites.includes(`${m.provider}:${m.id}`) && !favorites.includes(m.id));

    // Group remaining by provider
    const providers = new Set(availableModels.map((m) => m.provider));
    const providerSections: ModelSection[] = Array.from(providers).map((provider) => ({
      title: provider.toUpperCase(),
      items: availableModels.filter(
        (m) =>
          m.provider === provider &&
          !favorites.includes(`${m.provider}:${m.id}`) &&
          !favorites.includes(m.id) &&
          !recents.includes(`${m.provider}:${m.id}`) &&
          !recents.includes(m.id)
      ),
    })).filter((s) => s.items.length > 0);

    const result: ModelSection[] = [];
    if (favItems.length > 0) result.push({ title: "FAVORITES", items: favItems, isFav: true });
    if (recentItems.length > 0) result.push({ title: "RECENT", items: recentItems, isRecent: true });
    result.push(...providerSections);
    return result;
  }, [availableModels, favorites, recents]);

  const selectModel = (provider: string, id: string) => {
    addRecent(`${provider}:${id}`);
    void onSelectModel(provider, id);
    setOpen(false);
  };

  const cycleThinking = (delta: 1 | -1) => {
    const currentIndex = thinkingOptions.indexOf(currentThinking);
    const nextIndex = (currentIndex + delta + thinkingOptions.length) % thinkingOptions.length;
    void onSelectThinking(thinkingOptions[nextIndex] ?? "high");
  };

  return (
    <div className="model-picker-container">
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger asChild>
          <button
            type="button"
            className="composer-chip-btn"
            disabled={disabled || availableModels.length === 0}
            title={`Active Model: ${currentModelName} · Thinking: ${currentThinking}`}
            aria-haspopup="dialog"
            aria-expanded={open}
          >
            <span className="chip-label">{currentModelName}</span>
          </button>
        </PopoverTrigger>
        <PopoverContent className="w-[380px] max-w-[calc(100vw-2rem)] p-0" align="start" sideOffset={6}>
          <Command>
            <CommandInput
              placeholder="Search models"
              value={search}
              onValueChange={setSearch}
              onKeyDown={(e) => {
                if (e.key === "ArrowRight") {
                  e.preventDefault();
                  cycleThinking(1);
                } else if (e.key === "ArrowLeft") {
                  e.preventDefault();
                  cycleThinking(-1);
                }
              }}
            />
            <CommandList className="model-list-scroll max-h-[320px]">
              <CommandEmpty>No matching models found</CommandEmpty>
              {sections.map((section) => (
                <CommandGroup
                  key={section.title}
                  heading={`${section.isFav ? "★ " : section.isRecent ? "🕒 " : "❖ "}${section.title}`}
                >
                  {section.items.map((m) => {
                    const modelKey = `${m.provider}:${m.id}`;
                    const isSelected = currentModelId === m.id || currentModelId === modelKey;
                    const isFav = favorites.includes(modelKey) || favorites.includes(m.id);
                    const ctxLabel = getContextWindowLabel(m);

                    return (
                      <CommandRow
                        key={modelKey}
                        value={`${m.name} ${m.id} ${m.provider}`}
                        onSelect={() => selectModel(m.provider, m.id)}
                        className={`model-row-item ${isSelected ? "selected" : ""}`}
                      >
                        <span className="drag-handle">⠿</span>
                        <span className="model-sparkle">❖</span>
                        <span className="model-name-text">{m.name}</span>
                        <Badge variant="outline" className="context-size-tag font-mono text-[11px] px-1 py-0">
                          {ctxLabel}
                        </Badge>

                        {isSelected && (
                          <Badge variant="secondary" className="model-thinking-tag text-[11px] px-1.5 py-0">
                            Thinking: {currentThinking.charAt(0).toUpperCase() + currentThinking.slice(1)}
                          </Badge>
                        )}

                        {isSelected && <span className="check-icon">✓</span>}

                        <button
                          type="button"
                          className={`fav-star-btn ${isFav ? "favorited" : ""}`}
                          onClick={(e) => toggleFavorite(modelKey, e)}
                          onMouseDown={(e) => e.stopPropagation()}
                          title={isFav ? "Remove from favorites" : "Add to favorites"}
                          aria-label={isFav ? `Remove ${m.name} from favorites` : `Add ${m.name} to favorites`}
                        >
                          {isFav ? "★" : "☆"}
                        </button>
                      </CommandRow>
                    );
                  })}
                </CommandGroup>
              ))}
            </CommandList>
            <div className="model-thinking-section">
              <div className="popover-header-title px-2 py-1.5">Thinking & Effort</div>
              <div role="listbox" aria-label="Select thinking effort">
                {thinkingOptions.map((level) => (
                  <div
                    key={level}
                    role="option"
                    aria-selected={level === currentThinking}
                    className={`thinking-option-row ${level === currentThinking ? "active" : ""}`}
                    onClick={() => {
                      void onSelectThinking(level);
                    }}
                    onKeyDown={(e) => {
                      if (e.key === "Enter" || e.key === " ") {
                        e.preventDefault();
                        void onSelectThinking(level);
                      }
                    }}
                    tabIndex={0}
                  >
                    <ThinkingSignalBars options={thinkingOptions} current={level} />
                    <span className="thinking-option-name">{level}</span>
                    {level === currentThinking && <span className="check-icon">✓</span>}
                  </div>
                ))}
              </div>
            </div>
            <div className="model-popover-footer">
              <span>↑↓ navigate</span>
              <span>Tab switch agent</span>
              <span>←→ thinking</span>
            </div>
          </Command>
        </PopoverContent>
      </Popover>
    </div>
  );
}
