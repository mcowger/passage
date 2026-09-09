import React, { useEffect, useMemo, useRef, useState } from "react";
import type { AgentCapabilities } from "../../shared/domain/agents.ts";
import { Input } from "./ui/input.tsx";
import { Badge } from "./ui/badge.tsx";

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
  const [modelOpen, setModelOpen] = useState(false);
  const [thinkingOpen, setThinkingOpen] = useState(false);
  const [search, setSearch] = useState("");
  const [highlightIndex, setHighlightIndex] = useState(0);

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

  const searchInputRef = useRef<HTMLInputElement>(null);
  const popoverRef = useRef<HTMLDivElement>(null);
  const thinkingPopoverRef = useRef<HTMLDivElement>(null);

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

  // Close on outside click
  useEffect(() => {
    const handleOutsideClick = (e: MouseEvent) => {
      if (popoverRef.current && !popoverRef.current.contains(e.target as Node)) {
        setModelOpen(false);
      }
      if (thinkingPopoverRef.current && !thinkingPopoverRef.current.contains(e.target as Node)) {
        setThinkingOpen(false);
      }
    };
    if (modelOpen || thinkingOpen) {
      document.addEventListener("mousedown", handleOutsideClick);
      return () => document.removeEventListener("mousedown", handleOutsideClick);
    }
  }, [modelOpen, thinkingOpen]);

  // Focus search input on open
  useEffect(() => {
    if (modelOpen) {
      setSearch("");
      setHighlightIndex(0);
      setTimeout(() => searchInputRef.current?.focus(), 50);
    }
  }, [modelOpen]);

  // Filtered models
  const filteredModels = useMemo(() => {
    const query = search.trim().toLowerCase();
    if (!query) return availableModels;
    return availableModels.filter(
      (m) =>
        m.name.toLowerCase().includes(query) ||
        m.id.toLowerCase().includes(query) ||
        m.provider.toLowerCase().includes(query)
    );
  }, [availableModels, search]);

  // Grouped sections for display
  const sections = useMemo<ModelSection[]>(() => {
    if (search.trim()) {
      return [{ title: "MATCHING MODELS", items: filteredModels }];
    }

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
  }, [availableModels, favorites, recents, search, filteredModels]);

  const flatItems = useMemo(() => {
    return sections.flatMap((s) => s.items);
  }, [sections]);

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setHighlightIndex((prev) => (prev + 1) % Math.max(1, flatItems.length));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setHighlightIndex((prev) => (prev - 1 + flatItems.length) % Math.max(1, flatItems.length));
    } else if (e.key === "Enter") {
      e.preventDefault();
      const target = flatItems[highlightIndex];
      if (target) {
        addRecent(`${target.provider}:${target.id}`);
        void onSelectModel(target.provider, target.id);
        setModelOpen(false);
      }
    } else if (e.key === "ArrowRight" || e.key === "ArrowLeft") {
      e.preventDefault();
      // Cycle thinking level
      const currentIndex = thinkingOptions.indexOf(currentThinking);
      const delta = e.key === "ArrowRight" ? 1 : -1;
      const nextIndex = (currentIndex + delta + thinkingOptions.length) % thinkingOptions.length;
      void onSelectThinking(thinkingOptions[nextIndex] ?? "high");
    } else if (e.key === "Escape") {
      setModelOpen(false);
    }
  };

  return (
    <div className="model-picker-container">
      {/* Model Chooser Chip Button */}
      <div className="picker-chip-wrapper" ref={popoverRef}>
        <button
          type="button"
          className="composer-chip-btn"
          onClick={() => {
            setModelOpen(!modelOpen);
            setThinkingOpen(false);
          }}
          disabled={disabled || availableModels.length === 0}
          title={`Active Model: ${currentModelName}`}
          aria-haspopup="dialog"
          aria-expanded={modelOpen}
        >
          <span className="chip-sparkle">❖</span>
          <span className="chip-label">{currentModelName}</span>
        </button>

        {modelOpen && (
          <div className="model-chooser-popover" onKeyDown={handleKeyDown}>
            {/* Search header */}
            <div className="model-search-box">
              <span className="search-icon">🔍</span>
              <Input
                ref={searchInputRef}
                type="text"
                placeholder="Search models"
                value={search}
                onChange={(e) => {
                  setSearch(e.target.value);
                  setHighlightIndex(0);
                }}
              />
            </div>

            {/* Model list sections */}
            <div className="model-list-scroll">
              {sections.map((section) => (
                <div key={section.title} className="model-section-group">
                  <div className="model-section-header">
                    <span>
                      {section.isFav ? "★ " : section.isRecent ? "🕒 " : "❖ "}
                      {section.title}
                    </span>
                    <span className="chevron-icon">▾</span>
                  </div>
                  {section.items.map((m) => {
                    const modelKey = `${m.provider}:${m.id}`;
                    const isSelected = currentModelId === m.id || currentModelId === modelKey;
                    const isHighlighted = flatItems[highlightIndex]?.id === m.id && flatItems[highlightIndex]?.provider === m.provider;
                    const isFav = favorites.includes(modelKey) || favorites.includes(m.id);
                    const ctxLabel = getContextWindowLabel(m);

                    return (
                      <div
                        key={modelKey}
                        className={`model-row-item ${isSelected ? "selected" : ""} ${isHighlighted ? "highlighted" : ""}`}
                        onClick={() => {
                          addRecent(modelKey);
                          void onSelectModel(m.provider, m.id);
                          setModelOpen(false);
                        }}
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
                          title={isFav ? "Remove from favorites" : "Add to favorites"}
                        >
                          {isFav ? "★" : "☆"}
                        </button>
                      </div>
                    );
                  })}
                </div>
              ))}

              {flatItems.length === 0 && (
                <div className="no-models-found">No matching models found</div>
              )}
            </div>

            {/* Footer keyboard shortcuts hint */}
            <div className="model-popover-footer">
              <span>↑↓ navigate</span>
              <span>Tab switch agent</span>
              <span>←→ thinking</span>
            </div>
          </div>
        )}
      </div>

      {/* Thinking / Effort Chip Button */}
      <div className="picker-chip-wrapper" ref={thinkingPopoverRef}>
        <button
          type="button"
          className="composer-chip-btn blue"
          onClick={() => {
            setThinkingOpen(!thinkingOpen);
            setModelOpen(false);
          }}
          disabled={disabled || thinkingOptions.length === 0}
          title={`Thinking / Effort: ${currentThinking}`}
          aria-label={`Thinking effort: ${currentThinking}. Activate to change.`}
          aria-haspopup="listbox"
          aria-expanded={thinkingOpen}
        >
          <ThinkingSignalBars options={thinkingOptions} current={currentThinking} />
        </button>

        {thinkingOpen && (
          <div className="thinking-popover" role="listbox" aria-label="Select thinking effort">
            <div className="popover-header-title">Thinking & Effort</div>
            {thinkingOptions.map((level) => (
              <div
                key={level}
                role="option"
                aria-selected={level === currentThinking}
                className={`thinking-option-row ${level === currentThinking ? "active" : ""}`}
                onClick={() => {
                  void onSelectThinking(level);
                  setThinkingOpen(false);
                }}
              >
                <ThinkingSignalBars options={thinkingOptions} current={level} />
                <span className="thinking-option-name">{level}</span>
                {level === currentThinking && <span className="check-icon">✓</span>}
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
