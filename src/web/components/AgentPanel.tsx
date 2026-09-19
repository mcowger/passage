import { Fragment, memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { DragEvent, ReactNode } from "react";
import type { AgentCapabilities, AgentHistory, AgentSummary, SlashCommand, TimelineItem, ToolActivity, UserFileRef, UserImageRef } from "../../shared/domain/agents.ts";
import type { WorkspaceSettings, TimelineExpansionSettings } from "../../shared/domain/settings.ts";
import { DEFAULT_TIMELINE_EXPANSION } from "../../shared/domain/settings.ts";
import { MAX_AGENT_FILES, MAX_AGENT_FILE_DATA_BYTES, MAX_AGENT_IMAGES, MAX_AGENT_IMAGE_DATA_BYTES, type AgentFile, type AgentImage } from "../../shared/protocol/agents.ts";
import { WorkspaceApiError, friendlyApiError, type WorkspaceApi } from "../api.ts";
import { toast } from "sonner";
import { subscribeWorkspace } from "../workspaceSocket.ts";
import type { GitStatus } from "../../shared/domain/git.ts";
import { ModelPicker } from "./ModelPicker.tsx";
import { DisplayOptionsPopover } from "./DisplayOptionsPopover.tsx";
import { computeLatestTimelineIds, isItemExpanded, type LatestTimelineIds } from "../lib/timeline-expansion.ts";
import { hasFileDrag } from "../lib/image-drop.ts";
import { Streamdown } from "streamdown";
import { Button } from "./ui/button.tsx";
import { Alert, AlertDescription, AlertTitle } from "./ui/alert.tsx";
import { ToolRow } from "./ToolRow.tsx";
import { FileTypeIcon } from "./FileTypeIcon.tsx";
import { splitSkillRefs } from "./skillRefs.ts";
import { ComposerAutocomplete, COMPOSER_SUGGESTION_LIST_ID } from "./ComposerAutocomplete.tsx";
import { ComposerEditor, currentViewportIsMobileComposer, type ComposerEditorHandle } from "./ComposerEditor.tsx";
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
import { UserFileStrip, UserImageStrip } from "./UserImages.tsx";
import { getToolDiff } from "../lib/tool-diff.ts";
import { formatCompactTokens } from "../lib/utils.ts";
import { RECEIVING_ACTIVITY_WINDOW_MS, STREAM_PHASE_LABELS, emptyStreamActivity, formatByteCount, type StreamActivity, type StreamPhase } from "../lib/stream-activity.ts";
import {
  Clock,
  CircleAlert,
  Scissors,
  Square,
  ArrowUp,
  ArrowDownUp,
  Plus,
  ReplaceAll,
  File,
  Brain,
  MessageSquareMore,
  FilePenLine,
  FolderGit2,
  Upload,
  Wrench,
  PencilSparkles,
  GraduationCap,
  GitCommitHorizontal,
  GitMerge,
  RotateCwFadingClock,
  X,
} from "lucide-react";
import { Spinner } from "./ui/spinner.tsx";
import { Popover, PopoverContent, PopoverTrigger } from "./ui/popover.tsx";

const STREAMING_STATS_INTERVAL_MS = 300;
/**
 * Hysteresis for the live-tail pin: breaking away takes only a small upward
 * motion, while rejoining takes a scroll back near the bottom. A single
 * generous threshold (previously 48px both ways) felt like fighting on
 * mobile -- small flicks kept snapping back to the bottom until the user
 * made an exaggerated gesture to break free.
 */
export const UNPIN_SLACK_PX = 12;
/** Distance from the bottom that re-pins an unpinned viewport. */
export const REPIN_SLACK_PX = 48;

/**
 * Hysteresis for the live-tail pin. A pinned viewport breaks away on a
 * small motion (`unpinSlack`); an unpinned one rejoins only near the
 * bottom (`repinSlack`). Pure for testing; the scroll listener below is
 * the only live caller.
 */
export function resolvePinned(
  distanceFromBottom: number,
  currentlyPinned: boolean,
  unpinSlack: number = UNPIN_SLACK_PX,
  repinSlack: number = REPIN_SLACK_PX,
): boolean {
  if (currentlyPinned) return distanceFromBottom <= unpinSlack;
  return distanceFromBottom <= repinSlack;
}
/** Distance from the top that triggers backfilling the previous page of history. */
const LOAD_MORE_HISTORY_SLACK_PX = 120;

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
  onOptimisticMessage?: (message: string, images?: UserImageRef[], files?: UserFileRef[]) => void;
  /** Offline transcript override for rendering verification (never live state). */
  previewHistory?: AgentHistory;
  settings?: WorkspaceSettings;
  /** Whether an older page of history is available to backfill. */
  hasMoreHistory?: boolean;
  /** Whether a backfill fetch for older history is in flight. */
  loadingMoreHistory?: boolean;
  /** Fetches and prepends the previous page of history. */
  onLoadMoreHistory?: () => void;
  /** Live activity holder written by the socket owner; sampled on the pill's interval. */
  streamActivityRef?: { current: StreamActivity };
  onWorkspaceDeleted?: () => void | Promise<void>;
};

export function resolveActiveQuestionRequest(agent: AgentSummary): QuestionRequest | null {
  const pending = agent.pendingUiRequest as Record<string, unknown> | undefined;
  if (pending && pending.id) {
    if (pending.method === "select" || (Array.isArray(pending.options) && pending.options.length > 0)) {
      let header = "Select";
      let question = String(pending.title || "Choose an option");
      const titleMatch = question.match(/^\[(.*?)\]\s*(.*)$/);
      if (titleMatch) {
        header = titleMatch[1];
        question = titleMatch[2];
      }

      const rawOptions = Array.isArray(pending.options) ? pending.options : [];
      const allowOther = rawOptions.some((option) =>
        typeof option === "string" && /^\d+\.\s*(Type something\.|Other\b)|^Type something\.$/i.test(option.trim())
      );
      const options: QuestionOption[] = rawOptions.flatMap((opt: unknown) => {
        if (!opt) return [];
        if (typeof opt === "object" && opt !== null && "label" in opt) {
          const o = opt as { label: string; description?: string; preview?: string };
          const label = String(o.label || "").trim();
          if (!label || /^\d+\.\s*(Type something\.|Other\b)/i.test(label) || label === "Type something.") return [];
          return [
            {
              label,
              description: o.description ? String(o.description) : undefined,
              preview: o.preview ? String(o.preview) : undefined,
            },
          ];
        }
        const raw = typeof opt === "string" ? opt.trim() : "";
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
        // Check for "Label — Description" without leading numbers
        const matchNoNumWithDesc = raw.match(/^([^\u2014\u2013-]+?)\s*[\u2014\u2013-]\s*(.*)$/);
        if (matchNoNumWithDesc) {
          return [{ label: matchNoNumWithDesc[1].trim(), description: matchNoNumWithDesc[2].trim() }];
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
            allowOther,
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
            placeholder: typeof pending.placeholder === "string" ? pending.placeholder : undefined,
            prefill: typeof pending.prefill === "string" ? pending.prefill : undefined,
          },
        ],
      };
    }
  }
  return null;
}

/** A native Pi dialog supersedes its blocking tool invocation while it is open. */
export function timelineWithoutBlockingTool(timeline: TimelineItem[], hasActiveUiRequest: boolean): TimelineItem[] {
  if (!hasActiveUiRequest) return timeline;
  return timeline.filter(
    (item) => item.kind !== "tool" || item.status !== "running" || item.name !== "ask_user_question"
  );
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

export function resolveCurrentThinking(
  thinkingPreference: string | null,
  historyThinkingLevel: AgentHistory["currentThinkingLevel"],
) {
  return thinkingPreference ?? historyThinkingLevel ?? "default";
}

export function resolveStreamActive(status: AgentSummary["status"]): boolean {
  return status === "running";
}

/**
 * The elapsed timer anchors to Passage's authoritative run start when the
 * daemon reports one, so reloading the page mid-run does not reset it to the
 * moment the transcript was loaded. It only falls back to first observation
 * when the daemon has no recorded run start (for example, an unpersisted
 * process whose start Passage never saw).
 */
export function resolveStreamStartMs(runStartedAt: number | undefined, observedAt: number): number {
  return typeof runStartedAt === "number" && Number.isSafeInteger(runStartedAt) && runStartedAt > 0
    ? runStartedAt
    : observedAt;
}

export function isComposerLocked(status: AgentSummary["status"]): boolean {
  return status === "stopping";
}

/**
 * iOS single-tap send: tapping a composer commit button (Send / Steer /
 * Queue / Stop) while the contentEditable editor holds focus blurs it,
 * which dismisses the iOS keyboard and shifts the composer between
 * touchstart and click -- Safari then delivers the tap as a dismiss-only
 * gesture and the click never lands, so the message needs a second tap.
 *
 * `pointerdown` preventDefault does NOT fix this on iOS Safari (verified
 * on-device): the blur/layout shift happens outside the pointerdown
 * default action, so the click is still swallowed.
 *
 * The pattern that works per web reports (SO 71513013, Julo, tested on
 * iOS; Ionic forum touchstart/touchend threads) is handling `touchend`
 * directly: `preventDefault()` there suppresses the synthetic mouse/click
 * sequence and we dispatch the action immediately instead of waiting for
 * the click that will never arrive. Desktop mouse and keyboard activation
 * (Enter/Space -> click, no touch) keep using `onClick`. The `touchend`
 * dispatch stamps a timestamp so the trailing synthetic click (if one
 * slips through) is ignored -- see `shouldSuppressComposerClick`.
 * (React attaches touchstart as passive, so its preventDefault is a
 * no-op; touchend is not passive, so preventDefault works here.)
 */
export const COMPOSER_TOUCH_SEND_SUPPRESS_MS = 700;

export function shouldSuppressComposerClickAfterTouch(lastTouchMs: number | null, nowMs: number): boolean {
  return lastTouchMs !== null && nowMs - lastTouchMs < COMPOSER_TOUCH_SEND_SUPPRESS_MS;
}

/** Same relevance rule as the Changes panel: a non-main branch with commits ahead of main. */
export function isComposerMergeRelevant(status: GitStatus | null | undefined): boolean {
  if (!status) return false;
  const isMainWorktree = status.checkoutRoot === status.mainCheckoutRoot || status.branchRef === "main";
  return !isMainWorktree && status.aheadOfMain > 0;
}

export type ComposerGitOption = "commit" | "merge" | "rebase" | "push";

/**
 * Smart Git options for the composer button:
 * - Commit: the workspace is dirty (uncommitted changes present).
 * - Merge: the branch is ahead of main.
 * - Rebase: main has moved since the branch was cut (branch is behind main).
 * - Push: a remote branch exists and is behind the local branch.
 * Commit is offered on any branch (including main) whenever the tree is
 * dirty; merge/rebase/push stay gated on non-main branches with a branchRef.
 */
export function resolveComposerGitOptions(status: GitStatus | null | undefined): ComposerGitOption[] {
  if (!status) return [];
  const options: ComposerGitOption[] = [];
  const dirty = status.dirty || status.files.length > 0;
  if (dirty && !status.conflicted) options.push("commit");
  if (!status.branchRef) return options;
  const isMainWorktree = status.checkoutRoot === status.mainCheckoutRoot || status.branchRef === "main";
  if (isMainWorktree) return options;
  if (status.aheadOfMain > 0) options.push("merge");
  if ((status.behindMain ?? 0) > 0) options.push("rebase");
  if (status.hasUpstream && status.ahead > 0) options.push("push");
  return options;
}

/**
 * A follow-up composed while the agent is running. It stays attached to the
 * composer (never in the timeline, never sent to Pi) until the run settles,
 * so it can be retracted per-item. Ephemeral and browser-local by design:
 * Pi exposes no per-item queue removal, so Passage holds the queue itself
 * instead of forwarding it to Pi's internal queue early.
 */
export type QueuedFollowUp = {
  id: string;
  text: string;
  images: Array<AgentImage & { name: string }>;
  files: AgentFile[];
  createdAt: number;
};

function newQueuedFollowUpId(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") return crypto.randomUUID();
  return `queued-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

export function createQueuedFollowUp(text: string, images: Array<AgentImage & { name: string }>, files: AgentFile[] = []): QueuedFollowUp {
  return { id: newQueuedFollowUpId(), text, images: [...images], files: [...files], createdAt: Date.now() };
}

export function removeQueuedFollowUp(queue: QueuedFollowUp[], id: string): QueuedFollowUp[] {
  return queue.filter((item) => item.id !== id);
}

/** Attached queue strip rendered directly above the composer input. */
export function QueuedFollowUpList({
  queue,
  disabled,
  onRetract,
  onClear,
}: {
  queue: QueuedFollowUp[];
  disabled?: boolean;
  onRetract: (id: string) => void;
  onClear: () => void;
}) {
  if (queue.length === 0) return null;
  return (
    <div
      className="composer-queue"
      role="group"
      aria-label={`${queue.length} queued follow-up${queue.length === 1 ? "" : "s"}, attached to the composer`}
    >
      <div className="composer-queue-header">
        <span className="composer-queue-title">
          <Clock size={12} aria-hidden="true" />
          Queued · sends when this run settles
        </span>
        {queue.length > 1 && (
          <button type="button" className="composer-queue-clear" onClick={onClear} disabled={disabled}>
            Clear all
          </button>
        )}
      </div>
      <ul className="composer-queue-list">
        {queue.map((item, index) => (
          <li key={item.id} className="composer-queue-item">
            <span className="composer-queue-index" aria-hidden="true">{index + 1}</span>
            <span className="composer-queue-text" title={item.text}>{item.text}</span>
            {item.images.length > 0 && (
              <span
                className="composer-queue-images"
                title={item.images.map((image) => image.name).join(", ")}
              >
                {item.images.length} image{item.images.length === 1 ? "" : "s"}
              </span>
            )}
            {item.files.length > 0 && (
              <span
                className="composer-queue-images"
                title={item.files.map((file) => file.name).join(", ")}
              >
                {item.files.length} file{item.files.length === 1 ? "" : "s"}
              </span>
            )}
            <button
              type="button"
              className="composer-queue-retract"
              onClick={() => onRetract(item.id)}
              disabled={disabled}
              title="Retract this follow-up"
              aria-label={`Retract queued follow-up ${index + 1}`}
            >
              <X size={13} aria-hidden="true" />
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}

/**
 * Smart Git shortcut for the bottom composer bar. Fetches its own Git status and
 * only renders when at least one action is relevant: commit (dirty tree),
 * merge (ahead of main), rebase (main has diverged), or push (remote branch
 * exists and is behind).
 * A single option renders as a direct action button; multiple options collapse
 * into a FolderGit2 icon button with a thinking-selector-style popup menu.
 * Merge still runs only after explicit confirmation.
 */
function ComposerMergeButton({
  workspaceId,
  api,
  disabled,
  settled = true,
  onWorkspaceDeleted,
  hideIcons,
}: {
  workspaceId: string;
  api: WorkspaceApi;
  disabled?: boolean;
  /** True once the owning agent is settled. Drives a status re-check (see below); not a commit gate. */
  settled?: boolean;
  onWorkspaceDeleted?: () => void | Promise<void>;
  /** Mobile mode: omit the decorative leading icon to save horizontal space. */
  hideIcons?: boolean;
}) {
  const [status, setStatus] = useState<GitStatus | null>(null);
  const [busyOp, setBusyOp] = useState<ComposerGitOption | null>(null);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const [mergedBranch, setMergedBranch] = useState<string | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [deleteError, setDeleteError] = useState("");

  const refresh = useCallback(async () => {
    try {
      setStatus(await api.gitStatus(workspaceId));
    } catch {
      // Non-Git workspaces (or transient failures): hide the button.
      setStatus(null);
    }
  }, [api, workspaceId]);

  useEffect(() => {
    setStatus(null);
    setConfirmOpen(false);
    setMenuOpen(false);
    setMergedBranch(null);
    setDeleteError("");
    void refresh();
  }, [refresh]);

  const refreshRef = useRef(refresh);
  refreshRef.current = refresh;
  // Commit is the only option when the tree is dirty but the branch is
  // otherwise up to date, so a stale clean snapshot hides this button
  // entirely. The `git-status-changed` invalidation can be missed, so also
  // re-check when the owning agent settles (run writes are on disk by
  // then). Skips the initial mount, which already fetches.
  const wasSettledRef = useRef(settled);
  useEffect(() => {
    const wasSettled = wasSettledRef.current;
    wasSettledRef.current = settled;
    if (settled && !wasSettled) void refreshRef.current();
  }, [settled]);
  useEffect(() => {
    let invalidateTimer: ReturnType<typeof setTimeout> | undefined;
    const subscription = subscribeWorkspace(
      workspaceId,
      (event) => {
        if (event.type !== "git-status-changed" && event.type !== "files-changed") return;
        if (invalidateTimer) clearTimeout(invalidateTimer);
        invalidateTimer = setTimeout(() => {
          invalidateTimer = undefined;
          void refreshRef.current();
        }, 750);
      },
      async () => {
        await refreshRef.current();
      },
    );
    return () => {
      if (invalidateTimer) clearTimeout(invalidateTimer);
      subscription.close();
    };
  }, [workspaceId]);

  const busy = busyOp !== null;

  const handleConfirmMerge = () => {
    if (busy) return;
    const branchRef = status?.branchRef ?? "branch";
    setConfirmOpen(false);
    setMenuOpen(false);
    setBusyOp("merge");
    void api.gitMergeIntoMain(workspaceId).then(
      (next) => {
        setStatus(next);
        setDeleteError("");
        setMergedBranch(next.branchRef ?? branchRef);
        toast.success(`Merged ${next.branchRef ?? branchRef} into main`);
      },
      (err: unknown) => {
        const message = friendlyApiError(err, "Could not merge into main. Resolve any conflicts and try again.");
        toast.error("Merge into main failed", { description: message });
      },
    ).finally(() => setBusyOp(null));
  };

  const handleRebase = () => {
    if (busy) return;
    const branchRef = status?.branchRef ?? "branch";
    setMenuOpen(false);
    setBusyOp("rebase");
    void api.gitRebaseOntoMain(workspaceId).then(
      (next) => {
        setStatus(next);
        toast.success(`Rebased ${next.branchRef ?? branchRef} onto main`);
      },
      (err: unknown) => {
        const message = friendlyApiError(err, "Could not rebase onto main. Resolve any conflicts and try again.");
        toast.error("Rebase onto main failed", { description: message });
      },
    ).finally(() => setBusyOp(null));
  };

  const handlePush = () => {
    if (busy) return;
    const branchRef = status?.branchRef ?? "branch";
    setMenuOpen(false);
    setBusyOp("push");
    void api.gitPush(workspaceId).then(
      (next) => {
        setStatus(next);
        toast.success(`Pushed ${next.branchRef ?? branchRef}`);
      },
      (err: unknown) => {
        const message = friendlyApiError(err, "Could not push the branch. Check the remote and try again.");
        toast.error("Push failed", { description: message });
      },
    ).finally(() => setBusyOp(null));
  };

  const handleCommitAuto = () => {
    if (busy) return;
    setMenuOpen(false);
    setBusyOp("commit");
    void api.gitCommitAuto(workspaceId).then(
      (result) => {
        setStatus(result.status);
        toast.success("Committed changes", { description: result.message });
      },
      (err: unknown) => {
        const message = friendlyApiError(err, "Could not commit changes. Try again.");
        toast.error("Commit failed", { description: message });
      },
    ).finally(() => setBusyOp(null));
  };

  const handleDeleteWorkspace = () => {
    if (mergedBranch === null || deleting) return;
    setDeleting(true);
    setDeleteError("");
    void api.removeWorktree(workspaceId).then(
      async () => {
        setDeleting(false);
        setMergedBranch(null);
        toast.success("Workspace deleted");
        await onWorkspaceDeleted?.();
      },
      (err: unknown) => {
        setDeleting(false);
        setDeleteError(friendlyApiError(err, "Could not delete the workspace. Remove it from workspace details."));
      },
    );
  };

  const options = resolveComposerGitOptions(status);
  if (options.length === 0 && mergedBranch === null) return null;
  const branchRef = status?.branchRef ?? mergedBranch ?? "branch";
  const ahead = status?.aheadOfMain ?? 0;
  const behindMain = status?.behindMain ?? 0;
  const aheadUpstream = status?.ahead ?? 0;

  const runOption = (option: ComposerGitOption) => {
    if (option === "commit") handleCommitAuto();
    else if (option === "merge") setConfirmOpen(true);
    else if (option === "rebase") handleRebase();
    else handlePush();
  };

  const dirtyCount = status?.files.length ?? 0;
  const optionMeta: Record<ComposerGitOption, { label: string; detail: string; title: string; Icon: typeof GitMerge }> = {
    commit: {
      label: "Commit",
      detail: `${dirtyCount} changed`,
      title: `Auto-commit ${dirtyCount} changed file${dirtyCount === 1 ? "" : "s"} (stage all + generate message)`,
      Icon: GitCommitHorizontal,
    },
    merge: {
      label: "Merge",
      detail: `${ahead} ahead`,
      title: `Merge ${branchRef} into main (${ahead} commit${ahead === 1 ? "" : "s"} ahead)`,
      Icon: GitMerge,
    },
    rebase: {
      label: "Rebase",
      detail: `${behindMain} behind main`,
      title: `Rebase ${branchRef} onto main (${behindMain} commit${behindMain === 1 ? "" : "s"} behind)`,
      Icon: ArrowDownUp,
    },
    push: {
      label: "Push",
      detail: `${aheadUpstream} ahead`,
      title: `Push ${branchRef} to remote (${aheadUpstream} commit${aheadUpstream === 1 ? "" : "s"} ahead)`,
      Icon: Upload,
    },
  };

  return (
    <>
      {options.length === 1 && options[0] !== undefined ? (() => {
        const only = options[0];
        const meta = optionMeta[only];
        const MetaIcon = meta.Icon;
        return (
          <Button
            variant="secondary"
            size="xs"
            className="composer-action-btn"
            onClick={() => runOption(only)}
            disabled={disabled || busy}
            title={meta.title}
            aria-label={meta.title}
          >
            {busy ? <Spinner className="size-3" /> : hideIcons ? null : <MetaIcon size={14} aria-hidden="true" />}
            {meta.label}
          </Button>
        );
      })() : options.length > 1 ? (
        <Popover open={menuOpen} onOpenChange={setMenuOpen}>
          <PopoverTrigger asChild>
            <Button
              variant="secondary"
              size="xs"
              className="composer-action-btn"
              disabled={disabled || busy}
              title={`Git options for ${branchRef}: ${options.map((o) => optionMeta[o].label).join(", ")}`}
              aria-label={`Git options for ${branchRef}`}
              aria-haspopup="menu"
              aria-expanded={menuOpen}
            >
              {busy ? <Spinner className="size-3" /> : <FolderGit2 size={14} aria-hidden="true" />}
            </Button>
          </PopoverTrigger>
          <PopoverContent className="thinking-popover w-56 max-w-[calc(100vw-2rem)] p-1" align="start" side="top" sideOffset={6}>
            <div className="popover-header-title px-2 py-1.5">Git options</div>
            <div role="menu" aria-label={`Git options for ${branchRef}`}>
              {options.map((option) => {
                const meta = optionMeta[option];
                const MetaIcon = meta.Icon;
                const isBusy = busyOp === option;
                return (
                  <div
                    key={option}
                    role="menuitem"
                    className="thinking-option-row"
                    title={meta.title}
                    aria-label={meta.title}
                    aria-disabled={busy}
                    tabIndex={busy ? -1 : 0}
                    onClick={() => { if (!busy) runOption(option); }}
                    onKeyDown={(e) => {
                      if ((e.key === "Enter" || e.key === " ") && !busy) {
                        e.preventDefault();
                        runOption(option);
                      }
                    }}
                  >
                    {isBusy ? <Spinner className="size-3" /> : <MetaIcon size={14} aria-hidden="true" />}
                    <span className="thinking-option-name">{meta.label}</span>
                    <span className="ml-auto text-xs text-muted-foreground">{meta.detail}</span>
                  </div>
                );
              })}
            </div>
          </PopoverContent>
        </Popover>
      ) : null}
      <AlertDialog open={confirmOpen} onOpenChange={setConfirmOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Merge into main?</AlertDialogTitle>
            <AlertDialogDescription>
              Merge <code className="font-mono">{branchRef}</code> ({ahead} commit{ahead === 1 ? "" : "s"} ahead)
              into <code className="font-mono">main</code>? The branch is rebased onto main, then main
              fast-forwards to it.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={handleConfirmMerge}>Merge into main</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
      <AlertDialog open={mergedBranch !== null} onOpenChange={(open) => { if (!open && !deleting) setMergedBranch(null); }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Merged into main</AlertDialogTitle>
            <AlertDialogDescription>
              <code className="font-mono">{mergedBranch}</code> was merged into main. Delete this workspace?
              The branch is kept; the worktree directory is removed.
            </AlertDialogDescription>
          </AlertDialogHeader>
          {deleteError && <Alert variant="destructive"><AlertDescription>{deleteError}</AlertDescription></Alert>}
          <AlertDialogFooter>
            <AlertDialogCancel disabled={deleting}>Keep workspace</AlertDialogCancel>
            <AlertDialogAction
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
              disabled={deleting}
              onClick={(event) => {
                event.preventDefault();
                handleDeleteWorkspace();
              }}
            >
              {deleting ? <Spinner className="size-3" /> : null}
              Delete workspace
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
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
  settings,
  hasMoreHistory,
  loadingMoreHistory,
  onLoadMoreHistory,
  streamActivityRef,
  onWorkspaceDeleted,
}: AgentPanelProps) {
  const effectiveHistory = previewHistory ?? history;
  // Distinct from `error` (a failed agent/history fetch): this is the agent
  // itself reporting a stopped/errored Pi process (e.g. it never booted, or
  // crashed mid-run). Nothing retries this automatically -- capabilities and
  // model info stay stuck ("model unavailable") until the user retries --
  // so it needs its own visible, actionable banner. `interrupted` is not a
  // Pi failure: Passage lost track of in-flight work (most commonly a
  // daemon restart), so it gets its own, non-blaming wording.
  const statusErrorMessage = agent.status === "error"
    ? "This agent hit an error and stopped responding. Retry to reconnect."
    : agent.status === "interrupted"
      ? "This agent's work was interrupted (for example, by a Passage restart) before it finished. Retry to continue."
      : "";
  const bannerMessage = error || statusErrorMessage;
  const [sessionExpansion, setSessionExpansion] = useState<TimelineExpansionSettings>(
    () => settings?.timelineExpansion ?? DEFAULT_TIMELINE_EXPANSION
  );
  const [sessionExpansionOverridden, setSessionExpansionOverridden] = useState(false);
  const [manualToggles, setManualToggles] = useState<Record<string, boolean>>({});

  useEffect(() => {
    if (!sessionExpansionOverridden) {
      setSessionExpansion(settings?.timelineExpansion ?? DEFAULT_TIMELINE_EXPANSION);
    }
  }, [settings?.timelineExpansion, sessionExpansionOverridden]);

  const handleUpdateSessionExpansion = (next: TimelineExpansionSettings) => {
    setSessionExpansion(next);
    setSessionExpansionOverridden(true);
  };

  const handleResetSessionExpansion = () => {
    setSessionExpansion(settings?.timelineExpansion ?? DEFAULT_TIMELINE_EXPANSION);
    setSessionExpansionOverridden(false);
    setManualToggles({});
  };

  const [busy, setBusy] = useState(false);
  const timelineRef = useRef<HTMLDivElement>(null);
  const running = agent.status === "running";
  const stopping = isComposerLocked(agent.status);
  const timeline = effectiveHistory?.timeline ?? [];
  const streamActive = resolveStreamActive(agent.status);
  const fallbackStreamActivityRef = useRef<StreamActivity>(emptyStreamActivity());
  const activityRef = streamActivityRef ?? fallbackStreamActivityRef;
  const streamingStartedAtRef = useRef<number | null>(null);
  const [streamPhase, setStreamPhase] = useState<StreamPhase | null>(null);
  const [receiving, setReceiving] = useState(false);
  const [elapsedSeconds, setElapsedSeconds] = useState(0);
  const [streamIdleSeconds, setStreamIdleSeconds] = useState<number | null>(null);
  const [streamBytes, setStreamBytes] = useState(0);

  // The interval is the pill's only render driver, so the elapsed timer keeps
  // advancing while Pi is silent (waiting for the first token after a prompt
  // or a long tool run). Frame activity lands in a ref, not state, so a frame
  // burst never triggers an extra render -- it is sampled here instead.
  useEffect(() => {
    if (!streamActive) {
      streamingStartedAtRef.current = null;
      setStreamPhase(null);
      setReceiving(false);
      setElapsedSeconds(0);
      setStreamIdleSeconds(null);
      setStreamBytes(0);
      return;
    }

    if (streamingStartedAtRef.current === null) {
      streamingStartedAtRef.current = Date.now();
      // Drop the previous run's final phase so a new run does not briefly show
      // it before its first content frame lands.
      activityRef.current = emptyStreamActivity();
    }
    const startedAt = resolveStreamStartMs(agent.runStartedAt, streamingStartedAtRef.current);
    const tick = () => {
      const now = Date.now();
      setElapsedSeconds(Math.max(0, (now - startedAt) / 1000));
      const activity = activityRef.current;
      setStreamPhase(activity.phase);
      setReceiving(activity.lastFrameAt > 0 && now - activity.lastFrameAt < RECEIVING_ACTIVITY_WINDOW_MS);
      setStreamBytes(activity.bytes);
      setStreamIdleSeconds(activity.lastFrameAt > 0 ? Math.max(0, (now - activity.lastFrameAt) / 1000) : null);
    };
    tick();
    const interval = setInterval(tick, STREAMING_STATS_INTERVAL_MS);
    return () => clearInterval(interval);
  }, [streamActive, agent.runStartedAt]);

  // Whether the viewport is following the live tail. A small upward motion
  // unpins it (UNPIN_SLACK_PX); scrolling back near the bottom re-pins it
  // (REPIN_SLACK_PX). Autoscroll never runs while a finger is down, so the
  // per-frame re-assert below can't fight an active touch drag -- the
  // scroll listener records the unpin during the gesture and the next
  // frame after touchend honors it. Row heights can
  // change many times a second while streaming (tool output growing,
  // expansion resolving) -- driving autoscroll off a single post-commit
  // effect let that outpace React and yanked the viewport around. Instead
  // this is re-asserted continuously (every frame while streaming, and
  // synchronously before paint on every other render), so it can only ever
  // sit exactly at the bottom or exactly where the user left it.
  const pinnedRef = useRef(true);
  // True while a touch gesture is active on the timeline. Autoscroll stays
  // parked for the whole gesture so it never fights the finger; the scroll
  // listener (which still runs) decides the post-gesture pin state.
  const userTouchingRef = useRef(false);
  // Finger Y + scroll offset at touchstart, so an upward drag unpins
  // immediately even before the scroll event catches up (iOS coalesces
  // scroll events during a drag).
  const touchStartRef = useRef<{ y: number; scrollTop: number } | null>(null);
  const scrollToBottomIfPinned = () => {
    const el = timelineRef.current;
    if (!el || !pinnedRef.current || userTouchingRef.current) return;
    el.scrollTop = el.scrollHeight;
  };
  const questionRequest = useMemo(
    () => resolveActiveQuestionRequest(agent),
    [agent]
  );
  const pinnedQuestionIdRef = useRef<string | null>(null);
  // Image drop zone: files dropped anywhere on the chat window attach to
  // the composer draft via the ref below. The depth counter balances the
  // bubbled dragenter/dragleave pairs from nested children so the overlay
  // only clears once the pointer truly leaves the panel.
  const attachFilesRef = useRef<((files: FileList | File[] | null) => void) | null>(null);
  const [dropActive, setDropActive] = useState(false);
  const dropDepthRef = useRef(0);

  const handlePanelDragEnter = (event: DragEvent) => {
    if (stopping || !hasFileDrag(event.dataTransfer.types)) return;
    event.preventDefault();
    dropDepthRef.current += 1;
    setDropActive(true);
  };
  const handlePanelDragOver = (event: DragEvent) => {
    if (stopping || !hasFileDrag(event.dataTransfer.types)) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = "copy";
  };
  const handlePanelDragLeave = (event: DragEvent) => {
    if (!hasFileDrag(event.dataTransfer.types)) return;
    event.preventDefault();
    dropDepthRef.current = Math.max(0, dropDepthRef.current - 1);
    if (dropDepthRef.current === 0) setDropActive(false);
  };
  const handlePanelDrop = (event: DragEvent) => {
    if (stopping || !hasFileDrag(event.dataTransfer.types)) return;
    event.preventDefault();
    dropDepthRef.current = 0;
    setDropActive(false);
    const files = event.dataTransfer.files;
    if (files && files.length > 0) attachFilesRef.current?.(files);
  };

  // Scrolling near the top backfills the previous page of history. Refs
  // (rather than effect deps) keep the mount-only scroll listener below
  // reading the latest values without re-subscribing on every change.
  const hasMoreHistoryRef = useRef(hasMoreHistory);
  hasMoreHistoryRef.current = hasMoreHistory;
  const loadingMoreHistoryRef = useRef(loadingMoreHistory);
  loadingMoreHistoryRef.current = loadingMoreHistory;
  const onLoadMoreHistoryRef = useRef(onLoadMoreHistory);
  onLoadMoreHistoryRef.current = onLoadMoreHistory;
  // Captured right before a backfill fetch starts so the resulting DOM
  // growth above the viewport can be compensated for once it renders,
  // instead of visually yanking the transcript the user is reading.
  const pendingScrollRestoreRef = useRef<{ scrollHeight: number; scrollTop: number } | null>(null);

  useEffect(() => {
    const el = timelineRef.current;
    if (!el) return;
    const onScroll = () => {
      pinnedRef.current = resolvePinned(el.scrollHeight - el.scrollTop - el.clientHeight, pinnedRef.current);
      if (hasMoreHistoryRef.current && !loadingMoreHistoryRef.current && el.scrollTop <= LOAD_MORE_HISTORY_SLACK_PX) {
        pendingScrollRestoreRef.current = { scrollHeight: el.scrollHeight, scrollTop: el.scrollTop };
        onLoadMoreHistoryRef.current?.();
      }
    };
    const onTouchStart = (event: TouchEvent) => {
      userTouchingRef.current = true;
      const touch = event.touches[0];
      touchStartRef.current = touch ? { y: touch.clientY, scrollTop: el.scrollTop } : null;
    };
    const onTouchMove = (event: TouchEvent) => {
      // Unpin on upward-drag intent right away instead of waiting for the
      // coalesced scroll event: a downward finger move (clientY grows) or
      // a scrollTop that already retreated past the unpin slack means the
      // user is reading earlier output.
      if (!pinnedRef.current) return;
      const start = touchStartRef.current;
      const touch = event.touches[0];
      if (touch && start && touch.clientY - start.y > 10) {
        pinnedRef.current = false;
        return;
      }
      if (start && start.scrollTop - el.scrollTop > UNPIN_SLACK_PX) {
        pinnedRef.current = false;
      }
    };
    const onTouchEnd = () => {
      userTouchingRef.current = false;
      touchStartRef.current = null;
    };
    el.addEventListener("scroll", onScroll, { passive: true });
    el.addEventListener("touchstart", onTouchStart, { passive: true });
    el.addEventListener("touchmove", onTouchMove, { passive: true });
    el.addEventListener("touchend", onTouchEnd, { passive: true });
    el.addEventListener("touchcancel", onTouchEnd, { passive: true });
    return () => {
      el.removeEventListener("scroll", onScroll);
      el.removeEventListener("touchstart", onTouchStart);
      el.removeEventListener("touchmove", onTouchMove);
      el.removeEventListener("touchend", onTouchEnd);
      el.removeEventListener("touchcancel", onTouchEnd);
    };
  }, []);

  useLayoutEffect(() => {
    const pending = pendingScrollRestoreRef.current;
    if (!pending) return;
    pendingScrollRestoreRef.current = null;
    const el = timelineRef.current;
    if (!el) return;
    el.scrollTop = pending.scrollTop + (el.scrollHeight - pending.scrollHeight);
  }, [timeline]);

  useEffect(() => {
    if (!streamActive) return;
    let frame: number;
    const tick = () => {
      scrollToBottomIfPinned();
      frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [streamActive]);

  // A question needing the user's response is always brought into view, even
  // when the user had scrolled away to read earlier output. Forcing the pin
  // here (before scrolling, and only when the question changes) means the card
  // is visible on the commit it mounts rather than one render later.
  useLayoutEffect(() => {
    const questionId = questionRequest?.id ?? null;
    if (questionId !== null && pinnedQuestionIdRef.current !== questionId) {
      pinnedQuestionIdRef.current = questionId;
      pinnedRef.current = true;
    }
    scrollToBottomIfPinned();
  });

  // Brand-new sessions have no persisted preference and no journaled model
  // yet; fall back to the live Pi defaults carried by capabilities (from
  // `get_state`) so the chip shows the real model instead of
  // "model unavailable" while the background boot settles. While
  // capabilities are still in flight, show a neutral loading label rather
  // than the error-looking unavailable fallback.
  const liveModel = effectiveHistory?.currentModel ?? capabilities?.currentModel;
  const liveThinkingLevel = effectiveHistory?.currentThinkingLevel ?? capabilities?.currentThinkingLevel;
  const model = liveModel
    ? `${liveModel.provider}/${liveModel.modelId}`
    : agent.modelPreference ?? (capabilities ? "model unavailable" : "loading\u2026");
  const thinking = resolveCurrentThinking(agent.thinkingPreference, liveThinkingLevel);
  const modelOptions = useMemo(
    () => capabilities?.models.filter((option) => option.authenticated) ?? [],
    [capabilities?.models]
  );
  const currentModel = useMemo(
    () => resolveCurrentModel(agent.modelPreference, liveModel, modelOptions),
    [agent.modelPreference, liveModel, modelOptions]
  );
  const currentModelDisplayName = currentModel?.name ?? (model.includes("/") ? model.split("/")[1] : model);

  const maxTokens = (currentModel && "contextWindow" in currentModel && typeof currentModel.contextWindow === "number")
    ? currentModel.contextWindow
    : 200_000;
  const contextTokens = effectiveHistory?.contextUsage?.tokens ?? null;
  const contextPct = contextTokens !== null && contextTokens > 0 ? Math.min(100, Math.max(1, Math.round((contextTokens / maxTokens) * 100))) : 0;
  const pieColor = contextPct >= 95 ? "var(--danger, #b91c1c)" : contextPct >= 80 ? "var(--warning, #b45309)" : "currentColor";
  const changeSummary = useMemo(() => summarizeChanges(effectiveHistory?.timeline ?? []), [effectiveHistory?.timeline]);
  const latestIds = useMemo(
    () => computeLatestTimelineIds(effectiveHistory?.timeline ?? []),
    [effectiveHistory?.timeline]
  );

  const visibleTimeline = useMemo(
    () => timelineWithoutBlockingTool(timeline, questionRequest !== null),
    [timeline, questionRequest]
  );



  const handleRespondUi = async (result: { id: string; value?: string; custom?: boolean; confirmed?: boolean; cancelled?: true }) => {
    try {
      await api.respondUi(agent.id, result);
      await onRefresh();
    } catch (err) {
      console.error("Failed to respond to UI prompt:", err);
    }
  };

  return (
    <section
      className={`agent-panel${dropActive ? " agent-panel-drop-active" : ""}`}
      aria-label={`Agent conversation ${agent.title}`}
      onDragEnter={handlePanelDragEnter}
      onDragOver={handlePanelDragOver}
      onDragLeave={handlePanelDragLeave}
      onDrop={handlePanelDrop}
    >
      {bannerMessage && (
        <div className="alert agent-alert" role="alert">
          <span>{bannerMessage}</span>
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
              {loadingMoreHistory && <p className="muted timeline-loading-more">Loading earlier messages…</p>}
              {visibleTimeline.map((item) => (
                <TimelineRow
                  key={item.id}
                  item={item}
                  agentId={agent.id}
                  api={api}
                  workspaceId={agent.workspaceId}
                  expansion={sessionExpansion}
                  latestIds={latestIds}
                  manualToggles={manualToggles}
                  onToggleManual={(id, open) => {
                    setManualToggles((prev) => ({ ...prev, [id]: open }));
                  }}
                />
              ))}
              {questionRequest && (
                <QuestionCard key={questionRequest.id} request={questionRequest} onRespond={handleRespondUi} />
              )}
            </>
          )}
      </div>

      <AgentComposer
        agentId={agent.id}
        workspaceId={agent.workspaceId}
        running={running}
        stopping={stopping}
        loading={loading}
        idle={agent.status === "idle"}
        streamActive={streamActive}
        streamPhase={streamPhase}
        receiving={receiving}
        elapsedSeconds={elapsedSeconds}
        streamIdleSeconds={streamIdleSeconds}
        streamBytes={streamBytes}
        capabilities={capabilities}
        api={api}
        busy={busy}
        setBusy={setBusy}
        onRefresh={onRefresh}
        onModelChanged={onModelChanged}
        onOptimisticMessage={(message, images, files) => {
          // A user sending a new message always wants to see it, even if they
          // had scrolled up to read earlier output.
          pinnedRef.current = true;
          onOptimisticMessage?.(message, images, files);
        }}
        currentModel={currentModel}
        currentModelDisplayName={currentModelDisplayName}
        thinking={thinking}
        contextTokens={contextTokens}
        maxTokens={maxTokens}
        contextPct={contextPct}
        pieColor={pieColor}
        usage={effectiveHistory?.usage}
        changeSummary={changeSummary}
        sessionExpansion={sessionExpansion}
        onSessionExpansionChange={handleUpdateSessionExpansion}
        onResetSessionExpansion={handleResetSessionExpansion}
        isExpansionOverridden={sessionExpansionOverridden}
        onWorkspaceDeleted={onWorkspaceDeleted}
        attachFilesRef={attachFilesRef}
      />
      {dropActive && (
        <div className="agent-drop-overlay" aria-hidden="true">
          <span className="agent-drop-overlay-label">Drop files to attach</span>
        </div>
      )}
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

export function formatIdleSinceLastFrame(idleSeconds: number | null): string {
  if (idleSeconds == null || !Number.isFinite(idleSeconds) || idleSeconds < 0) return "\u2014";
  if (idleSeconds < 60) return `${idleSeconds.toFixed(1)}s`;
  return formatDuration(idleSeconds);
}

/** Latest full-line bold heading (e.g. `**Thinking Summary 2**`) in thinking
 *  text, if any. Models that structure thinking with bold summary lines get a
 *  live status in the collapsed row: as new summaries stream in, the preview
 *  follows the most recent one instead of showing the start of the text.
 *  Lines with inline bold mid-sentence do not count -- the whole trimmed line
 *  must be a single bold span. A missing closing marker is tolerated so a
 *  summary still shows while it is streaming in. */
export function extractLatestThinkingSummary(text: string): string | undefined {
  let latest: string | undefined;
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (!line) continue;
    for (const marker of ["**", "__"]) {
      if (!line.startsWith(marker)) continue;
      let inner = line.slice(marker.length);
      if (inner.endsWith(marker)) inner = inner.slice(0, -marker.length);
      // Inline bold elsewhere on the line means this is prose, not a heading.
      if (!inner || inner.includes(marker)) break;
      const cleaned = inner.replace(/`([^`]+)`/g, "$1").replace(/\s+/g, " ").trim();
      if (cleaned) latest = cleaned;
      break;
    }
  }
  return latest;
}

export function formatThinkingPreview(text: string, maxLength = 70): string {
  const summary = extractLatestThinkingSummary(text);
  if (summary) return summary.slice(0, maxLength);
  return text
    .replace(/^(?:#{1,6}\s+|[-*+]\s+|\d+[.)]\s+)/gm, "")
    .replace(/(\*\*|__|~~)(?=\S)([\s\S]*?\S)\1/g, "$2")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, maxLength);
}

const STREAM_PHASE_ICONS = {
  thinking: Brain,
  responding: MessageSquareMore,
  "composing-tool-call": FilePenLine,
  "running-tool": Wrench,
  "receiving-tool-result": PencilSparkles,
} as const satisfies Record<StreamPhase, typeof Brain>;

const LiveStreamPhase = memo(function LiveStreamPhase({
  phase,
  receiving,
}: {
  phase: StreamPhase | null;
  receiving: boolean;
}) {
  if (!phase) return <span className="live-stream-phase" aria-hidden="true" />;
  const Icon = STREAM_PHASE_ICONS[phase];
  const label = STREAM_PHASE_LABELS[phase];
  return (
    <span
      className={`live-stream-phase${receiving ? " is-receiving" : ""}`}
      title={label}
      role="img"
      aria-label={label}
    >
      <Icon size={11} aria-hidden="true" />
    </span>
  );
});

const LiveStreamTraffic = memo(function LiveStreamTraffic({
  bytes,
  idleSeconds,
}: {
  bytes: number;
  idleSeconds: number | null;
}) {
  const idleText = formatIdleSinceLastFrame(idleSeconds);
  const title =
    idleSeconds == null
      ? `${bytes.toLocaleString()} bytes this run (live wire traffic), waiting for first frame`
      : `${bytes.toLocaleString()} bytes this run (live wire traffic), last frame ${idleText} ago`;
  return (
    <span className="composer-status-traffic" aria-hidden="true" title={title}>
      <span aria-hidden="true">·</span>
      <span className="composer-status-bytes">{formatByteCount(bytes)}</span>
      <span aria-hidden="true">·</span>
      <span className="composer-status-idle">
        <RotateCwFadingClock size={11} aria-hidden="true" />
        <span className="composer-status-idle-text">{idleText}</span>
      </span>
    </span>
  );
});

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
  /** Receives the composer's file-attach function so panel-level drops can attach. */
  attachFilesRef?: { current: ((files: FileList | File[] | null) => void) | null };
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

/** Render backticked `@`path`` refs as inline file chips and `/skill:name`
 *  refs as skill chips (graduation cap) at display time. */
export function renderFileRefs(text: string): ReactNode[] {
  const nodes: ReactNode[] = [];
  let key = 0;
  const pushText = (part: string) => {
    for (const segment of splitSkillRefs(part)) {
      if (typeof segment === "string") {
        nodes.push(segment);
      } else {
        nodes.push(
          <span key={`skill-ref-${key++}`} className="skill-ref-chip" title={segment.skill}>
            <GraduationCap size={12} />
            <code className="skill-ref-name">{segment.skill}</code>
          </span>,
        );
      }
    }
  };
  let last = 0;
  let match: RegExpExecArray | null;
  FILE_REF_PATTERN.lastIndex = 0;
  while ((match = FILE_REF_PATTERN.exec(text)) !== null) {
    if (match.index > last) pushText(text.slice(last, match.index));
    const refPath = match[1]!;
    nodes.push(
      <span key={`file-ref-${key++}`} className="file-ref-chip" title={refPath}>
        <FileTypeIcon path={refPath} size={12} />
        <code className="file-ref-path">{truncateFileRefPath(refPath)}</code>
      </span>,
    );
    last = match.index + match[0].length;
  }
  if (last < text.length) pushText(text.slice(last));
  if (nodes.length === 0) nodes.push(text);
  return nodes;
}

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
    const finalMessage = value || (images.length > 0 ? "Attached image" : uploadFiles.length > 0 ? `Attached file: ${uploadFiles.map((file) => file.name).join(", ")}` : "");
    const payloadImages: AgentImage[] = images.map(({ type, data, mimeType, name }) => ({
      type,
      data,
      mimeType,
      name,
    }));
    const payloadFiles: AgentFile[] = uploadFiles.map(({ type, data, mimeType, name }) => ({
      type,
      data,
      mimeType,
      name,
    }));
    // Instant pre-echo: the daemon hasn't hashed/cached these yet, so the
    // optimistic row carries data URLs and no hashes; the real row_upsert
    // (with cache refs) replaces this row when it arrives. File paths are
    // unknown until the daemon writes them, so the pre-echo uses the plain
    // filename as a placeholder path.
    const optimisticImages: UserImageRef[] = images.map(({ mimeType, name, data }) => ({
      hash: "",
      mimeType,
      name,
      previewUrl: `data:${mimeType};base64,${data}`,
    }));
    const optimisticFiles: UserFileRef[] = uploadFiles.map(({ name, mimeType, data }) => ({
      hash: "",
      name,
      path: name,
      size: Math.floor((data.length * 3) / 4),
      mimeType,
    }));
    onOptimisticMessage?.(
      finalMessage,
      optimisticImages.length > 0 ? optimisticImages : undefined,
      optimisticFiles.length > 0 ? optimisticFiles : undefined,
    );
    void run(
      async () => {
        await api[kind](
          agentId,
          finalMessage,
          payloadImages.length > 0 ? payloadImages : undefined,
          payloadFiles.length > 0 ? payloadFiles : undefined,
        );
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
    const label = value || (images.length > 0 ? "Attached image" : `Attached file: ${uploadFiles.map((file) => file.name).join(", ")}`);
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
        const payloadImages: AgentImage[] = item.images.map(({ type, data, mimeType, name }) => ({
          type,
          data,
          mimeType,
          name,
        }));
        const optimisticImages: UserImageRef[] = item.images.map(({ mimeType, name, data }) => ({
          hash: "",
          mimeType,
          name,
          previewUrl: `data:${mimeType};base64,${data}`,
        }));
        const payloadFiles: AgentFile[] = item.files.map(({ type, data, mimeType, name }) => ({
          type,
          data,
          mimeType,
          name,
        }));
        const optimisticFiles: UserFileRef[] = item.files.map(({ name, mimeType, data }) => ({
          hash: "",
          name,
          path: name,
          size: Math.floor((data.length * 3) / 4),
          mimeType,
        }));
        onOptimisticMessage?.(
          item.text,
          optimisticImages.length > 0 ? optimisticImages : undefined,
          optimisticFiles.length > 0 ? optimisticFiles : undefined,
        );
        try {
          const imagesArg = payloadImages.length > 0 ? payloadImages : undefined;
          const filesArg = payloadFiles.length > 0 ? payloadFiles : undefined;
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
            <ComposerMergeButton workspaceId={workspaceId} api={api} disabled={busy || stopping} settled={!running && !stopping} onWorkspaceDeleted={onWorkspaceDeleted} hideIcons={isMobileComposer} />
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

const AgentComposer = memo(AgentComposerInner);

function summarizeChanges(timeline: TimelineItem[]): { fileCount: number; additions: number; deletions: number } | undefined {
  const files = new Set<string>();
  let additions = 0;
  let deletions = 0;
  const activities = timeline.filter((item): item is ToolActivity => item.kind === "tool");
  for (const activity of activities) {
    const diff = getToolDiff(activity);
    if (!diff || !diff.path || (diff.additions === 0 && diff.deletions === 0)) continue;
    files.add(diff.path);
    additions += diff.additions;
    deletions += diff.deletions;
  }
  return files.size > 0 ? { fileCount: files.size, additions, deletions } : undefined;
}

export interface TimelineRowProps {
  item: TimelineItem;
  agentId: string;
  api: WorkspaceApi;
  workspaceId?: string;
  expansion?: TimelineExpansionSettings;
  latestIds?: LatestTimelineIds;
  manualToggles?: Record<string, boolean>;
  onToggleManual?: (id: string, open: boolean) => void;
}

export const TimelineRow = memo(function TimelineRow({
  item,
  agentId,
  api,
  workspaceId,
  expansion = DEFAULT_TIMELINE_EXPANSION,
  latestIds = { latestToolIds: {} },
  manualToggles = {},
  onToggleManual,
}: TimelineRowProps) {
  if (item.kind === "unknown") return <article className="timeline-row unknown"><strong>Unknown activity</strong><code>{item.entryType}</code></article>;
  if (item.kind === "tool") {
    const isExpanded = isItemExpanded(item, expansion, latestIds, manualToggles);
    return (
      <ToolRow
        item={item}
        open={isExpanded}
        onOpenChange={(open) => onToggleManual?.(item.id, open)}
        workspaceId={workspaceId}
        api={api}
      />
    );
  }
  if (item.kind === "thinking") {
    const isExpanded = isItemExpanded(item, expansion, latestIds, manualToggles);
    const preview = formatThinkingPreview(item.text);
    return (
      <details
        className="thinking-row"
        open={isExpanded}
        onToggle={(e) => onToggleManual?.(item.id, e.currentTarget.open)}
      >
        <summary className="thinking-summary">
          <span className="thinking-icon">⚙</span>
          <span className="thinking-label">Thinking</span>
          {!isExpanded && <span className="thinking-preview">{preview}…</span>}
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
    if (item.summaryType === "branch") {
      return (
        <article className="timeline-row summary">
          <strong>Branch summary</strong>
          <p>{item.text}</p>
        </article>
      );
    }
    const label = item.compactionReason === "manual"
      ? "Context manually compacted"
      : item.compactionReason === "auto"
        ? "Context auto-compacted"
        : "Context compacted";
    return (
      <article className="timeline-row compaction-divider" aria-label={label}>
        <div className="compaction-divider-rule">
          <span className="compaction-divider-line" aria-hidden="true" />
          <span className="compaction-divider-label">
            <Scissors size={13} aria-hidden="true" />
            <span>{label}</span>
          </span>
          <span className="compaction-divider-line" aria-hidden="true" />
        </div>
        {item.tokensBefore !== undefined && (
          <p className="compaction-divider-subtext">Compacted from {item.tokensBefore.toLocaleString("en-US")} tokens</p>
        )}
        {item.text && (
          <details className="compaction-divider-details">
            <summary>Show summary</summary>
            <p>{item.text}</p>
          </details>
        )}
      </article>
    );
  }
  if (item.kind === "error") {
    return (
      <Alert variant="destructive" className="assistant-error-alert px-3 py-2 border-destructive/40 bg-destructive/5">
        <CircleAlert aria-hidden="true" />
        <AlertTitle>Agent error</AlertTitle>
        <AlertDescription>{item.text}</AlertDescription>
      </Alert>
    );
  }
  if (item.kind === "user") {
    return (
      <div className="user-message-container">
        <div className="user-message-card">
          <p>{renderFileRefs(item.text)}</p>
          {item.images && item.images.length > 0 && (
            <UserImageStrip agentId={agentId} api={api} images={item.images} />
          )}
          {item.files && item.files.length > 0 && (
            <UserFileStrip agentId={agentId} api={api} files={item.files} />
          )}
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
