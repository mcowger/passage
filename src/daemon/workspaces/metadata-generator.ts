import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { MAX_DOMAIN_LABEL_LENGTH, MAX_DOMAIN_PATH_LENGTH } from "../../shared/domain/workspaces.ts";
import { renderWorktreePrompt } from "../../shared/domain/settings.ts";
import { PiRpcManager, type PiEvent, type PiProcessHandle, type PiRpcOptions } from "../agents/rpc/index.ts";

export const worktreeSuggestionSchema = z.object({
  label: z.string().trim().min(1).max(MAX_DOMAIN_LABEL_LENGTH),
  branch: z.string().trim().min(1).max(MAX_DOMAIN_PATH_LENGTH),
  folder: z.string().trim().min(1).max(MAX_DOMAIN_LABEL_LENGTH),
}).strict();

export type WorktreeSuggestion = z.infer<typeof worktreeSuggestionSchema>;
type MetadataGeneratorPiOptions = Pick<PiRpcOptions, "executable" | "executableArgs">;

export function deterministicSlugSuggestion(purpose: string): WorktreeSuggestion {
  const clean = purpose.trim().replace(/[\r\n]+/g, " ");
  const words = clean
    .toLowerCase()
    .replace(/[^a-z0-9\s-_]/g, " ")
    .split(/\s+/)
    .filter(Boolean);
  const label = (clean.slice(0, 70) || "New worktree").trim();
  const slug = words
    .slice(0, 5)
    .join("-")
    .replace(/[-_]+/g, "-")
    .replace(/^-|-$/g, "") || "worktree";
  const suffix = crypto.randomUUID().slice(0, 4);
  const branch = `feature/${slug}`;
  const folder = `${slug}--wk_${suffix}`;
  return { label, branch, folder };
}

export class MetadataGenerator {
  private readonly manager = new PiRpcManager(1);

  constructor(private readonly timeoutMs = 10_000, private readonly pi: MetadataGeneratorPiOptions = {}) {}

  async suggest(purpose: string, cwd?: string, model?: string, thinkingLevel?: string, promptTemplate = ""): Promise<WorktreeSuggestion> {
    const fallback = deterministicSlugSuggestion(purpose);
    if (!purpose.trim()) return fallback;

    let sessionDir: string | undefined;
    let agentId: string | undefined;
    try {
      const prompt = renderWorktreePrompt(promptTemplate, purpose);

      sessionDir = await mkdtemp(join(tmpdir(), "passage-worktree-metadata-"));
      agentId = `metadata-${crypto.randomUUID()}`;
      const piProcess = await this.manager.start(agentId, {
        cwd: cwd?.trim() || process.cwd(),
        sessionDir,
        sessionId: `worktree-metadata-${crypto.randomUUID()}`,
        model: model?.trim() || undefined,
        disableTools: true,
        ...this.pi,
      });
      // Best-effort: an unsupported level only costs this suggestion,
      // never the caller's flow (callers fall back to deterministic slugs).
      if (thinkingLevel?.trim()) {
        await piProcess.request({ type: "set_thinking_level", level: thinkingLevel.trim() }, this.timeoutMs).catch(() => undefined);
      }

      const result = await this.readSuggestion(piProcess, prompt);

      if (!result) return fallback;

      // Extract JSON if wrapped in code blocks or extra text
      const jsonMatch = result.match(/\{[\s\S]*\}/);
      if (!jsonMatch) return fallback;

      const parsed = JSON.parse(jsonMatch[0]);
      const validated = worktreeSuggestionSchema.safeParse(parsed);
      if (validated.success) {
        return validated.data;
      }
      return fallback;
    } catch {
      return fallback;
    } finally {
      if (agentId) await this.manager.stop(agentId).catch(() => undefined);
      if (sessionDir) await rm(sessionDir, { recursive: true, force: true }).catch(() => undefined);
    }
  }

  private async readSuggestion(process: PiProcessHandle, prompt: string): Promise<string | null> {
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
        new Promise<void>((_, reject) => setTimeout(() => reject(new Error("Pi metadata suggestion timed out")), this.timeoutMs)),
      ]);
      return response;
    } finally {
      unsubscribe();
    }
  }
}
