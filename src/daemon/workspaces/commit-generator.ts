import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { renderCommitPrompt } from "../../shared/domain/settings.ts";
import type { TimelineItem } from "../../shared/domain/agents.ts";
import type { GitDiff } from "../../shared/domain/git.ts";
import { PiRpcManager, type PiEvent, type PiProcessHandle, type PiRpcOptions } from "../agents/rpc/index.ts";

/** Max diff characters forwarded to the commit-message model. */
export const MAX_COMMIT_DIFF_CHARS = 100000;
/** Max changed-file list characters forwarded to the model. */
export const MAX_COMMIT_FILES_CHARS = 4000;
/** Max user-message excerpt characters forwarded to the model. */
export const MAX_COMMIT_USER_MESSAGES_CHARS = 8000;
/** Max final-assistant-message excerpt characters forwarded to the model. */
export const MAX_COMMIT_FINAL_ASSISTANT_CHARS = 4000;
/** Max user messages included (oldest first, chronological). */
export const MAX_COMMIT_USER_MESSAGE_COUNT = 20;
/** Max final assistant messages included (most recent last). */
export const MAX_COMMIT_FINAL_ASSISTANT_COUNT = 3;
/** Per-message character cap before the overall truncation applies. */
export const MAX_COMMIT_CONVERSATION_MESSAGE_CHARS = 2000;
/** Display cap for a generated subject line (git convention ~72). */
export const MAX_COMMIT_SUBJECT_CHARS = 72;
/** Hard cap for the full generated message (subject + body). */
export const MAX_COMMIT_MESSAGE_CHARS = 1000;

type CommitGeneratorPiOptions = Pick<PiRpcOptions, "executable" | "executableArgs">;

export type CommitConversation = {
  /** Plain-text user requests/coaching, oldest first. */
  userMessages?: string;
  /** Plain-text final agent replies (wrap-ups), most recent last. */
  finalAssistantMessages?: string;
};

export function buildCommitPrompt(files: string, diff: string, template = "", conversation: CommitConversation = {}): string {
  return renderCommitPrompt(
    template,
    files,
    diff,
    truncateCommitConversation(conversation.userMessages ?? "", MAX_COMMIT_USER_MESSAGES_CHARS),
    truncateCommitConversation(conversation.finalAssistantMessages ?? "", MAX_COMMIT_FINAL_ASSISTANT_CHARS),
  );
}

/** Truncate a pre-formatted conversation excerpt for the commit prompt. */
export function truncateCommitConversation(text: string, maxChars: number): string {
  const clean = text.trim();
  if (!clean) return "(none)";
  return clean.length > maxChars
    ? `${clean.slice(0, maxChars).trimEnd()}\n…(truncated)`
    : clean;
}

/** Format raw message texts as a numbered excerpt block, or `(none)`. */
export function formatConversationMessages(messages: string[]): string {
  const clean = messages.map((m) => m.trim()).filter(Boolean);
  if (clean.length === 0) return "(none)";
  return clean.map((m, i) => `Message ${i + 1}: "${m}"`).join("\n");
}

/** Extract plain-text conversation context from a timeline for the commit
 *  prompt. Only `user` rows feed `userMessages` and only `assistant` rows
 *  feed `finalAssistantMessages` (most recent last, capped). `thinking`
 *  (reasoning), `tool`, `summary`, `error`, and `unknown` rows are excluded,
 *  and image/file attachments are never included: only each row's `text`
 *  field is read, never its `images`/`files` refs. */
export function extractCommitConversation(
  timeline: TimelineItem[],
  options: { maxUserMessages?: number; maxFinalAssistant?: number; maxMessageChars?: number } = {},
): { userMessages: string[]; finalAssistantMessages: string[] } {
  const maxUser = options.maxUserMessages ?? MAX_COMMIT_USER_MESSAGE_COUNT;
  const maxAssistant = options.maxFinalAssistant ?? MAX_COMMIT_FINAL_ASSISTANT_COUNT;
  const maxChars = options.maxMessageChars ?? MAX_COMMIT_CONVERSATION_MESSAGE_CHARS;
  const users: string[] = [];
  const assistants: string[] = [];
  for (const row of timeline) {
    if (row.kind === "user") {
      const text = row.text.trim();
      if (text) users.push(text.slice(0, maxChars).trim());
    } else if (row.kind === "assistant") {
      const text = row.text.trim();
      if (text) assistants.push(text.slice(0, maxChars).trim());
    }
  }
  return {
    userMessages: users.slice(-maxUser),
    finalAssistantMessages: assistants.slice(-maxAssistant),
  };
}

/** Format a changed-file list for the commit prompt. */
export function formatChangedFiles(files: Array<{ path: string; kind: string }>): string {
  if (files.length === 0) return "(no changes)";
  const lines = files.map((f) => `- ${f.path} (${f.kind})`);
  const joined = lines.join("\n");
  return joined.length > MAX_COMMIT_FILES_CHARS
    ? `${joined.slice(0, MAX_COMMIT_FILES_CHARS).trimEnd()}\n…(truncated)`
    : joined;
}

/** Truncate an overall diff for the commit prompt. */
export function truncateCommitDiff(diff: string): string {
  const clean = diff.trim();
  if (!clean) return "(no textual diff)";
  return clean.length > MAX_COMMIT_DIFF_CHARS
    ? `${clean.slice(0, MAX_COMMIT_DIFF_CHARS).trimEnd()}\n…(diff truncated)`
    : clean;
}

/** Normalizes raw model output to a committable message, or null when it
 *  carries nothing usable (so the caller can fall back). Strips code
 *  fences, surrounding quotes, and enforces length caps. */
export function sanitizeCommitMessage(raw: string | null | undefined): string | null {
  if (!raw) return null;
  let message = raw.trim();
  // Strip fenced code blocks if the model added them anyway.
  const fence = message.match(/```(?:\w+)?\n([\s\S]*?)```/);
  if (fence) message = fence[1].trim();
  message = message.replace(/^["'“”‘’]+/, "").replace(/["'“”‘’]+$/, "").trim();
  message = message.replace(/\s+$/g, "").trim();
  if (!message) return null;
  const lines = message.split("\n");
  // Enforce a 72-char subject line; keep an optional body.
  if (lines[0].length > MAX_COMMIT_SUBJECT_CHARS) {
    const cut = lines[0].slice(0, MAX_COMMIT_SUBJECT_CHARS);
    const boundary = cut.lastIndexOf(" ");
    lines[0] = (boundary > 24 ? cut.slice(0, boundary) : cut).trim();
  }
  message = lines.join("\n").trim();
  if (message.length > MAX_COMMIT_MESSAGE_CHARS) {
    message = message.slice(0, MAX_COMMIT_MESSAGE_CHARS).trimEnd();
  }
  if (!message) return null;
  return message;
}

/** Serialize structured diffs into compact text for the commit prompt.
 *  Binary/oversized entries become one-line markers so the model still
 *  sees which files changed beyond text. */
export function serializeDiffsForPrompt(diffs: GitDiff[]): string {
  const parts: string[] = [];
  for (const diff of diffs) {
    if (!diff.path) continue;
    const name = diff.oldPath && diff.oldPath !== diff.path ? `${diff.oldPath} -> ${diff.path}` : diff.path;
    if (diff.binary) {
      parts.push(`Binary file: ${name}`);
      continue;
    }
    if (diff.oversized) {
      parts.push(`Oversized diff omitted: ${name}`);
      continue;
    }
    if (diff.hunks.length === 0) {
      parts.push(`No text differences: ${name}`);
      continue;
    }
    const hunks = diff.hunks.map((hunk) => {
      const lines = hunk.lines.map((line) => `${line.kind === "added" ? "+" : line.kind === "removed" ? "-" : " "}${line.text}`).join("\n");
      return `@@ ${name} @@\n${lines}`;
    });
    parts.push(hunks.join("\n"));
  }
  return parts.join("\n");
}

/** Max raw diff characters forwarded for a PR description (branch diffs
 *  run larger than working-tree diffs). */
export const MAX_PR_DIFF_CHARS = 100000;
/** Hard cap for a generated PR body. */
export const MAX_PR_BODY_CHARS = 6000;

export type PrSuggestion = { title: string; body: string };

/** Deterministic PR body when the model is unavailable: changed files plus
 *  an honest testing section (never invent test runs). */
export function fallbackPrBody(files: Array<{ path: string; kind: string }>, base: string): string {
  const lines = files.length === 0
    ? ["- (no committed changes found)"]
    : files.slice(0, 30).map((f) => `- ${f.path} (${f.kind})`);
  if (files.length > 30) lines.push(`- …and ${files.length - 30} more`);
  return [`## Summary`, ``, `Changes on this branch vs \`${base}\`.`, ``, `## Changes`, ``, ...lines, ``, `## Testing`, ``, `Not run.`, ``].join("\n");
}

/** Split raw model output into a title (first line, <=72 chars) and body.
 *  Returns null when nothing usable is present. */
export function parsePrSuggestion(raw: string | null | undefined): PrSuggestion | null {
  if (!raw) return null;
  let text = raw.trim();
  const fence = text.match(/```(?:\w+)?\n([\s\S]*?)```/);
  if (fence) text = fence[1].trim();
  const lines = text.split("\n").map((l) => l.trim());
  while (lines.length > 0 && !lines[0]) lines.shift();
  if (lines.length === 0) return null;
  let title = (lines.shift() ?? "").replace(/^["'“”‘’#\-\*\s]+/, "").replace(/["'“”‘’\s]+$/, "").trim();
  if (!title) return null;
  if (title.length > MAX_COMMIT_SUBJECT_CHARS) {
    const cut = title.slice(0, MAX_COMMIT_SUBJECT_CHARS);
    const boundary = cut.lastIndexOf(" ");
    title = (boundary > 24 ? cut.slice(0, boundary) : cut).trim();
  }
  let body = lines.join("\n").replace(/^\s*(?:---+|___+)\s*\n/, "").trim();
  // Drop a repeated title heading if the model echoed it.
  if (body.startsWith("#")) {
    const [heading, ...rest] = body.split("\n");
    if (heading.replace(/^#+\s*/, "").trim() === title) body = rest.join("\n").trim();
  }
  if (body.length > MAX_PR_BODY_CHARS) body = body.slice(0, MAX_PR_BODY_CHARS).trimEnd();
  return { title, body };
}

/** Deterministic fallback when the model is unavailable: a subject line
 *  derived from the changed file list. */
export function fallbackCommitMessage(files: Array<{ path: string; kind: string }>): string {
  if (files.length === 0) return "Update files";
  const names = files.slice(0, 3).map((f) => f.path.split("/").pop() ?? f.path);
  const kinds = new Set(files.map((f) => f.kind));
  let verb = "Update";
  if (kinds.size === 1) {
    if (kinds.has("added") || kinds.has("untracked")) verb = "Add";
    else if (kinds.has("deleted")) verb = "Remove";
  }
  const subject = `${verb} ${names.join(", ")}${files.length > 3 ? ` and ${files.length - 3} more` : ""}`;
  return subject.length > MAX_COMMIT_SUBJECT_CHARS
    ? `${subject.slice(0, MAX_COMMIT_SUBJECT_CHARS - 1).trim()}…`
    : subject;
}

export class CommitGenerator {
  private readonly manager = new PiRpcManager(1);

  constructor(private readonly timeoutMs = 30_000, private readonly pi: CommitGeneratorPiOptions = {}) {}

  /** Best-effort PR title + body for a branch diff vs a base. Never throws:
   *  returns null when the model is unavailable, times out, or answers with
   *  nothing usable (the caller falls back to a template). */
  async suggestPullRequest(
    files: Array<{ path: string; kind: string }>,
    diff: string,
    base: string,
    branch: string,
    cwd?: string,
    model?: string,
    thinkingLevel?: string,
    conversation: CommitConversation = {},
  ): Promise<PrSuggestion | null> {
    if (files.length === 0) return null;
    const prompt = [
      `Write a GitHub pull request for branch "${branch}" into "${base}".`,
      `First line: the PR title only (imperative, max 72 characters).`,
      `Then a blank line, then the markdown body with exactly these sections:`,
      `## Summary`,
      `## Changes`,
      `## Testing`,
      `Under Testing, write "Not run." unless the diff or conversation shows evidence tests ran.`,
      `Describe the diff; do not paste the conversation. No code fences around the answer.`,
      ``,
      `Files changed:`,
      formatChangedFiles(files),
      ``,
      `Diff (truncated):`,
      diff.trim() ? diff.slice(0, MAX_PR_DIFF_CHARS).trimEnd() : "(no textual diff)",
      ``,
      `User requests (context):`,
      truncateCommitConversation(conversation.userMessages ?? "", MAX_COMMIT_USER_MESSAGES_CHARS),
      ``,
      `Final agent summaries (context):`,
      truncateCommitConversation(conversation.finalAssistantMessages ?? "", MAX_COMMIT_FINAL_ASSISTANT_CHARS),
    ].join("\n");
    const response = await this.generate(prompt, cwd, model, thinkingLevel, "passage-pr-description-");
    return parsePrSuggestion(response);
  }

  /** Best-effort commit message for the given changed files + diff. Never
   *  throws: returns null when the model is unavailable, times out, or
   *  answers with nothing usable (the caller falls back). */
  async suggestCommit(
    files: Array<{ path: string; kind: string }>,
    diff: string,
    cwd?: string,
    model?: string,
    thinkingLevel?: string,
    promptTemplate = "",
    conversation: CommitConversation = {},
  ): Promise<string | null> {
    if (files.length === 0) return null;
    const prompt = buildCommitPrompt(
      formatChangedFiles(files),
      truncateCommitDiff(diff),
      promptTemplate,
      conversation,
    );
    // Best-effort: an unsupported level must never fail the commit --
    // the caller falls back to a deterministic message.
    const response = await this.generate(prompt, cwd, model, thinkingLevel, "passage-commit-message-");
    return sanitizeCommitMessage(response);
  }

  /** Run one tools-disabled Pi prompt and return the raw text. Never throws:
   *  failures resolve to null so callers can fall back. */
  private async generate(prompt: string, cwd?: string, model?: string, thinkingLevel?: string, tag = "passage-generate-"): Promise<string | null> {
    let sessionDir: string | undefined;
    let agentId: string | undefined;
    try {
      sessionDir = await mkdtemp(join(tmpdir(), tag));
      agentId = `${tag}${crypto.randomUUID()}`;
      const piProcess = await this.manager.start(agentId, {
        cwd: cwd?.trim() || process.cwd(),
        sessionDir,
        sessionId: `${tag}${crypto.randomUUID()}`,
        model: model?.trim() || undefined,
        disableTools: true,
        ...this.pi,
      });
      if (thinkingLevel?.trim()) {
        await piProcess.request({ type: "set_thinking_level", level: thinkingLevel.trim() }, this.timeoutMs).catch(() => undefined);
      }
      return await this.readMessage(piProcess, prompt);
    } catch {
      return null;
    } finally {
      if (agentId) await this.manager.stop(agentId).catch(() => undefined);
      if (sessionDir) await rm(sessionDir, { recursive: true, force: true }).catch(() => undefined);
    }
  }

  private async readMessage(process: PiProcessHandle, prompt: string): Promise<string | null> {
    let response = "";
    let settle: (() => void) | undefined;
    const settled = new Promise<void>((resolve) => { settle = resolve; });
    const append = (event: PiEvent) => {
      if (event.type === "message_update") {
        const assistantEvent = event.assistantMessageEvent as { type?: unknown; delta?: unknown } | undefined;
        if (assistantEvent?.type === "text_delta" && typeof assistantEvent.delta === "string") response += assistantEvent.delta;
      } else if (event.type === "message_end") {
        const message = event.message as { role?: unknown; content?: unknown } | undefined;
        if (message?.role === "assistant" && Array.isArray(message.content)) {
          const text = message.content
            .filter((block): block is { type: "text"; text: string } => typeof block === "object" && block !== null && (block as { type?: unknown }).type === "text" && typeof (block as { text?: unknown }).text === "string")
            .map((block) => block.text)
            .join("");
          if (text) response = text;
        }
      } else if (event.type === "agent_settled") {
        settle?.();
      }
    };
    const unsubscribe = process.subscribe(append);
    try {
      await process.request({ type: "prompt", message: prompt }, this.timeoutMs);
      await Promise.race([
        settled,
        new Promise<void>((_, reject) => setTimeout(() => reject(new Error("Pi commit message suggestion timed out")), this.timeoutMs)),
      ]);
      return response || null;
    } finally {
      unsubscribe();
    }
  }
}
