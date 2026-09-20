import { memo, useEffect, useRef, useState } from "react";
import type {
  AgentCapabilities,
  AgentHistory,
  AgentSummary,
  UserFileRef,
  UserImageRef,
} from "../../shared/domain/agents.ts";
import type { TimelineExpansionSettings } from "../../shared/domain/settings.ts";
import { WorkspaceApiError, friendlyApiError, type WorkspaceApi } from "../api.ts";
import { ModelPicker } from "./ModelPicker.tsx";
import { DisplayOptionsPopover } from "./DisplayOptionsPopover.tsx";
import {
  ComposerAutocomplete,
  COMPOSER_SUGGESTION_LIST_ID,
} from "./ComposerAutocomplete.tsx";
import {
  ComposerEditor,
  currentViewportIsMobileComposer,
  type ComposerEditorHandle,
} from "./ComposerEditor.tsx";
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
import { Button } from "./ui/button.tsx";
import { formatCompactTokens } from "../lib/utils.ts";
import { type StreamPhase } from "../lib/stream-activity.ts";
import {
  ArrowUp,
  Clock,
  File,
  Plus,
  ReplaceAll,
  Square,
} from "lucide-react";
import { shouldSuppressComposerClickAfterTouch } from "./agentPanelState.ts";
import { useComposerDraft } from "./useComposerDraft.ts";
import { useComposerAttachments } from "./useComposerAttachments.ts";
import { useFollowUpQueue } from "./useFollowUpQueue.ts";
import { useComposerSuggestions } from "./useComposerSuggestions.ts";
import {
  attachmentLabel,
  toOptimisticFiles,
  toOptimisticImages,
  toPayloadFiles,
  toPayloadImages,
} from "./composerAttachments.ts";
import { QueuedFollowUpList } from "./QueuedFollowUpList.tsx";
import { ComposerMergeButton } from "./ComposerMergeButton.tsx";
import {
  LiveStreamPhase,
  LiveStreamTraffic,
  formatDuration,
} from "./TimelineRow.tsx";

const CONTEXT_RING_RADIUS = 6;
const CONTEXT_RING_CIRCUMFERENCE = 2 * Math.PI * CONTEXT_RING_RADIUS;

/** Stroke-based donut: stays legible at low % where a filled conic pie is a sliver.
 *  Round caps keep even 1-3% visible as a dot on the track. */
function ContextRing({ pct, color }: { pct: number; color: string }) {
  const clamped = Math.min(100, Math.max(0, pct));
  return (
    <svg className="context-ring" width="14" height="14" viewBox="0 0 16 16" aria-hidden="true">
      <circle
        cx="8"
        cy="8"
        r={CONTEXT_RING_RADIUS}
        fill="none"
        stroke="rgba(127, 127, 127, 0.35)"
        strokeWidth="2.5"
      />
      {clamped > 0 && (
        <circle
          cx="8"
          cy="8"
          r={CONTEXT_RING_RADIUS}
          fill="none"
          stroke={color}
          strokeWidth="2.5"
          strokeLinecap="round"
          strokeDasharray={`${(clamped / 100) * CONTEXT_RING_CIRCUMFERENCE} ${CONTEXT_RING_CIRCUMFERENCE}`}
          transform="rotate(-90 8 8)"
        />
      )}
    </svg>
  );
}

type AgentComposerProps = {
  agentId: string;
  workspaceId: string;
  running: boolean;
  stopping: boolean;
  /** Agent summary/history still loading: the true status is unknown, so sending is disabled until it settles. */
  loading: boolean;
  /** True only when the agent status is exactly `idle`: the settle signal that drains the attached queue. */
  idle: boolean;
  streamActive: boolean;
  streamPhase: StreamPhase | null;
  receiving: boolean;
  elapsedSeconds: number;
  streamIdleSeconds: number | null;
  streamBytes: number;
  capabilities?: AgentCapabilities;
  api: WorkspaceApi;
  busy: boolean;
  setBusy: (b: boolean) => void;
  onRefresh: () => Promise<void>;
  onModelChanged?: (agent: AgentSummary) => void;
  onOptimisticMessage?: (message: string, images?: UserImageRef[], files?: UserFileRef[]) => void;
  currentModel?: AgentCapabilities["models"][number] | { name: string; id: string; provider: string; contextWindow?: number };
  currentModelDisplayName: string;
  thinking: string;
  contextTokens: number | null;
  maxTokens: number;
  contextPct: number;
  pieColor: string;
  usage?: AgentHistory["usage"];
  changeSummary?: { fileCount: number; additions: number; deletions: number };
  sessionExpansion: TimelineExpansionSettings;
  onSessionExpansionChange: (next: TimelineExpansionSettings) => void;
  onResetSessionExpansion: () => void;
  isExpansionOverridden: boolean;
  onWorkspaceDeleted?: () => void | Promise<void>;
  /** Bumped by the owning session on every history load so the composer's git
   *  buttons re-check status even when live WS invalidations were missed
   *  (e.g. after a browser refresh). */
  gitStatusRefreshKey?: number;
  /** Receives the composer's file-attach function so panel-level drops can attach. */
  attachFilesRef?: { current: ((files: FileList | File[] | null) => void) | null };
};

/** Middle-out truncation that preserves the filename suffix. */

function AgentComposerInner({
  agentId,
  workspaceId,
  running,
  stopping,
  loading,
  idle,
  streamActive,
  streamPhase,
  receiving,
  elapsedSeconds,
  streamIdleSeconds,
  streamBytes,
  capabilities,
  api,
  busy,
  setBusy,
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
  sessionExpansion,
  onSessionExpansionChange,
  onResetSessionExpansion,
  isExpansionOverridden,
  onWorkspaceDeleted,
  gitStatusRefreshKey,
  attachFilesRef,
}: AgentComposerProps) {
  const { draftKey, draft, updateDraft, clearDraft } = useComposerDraft(agentId);
  const [composerError, setComposerError] = useState("");
  const [composerNotice, setComposerNotice] = useState<{ tone: "info" | "success"; text: string } | null>(null);
  const { images, uploadFiles, addAttachments, removeImage, removeFile, resetAttachments } =
    useComposerAttachments(agentId, setComposerError);
  const { queue, enqueueFollowUp, retractQueued, clearQueued } = useFollowUpQueue({
    agentId,
    idle,
    stopping,
    busy,
    setBusy,
    api,
    onOptimisticMessage,
    onRefresh,
    onError: setComposerError,
  });
  const [ctxDetailsOpen, setCtxDetailsOpen] = useState(false);
  const ctxDetailsRef = useRef<HTMLDivElement>(null);
  const composerInputRef = useRef<ComposerEditorHandle>(null);
  const lastComposerTouchSendRef = useRef<number | null>(null);
  const [caret, setCaret] = useState<number | null>(null);
  const [compactConfirmOpen, setCompactConfirmOpen] = useState(false);
  const [isMobileComposer, setIsMobileComposer] = useState(() => currentViewportIsMobileComposer());
  const placeCaret = (position: number) => {
    setCaret(position);
    requestAnimationFrame(() => {
      const input = composerInputRef.current;
      if (!input) return;
      input.focus();
      input.setCaret(position);
    });
  };

  const {
    autocomplete,
    filteredCommands,
    suggestionOpen,
    activeValue,
    acceptFile,
    acceptCommand,
    handleActiveValueChange,
    handleEditorKeyDown,
  } = useComposerSuggestions({
    draft,
    updateDraft,
    caret,
    placeCaret,
    workspaceId,
    api,
    capabilities,
    onCompactRequest: () => setCompactConfirmOpen(true),
    running,
    stopping,
    loading,
    busy,
    onSubmit: (kind) => send(kind),
  });

  useEffect(() => {
    setCtxDetailsOpen(false);
  }, [draftKey]);

  useEffect(() => {
    composerInputRef.current?.focus();
  }, [agentId]);

  useEffect(() => {
    const update = () => setIsMobileComposer(currentViewportIsMobileComposer());
    window.addEventListener("resize", update);
    const coarseQuery = window.matchMedia?.("(pointer: coarse)");
    coarseQuery?.addEventListener?.("change", update);
    return () => {
      window.removeEventListener("resize", update);
      coarseQuery?.removeEventListener?.("change", update);
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

  const run = async (
    action: () => Promise<unknown>,
    shouldClearDraft = false,
    refreshAfter = true,
  ) => {
    setBusy(true);
    setComposerError("");
    setComposerNotice(null);
    try {
      await action();
      if (shouldClearDraft) clearDraft();
      if (refreshAfter) await onRefresh();
    } catch (cause) {
      setComposerError(friendlyApiError(cause, "Agent command failed"));
      // A stale client (missed WS events across a disconnect) sends the wrong
      // verb -- prompt while running, or anything while stopping -- and the
      // server rejects it as invalid-input. Resync immediately so the composer
      // shows the true status and the retry uses the right verb instead of
      // failing the same way until a manual reload.
      if (cause instanceof WorkspaceApiError && cause.code === "invalid-input") void onRefresh();
    } finally {
      setBusy(false);
    }
  };

  const send = (kind: "prompt" | "steer" | "followUp") => {
    const value = draft.trim();
    if (!value && images.length === 0 && uploadFiles.length === 0) return;
    const finalMessage = attachmentLabel(value, images, uploadFiles);
    const payloadImages = toPayloadImages(images);
    const payloadFiles = toPayloadFiles(uploadFiles);
    onOptimisticMessage?.(finalMessage, toOptimisticImages(images), toOptimisticFiles(uploadFiles));
    void run(
      async () => {
        await api[kind](agentId, finalMessage, payloadImages, payloadFiles);
        resetAttachments();
      },
      true,
      false,
    );
    // Dismiss the iOS keyboard now that the message is away: focus was held
    // through pointerdown so this tap sent on the first try, and releasing
    // it here restores the familiar post-send dismissal.
    composerInputRef.current?.blur();
  };

  /**
   * Attach a follow-up to the composer instead of sending it: while the run
   * is active the item lives only in this local queue (above the input, out
   * of the timeline), where each item stays retractable until it dispatches.
   */
  const queueFollowUp = () => {
    const value = draft.trim();
    if ((!value && images.length === 0 && uploadFiles.length === 0) || stopping || loading) return;
    enqueueFollowUp(attachmentLabel(value, images, uploadFiles), images, uploadFiles);
    clearDraft();
    resetAttachments();
    setComposerError("");
    composerInputRef.current?.blur();
  };

  useEffect(() => {
    if (!attachFilesRef) return;
    attachFilesRef.current = addAttachments;
    return () => {
      attachFilesRef.current = null;
    };
  });

  return (
    <footer className="composer-container">
      <div className="composer-meta-line">
        {changeSummary ? (
          <div
            className="agent-change-summary composer-status-pill"
            aria-label={`${changeSummary.fileCount} changed files, ${changeSummary.additions} additions, ${changeSummary.deletions} deletions`}
          >
            <ReplaceAll size={11} aria-hidden="true" />
            <span className="agent-change-count">{changeSummary.fileCount}</span>
            <File size={11} aria-hidden="true" />
            <span className="add-count">+{changeSummary.additions}</span>
            <span className="del-count">-{changeSummary.deletions}</span>
          </div>
        ) : (
          <div />
        )}
        <div className="composer-meta-right">
          {streamActive && (
            <div
              className="composer-status-pill"
              role="status"
              aria-live="polite"
            >
              <span className="pulse-dot" />
              <span className="composer-status-duration">{formatDuration(elapsedSeconds)}</span>
              <LiveStreamPhase phase={streamPhase} receiving={receiving} />
              <LiveStreamTraffic bytes={streamBytes} idleSeconds={streamIdleSeconds} />
            </div>
          )}
          <div className="composer-ctx-wrapper" ref={ctxDetailsRef}>
            <button
              type="button"
              className="composer-ctx-pill"
              onClick={() => setCtxDetailsOpen((prev) => !prev)}
              title={`${formatCompactTokens(contextTokens ?? 0)} / ${formatCompactTokens(maxTokens)} tokens · ${contextPct}% context · Click for details`}
              aria-label={`Context used: ${contextPct}%. Click for usage breakdown.`}
              aria-expanded={ctxDetailsOpen}
              aria-haspopup="dialog"
            >
              <ContextRing pct={contextPct} color={pieColor} />
              <span>{contextPct}%</span>
              {usage?.cost !== undefined && usage.cost > 0 && (
                <span className="composer-ctx-cost">
                  <span className="composer-stat-sep">·</span>
                  <span>${usage.cost.toFixed(2)}</span>
                </span>
              )}
            </button>

            {ctxDetailsOpen && (
              <div className="ctx-details-popover" role="dialog" aria-label="Context and usage breakdown">
                <div className="popover-header-title">Context &amp; Usage</div>
                <div className="ctx-details-grid">
                  <div className="ctx-detail-row">
                    <span>Context used</span>
                    <b>
                      {contextPct}% ({formatCompactTokens(contextTokens ?? 0)} / {formatCompactTokens(maxTokens)})
                    </b>
                  </div>
                  <div className="ctx-detail-row">
                    <span>Input tokens</span>
                    <span>{formatCompactTokens(usage?.input ?? 0)}</span>
                  </div>
                  <div className="ctx-detail-row">
                    <span>Output tokens</span>
                    <span>{formatCompactTokens(usage?.output ?? 0)}</span>
                  </div>
                  <div className="ctx-detail-row">
                    <span>Cache read</span>
                    <span>{formatCompactTokens(usage?.cacheRead ?? 0)}</span>
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
        </div>
      </div>
      <QueuedFollowUpList queue={queue} disabled={busy || stopping || loading} onRetract={retractQueued} onClear={clearQueued} />
      {streamActive && streamBytes === 0 && elapsedSeconds >= 60 && (
        <div className="composer-notice-alert composer-notice-info" role="status">
          <span>ⓘ No output for {formatDuration(elapsedSeconds)} — the command may be stuck. Stop also kills the running command.</span>
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
          skillsAvailable={capabilities?.skillsAvailable ?? false}
          skillsSupported={capabilities?.skillsSupported ?? false}
          activeIndex={autocomplete.activeIndex}
          activeValue={activeValue}
          onActiveValueChange={handleActiveValueChange}
          onHoverIndex={autocomplete.setActiveIndex}
          onSelectFile={acceptFile}
          onSelectCommand={acceptCommand}
          onEscape={() => autocomplete.dismiss()}
          onInteractOutside={(insideComposer) => {
            if (!insideComposer) autocomplete.dismiss();
          }}
        />
        <ComposerEditor
          ref={composerInputRef}
          value={draft}
          onChange={updateDraft}
          onCaretChange={setCaret}
          onPasteFiles={(files) => void addAttachments(files)}
          ariaExpanded={suggestionOpen}
          ariaControls={suggestionOpen ? COMPOSER_SUGGESTION_LIST_ID : undefined}
          ariaActivedescendant={suggestionOpen && activeValue ? `composer-option-${activeValue}` : undefined}
          onKeyDown={handleEditorKeyDown}
          placeholder={
            loading
              ? "Loading agent status…"
              : stopping
              ? "Stopping agent execution…"
              : running
              ? isMobileComposer
                ? "Steer now (⌘+Enter) or queue follow-up…"
                : "Steer now (Enter) or queue follow-up…"
              : "@ for files; / for commands"
          }
          disabled={stopping || loading}
        />
        {composerError && (
          <div className="composer-error-alert" role="alert">
            <span>⚠️ {composerError}</span>
          </div>
        )}
        {composerNotice && (
          <div className={`composer-notice-alert composer-notice-${composerNotice.tone}`} role="status">
            <span>{composerNotice.tone === "info" ? "ⓘ" : "✓"} {composerNotice.text}</span>
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
                  onClick={() => removeImage(image)}
                  aria-label={`Remove ${image.name}`}
                >
                  ×
                </button>
              </div>
            ))}
          </div>
        )}
        {uploadFiles.length > 0 && (
          <div className="attachment-list" aria-label="Attached files">
            {uploadFiles.map((file) => (
              <div key={`${file.name}:${file.data.length}`} className="attachment-chip">
                <span className="attachment-file-icon" aria-hidden="true">📎</span>
                <span className="attachment-name">{file.name}</span>
                <button
                  type="button"
                  className="attachment-remove"
                  onClick={() => removeFile(file)}
                  aria-label={`Remove ${file.name}`}
                >
                  ×
                </button>
              </div>
            ))}
          </div>
        )}
        <div className="composer-toolbar">
          <div className="composer-toolbar-left">
            <label className="composer-attach-btn" title="Attach file or image" aria-label="Attach file or image">
              <Plus size={14} aria-hidden="true" />
              <input
                type="file"
                multiple
                disabled={stopping}
                onChange={(event) => {
                  void addAttachments(event.target.files);
                  event.currentTarget.value = "";
                }}
              />
            </label>
          </div>
          <div className="composer-toolbar-right">
            <ComposerMergeButton workspaceId={workspaceId} api={api} disabled={busy || stopping} settled={!running && !stopping} refreshKey={gitStatusRefreshKey} onWorkspaceDeleted={onWorkspaceDeleted} hideIcons={isMobileComposer} />
            <DisplayOptionsPopover
              expansion={sessionExpansion}
              onExpansionChange={onSessionExpansionChange}
              onResetDefaults={onResetSessionExpansion}
              isOverridden={isExpansionOverridden}
            />
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
                  onTouchEnd={(event) => {
                    event.preventDefault();
                    lastComposerTouchSendRef.current = Date.now();
                    send("steer");
                  }}
                  onClick={() => {
                    if (shouldSuppressComposerClickAfterTouch(lastComposerTouchSendRef.current, Date.now())) return;
                    send("steer");
                  }}
                  disabled={busy || loading}
                  title={isMobileComposer ? "Steer now (⌘+Enter)" : "Steer now (Enter)"}
                  aria-label="Steer now"
                >
                  <ArrowUp size={14} aria-hidden="true" />
                </Button>
                <Button
                  variant="secondary"
                  size="xs"
                  className="composer-action-btn"
                  onTouchEnd={(event) => {
                    event.preventDefault();
                    lastComposerTouchSendRef.current = Date.now();
                    queueFollowUp();
                  }}
                  onClick={() => {
                    if (shouldSuppressComposerClickAfterTouch(lastComposerTouchSendRef.current, Date.now())) return;
                    queueFollowUp();
                  }}
                  disabled={busy || loading}
                  title="Queue follow-up — stays attached to the composer until this run settles"
                  aria-label="Queue follow-up"
                >
                  <Clock size={14} aria-hidden="true" />
                </Button>
                <Button
                  variant="destructive"
                  size="xs"
                  className="composer-action-btn"
                  onTouchEnd={(event) => {
                    event.preventDefault();
                    lastComposerTouchSendRef.current = Date.now();
                    void run(() => api.abort(agentId));
                    composerInputRef.current?.blur();
                  }}
                  onClick={() => {
                    if (shouldSuppressComposerClickAfterTouch(lastComposerTouchSendRef.current, Date.now())) return;
                    void run(() => api.abort(agentId));
                    composerInputRef.current?.blur();
                  }}
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
                onTouchEnd={(event) => {
                  event.preventDefault();
                  lastComposerTouchSendRef.current = Date.now();
                  send("prompt");
                }}
                onClick={() => {
                  if (shouldSuppressComposerClickAfterTouch(lastComposerTouchSendRef.current, Date.now())) return;
                  send("prompt");
                }}
                disabled={busy || loading || (!draft.trim() && images.length === 0 && uploadFiles.length === 0)}
              >
                {isMobileComposer ? "Send" : "Send ↵"}
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
              working session. This cannot be undone. If the agent is mid-run, its current run is stopped first.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                setCompactConfirmOpen(false);
                void run(async () => {
                  const result = await api.compact(agentId);
                  if (result.compacted) {
                    setComposerNotice({
                      tone: "success",
                      text: result.tokensBefore !== undefined
                        ? `Session compacted \u2014 compacted from ${result.tokensBefore.toLocaleString("en-US")} tokens.`
                        : "Session compacted.",
                    });
                  } else {
                    setComposerNotice({
                      tone: "info",
                      text: result.reason === "already-compacted"
                        ? "Already compacted \u2014 nothing to do."
                        : "Nothing to compact yet \u2014 the session is too short.",
                    });
                  }
                }, false, true);
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

export const AgentComposer = memo(AgentComposerInner);
