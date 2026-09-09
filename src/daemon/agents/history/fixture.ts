import type { AgentHistory } from "../../../shared/domain/agents.ts";
import { parsePiJsonl } from "./index.ts";

const line = (value: unknown) => `${JSON.stringify(value)}\n`;

const header = { type: "session", version: 3, id: "session-fixture-gaps-8-9", timestamp: "2026-09-09T00:00:00Z", cwd: "/fixture" };

const longOutput = Array.from(
  { length: 60 },
  (_, i) => `TOOL_OUTPUT_LINE_${String(i + 1).padStart(3, "0")} some diagnostic text here`,
).join("\n");
const bigContent = Array.from({ length: 40 }, (_, i) => `Line ${i + 1} of the created file body.`).join("\n");
const finalProse = `Created \`LIVE_SEQUENCE.md\` with contents:\n\n\`\`\`\n${bigContent.split("\n").slice(0, 10).join("\n")}\n... (30 more lines)\n\`\`\`\n\nCommand output confirmed \`live agent command complete\` and \`?? LIVE_SEQUENCE.md\` in git status. ${"The full transcript continues below the fold with additional verification notes. ".repeat(6)}`;

const source = [
  line(header),
  line({ type: "message", id: "u1", parentId: null, timestamp: "t", message: { role: "user", content: "Create LIVE_SEQUENCE.md and verify it" } }),
  line({ type: "message", id: "a1", parentId: "u1", timestamp: "t", message: { role: "assistant", content: [
    { type: "toolCall", id: "write-1", name: "write", arguments: { path: "LIVE_SEQUENCE.md", content: bigContent } },
  ] } }),
  line({ type: "message", id: "r1", parentId: "a1", timestamp: "t", message: { role: "toolResult", toolCallId: "write-1", toolName: "write", content: [{ type: "text", text: "Wrote LIVE_SEQUENCE.md (40 lines)" }], isError: false } }),
  line({ type: "message", id: "a2", parentId: "r1", timestamp: "t", message: { role: "assistant", content: [
    { type: "toolCall", id: "bash-1", name: "bash", arguments: { command: "printf 'live agent command complete\\n' && git status --short" } },
    { type: "toolCall", id: "read-1", name: "read", arguments: { path: "LIVE_SEQUENCE.md" } },
  ] } }),
  line({ type: "message", id: "r2", parentId: "a2", timestamp: "t", message: { role: "toolResult", toolCallId: "bash-1", toolName: "bash", content: [{ type: "text", text: `${longOutput}\n?? LIVE_SEQUENCE.md` }], isError: false } }),
  line({ type: "message", id: "r3", parentId: "r2", timestamp: "t", message: { role: "toolResult", toolCallId: "read-1", toolName: "read", content: [{ type: "text", text: bigContent }], isError: false } }),
  line({ type: "message", id: "a3", parentId: "r3", timestamp: "t", message: { role: "assistant", provider: "plexus", model: "muse-spark-1.3", usage: { input: 41000, output: 1200, cacheRead: 40000, cacheWrite: 0, totalTokens: 42200, cost: { total: 0.021 } }, content: [{ type: "text", text: finalProse }] } }),
].join("");

const bytes = new TextEncoder().encode(source);

/**
 * Deterministic transcript used to verify the agent timeline without
 * contacting a model provider: one significant `write` tool activity, one
 * `bash`/`read` process group with long outputs, and a long final response
 * that exercises settlement scrolling. Shape: user, tool:write, process,
 * assistant.
 */
export function fixtureTranscriptHistory(): AgentHistory {
  return parsePiJsonl(source, {
    mtimeMs: 0,
    size: bytes.byteLength,
    contentHash: "fixture-gaps-8-9",
  });
}
