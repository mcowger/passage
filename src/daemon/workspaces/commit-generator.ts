import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { renderCommitPrompt } from "../../shared/domain/settings.ts";
import type { GitDiff } from "../../shared/domain/git.ts";
import { PiRpcManager, type PiEvent, type PiProcessHandle, type PiRpcOptions } from "../agents/rpc/index.ts";

/** Max diff characters forwarded to the commit-message model. */
export const MAX_COMMIT_DIFF_CHARS = 100000;
/** Max changed-file list characters forwarded to the model. */
export const MAX_COMMIT_FILES_CHARS = 4000;
/** Display cap for a generated subject line (git convention ~72). */
export const MAX_COMMIT_SUBJECT_CHARS = 72;
/** Hard cap for the full generated message (subject + body). */
export const MAX_COMMIT_MESSAGE_CHARS = 1000;

type CommitGeneratorPiOptions = Pick<PiRpcOptions, "executable" | "executableArgs">;

export function buildCommitPrompt(files: string, diff: string, template = ""): string {
  return renderCommitPrompt(template, files, diff);
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
  ): Promise<string | null> {
    if (files.length === 0) return null;
    let sessionDir: string | undefined;
    let agentId: string | undefined;
    try {
      const prompt = buildCommitPrompt(
        formatChangedFiles(files),
        truncateCommitDiff(diff),
        promptTemplate,
      );
      sessionDir = await mkdtemp(join(tmpdir(), "passage-commit-message-"));
      agentId = `commit-message-${crypto.randomUUID()}`;
      const piProcess = await this.manager.start(agentId, {
        cwd: cwd?.trim() || process.cwd(),
        sessionDir,
        sessionId: `commit-message-${crypto.randomUUID()}`,
        model: model?.trim() || undefined,
        disableTools: true,
        ...this.pi,
      });
      // Best-effort: an unsupported level must never fail the commit --
      // the caller falls back to a deterministic message.
      if (thinkingLevel?.trim()) {
        await piProcess.request({ type: "set_thinking_level", level: thinkingLevel.trim() }, this.timeoutMs).catch(() => undefined);
      }
      const response = await this.readMessage(piProcess, prompt);
      return sanitizeCommitMessage(response);
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
