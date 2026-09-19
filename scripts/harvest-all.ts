/**
 * Expansive live harvest of real Pi RPC + JSONL shapes for fixture authoring.
 * One-shot, offline review afterwards. Output goes to /tmp (gitignored) only.
 * Usage: PASSAGE_PI_LIVE=real bun scripts/harvest-all.ts
 */
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PiRpcClient } from "../tests/pi-rpc/client.ts";

const OUT_ROOT = "/tmp/pi-fixture-raw";
await mkdir(OUT_ROOT, { recursive: true });

type Client = PiRpcClient;

async function waitFor(client: Client, type: string, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (client.events.some((e) => e.type === type)) return true;
    await Bun.sleep(250);
  }
  return false;
}

async function saveScenario(name: string, client: Client, sessionDir: string, log: unknown[]) {
  const outDir = join(OUT_ROOT, name);
  await mkdir(outDir, { recursive: true });
  await writeFile(join(outDir, "rpc-events.json"), JSON.stringify(client.events, null, 2));
  await writeFile(join(outDir, "driver-log.json"), JSON.stringify(log, null, 2));
  for (const f of await readdir(sessionDir)) {
    await writeFile(join(outDir, `session-${f}`), await readFile(join(sessionDir, f)));
  }
  const types = [...new Set(client.events.map((e) => e.type))].join(",");
  console.log(`[saved ${name}] events=${client.events.length} types=${types}`);
}

async function freshClient(cwd: string, sessionId: string) {
  const sessionDir = join(cwd, "..", "sessions", sessionId);
  await mkdir(sessionDir, { recursive: true });
  return { client: new PiRpcClient({ cwd, sessionDir, sessionId }), sessionDir };
}

async function scenario(name: string, root: string, fn: (cwd: string) => Promise<void>) {
  const cwd = join(root, name);
  await mkdir(cwd, { recursive: true });
  await writeFile(join(cwd, ".keep"), "");
  console.log(`--- scenario ${name} ---`);
  try {
    await fn(cwd);
  } catch (error) {
    console.log(`[scenario ${name} FAILED] ${error instanceof Error ? error.message : String(error)}`);
  }
}

const root = join(tmpdir(), `pi-harvest-all-${Date.now()}`);
await mkdir(root, { recursive: true });

// 0. Free inspector commands (no model call) — also reveals tool/command names.
await scenario("session-commands", root, async (cwd) => {
  const { client, sessionDir } = await freshClient(cwd, "harvest-commands");
  const log: unknown[] = [];
  try {
    for (const cmd of [
      { type: "get_state" },
      { type: "get_tree" },
      { type: "get_entries", limit: 5 },
      { type: "get_commands" },
      { type: "get_available_models" },
      { type: "get_available_thinking_levels" },
    ] as const) {
      try {
        log.push({ at: cmd.type, response: await client.request(cmd) });
      } catch (error) {
        log.push({ at: cmd.type, error: String(error) });
      }
    }
  } finally {
    await saveScenario("session-commands", client, sessionDir, log);
    await client.shutdown();
  }
});

// 1. Edit flow: read + edit a seeded file.
await scenario("edit-flow", root, async (cwd) => {
  await writeFile(join(cwd, "NOTES.md"), "# Fixture notes\n\nLine one.\nLine two.\n");
  const { client, sessionDir } = await freshClient(cwd, "harvest-edit");
  const log: unknown[] = [];
  try {
    log.push({ at: "get_state", response: await client.request({ type: "get_state" }) });
    log.push({
      at: "prompt",
      response: await client.request({
        type: "prompt",
        message: "Read NOTES.md, then append a line 'Line three.' to it with the edit tool. Keep your final message under 15 words.",
      }),
    });
    log.push({ settled: await waitFor(client, "agent_settled", 180_000) });
    log.push({ at: "get_state-end", response: await client.request({ type: "get_state" }) });
  } finally {
    await saveScenario("edit-flow", client, sessionDir, log);
    await client.shutdown();
  }
});

// 2. Tool error: missing file + failing bash.
await scenario("tool-error", root, async (cwd) => {
  const { client, sessionDir } = await freshClient(cwd, "harvest-toolerror");
  const log: unknown[] = [];
  try {
    log.push({
      at: "prompt",
      response: await client.request({
        type: "prompt",
        message: "Read the file DOES_NOT_EXIST.txt and also run `exit 3` with bash. Report what happened in under 25 words.",
      }),
    });
    log.push({ settled: await waitFor(client, "agent_settled", 180_000) });
  } finally {
    await saveScenario("tool-error", client, sessionDir, log);
    await client.shutdown();
  }
});

// 3. Long output: seq 1 300.
await scenario("long-output", root, async (cwd) => {
  const { client, sessionDir } = await freshClient(cwd, "harvest-longout");
  const log: unknown[] = [];
  try {
    log.push({
      at: "prompt",
      response: await client.request({
        type: "prompt",
        message: "Run `seq 1 300` with bash and reply with only the count of lines, nothing else.",
      }),
    });
    log.push({ settled: await waitFor(client, "agent_settled", 180_000) });
  } finally {
    await saveScenario("long-output", client, sessionDir, log);
    await client.shutdown();
  }
});

// 4. Steer + follow-up on a slow task.
await scenario("steer-followup", root, async (cwd) => {
  const { client, sessionDir } = await freshClient(cwd, "harvest-steer");
  const log: unknown[] = [];
  try {
    const admitted = await client.request({
      type: "prompt",
      message: "Count slowly from 1 to 30, one number per line, using bash `for i in $(seq 1 30); do echo $i; sleep 0.4; done`. Then say done.",
    });
    log.push({ at: "prompt-accepted", response: admitted });
    await Bun.sleep(4000);
    try {
      log.push({ at: "steer", response: await client.request({ type: "steer", message: "Also say STEERED at the end." }) });
    } catch (error) {
      log.push({ at: "steer", error: String(error) });
    }
    try {
      log.push({ at: "follow_up", response: await client.request({ type: "follow_up", message: "Reply with exactly FOLLOWED." }) });
    } catch (error) {
      log.push({ at: "follow_up", error: String(error) });
    }
    log.push({ settled: await waitFor(client, "agent_settled", 180_000) });
    try {
      log.push({ at: "modes", steering: await client.request({ type: "set_steering_mode", mode: "one-at-a-time" }) });
    } catch (error) {
      log.push({ at: "modes", error: String(error) });
    }
  } finally {
    await saveScenario("steer-followup", client, sessionDir, log);
    await client.shutdown();
  }
});

// 5. Abort mid-stream.
await scenario("abort", root, async (cwd) => {
  const { client, sessionDir } = await freshClient(cwd, "harvest-abort");
  const log: unknown[] = [];
  try {
    log.push({
      at: "prompt",
      response: await client.request({
        type: "prompt",
        message: "Explain distributed consensus in great detail, at least 800 words. Be thorough and verbose.",
      }),
    });
    await waitFor(client, "agent_start", 60_000);
    await Bun.sleep(5000);
    try {
      log.push({ at: "abort", response: await client.request({ type: "abort" }) });
    } catch (error) {
      log.push({ at: "abort", error: String(error) });
    }
    log.push({ settled: await waitFor(client, "agent_settled", 120_000) });
    try {
      const state = await client.request({ type: "get_state" });
      log.push({ at: "get_state-end", response: state, isStreaming: (state.data as { isStreaming?: unknown })?.isStreaming });
    } catch (error) {
      log.push({ at: "get_state-end", error: String(error) });
    }
  } finally {
    await saveScenario("abort", client, sessionDir, log);
    await client.shutdown();
  }
});

// 6. Compaction: build context over several turns, then compact.
await scenario("compaction", root, async (cwd) => {
  const bigFile = Array.from({ length: 150 }, (_, i) => `Record ${i + 1}: fixture inventory line with some descriptive text for token bulk.`).join("\n");
  await writeFile(join(cwd, "INVENTORY.txt"), bigFile);
  const { client, sessionDir } = await freshClient(cwd, "harvest-compact");
  const log: unknown[] = [];
  try {
    for (let i = 1; i <= 3; i++) {
      log.push({
        at: `prompt-${i}`,
        response: await client.request({
          type: "prompt",
          message: `Turn ${i}: read INVENTORY.txt and summarize records ${(i - 1) * 50 + 1} to ${i * 50} in a few sentences.`,
        }),
      });
      await waitFor(client, "agent_settled", 180_000);
      client.events.length = 0; // keep per-turn events bounded; session file retains all
    }
    try {
      log.push({ at: "compact", response: await client.request({ type: "compact" }) });
      await waitFor(client, "agent_settled", 180_000);
    } catch (error) {
      log.push({ at: "compact", error: String(error) });
    }
  } finally {
    await saveScenario("compaction", client, sessionDir, log);
    await client.shutdown();
  }
});

// 7. Thinking levels: low then back.
await scenario("thinking-levels", root, async (cwd) => {
  const { client, sessionDir } = await freshClient(cwd, "harvest-thinking");
  const log: unknown[] = [];
  try {
    try {
      log.push({ at: "set-low", response: await client.request({ type: "set_thinking_level", level: "low" }) });
    } catch (error) {
      log.push({ at: "set-low", error: String(error) });
    }
    log.push({ at: "prompt", response: await client.request({ type: "prompt", message: "Reply with exactly the word PASSAGE" }) });
    log.push({ settled: await waitFor(client, "agent_settled", 120_000) });
    try {
      log.push({ at: "set-high", response: await client.request({ type: "set_thinking_level", level: "high" }) });
    } catch (error) {
      log.push({ at: "set-high", error: String(error) });
    }
  } finally {
    await saveScenario("thinking-levels", client, sessionDir, log);
    await client.shutdown();
  }
});

// 8. Extension UI: attempt to trigger a select dialog via ask_user_question.
await scenario("extension-ui", root, async (cwd) => {
  const { client, sessionDir } = await freshClient(cwd, "harvest-extui");
  const log: unknown[] = [];
  try {
    log.push({
      at: "prompt",
      response: await client.request({
        type: "prompt",
        message: "Use the ask_user_question tool to ask me which fixture to write next, offering options Alpha and Beta. Wait for my answer.",
      }),
    });
    const sawDialog = await waitFor(client, "extension_ui_request", 120_000);
    log.push({ sawDialog });
    if (sawDialog) {
      const dialog = client.events.find((e) => e.type === "extension_ui_request");
      log.push({ dialog });
      await Bun.sleep(2000);
      try {
        log.push({ at: "abort", response: await client.request({ type: "abort" }) });
      } catch (error) {
        log.push({ at: "abort", error: String(error) });
      }
      await waitFor(client, "agent_settled", 120_000);
    } else {
      await waitFor(client, "agent_settled", 120_000);
    }
  } finally {
    await saveScenario("extension-ui", client, sessionDir, log);
    await client.shutdown();
  }
});

console.log(`harvest root (inspect, then delete): ${root}`);
