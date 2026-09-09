import { Fragment, useEffect, useMemo, useRef, useState } from "react";
import type { AgentCapabilities, AgentHistory, AgentSummary, TimelineItem, ToolActivity } from "../../shared/domain/agents.ts";
import { MAX_AGENT_IMAGES, MAX_AGENT_IMAGE_DATA_BYTES, type AgentImage } from "../../shared/protocol/agents.ts";
import type { WorkspaceApi } from "../api.ts";
import { ModelPicker } from "./ModelPicker.tsx";
import { Streamdown } from "streamdown";
import { Button } from "./ui/button.tsx";
import { ToolRow } from "./ToolRow.tsx";
import { getToolDiff } from "../lib/tool-diff.ts";
import { estimateUpdatedTokens, getStreamingTokenText, type TokenEstimateCacheEntry } from "../lib/streaming-tokens.ts";
import {
  Clock,
  Square,
  ArrowUp,
  Expand,
  Shrink,
  Plus,
  Pencil,
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
  onArchive: () => Promise<void>;
  onOptimisticMessage?: (message: string) => void;
  /** Offline transcript override for rendering verification (never live state). */
  previewHistory?: AgentHistory;
};

export function AgentPanel({
  agent,
  history,
  capabilities,
  loading,
  error,
  api,
  onRefresh,
  onArchive: _onArchive,
  onOptimisticMessage,
  previewHistory,
}: AgentPanelProps) {
  const effectiveHistory = previewHistory ?? history;
  const draftKey = `passage:agent:${agent.id}:draft`;
  const conciseKey = `passage:agent:${agent.id}:concise`;
  const [draft, setDraft] = useState(() => localStorage.getItem(draftKey) ?? "");
  const [concise, setConcise] = useState(() => localStorage.getItem(conciseKey) === "true");
  const [busy, setBusy] = useState(false);
  const [composerError, setComposerError] = useState("");
  const [images, setImages] = useState<Array<AgentImage & { name: string }>>([]);
  const [ctxDetailsOpen, setCtxDetailsOpen] = useState(false);
  const ctxDetailsRef = useRef<HTMLDivElement>(null);
  const reservedImageCount = useRef(0);
  const timelineRef = useRef<HTMLDivElement>(null);
  const running = agent.status === "running";
  const timeline = effectiveHistory?.timeline ?? [];
  const streamActive = running || hasPendingStreamingItem(timeline);
  const streamingTokenText = useMemo(() => getStreamingTokenText(timeline), [timeline]);
  const streamingTokenTextRef = useRef(streamingTokenText);
  const streamingTokenCacheRef = useRef<TokenEstimateCacheEntry | undefined>(undefined);
  const streamingStartedAtRef = useRef<number | null>(null);
  const [streamingTokens, setStreamingTokens] = useState(0);
  const [streamingTokensPerSecond, setStreamingTokensPerSecond] = useState<number | null>(null);
  streamingTokenTextRef.current = streamingTokenText;

  useEffect(() => {
    if (!streamActive) {
      streamingStartedAtRef.current = null;
      streamingTokenCacheRef.current = undefined;
      setStreamingTokens(0);
      setStreamingTokensPerSecond(null);
      return;
    }

    if (streamingStartedAtRef.current === null) streamingStartedAtRef.current = Date.now();
    const tick = () => {
      const text = streamingTokenTextRef.current;
      const tokens = estimateUpdatedTokens(streamingTokenCacheRef.current, text);
      streamingTokenCacheRef.current = { text, tokens };
      setStreamingTokens(tokens);
      const elapsed = (Date.now() - (streamingStartedAtRef.current ?? Date.now())) / 1000;
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
    setDraft(localStorage.getItem(draftKey) ?? "");
    setConcise(localStorage.getItem(conciseKey) === "true");
    setImages([]);
    setCtxDetailsOpen(false);
    reservedImageCount.current = 0;
  }, [draftKey, conciseKey]);

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
    localStorage.setItem(draftKey, value);
  };
  const toggleConcise = () => {
    const next = !concise;
    setConcise(next);
    localStorage.setItem(conciseKey, String(next));
  };
  const run = async (action: () => Promise<unknown>, clearDraft = false, refreshAfter = true) => {
    setBusy(true);
    setComposerError("");
    try {
      await action();
      if (clearDraft) {
        updateDraft("");
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
    void run(async () => {
      await api[kind](agent.id, finalMessage, payloadImages.length > 0 ? payloadImages : undefined);
      setImages([]);
      reservedImageCount.current = 0;
    }, true, false);
  };

  const addImages = async (files: FileList | null) => {
    if (!files) return;
    let reserved = 0;
    try {
      const selected = Array.from(files);
      if (selected.length + reservedImageCount.current > MAX_AGENT_IMAGES) throw new Error(`Attach at most ${MAX_AGENT_IMAGES} images`);
      reservedImageCount.current += selected.length;
      reserved = selected.length;
      const attachments = await Promise.all(selected.map(async (file) => {
        let mimeType = file.type;
        if (mimeType === "image/jpg") mimeType = "image/jpeg";
        if (!mimeType.match(/^image\/(png|jpeg|gif|webp)$/)) throw new Error(`${file.name} is not a supported image`);
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
      }));
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

  const model = effectiveHistory?.currentModel
    ? `${effectiveHistory.currentModel.provider}/${effectiveHistory.currentModel.modelId}`
    : agent.modelPreference ?? "model unavailable";
  const thinking = effectiveHistory?.currentThinkingLevel ?? agent.thinkingPreference ?? "default";
  const modelOptions = capabilities?.models.filter((option) => option.authenticated) ?? [];
  const currentModel = effectiveHistory?.currentModel
    ? (modelOptions.find((option) => option.provider === effectiveHistory.currentModel!.provider && option.id === effectiveHistory.currentModel!.modelId) ?? {
        name: effectiveHistory.currentModel.modelId,
        id: effectiveHistory.currentModel.modelId,
        provider: effectiveHistory.currentModel.provider,
      })
    : modelOptions.find((option) => `${option.provider}/${option.id}` === agent.modelPreference || option.id === agent.modelPreference)
      ? modelOptions.find((option) => `${option.provider}/${option.id}` === agent.modelPreference || option.id === agent.modelPreference)!
      : undefined;
  const currentModelDisplayName = currentModel?.name ?? (model.includes("/") ? model.split("/")[1] : model);

  const maxTokens = (currentModel && "contextWindow" in currentModel && typeof currentModel.contextWindow === "number")
    ? currentModel.contextWindow
    : 200_000;
  const totalTokens = effectiveHistory?.usage?.totalTokens ?? ((effectiveHistory?.usage?.input ?? 0) + (effectiveHistory?.usage?.output ?? 0));
  const contextPct = totalTokens > 0 ? Math.min(100, Math.max(1, Math.round((totalTokens / maxTokens) * 100))) : 0;
  const pieColor = contextPct >= 95 ? "var(--danger, #b91c1c)" : contextPct >= 80 ? "var(--warning, #b45309)" : "currentColor";
  const changeSummary = summarizeChanges(effectiveHistory?.timeline ?? []);

  return (
    <section className="agent-panel" aria-label={`Agent conversation ${agent.title}`}>
      {(error || composerError) && (
        <div className="alert agent-alert" role="alert">
          <span>{error || composerError}</span>
          <button className="secondary small" onClick={() => void onRefresh()}>Retry</button>
        </div>
      )}
      <div className="timeline" ref={timelineRef}>
        {loading ? <p className="muted timeline-loading">Loading history…</p>
          : !effectiveHistory?.timeline.length ? (
            <div className="empty-transcript">
              <span className="empty-transcript-icon">◈</span>
              <h3>What are we working on?</h3>
              <p>Type a prompt below to start an autonomous session.</p>
            </div>
          ) : effectiveHistory.timeline.map((item, index) => (
            <Fragment key={item.id}>
              {streamActive && index === findStreamingStartIndex(effectiveHistory.timeline) && streamingTokenText && (
                <LiveStreamingStats tokens={streamingTokens} tokensPerSecond={streamingTokensPerSecond} />
              )}
              <TimelineRow item={item} concise={concise} />
            </Fragment>
          ))}
      </div>

      <footer className="composer-container">
        {running && (
          <div className="composer-status-line">
            <span className="pulse-dot" />
            <span>Pi Agent is running…</span>
          </div>
        )}
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
        <div className="composer-card">
          <textarea
            value={draft}
            onChange={(event) => updateDraft(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter" && !event.shiftKey) {
                event.preventDefault();
                if (running) send("steer");
                else send("prompt");
              }
            }}
            placeholder={running ? "Steer now (Enter) or queue follow-up…" : "@ for files/agents; / for commands and skills; ! for shell; # for snippets"}
            aria-label="Agent message"
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
                <input type="file" accept="image/png,image/jpeg,image/gif,image/webp" multiple onChange={(event) => { void addImages(event.target.files); event.currentTarget.value = ""; }} />
              </label>
              {totalTokens > 0 && (
                <div className="composer-ctx-wrapper" ref={ctxDetailsRef}>
                  <button
                    type="button"
                    className="composer-ctx-pill"
                    onClick={() => setCtxDetailsOpen((prev) => !prev)}
                    title={`${totalTokens.toLocaleString()} / ${maxTokens.toLocaleString()} tokens · ${contextPct}% context · Click for details`}
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
                    {effectiveHistory?.usage?.cost !== undefined && effectiveHistory.usage.cost > 0 && (
                      <>
                        <span className="composer-stat-sep">·</span>
                        <span>${effectiveHistory.usage.cost.toFixed(2)}</span>
                      </>
                    )}
                  </button>

                  {ctxDetailsOpen && (
                    <div className="ctx-details-popover" role="dialog" aria-label="Context and usage breakdown">
                      <div className="popover-header-title">Context &amp; Usage</div>
                      <div className="ctx-details-grid">
                        <div className="ctx-detail-row">
                          <span>Context used</span>
                          <b>{contextPct}% ({totalTokens.toLocaleString()} / {maxTokens.toLocaleString()})</b>
                        </div>
                        <div className="ctx-detail-row">
                          <span>Input tokens</span>
                          <span>{(effectiveHistory?.usage?.input ?? 0).toLocaleString()}</span>
                        </div>
                        <div className="ctx-detail-row">
                          <span>Output tokens</span>
                          <span>{(effectiveHistory?.usage?.output ?? 0).toLocaleString()}</span>
                        </div>
                        <div className="ctx-detail-row">
                          <span>Cache read</span>
                          <span>{(effectiveHistory?.usage?.cacheRead ?? 0).toLocaleString()}</span>
                        </div>
                        {effectiveHistory?.usage?.cost !== undefined && effectiveHistory.usage.cost > 0 && (
                          <div className="ctx-detail-row total">
                            <span>Cost</span>
                            <b>${effectiveHistory.usage.cost.toFixed(4)}</b>
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
                  await run(() => api.setModel(agent.id, provider, modelId));
                }}
                onSelectThinking={async (level) => {
                  await run(() => api.setThinking(agent.id, level));
                }}
                disabled={busy}
              />
              {running ? (
                <>
                  <Button size="sm" className="composer-action-btn" onClick={() => send("steer")} disabled={busy} title="Steer now (Enter)" aria-label="Steer now">
                    <ArrowUp size={14} aria-hidden="true" />
                  </Button>
                  <Button variant="secondary" size="sm" className="composer-action-btn" onClick={() => send("followUp")} disabled={busy} title="Queue follow-up" aria-label="Queue follow-up">
                    <Clock size={14} aria-hidden="true" />
                  </Button>
                  <Button variant="destructive" size="sm" className="composer-action-btn" onClick={() => void run(() => api.abort(agent.id))} disabled={busy} title="Stop agent execution" aria-label="Stop agent execution">
                    <Square size={13} aria-hidden="true" />
                  </Button>
                </>
              ) : (
                <Button size="sm" className="send-btn" onClick={() => send("prompt")} disabled={busy || (!draft.trim() && images.length === 0)}>
                  Send ↵
                </Button>
              )}
            </div>
          </div>
        </div>
      </footer>
    </section>
  );
}

function findStreamingStartIndex(timeline: TimelineItem[]): number {
  for (let i = timeline.length - 1; i >= 0; i--) {
    const item = timeline[i];
    if (item.kind === "user") {
      return i + 1;
    }
  }
  return 0;
}

function hasPendingStreamingItem(timeline: TimelineItem[]): boolean {
  const last = timeline.at(-1);
  return last?.kind === "thinking" || (last?.kind === "tool" && last.status === "running");
}

function LiveStreamingStats({ tokens, tokensPerSecond }: { tokens: number; tokensPerSecond: number | null }) {
  return (
    <div className="live-streaming-stats" role="status" aria-live="polite">
      <span className="live-streaming-token-count" title="Estimated streamed tokens">
        ↓ {Math.round(tokens).toLocaleString()}
      </span>
      {tokensPerSecond !== null && <span className="live-streaming-rate">{tokensPerSecond.toFixed(1)} t/s</span>}
    </div>
  );
}

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

function TimelineRow({ item, concise }: { item: TimelineItem; concise: boolean }) {
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
          <p>{item.text}</p>
        </div>
      </div>
    );
  }
  return (
    <article className="assistant-message-row">
      <div className="assistant-prose">
        <Streamdown>{item.text}</Streamdown>
      </div>
    </article>
  );
}
