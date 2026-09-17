import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pageHistory, parsePiJsonl, readPiHistory } from "./index.ts";

const directories: string[] = [];
const line = (value: unknown) => `${JSON.stringify(value)}\r\n`;
const header = { type: "session", version: 3, id: "session-1", timestamp: "2026-01-01T00:00:00Z", cwd: "/safe" };

const usage = {
  input: 3,
  output: 4,
  cacheRead: 2,
  cacheWrite: 1,
  totalTokens: 10,
  cost: { input: 0.01, output: 0.02, cacheRead: 0, cacheWrite: 0, total: 0.03 },
};

function revision(source: string) {
  const bytes = new TextEncoder().encode(source);
  return {
    mtimeMs: 1,
    size: bytes.byteLength,
    contentHash: new Bun.CryptoHasher("sha256").update(bytes).digest("hex"),
  };
}

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("Pi history projection", () => {
  test("pairs durable tool-result messages and preserves usage", () => {
    const source = [
      line(header),
      line({ type: "message", id: "u1", parentId: null, timestamp: "t", message: { role: "user", content: "Inspect" } }),
      line({ type: "message", id: "a1", parentId: "u1", timestamp: "t", message: { role: "assistant", provider: "anthropic", model: "model", usage, content: [
        { type: "thinking", thinking: "Plan" },
        { type: "toolCall", id: "tool-1", name: "read", arguments: { path: "x" } },
      ] } }),
      line({ type: "message", id: "r1", parentId: "a1", timestamp: "t", message: { role: "toolResult", toolCallId: "tool-1", toolName: "read", content: [{ type: "text", text: "ok" }], isError: false } }),
      line({ type: "message", id: "a2", parentId: "r1", timestamp: "t", message: { role: "assistant", content: [{ type: "text", text: "Done" }] } }),
    ].join("");
    const history = parsePiJsonl(source, revision(source));
    expect(history.timeline.map((item) => item.kind)).toEqual(["user", "thinking", "tool", "assistant"]);
    expect(history.timeline.find((item) => item.kind === "tool")).toMatchObject({ status: "complete", result: "ok" });
    expect(history.usage).toMatchObject({ input: 3, output: 4, totalTokens: 10, cost: 0.03 });
    expect(history.currentModel).toEqual({ provider: "anthropic", modelId: "model" });
  });

  test("projects only the active branch while retaining branch metadata", () => {
    const source = [
      line(header),
      line({ type: "message", id: "u1", parentId: null, timestamp: "t", message: { role: "user", content: "Root" } }),
      line({ type: "message", id: "old", parentId: "u1", timestamp: "t", message: { role: "assistant", content: "Old branch" } }),
      line({ type: "message", id: "new", parentId: "u1", timestamp: "t", message: { role: "assistant", content: "Active branch" } }),
    ].join("");
    const history = parsePiJsonl(source, revision(source));
    expect(history.timeline.map((item) => item.kind === "assistant" ? item.text : "")).toContain("Active branch");
    expect(history.timeline.map((item) => item.kind === "assistant" ? item.text : "")).not.toContain("Old branch");
    expect(history.branches.find((entry) => entry.id === "old")?.active).toBe(false);
  });

  test("uses the authoritative live leaf when it differs from file order", () => {
    const source = [
      line(header),
      line({ type: "message", id: "u1", parentId: null, timestamp: "t", message: { role: "user", content: "Root" } }),
      line({ type: "message", id: "old", parentId: "u1", timestamp: "t", message: { role: "assistant", content: "Selected branch" } }),
      line({ type: "session_info", id: "metadata", parentId: "u1", timestamp: "t", name: "File-last metadata" }),
    ].join("");
    const history = parsePiJsonl(source, revision(source), { leafId: "old" });
    expect(history.leafId).toBe("old");
    expect(history.leafInferred).toBeUndefined();
    expect(history.timeline.map((item) => item.kind === "assistant" ? item.text : "")).toContain("Selected branch");
    expect(history.sessionName).toBeUndefined();
  });

  test("labels the file-order leaf fallback as inferred", () => {
    const source = `${line(header)}${line({ type: "message", id: "u1", parentId: null, timestamp: "t", message: { role: "user", content: "Root" } })}${line({ type: "session_info", id: "metadata", parentId: "u1", timestamp: "t", name: "File last" })}`;
    const history = parsePiJsonl(source, revision(source));
    expect(history).toMatchObject({ leafId: "metadata", leafInferred: true });
  });

  test("projects completed tools and preserves errors and user boundaries", () => {
    const source = [
      line(header),
      line({ type: "message", id: "a1", parentId: null, timestamp: "t", message: { role: "assistant", content: [
        { type: "toolCall", id: "one", name: "read", arguments: {} },
        { type: "toolCall", id: "two", name: "search", arguments: {} },
        { type: "toolCall", id: "three", name: "edit", arguments: {} },
      ] } }),
      line({ type: "message", id: "r1", parentId: "a1", timestamp: "t", message: { role: "toolResult", toolCallId: "one", toolName: "read", content: "ok", isError: false } }),
      line({ type: "message", id: "r2", parentId: "r1", timestamp: "t", message: { role: "toolResult", toolCallId: "two", toolName: "search", content: "failed", isError: true } }),
      line({ type: "message", id: "r3", parentId: "r2", timestamp: "t", message: { role: "toolResult", toolCallId: "three", toolName: "edit", content: "ok", isError: false } }),
      line({ type: "message", id: "u2", parentId: "r3", timestamp: "t", message: { role: "user", content: "Next" } }),
    ].join("");
    const history = parsePiJsonl(source, revision(source));
    expect(history.timeline.some((item) => item.kind === "tool" && item.status === "error")).toBe(true);
    expect(history.timeline.some((item) => item.kind === "tool" && item.status === "complete")).toBe(true);
    expect(history.timeline.at(-1)?.kind).toBe("user");
  });

  test("reports context occupancy from the latest assistant turn, not cumulative usage", () => {
    const source = [
      line(header),
      line({ type: "message", id: "u1", parentId: null, timestamp: "t", message: { role: "user", content: "Inspect" } }),
      line({ type: "message", id: "a1", parentId: "u1", timestamp: "t", message: { role: "assistant", provider: "plexus", model: "m", usage: { input: 100, output: 10, cacheRead: 0, cacheWrite: 0, totalTokens: 110, cost: { total: 0.01 } }, content: [{ type: "text", text: "First" }] } }),
      line({ type: "message", id: "u2", parentId: "a1", timestamp: "t", message: { role: "user", content: "More" } }),
      line({ type: "message", id: "a2", parentId: "u2", timestamp: "t", message: { role: "assistant", provider: "plexus", model: "m", usage: { input: 5, output: 20, cacheRead: 500, cacheWrite: 0, totalTokens: 525, cost: { total: 0.02 } }, content: [{ type: "text", text: "Second" }] } }),
    ].join("");
    const history = parsePiJsonl(source, revision(source));
    expect(history.usage).toMatchObject({ input: 105, output: 30, cacheRead: 500, totalTokens: 635 });
    expect(history.contextUsage).toEqual({ tokens: 525 });
  });

  test("reports unknown context occupancy immediately after compaction", () => {
    const source = [
      line(header),
      line({ type: "message", id: "a1", parentId: null, timestamp: "t", message: { role: "assistant", provider: "plexus", model: "m", usage: { input: 100, output: 10, cacheRead: 0, cacheWrite: 0, totalTokens: 110, cost: { total: 0.01 } }, content: [{ type: "text", text: "First" }] } }),
      line({ type: "compaction", id: "c1", parentId: "a1", timestamp: "t", summary: "Compact", firstKeptEntryId: "a1", tokensBefore: 110, usage: { input: 50, output: 5, cacheRead: 0, cacheWrite: 0, totalTokens: 55, cost: { total: 0.005 } } }),
    ].join("");
    const history = parsePiJsonl(source, revision(source));
    expect(history.contextUsage).toEqual({ tokens: null });
  });

  test("tracks compaction, branch summaries, model/thinking changes, and unknown entries", () => {
    const source = [
      line(header),
      line({ type: "model_change", id: "m1", parentId: null, timestamp: "t", provider: "openai", modelId: "gpt" }),
      line({ type: "thinking_level_change", id: "t1", parentId: "m1", timestamp: "t", thinkingLevel: "high" }),
      line({ type: "compaction", id: "c1", parentId: "t1", timestamp: "t", summary: "Compact", firstKeptEntryId: "m1", tokensBefore: 10, usage }),
      line({ type: "branch_summary", id: "b1", parentId: "c1", timestamp: "t", fromId: "m1", summary: "Branch" }),
      line({ type: "future_entry", id: "x1", parentId: "b1", timestamp: "t", secret: "not exposed" }),
    ].join("");
    const history = parsePiJsonl(source, revision(source));
    expect(history.currentModel).toEqual({ provider: "openai", modelId: "gpt" });
    expect(history.currentThinkingLevel).toBe("high");
    expect(history.timeline.filter((item) => item.kind === "summary")).toHaveLength(2);
    expect(history.timeline.at(-1)).toEqual({ kind: "unknown", id: "x1", entryType: "future_entry" });
    expect(JSON.stringify(history)).not.toContain("not exposed");
  });

  test("accepts complete EOF records and flags malformed partial tails", () => {
    const complete = `${line(header)}${JSON.stringify({ type: "session_info", id: "n1", parentId: null, timestamp: "t", name: "Named" })}`;
    expect(parsePiJsonl(complete, revision(complete)).partialTail).toBe(false);
    const partial = `${line(header)}{"type":"message"`;
    const history = parsePiJsonl(partial, revision(partial));
    expect(history.partialTail).toBe(true);
    expect(history.malformedRecordCount).toBe(0);
  });

  test("retains assistant turns that settle with a Pi model error", () => {
    const source = `${line(header)}${line({ type: "message", id: "u1", parentId: null, timestamp: "t", message: { role: "user", content: "Try" } })}${line({ type: "message", id: "a1", parentId: "u1", timestamp: "t", message: { role: "assistant", content: [], errorMessage: "Model unavailable" } })}`;
    const history = parsePiJsonl(source, revision(source));
    expect(history.timeline.at(-1)).toEqual({ kind: "assistant", id: "a1:terminal", text: "Model unavailable", error: "Model unavailable" });
    expect(history.agentErrorCount).toBe(1);
  });

  test("keeps a terminal error ahead of its retained unexecuted tool call", () => {
    const source = [
      line(header),
      line({ type: "message", id: "u1", parentId: null, timestamp: "t", message: { role: "user", content: "Try" } }),
      line({ type: "message", id: "a1", parentId: "u1", timestamp: "t", message: { role: "assistant", content: [
        { type: "thinking", thinking: "Plan the request" },
        { type: "toolCall", id: "tool-1", name: "bash", arguments: { command: "bun test" } },
      ], errorMessage: "OpenAI Responses stream ended before a terminal response event" } }),
    ].join("");
    const history = parsePiJsonl(source, revision(source));

    expect(history.timeline.map((item) => item.kind)).toEqual(["user", "thinking", "assistant", "tool"]);
    expect(history.timeline[2]).toMatchObject({
      id: "a1:terminal",
      error: "OpenAI Responses stream ended before a terminal response event",
    });
    expect(history.timeline[3]).toMatchObject({ id: "tool-1", status: "running" });
  });

  test("suppresses the aborted run Pi compacted over, keeping the summary", () => {
    const source = [
      line(header),
      line({ type: "message", id: "u1", parentId: null, timestamp: "t", message: { role: "user", content: "Work" } }),
      line({ type: "message", id: "a1", parentId: "u1", timestamp: "t", message: { role: "assistant", content: [], stopReason: "aborted", errorMessage: "Request aborted" } }),
      line({ type: "compaction", id: "c1", parentId: "a1", timestamp: "t", summary: "Compact", firstKeptEntryId: "u1", tokensBefore: 115972, details: { reason: "manual", compactor: "pi-vcc" } }),
      line({ type: "message", id: "u2", parentId: "c1", timestamp: "t", message: { role: "user", content: "After" } }),
    ].join("");
    const history = parsePiJsonl(source, revision(source));
    expect(history.timeline.map((item) => item.kind)).toEqual(["summary", "user", "user"]);
    expect(history.timeline[0]).toMatchObject({ kind: "summary", summaryType: "compaction", text: "Compact", tokensBefore: 115972, compactionReason: "manual" });
    expect(history.agentErrorCount).toBe(0);
  });

  test("keeps a user-initiated stop notice even when compacted over", () => {
    const source = [
      line(header),
      line({ type: "message", id: "u1", parentId: null, timestamp: "t", message: { role: "user", content: "Work" } }),
      line({ type: "message", id: "a1", parentId: "u1", timestamp: "t", message: { role: "assistant", content: [], stopReason: "aborted", errorMessage: "Request was aborted" } }),
      line({ type: "compaction", id: "c1", parentId: "a1", timestamp: "t", summary: "Compact", firstKeptEntryId: "u1", tokensBefore: 50, details: { reason: "manual" } }),
    ].join("");
    const history = parsePiJsonl(source, revision(source));
    expect(history.timeline.map((item) => item.kind)).toEqual(["summary", "user", "assistant"]);
    expect(history.timeline.at(-1)).toMatchObject({ error: "Request was aborted" });
    expect(history.agentErrorCount).toBe(1);
  });

  test("keeps genuine model errors even when compacted over", () => {
    const source = [
      line(header),
      line({ type: "message", id: "u1", parentId: null, timestamp: "t", message: { role: "user", content: "Work" } }),
      line({ type: "message", id: "a1", parentId: "u1", timestamp: "t", message: { role: "assistant", content: [], stopReason: "error", errorMessage: "Model unavailable" } }),
      line({ type: "compaction", id: "c1", parentId: "a1", timestamp: "t", summary: "Compact", firstKeptEntryId: "u1", tokensBefore: 50, details: { reason: "manual" } }),
    ].join("");
    const history = parsePiJsonl(source, revision(source));
    expect(history.timeline.map((item) => item.kind)).toEqual(["summary", "user", "assistant"]);
    expect(history.timeline.at(-1)).toMatchObject({ error: "Model unavailable" });
    expect(history.agentErrorCount).toBe(1);
  });

  test("keeps an aborted run that compaction did not directly parent", () => {
    const source = [
      line(header),
      line({ type: "message", id: "u1", parentId: null, timestamp: "t", message: { role: "user", content: "Work" } }),
      line({ type: "message", id: "a1", parentId: "u1", timestamp: "t", message: { role: "assistant", content: [], stopReason: "aborted", errorMessage: "Request aborted" } }),
      line({ type: "message", id: "u2", parentId: "a1", timestamp: "t", message: { role: "user", content: "Retry" } }),
      line({ type: "compaction", id: "c1", parentId: "u2", timestamp: "t", summary: "Compact", firstKeptEntryId: "u1", tokensBefore: 50, details: { reason: "threshold" } }),
    ].join("");
    const history = parsePiJsonl(source, revision(source));
    expect(history.timeline.map((item) => item.kind)).toEqual(["summary", "user", "assistant", "user"]);
    expect(history.timeline[2]).toMatchObject({ error: "Request aborted" });
    expect(history.timeline[0]).toMatchObject({ kind: "summary", compactionReason: "auto" });
    expect(history.agentErrorCount).toBe(1);
  });

  test("omits compaction metadata the journal entry does not carry", () => {
    const source = [
      line(header),
      line({ type: "message", id: "u1", parentId: null, timestamp: "t", message: { role: "user", content: "Work" } }),
      line({ type: "compaction", id: "c1", parentId: "u1", timestamp: "t", summary: "Compact", firstKeptEntryId: "u1" }),
    ].join("");
    const history = parsePiJsonl(source, revision(source));
    expect(history.timeline[0]).toEqual({ kind: "summary", id: "c1", summaryType: "compaction", text: "Compact" });
  });

  test("detects append versus rewrite using the previous content fingerprint", async () => {
    const directory = await mkdtemp(join(tmpdir(), "passage-history-"));
    directories.push(directory);
    const path = join(directory, "session.jsonl");
    const initial = `${line(header)}${line({ type: "session_info", id: "n1", parentId: null, timestamp: "t", name: "One" })}`;
    await writeFile(path, initial);
    const first = await readPiHistory(path);
    await writeFile(path, `${initial}${line({ type: "session_info", id: "n2", parentId: "n1", timestamp: "t", name: "Two" })}`);
    expect((await readPiHistory(path, { previousRevision: first.revision })).rewritten).toBe(false);
    await writeFile(path, initial.replace("One", "New"));
    expect((await readPiHistory(path, { previousRevision: first.revision })).rewritten).toBe(true);
  });

  test("bounds records and pages projected history", () => {
    const source = `${line(header)}${line({ type: "message", id: "u1", parentId: null, timestamp: "t", message: { role: "user", content: "One" } })}${line({ type: "message", id: "u2", parentId: "u1", timestamp: "t", message: { role: "user", content: "Two" } })}`;
    const history = parsePiJsonl(source, revision(source));
    expect(pageHistory(history, history.timeline.length, 1)).toMatchObject({ nextBefore: 1, history: { timeline: [{ kind: "user", text: "Two" }] } });
    expect(() => parsePiJsonl(source, revision(source), { maxRecords: 1 })).toThrow("record limit");
  });

  test("projects a deterministic write, bash, and read tool sequence", () => {
    const source = [
      line(header),
      line({ type: "message", id: "u1", parentId: null, timestamp: "t", message: { role: "user", content: "Create the file and verify it" } }),
      line({ type: "message", id: "a1", parentId: "u1", timestamp: "t", message: { role: "assistant", content: [
        { type: "toolCall", id: "write-1", name: "write", arguments: { path: "LIVE_SEQUENCE.md", content: "# Live\n" } },
      ] } }),
      line({ type: "message", id: "r1", parentId: "a1", timestamp: "t", message: { role: "toolResult", toolCallId: "write-1", toolName: "write", content: [{ type: "text", text: "Wrote LIVE_SEQUENCE.md" }], isError: false } }),
      line({ type: "message", id: "a2", parentId: "r1", timestamp: "t", message: { role: "assistant", content: [
        { type: "toolCall", id: "bash-1", name: "bash", arguments: { command: "git status --short" } },
        { type: "toolCall", id: "read-1", name: "read", arguments: { path: "LIVE_SEQUENCE.md" } },
      ] } }),
      line({ type: "message", id: "r2", parentId: "a2", timestamp: "t", message: { role: "toolResult", toolCallId: "bash-1", toolName: "bash", content: [{ type: "text", text: "?? LIVE_SEQUENCE.md" }], isError: false } }),
      line({ type: "message", id: "r3", parentId: "r2", timestamp: "t", message: { role: "toolResult", toolCallId: "read-1", toolName: "read", content: [{ type: "text", text: "# Live\n" }], isError: false } }),
      line({ type: "message", id: "a3", parentId: "r3", timestamp: "t", message: { role: "assistant", content: [{ type: "text", text: "File created and verified." }] } }),
    ].join("");
    const history = parsePiJsonl(source, revision(source));
    const activities = history.timeline.filter((item) => item.kind === "tool");
    expect(activities.map((item) => item.name)).toEqual(["write", "bash", "read"]);
    expect(activities.every((item) => item.status === "complete")).toBe(true);
    expect(activities.map((item) => item.result)).toEqual(["Wrote LIVE_SEQUENCE.md", "?? LIVE_SEQUENCE.md", "# Live\n"]);
    // Tool rows stay in chronological (journal) order -- no grouping/reordering.
    expect(history.timeline.map((item) => item.kind)).toEqual(["user", "tool", "tool", "tool", "assistant"]);
    expect(history.timeline.at(-1)).toMatchObject({ kind: "assistant", text: "File created and verified." });
  });

  test("projects unknown model tools as generic activities", () => {
    // Mirrors the NullModel `tool_calls` persona shape (get_weather and friends):
    // Pi records the call, Passage renders it through the safe generic card.
    const source = [
      line(header),
      line({ type: "message", id: "a1", parentId: null, timestamp: "t", message: { role: "assistant", content: [
        { type: "toolCall", id: "tc-1", name: "get_weather", arguments: { location: "San Francisco, CA" } },
      ] } }),
      line({ type: "message", id: "r1", parentId: "a1", timestamp: "t", message: { role: "toolResult", toolCallId: "tc-1", toolName: "get_weather", content: [{ type: "text", text: "sunny" }], isError: false } }),
    ].join("");
    const history = parsePiJsonl(source, revision(source));
    const tool = history.timeline.filter((item) => item.kind === "tool").find((item) => item.name === "get_weather");
    expect(tool).toMatchObject({ status: "complete", result: "sunny" });
  });
});
