import React, { useState, useMemo, useRef, useEffect } from "react";
import {
  HelpCircle,
  Edit3,
  Check,
  X,
  ChevronRight,
  FileText,
  Code,
  ListChecks,
  CheckCheck,
} from "lucide-react";
import { cn } from "../lib/utils.ts";

export interface QuestionOption {
  label: string;
  description?: string;
}

export interface QuestionInfo {
  question: string;
  header?: string;
  options: QuestionOption[];
  multiple?: boolean;
}

export interface QuestionRequest {
  id: string;
  questions: QuestionInfo[];
  method?: "select" | "confirm" | "input" | "editor";
}

export interface QuestionCardProps {
  request: QuestionRequest;
  onRespond: (result: { id: string; value?: string; confirmed?: boolean; cancelled?: true }) => Promise<void>;
}

const SUMMARY_TAB = "summary";

export function QuestionCard({ request, onRespond }: QuestionCardProps) {
  const [activeTab, setActiveTab] = useState<string>("0");
  const [isResponding, setIsResponding] = useState(false);
  const [hasResponded, setHasResponded] = useState(false);
  const [copiedMd, setCopiedMd] = useState(false);
  const [copiedJson, setCopiedJson] = useState(false);

  // Selected options map: questionIndex -> string[]
  const [selectedOptions, setSelectedOptions] = useState<Record<number, string[]>>({});
  // Custom answer open state per question index
  const [customMode, setCustomMode] = useState<Record<number, boolean>>(() => {
    const initial: Record<number, boolean> = {};
    if (request.method === "input" || request.method === "editor") {
      initial[0] = true;
    }
    return initial;
  });
  // Custom text values per question index
  const [customText, setCustomText] = useState<Record<number, string>>({});

  const questions = useMemo(() => request.questions ?? [], [request.questions]);
  const isSummaryTab = activeTab === SUMMARY_TAB;
  const activeIndex = isSummaryTab ? -1 : Math.max(0, Math.min(questions.length - 1, Number(activeTab) || 0));
  const activeQuestion = isSummaryTab ? null : questions[activeIndex];

  const activeHeader = useMemo(() => {
    if (isSummaryTab) return null;
    const header = activeQuestion?.header?.trim();
    return header && header.length > 0 ? header : null;
  }, [activeQuestion?.header, isSummaryTab]);

  const tabs = useMemo(() => {
    if (questions.length <= 1) return [];
    const list: Array<{ value: string; label: string }> = questions.map((q, idx) => ({
      value: String(idx),
      label: q.header || `Q${idx + 1}`,
    }));
    list.push({ value: SUMMARY_TAB, label: "Summary" });
    return list;
  }, [questions]);

  // Track unanswered questions
  const unansweredIndexes = useMemo(() => {
    const list: number[] = [];
    questions.forEach((_q, index) => {
      const selected = selectedOptions[index] ?? [];
      const custom = customText[index]?.trim();
      const hasCustom = customMode[index] && Boolean(custom);
      if (selected.length === 0 && !hasCustom) {
        list.push(index);
      }
    });
    return list;
  }, [questions, selectedOptions, customMode, customText]);

  const requiredSatisfied = unansweredIndexes.length === 0;
  const isSingleQuestion = questions.length <= 1;

  const handleToggleOption = (label: string) => {
    if (isResponding) return;
    setCustomMode((prev) => ({ ...prev, [activeIndex]: false }));
    setSelectedOptions((prev) => {
      const current = prev[activeIndex] ?? [];
      const isMultiple = activeQuestion?.multiple;
      if (isMultiple) {
        const next = current.includes(label) ? current.filter((item) => item !== label) : [...current, label];
        return { ...prev, [activeIndex]: next };
      } else {
        // Single select replaces selection
        return { ...prev, [activeIndex]: [label] };
      }
    });
  };

  const handleSelectCustom = () => {
    if (isResponding) return;
    setCustomMode((prev) => ({ ...prev, [activeIndex]: true }));
    setSelectedOptions((prev) => ({ ...prev, [activeIndex]: [] }));
  };

  const handleCustomChange = (text: string) => {
    setCustomText((prev) => ({ ...prev, [activeIndex]: text }));
  };

  const handleNextOrSubmit = async () => {
    if (isResponding) return;
    if (!requiredSatisfied) {
      if (!isSingleQuestion) {
        // Navigate to the next unanswered question
        const nextIndex = unansweredIndexes.find((idx) => idx > activeIndex) ?? unansweredIndexes[0];
        if (nextIndex !== undefined) {
          setActiveTab(String(nextIndex));
          return;
        }
      }
      return;
    }

    // Submit answers
    setIsResponding(true);
    try {
      if (request.method === "confirm") {
        const selected = selectedOptions[0]?.[0];
        const isYes = selected?.toLowerCase() === "yes";
        await onRespond({ id: request.id, confirmed: isYes });
      } else if (request.method === "input" || request.method === "editor") {
        const val = customText[0] ?? "";
        await onRespond({ id: request.id, value: val });
      } else {
        // Collect answers for questions
        const answers: string[] = [];
        questions.forEach((_q, idx) => {
          const selected = selectedOptions[idx] ?? [];
          const custom = customText[idx]?.trim();
          if (customMode[idx] && custom) {
            answers.push(custom);
          } else if (selected.length > 0) {
            answers.push(selected.join(", "));
          }
        });
        const finalValue = answers.length === 1 ? answers[0] : answers.join("; ");
        await onRespond({ id: request.id, value: finalValue });
      }
      setHasResponded(true);
    } catch {
      setIsResponding(false);
    }
  };

  const handleDismiss = async () => {
    if (isResponding) return;
    setIsResponding(true);
    try {
      await onRespond({ id: request.id, cancelled: true });
      setHasResponded(true);
    } catch {
      setIsResponding(false);
    }
  };

  const handleCopyMarkdown = async () => {
    const md = questions
      .map((q, i) => {
        const options = q.options.map((o) => `- ${o.label}${o.description ? `: ${o.description}` : ""}`).join("\n");
        return `### ${q.header || `Question ${i + 1}`}\n${q.question}\n\n${options}`;
      })
      .join("\n\n");
    await navigator.clipboard.writeText(md);
    setCopiedMd(true);
    setTimeout(() => setCopiedMd(false), 2000);
  };

  const handleCopyJson = async () => {
    await navigator.clipboard.writeText(JSON.stringify(request, null, 2));
    setCopiedJson(true);
    setTimeout(() => setCopiedJson(false), 2000);
  };

  if (hasResponded || questions.length === 0) {
    return null;
  }

  const selectedForActive = selectedOptions[activeIndex] ?? [];
  const isCustomActive = Boolean(customMode[activeIndex]);
  const isMultiple = Boolean(activeQuestion?.multiple);

  return (
    <div className="w-full my-2 text-sm">
      <div className="border border-border/30 rounded-xl bg-muted/10 overflow-hidden shadow-xs">
        {/* Header */}
        <div className="px-3 py-2 border-b border-border/20 flex items-center gap-2 bg-muted/20">
          <HelpCircle className="h-4 w-4 text-amber-500 shrink-0" />
          <span className="text-xs font-semibold text-muted-foreground uppercase tracking-wider">Input needed</span>

          {activeHeader && (
            <span className="ml-auto text-xs font-medium text-foreground/80 px-2 py-0.5 rounded-full bg-muted/40 border border-border/30 truncate max-w-[200px]">
              {activeHeader}
            </span>
          )}

          <div className={cn("flex items-center gap-1", activeHeader ? null : "ml-auto")}>
            <button
              type="button"
              onClick={handleCopyMarkdown}
              title="Copy as Markdown"
              aria-label="Copy as Markdown"
              className="flex items-center justify-center h-6 w-6 rounded text-muted-foreground hover:text-foreground hover:bg-muted/40 transition-colors"
            >
              {copiedMd ? <CheckCheck className="h-3.5 w-3.5 text-emerald-500" /> : <FileText className="h-3.5 w-3.5" />}
            </button>
            <button
              type="button"
              onClick={handleCopyJson}
              title="Copy as JSON"
              aria-label="Copy as JSON"
              className="flex items-center justify-center h-6 w-6 rounded text-muted-foreground hover:text-foreground hover:bg-muted/40 transition-colors"
            >
              {copiedJson ? <CheckCheck className="h-3.5 w-3.5 text-emerald-500" /> : <Code className="h-3.5 w-3.5" />}
            </button>
          </div>
        </div>

        {/* Tab Bar (for multi-questions) */}
        {tabs.length > 1 && (
          <div className="px-3 pt-2 pb-1 flex items-center gap-1.5 flex-wrap border-b border-border/10 bg-muted/10">
            {tabs.map((tab) => {
              const isActive = activeTab === tab.value;
              const isSummary = tab.value === SUMMARY_TAB;
              const tabIndex = isSummary ? -1 : Number(tab.value);
              const isAnswered = !isSummary && !unansweredIndexes.includes(tabIndex);

              return (
                <button
                  key={tab.value}
                  type="button"
                  onClick={() => setActiveTab(tab.value)}
                  className={cn(
                    "px-2.5 py-1 text-xs font-medium rounded-md transition-colors flex items-center gap-1.5",
                    isActive
                      ? "bg-accent/40 text-foreground font-semibold"
                      : isSummary
                      ? "text-muted-foreground hover:text-foreground hover:bg-muted/30"
                      : isAnswered
                      ? "text-muted-foreground/70 hover:text-foreground hover:bg-muted/30"
                      : "text-foreground/85 hover:text-foreground hover:bg-muted/30"
                  )}
                >
                  {isSummary && <ListChecks className="h-3 w-3" />}
                  {tab.label}
                  {isAnswered && !isSummary && <Check className="h-2.5 w-2.5 text-emerald-500" />}
                </button>
              );
            })}
          </div>
        )}

        {/* Content Area */}
        <div className="px-3 py-3">
          {isSummaryTab ? (
            <div className="space-y-2">
              {questions.map((q, index) => {
                const selected = selectedOptions[index] ?? [];
                const custom = customText[index]?.trim();
                const hasCustom = customMode[index] && Boolean(custom);
                const answerText = hasCustom ? custom : selected.length > 0 ? selected.join(", ") : "(no answer)";

                return (
                  <button
                    key={index}
                    type="button"
                    onClick={() => setActiveTab(String(index))}
                    className="w-full text-left rounded-lg p-2 hover:bg-muted/20 transition-colors border border-border/10"
                  >
                    <div className="text-xs text-muted-foreground">{q.header || `Question ${index + 1}`}</div>
                    <div className={cn("text-sm font-medium mt-0.5", answerText !== "(no answer)" ? "text-foreground" : "text-muted-foreground/50 italic")}>
                      {answerText}
                    </div>
                  </button>
                );
              })}
            </div>
          ) : activeQuestion ? (
            <>
              <div className="font-semibold text-foreground text-sm leading-snug mb-2">
                {activeQuestion.question}
              </div>

              {isMultiple && (
                <div className="text-xs text-muted-foreground mb-2">Select multiple options</div>
              )}

              <div className="space-y-1">
                {activeQuestion.options.map((option, index) => {
                  const selected = selectedForActive.includes(option.label);
                  const recommended = /\(recommended\)/i.test(option.label);

                  return (
                    <button
                      key={`${index}:${option.label}`}
                      type="button"
                      onClick={() => handleToggleOption(option.label)}
                      disabled={isResponding}
                      className={cn(
                        "w-full px-2.5 py-2 text-left rounded-lg transition-all border",
                        selected
                          ? "bg-accent/25 border-border/50"
                          : "hover:bg-muted/30 border-transparent",
                        isResponding ? "opacity-60 cursor-not-allowed" : "cursor-pointer"
                      )}
                    >
                      <div className="flex items-start gap-2.5">
                        <div className="mt-0.5 shrink-0">
                          {isMultiple ? (
                            <div
                              className={cn(
                                "w-4 h-4 rounded border flex items-center justify-center transition-colors",
                                selected
                                  ? "bg-primary border-primary text-primary-foreground"
                                  : "border-muted-foreground/40 bg-transparent"
                              )}
                            >
                              {selected && <Check className="w-3 h-3" />}
                            </div>
                          ) : (
                            <div
                              className={cn(
                                "w-4 h-4 rounded-full border flex items-center justify-center transition-colors",
                                selected
                                  ? "border-primary"
                                  : "border-muted-foreground/40 bg-transparent"
                              )}
                            >
                              {selected && <div className="w-2 h-2 rounded-full bg-primary" />}
                            </div>
                          )}
                        </div>

                        <div className="min-w-0 flex-1">
                          <div className="flex items-center gap-1.5 flex-wrap">
                            <span className={cn("text-sm break-words", selected ? "text-foreground font-medium" : "text-foreground/85")}>
                              {option.label}
                            </span>
                            {recommended && (
                              <span className="text-[10px] text-primary/90 font-medium px-1.5 py-0.2 rounded bg-primary/10 border border-primary/20">
                                recommended
                              </span>
                            )}
                          </div>
                          {option.description && (
                            <div className="text-xs text-muted-foreground mt-0.5 break-words">
                              {option.description}
                            </div>
                          )}
                        </div>
                      </div>
                    </button>
                  );
                })}

                {/* Custom "Other..." option */}
                <button
                  type="button"
                  onClick={handleSelectCustom}
                  disabled={isResponding}
                  className={cn(
                    "w-full px-2.5 py-2 text-left rounded-lg transition-all border",
                    isCustomActive ? "bg-accent/20 border-border/40" : "hover:bg-muted/30 border-transparent",
                    isResponding ? "opacity-60 cursor-not-allowed" : "cursor-pointer"
                  )}
                >
                  <div className="flex items-center gap-2">
                    <Edit3 className={cn("h-3.5 w-3.5", isCustomActive ? "text-primary" : "text-muted-foreground/60")} />
                    <span className={cn("text-sm", isCustomActive ? "text-foreground font-medium" : "text-muted-foreground")}>
                      Other…
                    </span>
                  </div>
                </button>

                {isCustomActive && (
                  <div className="pl-6 pr-2 pt-1">
                    <textarea
                      value={customText[activeIndex] ?? ""}
                      onChange={(e) => handleCustomChange(e.target.value)}
                      placeholder="Your answer..."
                      disabled={isResponding}
                      rows={2}
                      className="w-full bg-background/50 border border-border/40 focus:border-primary rounded-lg px-2.5 py-1.5 outline-hidden text-sm text-foreground placeholder:text-muted-foreground/50 transition-colors resize-y min-h-[56px]"
                      autoFocus
                    />
                  </div>
                )}
              </div>
            </>
          ) : null}
        </div>

        {/* Footer Actions */}
        <div className="px-3 py-2 border-t border-border/20 flex items-center gap-2 bg-muted/20">
          <button
            type="button"
            onClick={handleNextOrSubmit}
            disabled={isResponding || (!requiredSatisfied && isSingleQuestion)}
            className={cn(
              "flex items-center gap-1 px-3 py-1 text-xs font-semibold rounded-md transition-colors cursor-pointer",
              "bg-emerald-500/10 text-emerald-400 border border-emerald-500/20 hover:bg-emerald-500/20",
              "disabled:opacity-50 disabled:cursor-not-allowed"
            )}
          >
            {requiredSatisfied || isSingleQuestion ? <Check className="h-3.5 w-3.5" /> : <ChevronRight className="h-3.5 w-3.5" />}
            {requiredSatisfied || isSingleQuestion ? "Submit" : "Next"}
          </button>

          <button
            type="button"
            onClick={handleDismiss}
            disabled={isResponding}
            className={cn(
              "flex items-center gap-1 px-3 py-1 text-xs font-semibold rounded-md transition-colors cursor-pointer",
              "bg-rose-500/10 text-rose-400 border border-rose-500/20 hover:bg-rose-500/20",
              "disabled:opacity-50 disabled:cursor-not-allowed"
            )}
          >
            <X className="h-3.5 w-3.5" />
            Dismiss
          </button>

          {isResponding && (
            <div className="ml-auto flex items-center gap-1.5 text-xs text-muted-foreground">
              <div className="animate-spin h-3 w-3 border border-primary border-t-transparent rounded-full" />
              <span>Sending...</span>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
