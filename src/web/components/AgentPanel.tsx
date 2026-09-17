import { Fragment, memo, useEffect, useMemo, useRef, useState } from "react";
import type { ReactNode } from "react";
import type { AgentCapabilities, AgentHistory, AgentSummary, SlashCommand, TimelineItem, ToolActivity } from "../../shared/domain/agents.ts";
import { MAX_AGENT_IMAGES, MAX_AGENT_IMAGE_DATA_BYTES, type AgentImage } from "../../shared/protocol/agents.ts";
import type { WorkspaceApi } from "../api.ts";
import { ModelPicker } from "./ModelPicker.tsx";
import { Streamdown } from "streamdown";
import { Button } from "./ui/button.tsx";
import { Alert, AlertDescription, AlertTitle } from "./ui/alert.tsx";
import { ToolRow } from "./ToolRow.tsx";
import { FileTypeIcon } from "./FileTypeIcon.tsx";
import { ComposerAutocomplete, COMPOSER_SUGGESTION_LIST_ID } from "./ComposerAutocomplete.tsx";
import {
  applyFileInsert,
  applySlashInsert,
  filterSlashCommands,
  useComposerTrigger,
} from "./useComposerTrigger.ts";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "./ui/alert-dialog.tsx";
import { QuestionCard, type QuestionRequest, type QuestionOption } from "./QuestionCard.tsx";
import { getToolDiff } from "../lib/tool-diff.ts";
import { estimateUpdatedTokens, getStreamingTokenText, type TokenEstimateCacheEntry } from "../lib/streaming-tokens.ts";
import {
  Clock,
  CircleAlert,
  Square,
  ArrowUp,
  Expand,
  Shrink,
  Plus,
  Pencil,
  AtSign,
  Slash,
} from "lucide-react";

const STREAMING_STATS_INTERVAL_MS = 300;

export type AgentPanelProps = {
  agent: AgentSummary;
  history?: AgentHistory;
  capabilities?: AgentCapabilities;
  loading: boolean;
  error?: string;
  api: WorkspaceApi;
  onRefresh: () => Promise<void>;
  onModelChanged?: (agent: AgentSummary) => void;
  onArchive: () => Promise<void>;
  onOptimisticMessage?: (message: string) => void;
  /** Offline transcript override for rendering verification (never live state). */
  previewHistory?: AgentHistory;
};

export function resolveActiveQuestionRequest(agent: AgentSummary, timeline?: TimelineItem[]): QuestionRequest | null {
  const pending = agent.pendingUiRequest as Record<string, unknown> | undefined;
  if (pending && pending.id) {
    if (Array.isArray(pending.questions) && pending.questions.length > 0) {
      return {
        id: String(pending.id),
        method: pending.method as any,
        questions: (pending.questions as any[]).map((q) => ({
          question: String(q.question || ""),
          header: q.header ? String(q.header) : undefined,
          options: Array.isArray(q.options)
            ? q.options.map((o: any) =>
                typeof o === "string"
                  ? { label: o }
                  : { label: String(o.label || ""), description: o.description ? String(o.description) : undefined }
              )
            : [],
          multiple: Boolean(q.multiple || q.multiSelect),
        })),
      };
    }

    if (pending.method === "select") {
      let header = "Select";
      let question = String(pending.title || "Choose an option");
      const titleMatch = question.match(/^\[(.*?)\]\s*(.*)$/);
      if (titleMatch) {
        header = titleMatch[1];
        question = titleMatch[2];
      }

      const rawOptions = Array.isArray(pending.options) ? pending.options : [];
      const options: QuestionOption[] = rawOptions.flatMap((opt: unknown) => {
        const raw = typeof opt === "string" ? opt : (opt as any)?.label ? String((opt as any).label) : "";
        if (!raw) return [];
        // Filter out "Type something." sentinel from list because QuestionCard has its own "Other..." row
        if (/^\d+\.\s*(Type something\.|Other\b)/i.test(raw) || raw === "Type something.") {
          return [];
        }
        // Check for "1. Label — Description" (using em-dash, en-dash, or hyphen)
        const matchWithDesc = raw.match(/^\d+\.\s*([^\u2014\u2013-]+?)\s*[\u2014\u2013-]\s*(.*)$/);
        if (matchWithDesc) {
          return [{ label: matchWithDesc[1].trim(), description: matchWithDesc[2].trim() }];
        }
        const matchNum = raw.match(/^\d+\.\s*(.*)$/);
        if (matchNum) {
          return [{ label: matchNum[1].trim() }];
        }
        return [typeof opt === "string" ? { label: opt } : { label: raw, description: (opt as any)?.description }];
      });

      return {
        id: String(pending.id),
        method: "select",
        questions: [
          {
            question,
            header,
            options,
          },
        ],
      };
    }

    if (pending.method === "confirm") {
      return {
        id: String(pending.id),
        method: "confirm",
        questions: [
          {
            question: String(pending.title || "Confirmation needed"),
            header: "Confirm",
            options: [
              { label: "Yes", description: pending.message ? String(pending.message) : undefined },
              { label: "No" },
            ],
          },
        ],
      };
    }

    if (pending.method === "input" || pending.method === "editor") {
      return {
        id: String(pending.id),
        method: pending.method as "input" | "editor",
        questions: [
          {
            question: String(pending.title || "Input needed"),
            header: pending.method === "editor" ? "Editor" : "Input",
            options: [],
          },
        ],
      };
    }
  }

  // Check last running tool in timeline
  if (timeline && timeline.length > 0) {
    for (let i = timeline.length - 1; i >= 0; i--) {
      const item = timeline[i];
      if (item.kind === "user") break;
      if (item.kind === "tool" && item.status === "running") {
        const input = item.input as { questions?: any[] } | undefined;
        if (Array.isArray(input?.questions) && input.questions.length > 0) {
          return {
            id: item.id,
            questions: input.questions.map((q: any) => ({
              question: String(q.question || ""),
              header: q.header ? String(q.header) : undefined,
              options: Array.isArray(q.options)
                ? q.options.map((o: any) =>
                    typeof o === "string"
                      ? { label: o }
                      : { label: String(o.label || ""), description: o.description ? String(o.description) : undefined }
                  )
                : [],
              multiple: Boolean(q.multiple || q.multiSelect),
            })),
          };
        }
      }
    }
  }

  return null;
}

export function resolveCurrentModel(
  modelPreference: string | null,
  historyModel: AgentHistory["currentModel"],
  modelOptions: AgentCapabilities["models"],
) {
  const findModel = (provider: string, modelId: string) =>
    modelOptions.find((option) => option.provider === provider && option.id === modelId) ?? {
      name: modelId,
      id: modelId,
      provider,
    };

  if (modelPreference) {
    const separator = modelPreference.indexOf("/");
    if (separator >= 0) {
      return findModel(modelPreference.slice(0, separator), modelPreference.slice(separator + 1));
    }
    const preferred = modelOptions.find((option) => option.id === modelPreference);
    if (preferred) return preferred;
  }

  return historyModel ? findModel(historyModel.provider, historyModel.modelId) : undefined;
}

export function resolveStreamActive(status: AgentSummary["status"]): boolean {
  return status === "running";
}

export function isComposerLocked(status: AgentSummary["status"]): boolean {
  return status === "stopping";
}

export function AgentPanel({
  agent,
  history,
  capabilities,
  loading,
  error,
  api,
  onRefresh,
  onModelChanged,
  onArchive: _onArchive,
  onOptimisticMessage,
  previewHistory,
}: AgentPanelProps) {
  const effectiveHistory = previewHistory ?? history;
  const conciseKey = `passage:agent:${agent.id}:concise`;
  const [concise, setConcise] = useState(() => localStorage.getItem(conciseKey) === "true");
  const [busy, setBusy] = useState(false);
  const timelineRef = useRef<HTMLDivElement>(null);
  const running = agent.status === "running";
  const stopping = isComposerLocked(agent.status);
  const timeline = effectiveHistory?.timeline ?? [];
  const streamActive = resolveStreamActive(agent.status);
  const streamingTokenText = useMemo(() => getStreamingTokenText(timeline), [timeline]);
  const streamingTokenTextRef = useRef(streamingTokenText);
  const streamingTokenCacheRef = useRef<TokenEstimateCacheEntry | undefined>(undefined);
  const streamingStartedAtRef = useRef<number | null>(null);
  const [streamingTokens, setStreamingTokens] = useState(0);
  const [streamingTokensPerSecond, setStreamingTokensPerSecond] = useState<number | null>(null);
  const [elapsedSeconds, setElapsedSeconds] = useState(0);
  streamingTokenTextRef.current = streamingTokenText;

  useEffect(() => {
    if (!streamActive) {
      streamingStartedAtRef.current = null;
      streamingTokenCacheRef.current = undefined;
      setStreamingTokens(0);
      setStreamingTokensPerSecond(null);
      setElapsedSeconds(0);
      return;
    }

    if (streamingStartedAtRef.current === null) streamingStartedAtRef.current = Date.now();
    const tick = () => {
      const text = streamingTokenTextRef.current;
      const tokens = estimateUpdatedTokens(streamingTokenCacheRef.current, text);
      streamingTokenCacheRef.current = { text, tokens };
      setStreamingTokens(tokens);
      const elapsed = (Date.now() - (streamingStartedAtRef.current ?? Date.now())) / 1000;
      setElapsedSeconds(elapsed);
      setStreamingTokensPerSecond(elapsed > 0.5 && tokens > 0 ? tokens / elapsed : null);
    };
    tick();
    const interval = setInterval(tick, STREAMING_STATS_INTERVAL_MS);
    return () => clearInterval(interval);
  }, [streamActive]);

  useEffect(() => {
    if (timelineRef.current) {
      timelineRef.current.scrollTop = timelineRef.current.scrollHeight;
    }
  }, [effectiveHistory?.timeline]);

  // After a run settles, layout can shift (composer status line hides, change
  // summary appears, tool details expand). Scroll again after paint so the
  // latest assistant content is fully above the composer.
  const wasStreaming = useRef(streamActive);
  useEffect(() => {
    const settled = wasStreaming.current && !streamActive;
    wasStreaming.current = streamActive;
    if (!settled || !timelineRef.current) return;
    const frame = requestAnimationFrame(() => {
      if (timelineRef.current) {
        timelineRef.current.scrollTop = timelineRef.current.scrollHeight;
      }
    });
    return () => cancelAnimationFrame(frame);
  }, [streamActive]);

  useEffect(() => {
    setConcise(localStorage.getItem(conciseKey) === "true");
  }, [conciseKey]);

  const toggleConcise = () => {
    const next = !concise;
    setConcise(next);
    localStorage.setItem(conciseKey, String(next));
  };

  const model = effectiveHistory?.currentModel
    ? `${effectiveHistory.currentModel.provider}/${effectiveHistory.currentModel.modelId}`
    : agent.modelPreference ?? "model unavailable";
  const thinking = effectiveHistory?.currentThinkingLevel ?? agent.thinkingPreference ?? "default";
  const modelOptions = useMemo(
    () => capabilities?.models.filter((option) => option.authenticated) ?? [],
    [capabilities?.models]
  );
  const currentModel = useMemo(
    () => resolveCurrentModel(agent.modelPreference, effectiveHistory?.currentModel, modelOptions),
    [agent.modelPreference, effectiveHistory?.currentModel, modelOptions]
  );
  const currentModelDisplayName = currentModel?.name ?? (model.includes("/") ? model.split("/")[1] : model);

  const maxTokens = (currentModel && "contextWindow" in currentModel && typeof currentModel.contextWindow === "number")
    ? currentModel.contextWindow
    : 200_000;
  const contextTokens = effectiveHistory?.contextUsage?.tokens ?? null;
  const contextPct = contextTokens !== null && contextTokens > 0 ? Math.min(100, Math.max(1, Math.round((contextTokens / maxTokens) * 100))) : 0;
  const pieColor = contextPct >= 95 ? "var(--danger, #b91c1c)" : contextPct >= 80 ? "var(--warning, #b45309)" : "currentColor";
  const changeSummary = useMemo(() => summarizeChanges(effectiveHistory?.timeline ?? []), [effectiveHistory?.timeline]);

  const questionRequest = useMemo(
    () => resolveActiveQuestionRequest(agent, effectiveHistory?.timeline),
    [agent, effectiveHistory?.timeline]
  );

  useEffect(() => {
    if (questionRequest && timelineRef.current) {
      timelineRef.current.scrollTop = timelineRef.current.scrollHeight;
    }
  }, [questionRequest]);

  const handleRespondUi = async (result: { id: string; value?: string; confirmed?: boolean; cancelled?: true }) => {
    try {
      await api.respondUi(agent.id, result);
      await onRefresh();
    } catch (err) {
      console.error("Failed to respond to UI prompt:", err);
    }
  };

  return (
    <section className="agent-panel" aria-label={`Agent conversation ${agent.title}`}>
      {error && (
        <div className="alert agent-alert" role="alert">
          <span>{error}</span>
          <button className="secondary small" onClick={() => void onRefresh()}>Retry</button>
        </div>
      )}
      <div className="timeline" ref={timelineRef}>
        {loading ? <p className="muted timeline-loading">Loading history…</p>
          : !effectiveHistory?.timeline.length && !questionRequest ? (
            <div className="empty-transcript">
              <span className="empty-transcript-icon">◈</span>
              <h3>What are we working on?</h3>
              <p>Type a prompt below to start an autonomous session.</p>
            </div>
          ) : (
            <>
              {effectiveHistory?.timeline?.map((item) => (
                <TimelineRow key={item.id} item={item} concise={concise} />
              ))}
              {questionRequest && (
                <QuestionCard request={questionRequest} onRespond={handleRespondUi} />
              )}
            </>
          )}
      </div>

      <AgentComposer
        agentId={agent.id}
        workspaceId={agent.workspaceId}
        running={running}
        stopping={stopping}
        streamActive={streamActive}
        streamingTokens={streamingTokens}
        streamingTokensPerSecond={streamingTokensPerSecond}
        elapsedSeconds={elapsedSeconds}
        capabilities={capabilities}
        api={api}
        busy={busy}
        setBusy={setBusy}
        concise={concise}
        toggleConcise={toggleConcise}
        onRefresh={onRefresh}
        onModelChanged={onModelChanged}
        onOptimisticMessage={onOptimisticMessage}
        currentModel={currentModel}
        currentModelDisplayName={currentModelDisplayName}
        thinking={thinking}
        contextTokens={contextTokens}
        maxTokens={maxTokens}
        contextPct={contextPct}
        pieColor={pieColor}
        usage={effectiveHistory?.usage}
        changeSummary={changeSummary}
      />
    </section>
  );
}

export function formatDuration(seconds: number): string {
  if (seconds < 60) {
    return `${seconds.toFixed(1)}s`;
  }
  const mins = Math.floor(seconds / 60);
  const remSecs = (seconds % 60).toFixed(0).padStart(2, "0");
  return `${mins}m ${remSecs}s`;
}

const LiveStreamingStats = memo(function LiveStreamingStats({
  tokens,
  tokensPerSecond,
}: {
  tokens: number;
  tokensPerSecond: number | null;
}) {
  if (tokens <= 0) return null;
  return (
    <div className="live-streaming-stats" role="status" aria-live="polite">
      <span className="live-streaming-token-count" title="Estimated streamed tokens">
        ↓ {Math.round(tokens).toLocaleString()}
      </span>
      {tokensPerSecond !== null && (
        <span className="live-streaming-rate">{tokensPerSecond.toFixed(1)} t/s</span>
      )}
    </div>
  );
});

type AgentComposerProps = {
  agentId: string;
  workspaceId: string;
  running: boolean;
  stopping: boolean;
  streamActive: boolean;
  streamingTokens: number;
  streamingTokensPerSecond: number | null;
  elapsedSeconds: number;
  capabilities?: AgentCapabilities;
  api: WorkspaceApi;
  busy: boolean;
  setBusy: (b: boolean) => void;
  concise: boolean;
  toggleConcise: () => void;
  onRefresh: () => Promise<void>;
  onModelChanged?: (agent: AgentSummary) => void;
  onOptimisticMessage?: (message: string) => void;
  currentModel?: AgentCapabilities["models"][number] | { name: string; id: string; provider: string; contextWindow?: number };
  currentModelDisplayName: string;
  thinking: string;
  contextTokens: number | null;
  maxTokens: number;
  contextPct: number;
  pieColor: string;
  usage?: AgentHistory["usage"];
  changeSummary?: { fileCount: number; additions: number; deletions: number };
};

/** Middle-out truncation that preserves the filename suffix. */
export function truncateFileRefPath(path: string, maxLength = 64): string {
  if (path.length <= maxLength) return path;
  const slash = path.lastIndexOf("/");
  const name = slash >= 0 ? path.slice(slash + 1) : path;
  if (name.length >= maxLength - 1) {
    const keep = Math.max(8, maxLength - 2);
    const head = Math.ceil(keep / 2);
    return `${name.slice(0, head)}\u2026${name.slice(name.length - (keep - head))}`;
  }
  const dir = slash >= 0 ? path.slice(0, slash) : "";
  const keepDir = Math.max(0, maxLength - name.length - 2);
  return `\u2026${dir.slice(dir.length - keepDir)}/${name}`;
}

const FILE_REF_PATTERN = /@`([^`\n]{1,4096})`/g;

/** Render backticked `@`path`` refs as inline file chips at display time. */
export function renderFileRefs(text: string): ReactNode[] {
  const nodes: ReactNode[] = [];
  let last = 0;
  let match: RegExpExecArray | null;
  let key = 0;
  FILE_REF_PATTERN.lastIndex = 0;
  while ((match = FILE_REF_PATTERN.exec(text)) !== null) {
    if (match.index > last) nodes.push(text.slice(last, match.index));
    const refPath = match[1]!;
    nodes.push(
      <span key={`file-ref-${key++}`} className="file-ref-chip" title={refPath}>
        <FileTypeIcon path={refPath} size={12} />
        <code className="file-ref-path">{truncateFileRefPath(refPath)}</code>
      </span>,
    );
    last = match.index + match[0].length;
  }
  if (last < text.length) nodes.push(text.slice(last));
  if (nodes.length === 0) nodes.push(text);
  return nodes;
}

function AgentComposerInner({
  agentId,
  workspaceId,
  running,
  stopping,
  streamActive,
  streamingTokens,
  streamingTokensPerSecond,
  elapsedSeconds,
  capabilities,
  api,
  busy,
  setBusy,
  concise,
  toggleConcise,
  onRefresh,
  onModelChanged,
  onOptimisticMessage,
  currentModel,
  currentModelDisplayName,
  thinking,
  contextTokens,
  maxTokens,
  contextPct,
  pieColor,
  usage,
  changeSummary,
}: AgentComposerProps) {
  const draftKey = `passage:agent:${agentId}:draft`;
  const [draft, setDraft] = useState(() => localStorage.getItem(draftKey) ?? "");
  const [composerError, setComposerError] = useState("");
  const [images, setImages] = useState<Array<AgentImage & { name: string }>>([]);
  const [ctxDetailsOpen, setCtxDetailsOpen] = useState(false);
  const ctxDetailsRef = useRef<HTMLDivElement>(null);
  const composerInputRef = useRef<HTMLTextAreaElement>(null);
  const reservedImageCount = useRef(0);
  const saveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [caret, setCaret] = useState<number | null>(null);
  const [compactConfirmOpen, setCompactConfirmOpen] = useState(false);
  const autocomplete = useComposerTrigger({ draft, caret, workspaceId, api });
  const slashCommands = useMemo(
    () => capabilities?.slashCommands ?? [],
    [capabilities?.slashCommands],
  );
  const skillsAvailable = capabilities?.skillsAvailable ?? false;
  const filteredCommands = useMemo(
    () =>
      autocomplete.trigger?.kind === "/"
        ? filterSlashCommands(slashCommands, autocomplete.trigger.query)
        : [],
    [autocomplete.trigger, slashCommands],
  );
  const suggestionOpen = autocomplete.trigger !== null;
  const suggestionCount =
    autocomplete.trigger?.kind === "@" ? autocomplete.files.length : filteredCommands.length;
  const activeValue = (() => {
    if (!autocomplete.trigger) return "";
    if (autocomplete.trigger.kind === "@") {
      const entry = autocomplete.files[autocomplete.activeIndex];
      return entry ? `file:${entry.path}` : "";
    }
    const command = filteredCommands[autocomplete.activeIndex];
    return command ? `cmd:${command.name}` : "";
  })();

  const placeCaret = (position: number) => {
    setCaret(position);
    requestAnimationFrame(() => {
      const input = composerInputRef.current;
      if (!input) return;
      input.focus();
      try {
        input.setSelectionRange(position, position);
      } catch {}
    });
  };

  const acceptFile = (path: string) => {
    const trigger = autocomplete.trigger;
    if (!trigger || trigger.kind !== "@") return;
    const next = applyFileInsert(draft, trigger, path);
    updateDraft(next.value);
    placeCaret(next.caret);
  };

  const acceptCommand = (command: SlashCommand) => {
    const trigger = autocomplete.trigger;
    if (!trigger || trigger.kind !== "/") return;
    if (command.kind === "action") {
      // Action kinds never send raw Pi JSON: compact routes through the
      // typed compact endpoint after explicit confirmation.
      if (command.name === "compact") setCompactConfirmOpen(true);
      return;
    }
    const next = applySlashInsert(draft, trigger, `/${command.name}`);
    updateDraft(next.value);
    placeCaret(next.caret);
  };

  const acceptActiveSuggestion = (): boolean => {
    const trigger = autocomplete.trigger;
    if (!trigger) return false;
    if (trigger.kind === "@") {
      const entry = autocomplete.files[autocomplete.activeIndex];
      if (!entry) return false;
      acceptFile(entry.path);
      return true;
    }
    const command = filteredCommands[autocomplete.activeIndex];
    if (!command) return false;
    acceptCommand(command);
    return true;
  };

  const syncCaret = (target: HTMLTextAreaElement) => {
    try {
      setCaret(target.selectionStart);
    } catch {
      setCaret(null);
    }
  };

  const insertTriggerChar = (char: "@" | "/") => {
    const input = composerInputRef.current;
    const position = input?.selectionStart ?? draft.length;
    const value = `${draft.slice(0, position)}${char}${draft.slice(position)}`;
    updateDraft(value);
    placeCaret(position + 1);
  };

  useEffect(() => {
    setDraft(localStorage.getItem(draftKey) ?? "");
    setImages([]);
    setCtxDetailsOpen(false);
    reservedImageCount.current = 0;
  }, [draftKey]);

  useEffect(() => {
    composerInputRef.current?.focus();
  }, [agentId]);

  useEffect(() => {
    return () => {
      if (saveTimerRef.current) {
        clearTimeout(saveTimerRef.current);
      }
    };
  }, []);

  useEffect(() => {
    if (!ctxDetailsOpen) return;
    const handleClickOutside = (e: MouseEvent) => {
      if (ctxDetailsRef.current && !ctxDetailsRef.current.contains(e.target as Node)) {
        setCtxDetailsOpen(false);
      }
    };
    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, [ctxDetailsOpen]);

  const updateDraft = (value: string) => {
    setDraft(value);
    if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
    saveTimerRef.current = setTimeout(() => {
      localStorage.setItem(draftKey, value);
    }, 250);
  };

  const run = async (
    action: () => Promise<unknown>,
    clearDraft = false,
    refreshAfter = true,
  ) => {
    setBusy(true);
    setComposerError("");
    try {
      await action();
      if (clearDraft) {
        if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
        setDraft("");
        localStorage.removeItem(draftKey);
      }
      if (refreshAfter) await onRefresh();
    } catch (cause) {
      setComposerError(cause instanceof Error ? cause.message : "Agent command failed");
    } finally {
      setBusy(false);
    }
  };

  const send = (kind: "prompt" | "steer" | "followUp") => {
    const value = draft.trim();
    if (!value && images.length === 0) return;
    const finalMessage = value || (images.length > 0 ? "Attached image" : "");
    const payloadImages: AgentImage[] = images.map(({ type, data, mimeType }) => ({
      type,
      data,
      mimeType,
    }));
    onOptimisticMessage?.(finalMessage);
    void run(
      async () => {
        await api[kind](agentId, finalMessage, payloadImages.length > 0 ? payloadImages : undefined);
        setImages([]);
        reservedImageCount.current = 0;
      },
      true,
      false,
    );
  };

  const addImages = async (files: FileList | null) => {
    if (!files) return;
    let reserved = 0;
    try {
      const selected = Array.from(files);
      if (selected.length + reservedImageCount.current > MAX_AGENT_IMAGES)
        throw new Error(`Attach at most ${MAX_AGENT_IMAGES} images`);
      reservedImageCount.current += selected.length;
      reserved = selected.length;
      const attachments = await Promise.all(
        selected.map(async (file) => {
          let mimeType = file.type;
          if (mimeType === "image/jpg") mimeType = "image/jpeg";
          if (!mimeType.match(/^image\/(png|jpeg|gif|webp)$/))
            throw new Error(`${file.name} is not a supported image`);
          if (file.size > MAX_AGENT_IMAGE_DATA_BYTES) throw new Error(`${file.name} is too large`);
          const base64 = await new Promise<string>((resolve, reject) => {
            const reader = new FileReader();
            reader.onload = () => {
              const result = String(reader.result ?? "");
              const comma = result.indexOf(",");
              resolve(comma >= 0 ? result.slice(comma + 1) : result);
            };
            reader.onerror = () => reject(new Error(`Failed to read ${file.name}`));
            reader.readAsDataURL(file);
          });
          return {
            type: "image" as const,
            data: base64,
            mimeType: mimeType as AgentImage["mimeType"],
            name: file.name,
          };
        })
      );
      setImages((current) => {
        const available = MAX_AGENT_IMAGES - current.length;
        if (attachments.length > available) {
          reservedImageCount.current -= attachments.length;
          return current;
        }
        return [...current, ...attachments];
      });
      setComposerError("");
    } catch (cause) {
      reservedImageCount.current -= reserved;
      setComposerError(cause instanceof Error ? cause.message : "Unable to attach image");
    }
  };

  return (
    <footer className="composer-container">
      <div
        className="composer-status-line"
        role={streamActive ? "status" : undefined}
        aria-live={streamActive ? "polite" : undefined}
        aria-hidden={!streamActive}
      >
        {streamActive && (
          <>
            <span className="pulse-dot" />
            <span className="composer-status-duration">{formatDuration(elapsedSeconds)}</span>
            <LiveStreamingStats tokens={streamingTokens} tokensPerSecond={streamingTokensPerSecond} />
          </>
        )}
      </div>
      {changeSummary && (
        <div
          className="agent-change-summary"
          aria-label={`${changeSummary.fileCount} changed files, ${changeSummary.additions} additions, ${changeSummary.deletions} deletions`}
        >
          <span className="agent-change-files">
            <Pencil size={12} aria-hidden="true" />
            {changeSummary.fileCount} changed file{changeSummary.fileCount === 1 ? "" : "s"}
          </span>
          <span className="add-count">+{changeSummary.additions}</span>
          <span className="del-count">-{changeSummary.deletions}</span>
        </div>
      )}
      <div className="composer-card composer-autocomplete-anchor">
        <ComposerAutocomplete
          open={suggestionOpen}
          kind={autocomplete.trigger?.kind ?? "@"}
          files={autocomplete.files}
          filesLoading={autocomplete.filesLoading}
          filesError={autocomplete.filesError}
          commands={filteredCommands}
          skillsAvailable={skillsAvailable}
          activeIndex={autocomplete.activeIndex}
          activeValue={activeValue}
          onActiveValueChange={(value) => {
            if (autocomplete.trigger?.kind === "@") {
              const index = autocomplete.files.findIndex((entry) => `file:${entry.path}` === value);
              if (index >= 0) autocomplete.setActiveIndex(index);
            } else {
              const index = filteredCommands.findIndex((command) => `cmd:${command.name}` === value);
              if (index >= 0) autocomplete.setActiveIndex(index);
            }
          }}
          onHoverIndex={autocomplete.setActiveIndex}
          onSelectFile={acceptFile}
          onSelectCommand={acceptCommand}
          onEscape={() => autocomplete.dismiss()}
          onInteractOutside={(insideComposer) => {
            if (!insideComposer) autocomplete.dismiss();
          }}
        />
        <textarea
          ref={composerInputRef}
          value={draft}
          onChange={(event) => {
            updateDraft(event.target.value);
            syncCaret(event.target);
          }}
          onSelect={(event) => syncCaret(event.currentTarget)}
          onKeyUp={(event) => syncCaret(event.currentTarget)}
          onClick={(event) => syncCaret(event.currentTarget)}
          onKeyDown={(event) => {
            if (suggestionOpen && autocomplete.trigger) {
              if (event.key === "ArrowDown" || event.key === "ArrowUp") {
                event.preventDefault();
                autocomplete.moveSelection(event.key === "ArrowDown" ? 1 : -1, suggestionCount);
                return;
              }
              if (event.key === "Escape") {
                // Dismiss only: the draft keeps the raw trigger token and the
                // caret stays where it was. Retyping re-opens.
                event.preventDefault();
                event.stopPropagation();
                autocomplete.dismiss();
                return;
              }
              if ((event.key === "Tab" || event.key === "Enter") && suggestionCount > 0 && !event.shiftKey) {
                event.preventDefault();
                acceptActiveSuggestion();
                return;
              }
            }
            if (event.key === "Enter" && !event.shiftKey) {
              event.preventDefault();
              if (stopping) return;
              if (running) send("steer");
              else if (!busy) send("prompt");
            }
          }}
          placeholder={
            stopping
              ? "Stopping agent execution…"
              : running
              ? "Steer now (Enter) or queue follow-up…"
              : "@ for files; / for commands"
          }
          aria-label="Agent message"
          role="combobox"
          aria-expanded={suggestionOpen}
          aria-controls={suggestionOpen ? COMPOSER_SUGGESTION_LIST_ID : undefined}
          aria-activedescendant={suggestionOpen && activeValue ? `composer-option-${activeValue}` : undefined}
          disabled={stopping}
          rows={2}
        />
        {composerError && (
          <div className="composer-error-alert" role="alert">
            <span>⚠️ {composerError}</span>
          </div>
        )}
        {images.length > 0 && (
          <div className="attachment-list" aria-label="Attached images">
            {images.map((image) => (
              <div key={`${image.name}:${image.data.length}`} className="attachment-chip">
                <img
                  src={`data:${image.mimeType};base64,${image.data}`}
                  alt={image.name}
                  className="attachment-thumb"
                />
                <span className="attachment-name">{image.name}</span>
                <button
                  type="button"
                  className="attachment-remove"
                  onClick={() => {
                    setImages((current) => current.filter((item) => item !== image));
                    reservedImageCount.current -= 1;
                  }}
                  aria-label={`Remove ${image.name}`}
                >
                  ×
                </button>
              </div>
            ))}
          </div>
        )}
        <div className="composer-toolbar">
          <div className="composer-toolbar-left">
            <label className="composer-attach-btn" title="Attach image" aria-label="Attach image">
              <Plus size={14} aria-hidden="true" />
              <input
                type="file"
                accept="image/png,image/jpeg,image/gif,image/webp"
                multiple
                disabled={stopping}
                onChange={(event) => {
                  void addImages(event.target.files);
                  event.currentTarget.value = "";
                }}
              />
            </label>
            <button
              type="button"
              className="composer-icon-btn"
              onClick={() => insertTriggerChar("@")}
              title="Mention a workspace file (@)"
              aria-label="Mention a workspace file"
              disabled={stopping}
            >
              <AtSign size={14} aria-hidden="true" />
            </button>
            <button
              type="button"
              className="composer-icon-btn"
              onClick={() => insertTriggerChar("/")}
              title="Browse slash commands (/)"
              aria-label="Browse slash commands"
              disabled={stopping}
            >
              <Slash size={14} aria-hidden="true" />
            </button>
            {contextTokens !== null && contextTokens > 0 && (
              <div className="composer-ctx-wrapper" ref={ctxDetailsRef}>
                <button
                  type="button"
                  className="composer-ctx-pill"
                  onClick={() => setCtxDetailsOpen((prev) => !prev)}
                  title={`${contextTokens.toLocaleString()} / ${maxTokens.toLocaleString()} tokens · ${contextPct}% context · Click for details`}
                  aria-label={`Context used: ${contextPct}%. Click for usage breakdown.`}
                  aria-expanded={ctxDetailsOpen}
                  aria-haspopup="dialog"
                >
                  <span
                    className="context-pie"
                    style={{
                      background: `conic-gradient(${pieColor} ${contextPct}%, var(--chip-blue-track, rgba(3, 105, 161, 0.18)) 0)`,
                    }}
                    aria-hidden="true"
                  />
                  <span>{contextPct}%</span>
                  {usage?.cost !== undefined && usage.cost > 0 && (
                    <>
                      <span className="composer-stat-sep">·</span>
                      <span>${usage.cost.toFixed(2)}</span>
                    </>
                  )}
                </button>

                {ctxDetailsOpen && (
                  <div className="ctx-details-popover" role="dialog" aria-label="Context and usage breakdown">
                    <div className="popover-header-title">Context &amp; Usage</div>
                    <div className="ctx-details-grid">
                      <div className="ctx-detail-row">
                        <span>Context used</span>
                        <b>
                          {contextPct}% ({contextTokens.toLocaleString()} / {maxTokens.toLocaleString()})
                        </b>
                      </div>
                      <div className="ctx-detail-row">
                        <span>Input tokens</span>
                        <span>{(usage?.input ?? 0).toLocaleString()}</span>
                      </div>
                      <div className="ctx-detail-row">
                        <span>Output tokens</span>
                        <span>{(usage?.output ?? 0).toLocaleString()}</span>
                      </div>
                      <div className="ctx-detail-row">
                        <span>Cache read</span>
                        <span>{(usage?.cacheRead ?? 0).toLocaleString()}</span>
                      </div>
                      {usage?.cost !== undefined && usage.cost > 0 && (
                        <div className="ctx-detail-row total">
                          <span>Cost</span>
                          <b>${usage.cost.toFixed(4)}</b>
                        </div>
                      )}
                    </div>
                  </div>
                )}
              </div>
            )}
          </div>
          <div className="composer-toolbar-right">
            <button
              type="button"
              className="composer-icon-btn"
              onClick={toggleConcise}
              title={concise ? "Switch to Detailed mode" : "Switch to Concise mode"}
              aria-label={concise ? "Switch to Detailed mode" : "Switch to Concise mode"}
              aria-pressed={concise}
            >
              {concise ? <Shrink size={14} aria-hidden="true" /> : <Expand size={14} aria-hidden="true" />}
            </button>
            <ModelPicker
              currentModelId={currentModel ? `${currentModel.provider}:${currentModel.id}` : undefined}
              currentModelName={currentModelDisplayName}
              currentThinking={thinking}
              capabilities={capabilities}
              onSelectModel={async (provider, modelId) => {
                await run(async () => {
                  const updatedAgent = await api.setModel(agentId, provider, modelId);
                  onModelChanged?.(updatedAgent);
                }, false, false);
              }}
              onSelectThinking={async (level) => {
                await run(() => api.setThinking(agentId, level));
              }}
              disabled={busy || stopping}
            />
            {stopping ? (
              <Button size="xs" className="composer-action-btn" disabled aria-label="Stopping agent execution">
                Stopping…
              </Button>
            ) : running ? (
              <>
                <Button
                  size="xs"
                  className="composer-action-btn"
                  onClick={() => send("steer")}
                  disabled={busy}
                  title="Steer now (Enter)"
                  aria-label="Steer now"
                >
                  <ArrowUp size={14} aria-hidden="true" />
                </Button>
                <Button
                  variant="secondary"
                  size="xs"
                  className="composer-action-btn"
                  onClick={() => send("followUp")}
                  disabled={busy}
                  title="Queue follow-up"
                  aria-label="Queue follow-up"
                >
                  <Clock size={14} aria-hidden="true" />
                </Button>
                <Button
                  variant="destructive"
                  size="xs"
                  className="composer-action-btn"
                  onClick={() => void run(() => api.abort(agentId))}
                  disabled={busy}
                  title="Stop agent execution"
                  aria-label="Stop agent execution"
                >
                  <Square size={13} aria-hidden="true" />
                </Button>
              </>
            ) : (
              <Button
                size="xs"
                className="send-btn"
                onClick={() => send("prompt")}
                disabled={busy || (!draft.trim() && images.length === 0)}
              >
                Send ↵
              </Button>
            )}
          </div>
        </div>
      </div>
      <AlertDialog open={compactConfirmOpen} onOpenChange={setCompactConfirmOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Compact conversation context?</AlertDialogTitle>
            <AlertDialogDescription>
              Pi will summarize the transcript to free context. The summary replaces earlier history in the
              working session. This cannot be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                setCompactConfirmOpen(false);
                void run(() => api.compact(agentId), false, true);
              }}
            >
              Compact
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </footer>
  );
}

const AgentComposer = memo(AgentComposerInner);

function summarizeChanges(timeline: TimelineItem[]): { fileCount: number; additions: number; deletions: number } | undefined {
  const files = new Set<string>();
  let additions = 0;
  let deletions = 0;
  const activities = timeline.flatMap((item): ToolActivity[] => item.kind === "tool" ? [item] : item.kind === "process" ? item.activities : []);
  for (const activity of activities) {
    const diff = getToolDiff(activity);
    if (!diff || !diff.path || (diff.additions === 0 && diff.deletions === 0)) continue;
    files.add(diff.path);
    additions += diff.additions;
    deletions += diff.deletions;
  }
  return files.size > 0 ? { fileCount: files.size, additions, deletions } : undefined;
}

export const TimelineRow = memo(function TimelineRow({ item, concise }: { item: TimelineItem; concise: boolean }) {
  if (item.kind === "unknown") return <article className="timeline-row unknown"><strong>Unknown activity</strong><code>{item.entryType}</code></article>;
  if (item.kind === "tool") {
    if (concise && !item.significant && item.status !== "error") {
      return <ToolRow item={item} conciseBadge />;
    }
    return <ToolRow item={item} />;
  }
  if (item.kind === "process") {
    return (
      <details className="timeline-row process">
        <summary className="process-summary">
          <span className="process-title">Process</span>
          <span className="process-count">{item.activities.length} {item.activities.length === 1 ? "activity" : "activities"}</span>
        </summary>
        {item.activities.map((activity) => (
          <ToolRow
            key={activity.id}
            item={activity}
            conciseBadge={concise && !activity.significant && activity.status !== "error"}
          />
        ))}
      </details>
    );
  }
  if (item.kind === "thinking") {
    const preview = item.text.replace(/^[#*\-\s]+/, "").slice(0, 70).replace(/\n/g, " ");
    return (
      <details className="thinking-row">
        <summary className="thinking-summary">
          <span className="thinking-icon">⚙</span>
          <span className="thinking-label">Thinking</span>
          <span className="thinking-preview">{preview}…</span>
        </summary>
        <div className="thinking-body">
          <Streamdown className="text-[12.5px] leading-relaxed text-muted-foreground italic">
            {item.text}
          </Streamdown>
        </div>
      </details>
    );
  }
  if (item.kind === "summary") {
    return (
      <article className="timeline-row summary">
        <strong>{item.summaryType === "compaction" ? "Compacted context" : "Branch summary"}</strong>
        <p>{item.text}</p>
      </article>
    );
  }
  if (item.kind === "user") {
    return (
      <div className="user-message-container">
        <div className="user-message-card">
          <p>{renderFileRefs(item.text)}</p>
        </div>
      </div>
    );
  }
  if (item.error) {
    const wasAborted = item.error === "Request was aborted";
    return (
      <Alert
        variant={wasAborted ? "default" : "destructive"}
        className={`assistant-error-alert px-3 py-2${wasAborted ? " assistant-abort-alert" : " border-destructive/40 bg-destructive/5"}`}
      >
        <CircleAlert aria-hidden="true" />
        <AlertTitle>{wasAborted ? "Agent run stopped" : "Pi error"}</AlertTitle>
        <AlertDescription>{wasAborted ? "Pi notice" : "Pi reported"}: {item.error}</AlertDescription>
      </Alert>
    );
  }
  return (
    <article className="assistant-message-row">
      <div className="assistant-prose">
        <Streamdown>{item.text}</Streamdown>
      </div>
    </article>
  );
});
