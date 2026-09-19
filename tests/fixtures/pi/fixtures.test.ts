/**
 * Fixture corpus gate: manifest integrity, secret scan, history projections,
 * and RPC replay through the real PiRpcManager (no model provider involved).
 */
import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile, cp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parsePiJsonl, readPiHistory } from "../../../src/daemon/agents/history/index.ts";
import { PiRpcManager, type PiEvent } from "../../../src/daemon/agents/rpc/index.ts";

const PI_DIR = import.meta.dir;
const REPLAY = join(PI_DIR, "replay.ts");

type ManifestFixture = {
  name: string;
  kind: string;
  purpose: string;
  expects: Record<string, unknown>;
  bytes: number;
  sha256: string;
};

async function manifest() {
  const doc = JSON.parse(await readFile(join(PI_DIR, "manifest.json"), "utf8")) as {
    version: number;
    piCliVersion: string;
    sessionFormatVersion: number;
    fixtures: ManifestFixture[];
  };
  return doc;
}

function revision(source: string) {
  return { mtimeMs: 1, size: new TextEncoder().encode(source).byteLength, contentHash: "test" };
}

async function waitFor(events: PiEvent[], type: string, timeoutMs = 10_000): Promise<PiEvent> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const found = events.find((e) => e.type === type);
    if (found) return found;
    await Bun.sleep(25);
  }
  throw new Error(`timed out waiting for ${type}`);
}

async function startReplay(agentId: string, scenarioName: string) {
  const dir = await mkdtemp(join(tmpdir(), "passage-fixture-"));
  const sessionId = `fixture-${agentId}`;
  const manager = new PiRpcManager(8);
  const scenario = join(PI_DIR, "rpc", `${scenarioName}.json`);
  const proc = await manager.start(agentId, {
    cwd: dir,
    sessionDir: dir,
    sessionId,
    executable: process.execPath,
    executableArgs: [REPLAY, "--scenario", scenario, "--session-dir", dir, "--session-id", sessionId],
  });
  const events: PiEvent[] = [];
  proc.subscribe((e) => events.push(e));
  return { dir, manager, proc, events, cleanup: async () => { await manager.shutdown(); await rm(dir, { recursive: true, force: true }); } };
}

describe("fixture manifest", () => {
  test("every committed fixture is described, hashed, and present", async () => {
    const doc = await manifest();
    expect(doc.piCliVersion).toBe("0.85.1-patch");
    expect(doc.sessionFormatVersion).toBe(3);
    expect(doc.fixtures.length).toBeGreaterThanOrEqual(15);
    for (const entry of doc.fixtures) {
      const content = await readFile(join(PI_DIR, entry.name));
      expect(content.byteLength).toBe(entry.bytes);
      expect(createHash("sha256").update(content).digest("hex")).toBe(entry.sha256);
      expect(entry.purpose.length).toBeGreaterThan(20);
    }
  });

  test("rejects leaked host, account, and provider identifiers", async () => {
    const doc = await manifest();
    const forbidden = [
      "/home/", "/Users/", "plexus.home", "/tmp/pi-", "/tmp/passage-",
      "msg_01a0b", "resp_6aae", "17897889",
      "\"encrypted_content\":\"Q-",
      "AKIA", "-----BEGIN",
    ];
    for (const entry of doc.fixtures) {
      const content = await readFile(join(PI_DIR, entry.name), "utf8");
      for (const pattern of forbidden) {
        expect(content, `${entry.name} contains ${pattern}`).not.toContain(pattern);
      }
    }
  });
});

describe("history fixtures", () => {
  test("basic settled turn projects header, model, usage, and occupancy", async () => {
    const src = await readFile(join(PI_DIR, "history/basic-settled.jsonl"), "utf8");
    const h = parsePiJsonl(src, revision(src));
    expect(h.currentModel).toEqual({ provider: "plexus", modelId: "muse-spark-1.3" });
    expect(h.contextUsage).toEqual({ tokens: 17645 });
    expect(h.timeline).toHaveLength(3);
    expect(h.timeline.at(-1)).toMatchObject({ kind: "assistant", text: "PASSAGE" });
  });

  test("sequential tools pair calls with completed results", async () => {
    const src = await readFile(join(PI_DIR, "history/sequential-tools.jsonl"), "utf8");
    const tools = parsePiJsonl(src, revision(src)).timeline.filter((i) => i.kind === "tool");
    expect(tools.map((t) => t.name)).toEqual(["write", "bash"]);
    expect(tools.every((t) => t.status === "complete")).toBe(true);
  });

  test("tool errors stay visible with fixture paths", async () => {
    const src = await readFile(join(PI_DIR, "history/tool-error.jsonl"), "utf8");
    const tools = parsePiJsonl(src, revision(src)).timeline.filter((i) => i.kind === "tool");
    expect(tools.some((t) => t.status === "error")).toBe(true);
    expect(src).toContain("/fixture");
  });

  test("long output preserves bulk for limit behavior", async () => {
    const src = await readFile(join(PI_DIR, "history/long-output.jsonl"), "utf8");
    const bash = parsePiJsonl(src, revision(src)).timeline.find((i) => i.kind === "tool" && i.name === "bash" && i.status === "complete");
    expect(bash?.kind === "tool" && typeof bash.result === "string" && bash.result.length).toBeGreaterThan(500);
  });

  test("significant edit pairs read and edit tools", async () => {
    const src = await readFile(join(PI_DIR, "history/significant-edit.jsonl"), "utf8");
    const tools = parsePiJsonl(src, revision(src)).timeline.filter((i) => i.kind === "tool");
    expect(tools.map((t) => t.name)).toEqual(["read", "edit"]);
  });

  test("aborted run retains its terminal error", async () => {
    const src = await readFile(join(PI_DIR, "history/aborted-run.jsonl"), "utf8");
    const h = parsePiJsonl(src, revision(src));
    expect(h.agentErrorCount).toBe(1);
    expect(h.timeline.at(-1)).toMatchObject({ kind: "assistant" });
  });

  test("steer and follow-up persist as user entries ending in FOLLOWED", async () => {
    const src = await readFile(join(PI_DIR, "history/steer-followup.jsonl"), "utf8");
    const h = parsePiJsonl(src, revision(src));
    expect(h.timeline.filter((i) => i.kind === "user")).toHaveLength(3);
    expect(h.timeline.at(-1)).toMatchObject({ kind: "assistant", text: "FOLLOWED" });
  });

  test("compaction summarizes and blanks occupancy", async () => {
    const src = await readFile(join(PI_DIR, "history/compaction.jsonl"), "utf8");
    const h = parsePiJsonl(src, revision(src));
    expect(h.timeline[0]).toMatchObject({ kind: "summary", summaryType: "compaction", tokensBefore: 132741 });
    expect(h.contextUsage).toEqual({ tokens: null });
  });

  test("branch selection honors the explicit leaf over file order", async () => {
    const src = await readFile(join(PI_DIR, "history/branch-selection.jsonl"), "utf8");
    const inferred = parsePiJsonl(src, revision(src));
    expect(inferred).toMatchObject({ leafId: "meta", leafInferred: true });
    const explicit = parsePiJsonl(src, revision(src), { leafId: "new" });
    expect(explicit.timeline.map((i) => (i.kind === "assistant" ? i.text : null)).filter(Boolean)).toEqual(["Fixture active branch reply."]);
    expect(explicit.branches.find((b) => b.id === "old")?.active).toBe(false);
  });

  test("unknown entries project safely without payloads", async () => {
    const src = await readFile(join(PI_DIR, "history/unknown-entry.jsonl"), "utf8");
    const h = parsePiJsonl(src, revision(src));
    expect(h.timeline.at(-1)).toEqual({ kind: "unknown", id: "x1", entryType: "future_widget" });
    expect(JSON.stringify(h)).not.toContain("not exposed");
  });

  test("partial tail flags recovery without malformed noise", async () => {
    const src = await readFile(join(PI_DIR, "history/partial-tail.jsonl"), "utf8");
    const h = parsePiJsonl(src, revision(src));
    expect(h.partialTail).toBe(true);
    expect(h.malformedRecordCount).toBe(0);
  });

  test("append versus rewrite detection works on fixture content", async () => {
    const dir = await mkdtemp(join(tmpdir(), "passage-fixture-rewrite-"));
    try {
      const path = join(dir, "session.jsonl");
      await cp(join(PI_DIR, "history/basic-settled.jsonl"), path);
      const first = await readPiHistory(path);
      expect(first.rewritten).toBe(false);
      const full = await readFile(path, "utf8");
      await writeFile(path, `${full}{\"type\":\"session_info\",\"id\":\"n9\",\"parentId\":null,\"timestamp\":\"t\",\"name\":\"Two\"}\n`);
      expect((await readPiHistory(path, { previousRevision: first.revision })).rewritten).toBe(false);
      await writeFile(path, full.slice(0, Math.floor(full.length / 2)));
      expect((await readPiHistory(path, { previousRevision: first.revision })).rewritten).toBe(true);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("rpc replay", () => {
  test("prompt admission is distinct from settlement and materializes the session", async () => {
    const { dir, proc, events, cleanup } = await startReplay("stream", "prompt-stream");
    try {
      await proc.request({ type: "prompt", message: "Reply with exactly the word PASSAGE" });
      await waitFor(events, "agent_settled");
      expect(events.map((e) => e.type)).toContain("message_update");
      const session = await readFile(join(dir, "fixture-stream.jsonl"), "utf8");
      expect(session).toContain("fixture-basic");
    } finally {
      await cleanup();
    }
  });

  test("sequential tools stream deltas and execution boundaries", async () => {
    const { proc, events, cleanup } = await startReplay("tools", "sequential-tools");
    try {
      await proc.request({ type: "prompt", message: "Fixture tools prompt" });
      await waitFor(events, "agent_settled");
      const types = events.map((e) => e.type);
      expect(types).toContain("tool_execution_start");
      expect(types).toContain("tool_execution_end");
    } finally {
      await cleanup();
    }
  });

  test("abort settles after the aborted tail", async () => {
    const { proc, events, cleanup } = await startReplay("abort", "abort-settlement");
    try {
      await proc.request({ type: "prompt", message: "Fixture abort prompt" });
      await proc.request({ type: "abort" });
      await waitFor(events, "agent_settled");
      expect(proc.lifecycle).toBe("running");
    } finally {
      await cleanup();
    }
  });

  test("steer and follow-up follow Pi queue semantics", async () => {
    const { proc, events, cleanup } = await startReplay("queue", "prompt-steer-follow-up");
    try {
      await proc.request({ type: "prompt", message: "Fixture count prompt" });
      await proc.request({ type: "steer", message: "Also say STEERED at the end." });
      const queue = await waitFor(events, "queue_update");
      expect(queue.steering).toContain("Also say STEERED at the end.");
      await proc.request({ type: "follow_up", message: "Reply with exactly FOLLOWED." });
      await waitFor(events, "agent_settled");
    } finally {
      await cleanup();
    }
  });

  test("extension select answers with the offered row", async () => {
    const { proc, events, cleanup } = await startReplay("extsel", "extension-select");
    try {
      await proc.request({ type: "prompt", message: "Fixture question prompt" });
      const deadline = Date.now() + 10_000;
      let dialog: { id: string; method: string; options?: unknown } | undefined;
      while (Date.now() < deadline) {
        const pending = proc.getPendingUiRequest() as unknown as { id: string; method: string; options?: unknown } | undefined;
        if (pending?.method === "select") { dialog = pending; break; }
        await Bun.sleep(25);
      }
      expect(dialog?.method).toBe("select");
      const options = dialog!.options as string[];
      expect(options.some((o) => /Type something/.test(o))).toBe(true);
      proc.respondExtensionUi({ id: dialog!.id, value: options[0]! });
      await waitFor(events, "agent_settled");
      const end = events.find((e) => e.type === "tool_execution_end");
      expect(JSON.stringify(end)).toContain("Alpha");
    } finally {
      await cleanup();
    }
  });

  test("extension free-text row routes through the input follow-up", async () => {
    const { proc, events, cleanup } = await startReplay("extcustom", "extension-custom-answer");
    try {
      await proc.request({ type: "prompt", message: "Fixture question prompt" });
      const deadline = Date.now() + 10_000;
      while (Date.now() < deadline) {
        const pending = proc.getPendingUiRequest() as unknown as { method: string } | undefined;
        if (pending?.method === "select") break;
        await Bun.sleep(25);
      }
      const select = proc.getPendingUiRequest() as unknown as { id: string };
      proc.respondExtensionUi({ id: select.id, value: "Gamma", custom: true });
      await waitFor(events, "agent_settled");
      // The typed answer is consumed inline by the input hop, never surfacing
      // as a second pending card.
      expect(proc.getPendingUiRequest()).toBeUndefined();
      const end = events.find((e) => e.type === "tool_execution_end");
      expect(JSON.stringify(end)).toContain("Gamma");
    } finally {
      await cleanup();
    }
  });

  test("compact refusal surfaces the real Pi error", async () => {
    const { proc, events, cleanup } = await startReplay("compact", "compact-refused");
    try {
      await expect(proc.request({ type: "compact" })).rejects.toThrow("Nothing to compact");
      await waitFor(events, "compaction_end");
    } finally {
      await cleanup();
    }
  });

  test("unrecorded commands fail loudly and crash the replay", async () => {
    const { proc, cleanup } = await startReplay("strict", "prompt-stream");
    try {
      await proc.request({ type: "prompt", message: "Reply with exactly the word PASSAGE" });
      await expect(proc.request({ type: "get_state" })).rejects.toThrow("exited");
      expect(proc.lifecycle).toBe("crashed");
    } finally {
      await cleanup();
    }
  });

  test("process exit settles pending work with bounded stderr", async () => {
    const { proc, events, cleanup } = await startReplay("crash", "crash-after-response");
    try {
      const crashed = new Promise((resolve) => proc.subscribeLifecycle(resolve));
      await proc.request({ type: "prompt", message: "Fixture crash prompt" });
      const event = (await crashed) as { lifecycle: string; stderr: string[] };
      expect(event.lifecycle).toBe("crashed");
      expect(event.stderr.join("")).toContain("simulated crash");
      expect(events.map((e) => e.type)).toContain("agent_start");
    } finally {
      await cleanup();
    }
  });
});
