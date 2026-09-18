import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { renderTitlePrompt } from "../../shared/domain/settings.ts";
import { getSharedLocalQwen, isLocalQwenModel } from "../llm/local-qwen.ts";
import { PiRpcManager, type PiEvent, type PiProcessHandle, type PiRpcOptions } from "./rpc/index.ts";

/** Eligible default title: agents still carrying the create() placeholder
 *  are the only ones the auto-titler may rename. A custom create-time
 *  title sets `titleOverridden`; an applied suggestion changes the title
 *  itself -- either one takes the agent out of eligibility. */
export const DEFAULT_AGENT_TITLE = "Agent";
/** Auto-titles fire once the transcript holds this many user messages. */
export const TITLE_SUGGEST_AFTER_USER_MESSAGES = 2;
/** Per-message characters forwarded to the suggestion model. */
export const MAX_TITLE_SOURCE_CHARS = 1000;
/** Display cap for an applied suggestion (domain allows 256). */
export const MAX_SUGGESTED_TITLE_CHARS = 60;

type TitleSuggesterPiOptions = Pick<PiRpcOptions, "executable" | "executableArgs">;

export function buildTitlePrompt(messages: string[], template = ""): string {
  const excerpt = messages
    .slice(0, TITLE_SUGGEST_AFTER_USER_MESSAGES)
    .map((message, index) => `Message ${index + 1}: "${message.slice(0, MAX_TITLE_SOURCE_CHARS).trim()}"`)
    .join("\n");
  if (template.trim() !== "") {
    if (template.includes("{{messages}}")) return template.split("{{messages}}").join(excerpt);
    return `${template}\n${excerpt}`;
  }
  return renderTitlePrompt("", messages);
}

/** Normalizes raw model output to a displayable title, or null when it
 *  carries nothing usable (so the caller keeps the placeholder). */
export function sanitizeAgentTitle(raw: string | null | undefined): string | null {
  if (!raw) return null;
  let title = raw.trim().replace(/[\r\n]+/g, " ").replace(/\s+/g, " ").trim();
  // Strip list markers, surrounding quotes/brackets, and a trailing period.
  title = title.replace(/^[-*•\d.)\s]+/, "").trim();
  title = title.replace(/^["'“”‘’\[(\{]+/, "").replace(/["'“”‘’\])}*_#]+$/, "").trim().replace(/\.$/, "").trim();
  // The model sometimes echoes an instruction prefix ("Title: ...").
  title = title.replace(/^(title|name|subject)\s*[:\-–]\s*/i, "").trim();
  if (!title) return null;
  if (title.length > MAX_SUGGESTED_TITLE_CHARS) {
    const cut = title.slice(0, MAX_SUGGESTED_TITLE_CHARS);
    const boundary = cut.lastIndexOf(" ");
    title = (boundary > 12 ? cut.slice(0, boundary) : cut).trim().replace(/\.$/, "");
  }
  if (!title || title.toLowerCase() === "agent") return null;
  return title;
}

/** Deterministic fallback from the first user message (first few words),
 *  used when the suggestion model is unavailable or returns nothing usable. */
export function fallbackAgentTitle(messages: string[]): string | null {
  const first = messages[0]?.trim().replace(/\s+/g, " ") ?? "";
  if (!first) return null;
  const words = first.split(" ").filter(Boolean).slice(0, 4).join(" ");
  if (!words) return null;
  const title = words.length > MAX_SUGGESTED_TITLE_CHARS
    ? `${words.slice(0, MAX_SUGGESTED_TITLE_CHARS - 1).trim()}…`
    : words;
  return sanitizeAgentTitle(title);
}

export class AgentTitleSuggester {
  private readonly manager = new PiRpcManager(1);

  constructor(private readonly timeoutMs = 30_000, private readonly pi: TitleSuggesterPiOptions = {}) {}

  /** Best-effort 3-4 word title for the given user messages. Never throws:
   *  returns null when the model is unavailable, times out, or answers
   *  with nothing usable (the caller keeps the placeholder / falls back). */
  async suggestTitle(messages: string[], cwd?: string, model?: string, thinkingLevel?: string, promptTemplate = ""): Promise<string | null> {
    const sources = messages.map((message) => message.trim()).filter(Boolean);
    if (sources.length === 0) return null;
    // Local path: same signature/return type, no Pi spawn. Thinking level
    // is intentionally ignored (Qwen Local is hardcoded to no thinking).
    if (isLocalQwenModel(model)) {
      try {
        const local = getSharedLocalQwen();
        if (!local) return fallbackAgentTitle(sources);
        const response = await local.generate(buildTitlePrompt(sources, promptTemplate));
        return sanitizeAgentTitle(response) ?? fallbackAgentTitle(sources);
      } catch {
        return fallbackAgentTitle(sources);
      }
    }
    let sessionDir: string | undefined;
    let agentId: string | undefined;
    try {
      sessionDir = await mkdtemp(join(tmpdir(), "passage-agent-title-"));
      agentId = `agent-title-${crypto.randomUUID()}`;
      const piProcess = await this.manager.start(agentId, {
        cwd: cwd?.trim() || process.cwd(),
        sessionDir,
        sessionId: `agent-title-${crypto.randomUUID()}`,
        model: model?.trim() || undefined,
        disableTools: true,
        ...this.pi,
      });
      // Best-effort: an unsupported level must never fail the title --
      // the message path keeps its placeholder and retries later.
      if (thinkingLevel?.trim()) {
        await piProcess.request({ type: "set_thinking_level", level: thinkingLevel.trim() }, this.timeoutMs).catch(() => undefined);
      }
      const response = await this.readTitle(piProcess, buildTitlePrompt(sources, promptTemplate));
      return sanitizeAgentTitle(response) ?? fallbackAgentTitle(sources);
    } catch {
      return fallbackAgentTitle(sources);
    } finally {
      if (agentId) await this.manager.stop(agentId).catch(() => undefined);
      if (sessionDir) await rm(sessionDir, { recursive: true, force: true }).catch(() => undefined);
    }
  }

  private async readTitle(process: PiProcessHandle, prompt: string): Promise<string | null> {
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
        new Promise<void>((_, reject) => setTimeout(() => reject(new Error("Pi agent title suggestion timed out")), this.timeoutMs)),
      ]);
      return response || null;
    } finally {
      unsubscribe();
    }
  }
}
