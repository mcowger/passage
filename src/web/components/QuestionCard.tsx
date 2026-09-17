import { useState, useMemo } from "react";
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
import { copyTextToClipboard } from "../lib/clipboard.ts";
import { Card, CardContent, CardFooter, CardHeader, CardTitle } from "./ui/card.tsx";
import { Tabs, TabsList, TabsTrigger } from "./ui/tabs.tsx";
import { Textarea } from "./ui/textarea.tsx";
import { Button } from "./ui/button.tsx";
import { Badge } from "./ui/badge.tsx";

export interface QuestionOption {
  label: string;
  description?: string;
  preview?: string;
}

export interface QuestionInfo {
  question: string;
  header?: string;
  options: QuestionOption[];
  multiple?: boolean;
  allowOther?: boolean;
  placeholder?: string;
  prefill?: string;
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
  const [customText, setCustomText] = useState<Record<number, string>>(() => {
    const prefill = request.questions[0]?.prefill;
    const initial: Record<number, string> = {};
    if (typeof prefill === "string") initial[0] = prefill;
    return initial;
  });

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
    try {
      const md = questions
        .map((q, i) => {
          const options = q.options.map((o) => `- ${o.label}${o.description ? `: ${o.description}` : ""}`).join("\n");
          return `### ${q.header || `Question ${i + 1}`}\n${q.question}\n\n${options}`;
        })
        .join("\n\n");
      const ok = await copyTextToClipboard(md);
      if (ok) {
        setCopiedMd(true);
        setTimeout(() => setCopiedMd(false), 2000);
      }
    } catch (err) {
      console.warn("Failed to copy markdown:", err);
    }
  };

  const handleCopyJson = async () => {
    try {
      const ok = await copyTextToClipboard(JSON.stringify(request, null, 2));
      if (ok) {
        setCopiedJson(true);
        setTimeout(() => setCopiedJson(false), 2000);
      }
    } catch (err) {
      console.warn("Failed to copy JSON:", err);
    }
  };

  if (hasResponded || questions.length === 0) {
    return null;
  }

  const selectedForActive = selectedOptions[activeIndex] ?? [];
  const isCustomActive = Boolean(customMode[activeIndex]);
  const isMultiple = Boolean(activeQuestion?.multiple);
  const acceptsCustomAnswer = request.method === "input" || request.method === "editor" || activeQuestion?.allowOther === true;

  return (
    <Card className="w-full my-2 text-sm gap-0 py-0 overflow-hidden border border-border/40 shadow-xs">
      {/* Header */}
      <CardHeader className="px-3 py-2 flex flex-row items-center gap-2 border-b border-border/20 bg-muted/20">
        <HelpCircle className="h-4 w-4 text-amber-500 shrink-0" />
        <CardTitle className="text-xs font-semibold text-muted-foreground uppercase tracking-wider">
          Input needed
        </CardTitle>

        {activeHeader && (
          <Badge variant="outline" className="ml-auto text-xs font-medium truncate max-w-[200px]">
            {activeHeader}
          </Badge>
        )}

        <div className={cn("flex items-center gap-1", activeHeader ? null : "ml-auto")}>
          <Button
            type="button"
            variant="ghost"
            size="icon-xs"
            onClick={handleCopyMarkdown}
            title="Copy as Markdown"
            aria-label="Copy as Markdown"
          >
            {copiedMd ? <CheckCheck className="h-3.5 w-3.5 text-emerald-500" /> : <FileText className="h-3.5 w-3.5" />}
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="icon-xs"
            onClick={handleCopyJson}
            title="Copy as JSON"
            aria-label="Copy as JSON"
          >
            {copiedJson ? <CheckCheck className="h-3.5 w-3.5 text-emerald-500" /> : <Code className="h-3.5 w-3.5" />}
          </Button>
        </div>
      </CardHeader>

      {/* Tab Bar (for multi-questions) */}
      {tabs.length > 1 && (
        <Tabs value={activeTab} onValueChange={setActiveTab} className="px-3 pt-2 pb-1 border-b border-border/10 bg-muted/10 gap-0">
          <TabsList className="h-auto bg-transparent p-0 gap-1.5 flex-wrap">
            {tabs.map((tab) => {
              const isSummary = tab.value === SUMMARY_TAB;
              const tabIndex = isSummary ? -1 : Number(tab.value);
              const isAnswered = !isSummary && !unansweredIndexes.includes(tabIndex);

              return (
                <TabsTrigger key={tab.value} value={tab.value} className="px-2.5 py-1 text-xs data-[state=active]:bg-accent/40">
                  {isSummary && <ListChecks className="h-3 w-3" />}
                  {tab.label}
                  {isAnswered && !isSummary && <Check className="h-2.5 w-2.5 text-emerald-500" />}
                </TabsTrigger>
              );
            })}
          </TabsList>
        </Tabs>
      )}

      {/* Content Area */}
      <CardContent className="px-3 py-3">
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

            {/* Options List */}
            <div className="space-y-1.5" role={isMultiple ? "group" : "radiogroup"}>
              {activeQuestion.options.map((option, index) => {
                const selected = selectedForActive.includes(option.label);
                const recommended = /\(recommended\)/i.test(option.label);

                return (
                  <button
                    key={`${index}:${option.label}`}
                    type="button"
                    role={isMultiple ? "checkbox" : "radio"}
                    aria-checked={selected}
                    disabled={isResponding}
                    onClick={() => handleToggleOption(option.label)}
                    className={cn(
                      "w-full px-2.5 py-2 rounded-lg transition-all border flex items-start gap-2.5 text-left cursor-pointer",
                      selected
                        ? "bg-accent/25 border-border/60 shadow-2xs"
                        : "hover:bg-muted/30 border-transparent",
                      isResponding && "opacity-60 cursor-not-allowed"
                    )}
                  >
                    {/* Radio / Checkbox indicator */}
                    <div className="mt-0.5 shrink-0">
                      {isMultiple ? (
                        <div
                          className={cn(
                            "size-4 rounded border flex items-center justify-center transition-colors",
                            selected
                              ? "bg-primary border-primary text-primary-foreground"
                              : "border-muted-foreground/40 bg-transparent"
                          )}
                        >
                          {selected && <Check className="size-3 stroke-[2.5]" />}
                        </div>
                      ) : (
                        <div
                          className={cn(
                            "size-4 rounded-full border flex items-center justify-center transition-colors",
                            selected
                              ? "border-primary"
                              : "border-muted-foreground/40 bg-transparent"
                          )}
                        >
                          {selected && <div className="size-2 rounded-full bg-primary" />}
                        </div>
                      )}
                    </div>

                    {/* Option Text & Description */}
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-1.5 flex-wrap">
                        <span className={cn("text-sm break-words", selected ? "text-foreground font-semibold" : "text-foreground/90")}>
                          {option.label}
                        </span>
                        {recommended && (
                          <Badge variant="outline" className="text-[10px] text-primary/90 px-1.5 py-0 rounded bg-primary/10 border-primary/20 font-medium">
                            recommended
                          </Badge>
                        )}
                      </div>
                      {option.description && (
                        <span className="block text-xs text-muted-foreground mt-0.5 break-words leading-normal">
                          {option.description}
                        </span>
                      )}
                      {option.preview && (
                        <pre className="mt-1.5 p-2 rounded bg-muted/40 border border-border/20 text-xs font-mono text-muted-foreground overflow-x-auto whitespace-pre">
                          <code>{option.preview}</code>
                        </pre>
                      )}
                    </div>
                  </button>
                );
              })}

              {activeQuestion?.allowOther && (
                <button
                  type="button"
                  onClick={handleSelectCustom}
                  disabled={isResponding}
                  className={cn(
                    "w-full px-2.5 py-2 text-left rounded-lg transition-all border cursor-pointer",
                    isCustomActive ? "bg-accent/20 border-border/40" : "hover:bg-muted/30 border-transparent",
                    isResponding && "opacity-60 cursor-not-allowed"
                  )}
                >
                  <div className="flex items-center gap-2">
                    <Edit3 className={cn("h-3.5 w-3.5", isCustomActive ? "text-primary" : "text-muted-foreground/60")} />
                    <span className={cn("text-sm", isCustomActive ? "text-foreground font-medium" : "text-muted-foreground")}>
                      Other…
                    </span>
                  </div>
                </button>
              )}

              {acceptsCustomAnswer && isCustomActive && (
                <div className="pl-6 pr-2 pt-1">
                  <Textarea
                    value={customText[activeIndex] ?? ""}
                    onChange={(e) => handleCustomChange(e.target.value)}
                    placeholder={activeQuestion?.placeholder ?? "Type your answer..."}
                    disabled={isResponding}
                    rows={2}
                    className="min-h-[56px] resize-y"
                    autoFocus
                  />
                </div>
              )}
            </div>
          </>
        ) : null}
      </CardContent>

      {/* Footer Actions — always rendered and clearly visible */}
      <CardFooter className="px-3 py-2 border-t border-border/20 bg-muted/20 flex items-center gap-2">
        <Button
          type="button"
          size="sm"
          onClick={handleNextOrSubmit}
          disabled={isResponding || (!requiredSatisfied && isSingleQuestion)}
          className={cn(
            "font-medium gap-1.5",
            requiredSatisfied || isSingleQuestion
              ? "bg-emerald-500/15 text-emerald-400 border border-emerald-500/30 hover:bg-emerald-500/25"
              : "opacity-50 cursor-not-allowed"
          )}
        >
          {requiredSatisfied || isSingleQuestion ? <Check className="h-3.5 w-3.5" /> : <ChevronRight className="h-3.5 w-3.5" />}
          {requiredSatisfied || isSingleQuestion ? "Submit answer" : "Next question"}
        </Button>

        <Button
          type="button"
          size="sm"
          variant="ghost"
          onClick={handleDismiss}
          disabled={isResponding}
          className="text-rose-400 hover:bg-rose-500/10 hover:text-rose-300 gap-1"
        >
          <X className="h-3.5 w-3.5" />
          Dismiss
        </Button>

        {isResponding && (
          <div className="ml-auto flex items-center gap-1.5 text-xs text-muted-foreground">
            <div className="animate-spin h-3 w-3 border border-primary border-t-transparent rounded-full" />
            <span>Sending...</span>
          </div>
        )}
      </CardFooter>
    </Card>
  );
}
