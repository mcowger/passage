import { memo, useEffect, useMemo, useRef, useState } from "react";
import type {
  AgentCapabilities,
  AgentHistory,
  AgentSummary,
  SlashCommand,
  UserFileRef,
  UserImageRef,
} from "../../shared/domain/agents.ts";
import type { TimelineExpansionSettings } from "../../shared/domain/settings.ts";
import {
  MAX_AGENT_FILES,
  MAX_AGENT_FILE_DATA_BYTES,
  MAX_AGENT_IMAGES,
  MAX_AGENT_IMAGE_DATA_BYTES,
  type AgentFile,
  type AgentImage,
} from "../../shared/protocol/agents.ts";
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
import {
  createQueuedFollowUp,
  removeQueuedFollowUp,
  shouldSuppressComposerClickAfterTouch,
  type QueuedFollowUp,
} from "./agentPanelState.ts";
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
  const draftKey = `passage:agent:${agentId}:draft`;
  const [draft, setDraft] = useState(() => localStorage.getItem(draftKey) ?? "");
  const [composerError, setComposerError] = useState("");
  const [composerNotice, setComposerNotice] = useState<{ tone: "info" | "success"; text: string } | null>(null);
  const [images, setImages] = useState<Array<AgentImage & { name: string }>>([]);
  const [uploadFiles, setUploadFiles] = useState<AgentFile[]>([]);
  const [ctxDetailsOpen, setCtxDetailsOpen] = useState(false);
  const ctxDetailsRef = useRef<HTMLDivElement>(null);
  const composerInputRef = useRef<ComposerEditorHandle>(null);
  const lastComposerTouchSendRef = useRef<number | null>(null);
  const reservedImageCount = useRef(0);
  const reservedFileCount = useRef(0);
  const saveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [queue, setQueue] = useState<QueuedFollowUp[]>([]);
  const dispatchingRef = useRef(false);
  const [caret, setCaret] = useState<number | null>(null);
  const [compactConfirmOpen, setCompactConfirmOpen] = useState(false);
  const [isMobileComposer, setIsMobileComposer] = useState(() => currentViewportIsMobileComposer());
  const autocomplete = useComposerTrigger({ draft, caret, workspaceId, api });
  const slashCommands = useMemo(
    () => capabilities?.slashCommands ?? [],
    [capabilities?.slashCommands],
  );
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
      input.setCaret(position);
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

  useEffect(() => {
    setDraft(localStorage.getItem(draftKey) ?? "");
    setImages([]);
    setUploadFiles([]);
    setCtxDetailsOpen(false);
    reservedImageCount.current = 0;
    reservedFileCount.current = 0;
    // The attached queue is ephemeral and browser-local: switching agents drops it.
    setQueue([]);
    dispatchingRef.current = false;
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
    setComposerNotice(null);
    try {
      await action();
      if (clearDraft) {
        if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
        setDraft("");
        localStorage.removeItem(draftKey);
      }
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
        setImages([]);
        setUploadFiles([]);
        reservedImageCount.current = 0;
        reservedFileCount.current = 0;
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
    const label = attachmentLabel(value, images, uploadFiles);
    setQueue((current) => [...current, createQueuedFollowUp(label, images, uploadFiles)]);
    if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
    setDraft("");
    localStorage.removeItem(draftKey);
    setImages([]);
    setUploadFiles([]);
    reservedImageCount.current = 0;
    reservedFileCount.current = 0;
    setComposerError("");
    composerInputRef.current?.blur();
  };

  const retractQueued = (id: string) => {
    if (dispatchingRef.current) return;
    setQueue((current) => removeQueuedFollowUp(current, id));
  };

  const clearQueued = () => {
    if (dispatchingRef.current) return;
    setQueue([]);
  };

  // Attached follow-ups enter the chat only once the run settles: while the
  // agent is idle the queue drains in order, starting a new turn with
  // `prompt` and queueing any remainder behind it with `follow_up` (a bare
  // `follow_up` on an idle agent only queues in Pi and never starts a run).
  // A failed send stops the drain, restores the unsent remainder to the
  // front, and surfaces the error -- nothing silently disappears from
  // the queue.
  useEffect(() => {
    if (!idle || stopping || busy || dispatchingRef.current || queue.length === 0) return;
    dispatchingRef.current = true;
    setBusy(true);
    setComposerError("");
    void (async () => {
      const pending = [...queue];
      setQueue([]);
      for (const [index, item] of pending.entries()) {
        const imagesArg = toPayloadImages(item.images);
        const filesArg = toPayloadFiles(item.files);
        onOptimisticMessage?.(item.text, toOptimisticImages(item.images), toOptimisticFiles(item.files));
        try {
          // The agent is idle at drain start, so the first item must start a
          // new turn via `prompt`. Anything after it rides behind the now
          // active run via `follow_up` (a sequential `prompt` would 409 as
          // "agent is active").
          if (index === 0) {
            await api.prompt(agentId, item.text, imagesArg, filesArg);
          } else {
            await api.followUp(agentId, item.text, imagesArg, filesArg);
          }
        } catch (cause) {
          const failedIndex = pending.indexOf(item);
          setQueue((current) => [...pending.slice(failedIndex), ...current]);
          setComposerError(friendlyApiError(cause, "Agent command failed"));
          if (cause instanceof WorkspaceApiError && cause.code === "invalid-input") void onRefresh();
          break;
        }
      }
      setBusy(false);
      dispatchingRef.current = false;
    })();
  }, [idle, stopping, busy, queue, agentId, api, onOptimisticMessage, onRefresh, setBusy]);

  const readAsBase64 = (file: File): Promise<string> =>
    new Promise<string>((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => {
        const result = String(reader.result ?? "");
        const comma = result.indexOf(",");
        resolve(comma >= 0 ? result.slice(comma + 1) : result);
      };
      reader.onerror = () => reject(new Error(`Failed to read ${file.name}`));
      reader.readAsDataURL(file);
    });

  const isSupportedImage = (mimeType: string): boolean =>
    /^image\/(png|jpeg|gif|webp)$/.test(mimeType);

  /** One attach path for everything (button + drag-drop): supported images
   *  ride as model API blocks, all other files land in the shared
   *  attachment cache and are referenced by path in the same message. */
  const addAttachments = async (files: FileList | File[] | null) => {
    if (!files) return;
    const selected = Array.from(files);
    const imageCandidates = selected.filter((file) => {
      const normalized = file.type === "image/jpg" ? "image/jpeg" : file.type;
      return isSupportedImage(normalized) && file.size <= MAX_AGENT_IMAGE_DATA_BYTES;
    });
    const fileCandidates = selected.filter((file) => !imageCandidates.includes(file));
    let reservedImages = 0;
    let reservedFiles = 0;
    try {
      if (imageCandidates.length + reservedImageCount.current > MAX_AGENT_IMAGES)
        throw new Error(`Attach at most ${MAX_AGENT_IMAGES} images`);
      if (fileCandidates.length + reservedFileCount.current + uploadFiles.length > MAX_AGENT_FILES)
        throw new Error(`Attach at most ${MAX_AGENT_FILES} files`);
      reservedImageCount.current += imageCandidates.length;
      reservedFileCount.current += fileCandidates.length;
      reservedImages = imageCandidates.length;
      reservedFiles = fileCandidates.length;
      const imageAttachments = await Promise.all(
        imageCandidates.map(async (file) => {
          const mimeType = file.type === "image/jpg" ? "image/jpeg" : file.type;
          const base64 = await readAsBase64(file);
          return {
            type: "image" as const,
            data: base64,
            mimeType: mimeType as AgentImage["mimeType"],
            name: file.name,
          };
        })
      );
      const fileAttachments: AgentFile[] = await Promise.all(
        fileCandidates.map(async (file) => {
          if (file.size > MAX_AGENT_FILE_DATA_BYTES) throw new Error(`${file.name} is too large`);
          if (!file.name.trim()) throw new Error("File is missing a name");
          const base64 = await readAsBase64(file);
          return {
            type: "file" as const,
            data: base64,
            mimeType: file.type || "application/octet-stream",
            name: file.name,
          };
        })
      );
      setImages((current) => {
        const available = MAX_AGENT_IMAGES - current.length;
        if (imageAttachments.length > available) {
          reservedImageCount.current -= imageAttachments.length;
          return current;
        }
        return [...current, ...imageAttachments];
      });
      setUploadFiles((current) => {
        const available = MAX_AGENT_FILES - current.length;
        if (fileAttachments.length > available) {
          reservedFileCount.current -= fileAttachments.length;
          return current;
        }
        return [...current, ...fileAttachments];
      });
      setComposerError("");
    } catch (cause) {
      reservedImageCount.current -= reservedImages;
      reservedFileCount.current -= reservedFiles;
      setComposerError(cause instanceof Error ? cause.message : "Unable to attach file");
    }
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
              <span
                className="context-pie"
                style={{
                  background: `conic-gradient(${pieColor} ${contextPct}%, var(--chip-blue-track, rgba(3, 105, 161, 0.18)) 0)`,
                }}
                aria-hidden="true"
              />
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
        <ComposerEditor
          ref={composerInputRef}
          value={draft}
          onChange={updateDraft}
          onCaretChange={setCaret}
          ariaExpanded={suggestionOpen}
          ariaControls={suggestionOpen ? COMPOSER_SUGGESTION_LIST_ID : undefined}
          ariaActivedescendant={suggestionOpen && activeValue ? `composer-option-${activeValue}` : undefined}
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
              // Mobile plain-Enter inserts a newline (handled in
              // ComposerEditor); only Cmd/Ctrl+Enter submits there.
              if (currentViewportIsMobileComposer() && !event.metaKey && !event.ctrlKey) return;
              event.preventDefault();
              if (stopping || loading) return;
              if (running) send("steer");
              else if (!busy && !loading) send("prompt");
            }
          }}
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
        {uploadFiles.length > 0 && (
          <div className="attachment-list" aria-label="Attached files">
            {uploadFiles.map((file) => (
              <div key={`${file.name}:${file.data.length}`} className="attachment-chip">
                <span className="attachment-file-icon" aria-hidden="true">📎</span>
                <span className="attachment-name">{file.name}</span>
                <button
                  type="button"
                  className="attachment-remove"
                  onClick={() => {
                    setUploadFiles((current) => current.filter((item) => item !== file));
                    reservedFileCount.current -= 1;
                  }}
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
