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

  test("groups only completed non-significant tools and preserves errors and user boundaries", () => {
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
    expect(history.timeline.some((item) => item.kind === "tool" && item.significant)).toBe(true);
    expect(history.timeline.at(-1)?.kind).toBe("user");
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
});
