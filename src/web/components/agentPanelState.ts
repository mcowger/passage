import type {
  AgentCapabilities,
  AgentHistory,
  AgentSummary,
  TimelineItem,
} from "../../shared/domain/agents.ts";
import type { AgentFile, AgentImage } from "../../shared/protocol/agents.ts";
import type { GitStatus, GithubStatus } from "../../shared/domain/git.ts";
import type { QuestionOption, QuestionRequest } from "./QuestionCard.tsx";

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

/**
 * Ship-It gate: true only when the workspace is dirty (uncommitted changes
 * present) and committable (not conflicted). This is the sole enablement
 * rule for the composer's Ship-It action.
 */
export function isComposerShipItEnabled(status: GitStatus | null | undefined): boolean {
  if (!status) return false;
  if (status.conflicted) return false;
  return status.dirty || status.files.length > 0;
}

/** @deprecated Use isComposerShipItEnabled. Kept for existing importers. */
export const isComposerSendItEnabled = isComposerShipItEnabled;

/**
 * True when a ship-it run should attempt the merge step after committing:
 * a non-main branch with a branchRef (the same branches the standalone
 * merge/rebase options serve). On main or a detached HEAD, ship-it stops
 * after the auto-commit.
 */
export function isComposerShipItMergeable(status: GitStatus | null | undefined): boolean {
  if (!status?.branchRef) return false;
  const isMainWorktree = status.checkoutRoot === status.mainCheckoutRoot || status.branchRef === "main";
  return !isMainWorktree;
}

/** @deprecated Use isComposerShipItMergeable. Kept for existing importers. */
export const isComposerSendItMergeable = isComposerShipItMergeable;

/**
 * True when the workspace itself can be offered for deletion (a separate
 * worktree checkout, not the main checkout). Mirrors the daemon guard that
 * refuses to remove the main checkout: only prompt when the checkout root
 * differs from a known main checkout root.
 */
export function isWorkspaceDeletable(status: GitStatus | null | undefined): boolean {
  if (!status?.mainCheckoutRoot) return false;
  return status.checkoutRoot !== status.mainCheckoutRoot;
}

/** Ordered steps for Ship It to a PR: commit when dirty, then (on a branch)
 *  rebase onto the remote and push before the PR dialog opens. PR creation
 *  itself re-pushes as a safety net, but the explicit steps surface
 *  commit/rebase/push failures before the dialog. Pure for testing. */
export type ShipPrStep = "commit" | "rebase" | "push";

export function shipPrSteps(dirty: boolean, mergeable: boolean): ShipPrStep[] {
  const steps: ShipPrStep[] = [];
  if (dirty) steps.push("commit");
  if (mergeable) steps.push("rebase", "push");
  return steps;
}

/** Decision state for the composer Git menu's GitHub section. Pure for
 *  testing: the menu itself renders in a Radix portal, which happy-dom
 *  cannot mount, so this is unit-tested instead of interaction-tested. */
export type GithubMenuState =
  | { kind: "loading" }
  | { kind: "unavailable" }
  | { kind: "not-installed" }
  | { kind: "not-authenticated" }
  | { kind: "create" }
  | { kind: "view"; pr: NonNullable<GithubStatus["pr"]> };

export function resolveGithubMenuState(gh: GithubStatus | null | undefined, loading: boolean): GithubMenuState {
  if (loading) return { kind: "loading" };
  if (!gh) return { kind: "unavailable" };
  if (!gh.installed) return { kind: "not-installed" };
  if (!gh.available) return { kind: "not-authenticated" };
  if (gh.pr) return { kind: "view", pr: gh.pr };
  return { kind: "create" };
}

/** Pending "delete this workspace?" prompt after a merge or a Ship It.
 * commitMessage lets the user review what was committed before deciding. */
export type DeleteWorkspacePrompt = { branch: string; merged: boolean; commitMessage?: string };

export type ComposerGitOption = "commit" | "merge" | "rebase" | "push";

/**
 * Smart Git options for the single composer Git menu:
 * - Commit: the workspace is dirty (uncommitted changes present).
 * - Merge: the branch is ahead of main (labelled "Merge locally...").
 * - Rebase: main has moved since the branch was cut (branch is behind main).
 * - Push: the branch has commits the remote lacks. Push and publish are
 *   one action: a missing upstream is set up on first push, so this is
 *   also offered when the branch is ahead of main but has no upstream yet.
 * Commit is offered on any branch (including main) whenever the tree is
 * dirty; merge/rebase/push stay gated on non-main branches with a branchRef.
 * Fetch is always available in the menu itself, so it is not part of this list.
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
  if ((status.hasUpstream && status.ahead > 0) || (!status.hasUpstream && status.aheadOfMain > 0)) options.push("push");
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
