import { describe, expect, it } from "bun:test";
import {
  buildCommitPrompt,
  extractCommitConversation,
  fallbackCommitMessage,
  formatChangedFiles,
  formatConversationMessages,
  sanitizeCommitMessage,
  serializeDiffsForPrompt,
  truncateCommitDiff,
  CommitGenerator,
} from "./commit-generator.ts";

const piScript = `let buffer = ""; process.stdin.on("data", (chunk) => { buffer += chunk; const lines = buffer.split("\\n"); buffer = lines.pop() ?? ""; for (const line of lines) { if (!line) continue; const request = JSON.parse(line); if (request.type === "get_state") { process.stdout.write(JSON.stringify({ type: "response", id: request.id, command: "get_state", success: true }) + "\\n"); continue; } if (request.type !== "prompt") continue; process.stdout.write(JSON.stringify({ type: "response", id: request.id, command: "prompt", success: true }) + "\\n"); process.stdout.write(JSON.stringify({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "Add retry helper" }] } }) + "\\n"); process.stdout.write(JSON.stringify({ type: "agent_settled" }) + "\\n"); } });`;

describe("sanitizeCommitMessage", () => {
  it("passes through a clean subject", () => {
    expect(sanitizeCommitMessage("Add retry helper")).toBe("Add retry helper");
  });
  it("strips fences and quotes", () => {
    expect(sanitizeCommitMessage('```\nAdd retry helper\n```')).toBe("Add retry helper");
    expect(sanitizeCommitMessage('"Add retry helper"')).toBe("Add retry helper");
  });
  it("truncates an overlong subject", () => {
    const long = `Add ${"x".repeat(100)}`;
    const out = sanitizeCommitMessage(long)!;
    expect(out.length).toBeLessThanOrEqual(72);
  });
  it("rejects empty output", () => {
    expect(sanitizeCommitMessage("")).toBeNull();
    expect(sanitizeCommitMessage("   ")).toBeNull();
  });
});

describe("fallbackCommitMessage", () => {
  it("derives a subject from changed files", () => {
    expect(fallbackCommitMessage([{ path: "a.ts", kind: "modified" }])).toBe("Update a.ts");
    expect(fallbackCommitMessage([{ path: "new.txt", kind: "untracked" }])).toBe("Add new.txt");
    expect(fallbackCommitMessage([])).toBe("Update files");
  });
});

describe("formatChangedFiles / truncateCommitDiff", () => {
  it("lists files with kinds", () => {
    expect(formatChangedFiles([{ path: "a.ts", kind: "modified" }])).toContain("a.ts (modified)");
    expect(formatChangedFiles([])).toBe("(no changes)");
  });
  it("truncates huge diffs", () => {
    expect(truncateCommitDiff("")).toBe("(no textual diff)");
    expect(truncateCommitDiff("x".repeat(30000))).not.toContain("(diff truncated)");
    expect(truncateCommitDiff("x".repeat(120000))).toContain("(diff truncated)");
  });
});

describe("serializeDiffsForPrompt", () => {
  it("serializes hunks and marks binary files", () => {
    const text = serializeDiffsForPrompt([
      { path: "a.ts", binary: false, oversized: false, truncated: false, additions: 1, deletions: 0, hunks: [{ oldStart: 1, oldLines: 1, newStart: 1, newLines: 2, header: "", lines: [{ kind: "added", text: "x" }] }] },
      { path: "img.png", binary: true, oversized: false, truncated: false, additions: 0, deletions: 0, hunks: [] },
    ]);
    expect(text).toContain("+x");
    expect(text).toContain("Binary file: img.png");
  });
});

describe("buildCommitPrompt", () => {
  it("replaces {{files}} and {{diff}}", () => {
    const out = buildCommitPrompt("FILES", "DIFF", "Files:\n{{files}}\nDiff:\n{{diff}}");
    expect(out).toContain("FILES");
    expect(out).toContain("DIFF");
  });
  it("uses the default template when blank", () => {
    const out = buildCommitPrompt("a.ts (modified)", "+x", "");
    expect(out).toContain("a.ts (modified)");
    expect(out).toContain("+x");
  });
  it("replaces {{user_messages}} and {{final_assistant_messages}}", () => {
    const out = buildCommitPrompt("F", "D", "U: {{user_messages}} A: {{final_assistant_messages}}", {
      userMessages: 'Message 1: "add retries"',
      finalAssistantMessages: 'Message 1: "done"',
    });
    expect(out).toContain("add retries");
    expect(out).toContain("done");
    expect(out).not.toContain("{{user_messages}}");
    expect(out).not.toContain("{{final_assistant_messages}}");
  });
  it("renders (none) conversation excerpts in the default template", () => {
    const out = buildCommitPrompt("a.ts (modified)", "+x", "");
    expect(out).toContain("(none)");
  });
});

describe("extractCommitConversation", () => {
  it("keeps user and assistant text while excluding reasoning, tools, and attachments", () => {
    const { userMessages, finalAssistantMessages } = extractCommitConversation([
      { kind: "user", id: "u1", text: "Add retries to fetch", images: [{ hash: "a".repeat(64), mimeType: "image/png", name: "shot.png" }], files: [{ hash: "b".repeat(64), name: "spec.txt", path: "/tmp/spec.txt", size: 3, mimeType: "text/plain" }] },
      { kind: "thinking", id: "t1", text: "secret chain of thought" },
      { kind: "tool", id: "tool1", name: "bash", input: null, status: "complete", result: "tool output" },
      { kind: "assistant", id: "a1", text: "Wrapped up the retry helper" },
      { kind: "summary", id: "s1", summaryType: "compaction", text: "summary text" },
      { kind: "error", id: "e1", text: "boom" },
    ]);
    expect(userMessages).toEqual(["Add retries to fetch"]);
    expect(finalAssistantMessages).toEqual(["Wrapped up the retry helper"]);
  });
  it("keeps only the most recent assistant messages", () => {
    const timeline = ["one", "two", "three", "four"].map((text, i) => ({ kind: "assistant" as const, id: `a${i}`, text }));
    const { finalAssistantMessages } = extractCommitConversation(timeline);
    expect(finalAssistantMessages).toEqual(["two", "three", "four"]);
  });
  it("skips empty texts", () => {
    const { userMessages, finalAssistantMessages } = extractCommitConversation([
      { kind: "user", id: "u1", text: "   " },
      { kind: "assistant", id: "a1", text: "" },
    ]);
    expect(userMessages).toEqual([]);
    expect(finalAssistantMessages).toEqual([]);
    expect(formatConversationMessages([])).toBe("(none)");
  });
});

describe("CommitGenerator", () => {
  it("reads the assistant message from Pi RPC events", async () => {
    const generator = new CommitGenerator(1_000, { executable: process.execPath, executableArgs: ["-e", piScript] });
    const result = await generator.suggestCommit([{ path: "a.ts", kind: "modified" }], "+x", "/tmp", "test/model");
    expect(result).toBe("Add retry helper");
  });

  it("returns null when Pi is unavailable", async () => {
    const generator = new CommitGenerator(50, { executable: "/does/not/exist" });
    const result = await generator.suggestCommit([{ path: "a.ts", kind: "modified" }], "+x");
    expect(result).toBeNull();
  });

  it("returns null with no files", async () => {
    const generator = new CommitGenerator(50, { executable: "/does/not/exist" });
    expect(await generator.suggestCommit([], "+x")).toBeNull();
  });
});
