import { z } from "zod";
import { MAX_DOMAIN_LABEL_LENGTH, MAX_DOMAIN_PATH_LENGTH } from "../../shared/domain/workspaces.ts";

export const worktreeSuggestionSchema = z.object({
  label: z.string().trim().min(1).max(MAX_DOMAIN_LABEL_LENGTH),
  branch: z.string().trim().min(1).max(MAX_DOMAIN_PATH_LENGTH),
  folder: z.string().trim().min(1).max(MAX_DOMAIN_LABEL_LENGTH),
}).strict();

export type WorktreeSuggestion = z.infer<typeof worktreeSuggestionSchema>;

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
  constructor(private readonly timeoutMs = process.env.PASSAGE_PI_LIVE === "1" ? 6000 : 1000) {}

  async suggest(purpose: string, cwd?: string): Promise<WorktreeSuggestion> {
    const fallback = deterministicSlugSuggestion(purpose);
    if (!purpose.trim()) return fallback;

    try {
      const prompt = [
        "Generate workspace metadata for a Git worktree based on this purpose description.",
        `Purpose: "${purpose.trim()}"`,
        "Return ONLY a valid JSON object (no markdown, no backticks, no code fence) with exactly these keys:",
        "- label: concise human-readable title (max 60 chars)",
        "- branch: valid git branch name like 'feature/short-name' or 'fix/short-name' (lowercase, hyphen-separated, no spaces)",
        "- folder: collision-safe directory name like 'short-name--wk_abcd' (lowercase, alphanumeric with hyphens/underscores, ending with a short suffix)",
      ].join("\n");

      const args = ["pi", "--mode", "rpc"];
      const proc = Bun.spawn(args, {
        cwd: cwd && cwd !== "" ? cwd : undefined,
        env: { ...process.env, NO_COLOR: "1" },
        stdin: "pipe",
        stdout: "pipe",
        stderr: "pipe",
      });

      let timeoutId: ReturnType<typeof setTimeout> | undefined;
      const timeoutPromise = new Promise<null>((resolve) => {
        timeoutId = setTimeout(() => {
          try { proc.kill(); } catch {}
          resolve(null);
        }, this.timeoutMs);
      });

      const rpcPromise = (async (): Promise<string | null> => {
        try {
          const stdin = proc.stdin;
          if (!stdin) return null;
          const req = JSON.stringify({ type: "prompt", id: "req_suggest_1", message: prompt }) + "\n";
          stdin.write(new TextEncoder().encode(req));
          await stdin.flush?.();

          const reader = (proc.stdout as ReadableStream<Uint8Array>).getReader();
          let buffer = "";
          let fullResponse = "";

          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            buffer += new TextDecoder().decode(value);
            const lines = buffer.split("\n");
            buffer = lines.pop() ?? "";

            for (const line of lines) {
              if (!line.trim()) continue;
              try {
                const parsed = JSON.parse(line) as { type?: string; message?: { content?: Array<{ type: string; text?: string }> }; text?: string; delta?: string };
                if (parsed.type === "message" && parsed.message?.content) {
                  for (const block of parsed.message.content) {
                    if (block.type === "text" && block.text) fullResponse += block.text;
                  }
                } else if (parsed.type === "text_delta" && parsed.delta) {
                  fullResponse += parsed.delta;
                } else if (parsed.type === "turn_end" || parsed.type === "agent_end") {
                  try { proc.kill(); } catch {}
                  return fullResponse;
                }
              } catch {}
            }
          }
          return fullResponse;
        } catch {
          return null;
        }
      })();

      const result = await Promise.race([rpcPromise, timeoutPromise]);
      if (timeoutId) clearTimeout(timeoutId);
      try { proc.kill(); } catch {}

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
    }
  }
}
