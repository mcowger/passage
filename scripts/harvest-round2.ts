/**
 * Round 2 harvest: real extension select dialog + successful compaction.
 * Usage: PASSAGE_PI_LIVE=real bun scripts/harvest-round2.ts
 */
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PiRpcClient } from "../tests/pi-rpc/client.ts";

const OUT_ROOT = "/tmp/pi-fixture-raw";
const root = join(tmpdir(), `pi-harvest-r2-${Date.now()}`);
await mkdir(root, { recursive: true });

async function waitForMatch(client: PiRpcClient, pred: (e: { type?: string; [k: string]: unknown }) => boolean, timeoutMs: number) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (client.events.some(pred)) return true;
    await Bun.sleep(250);
  }
  return false;
}

async function save(name: string, client: PiRpcClient, sessionDir: string, log: unknown[]) {
  const outDir = join(OUT_ROOT, name);
  await mkdir(outDir, { recursive: true });
  await writeFile(join(outDir, "rpc-events.json"), JSON.stringify(client.events, null, 2));
  await writeFile(join(outDir, "driver-log.json"), JSON.stringify(log, null, 2));
  for (const f of await readdir(sessionDir)) {
    await writeFile(join(outDir, `session-${f}`), await readFile(join(sessionDir, f)));
  }
  console.log(`[saved ${name}] events=${client.events.length} types=${[...new Set(client.events.map((e) => e.type))].join(",")}`);
}

// --- A. extension select dialog, answered properly ---
{
  const cwd = join(root, "ext-select");
  const sessionDir = join(root, "sessions", "harvest-extselect");
  await mkdir(cwd, { recursive: true });
  await mkdir(sessionDir, { recursive: true });
  const client = new PiRpcClient({ cwd, sessionDir, sessionId: "harvest-extselect" });
  const log: unknown[] = [];
  try {
    log.push({ at: "prompt", response: await client.request({ type: "prompt", message: "Use the ask_user_question tool to ask me which fixture to write next, offering options Alpha and Beta. Wait for my answer before doing anything else." }) });
    const sawSelect = await waitForMatch(
      client,
      (e) => e.type === "extension_ui_request" && (e as { method?: string }).method === "select",
      120_000,
    );
    log.push({ sawSelect });
    if (sawSelect) {
      const dialog = client.events.find((e) => e.type === "extension_ui_request" && (e as unknown as { method?: string }).method === "select");
      log.push({ dialog });
      // Answer with the first option via raw RPC (PiRpcClient has no UI helper).
      const id = (dialog as unknown as { id?: string })?.id;
      const options = (dialog as unknown as { options?: unknown })?.options;
      log.push({ dialogId: id, options });
      if (id && Array.isArray(options) && typeof options[0] === "string") {
        client.process.stdin.write(JSON.stringify({ type: "extension_ui_response", id, value: options[0] }) + "\n");
        log.push({ answered: options[0] });
      }
      await waitForMatch(client, (e) => e.type === "agent_settled", 120_000);
    } else {
      await waitForMatch(client, (e) => e.type === "agent_settled", 120_000);
    }
  } finally {
    await save("extension-select", client, sessionDir, log);
    await client.shutdown();
  }
}

// --- B. bulk context then compact ---
{
  const cwd = join(root, "bulk");
  const sessionDir = join(root, "sessions", "harvest-bulkcompact");
  await mkdir(cwd, { recursive: true });
  await mkdir(sessionDir, { recursive: true });
  // 6 data files x ~350 lines of chunky text (~2.5k tokens each readable unit).
  for (let f = 1; f <= 6; f++) {
    const lines = Array.from({ length: 350 }, (_, i) => `DATASET-${f} record ${i + 1}: identifier FX-${f}-${String(i + 1).padStart(4, "0")}, status nominal, checksum ${((i * 2654435761) >>> 0).toString(16)}, notes field with filler prose for token bulk and nothing sensitive.`);
    await writeFile(join(cwd, `DATA-${f}.txt`), lines.join("\n"));
  }
  const client = new PiRpcClient({ cwd, sessionDir, sessionId: "harvest-bulkcompact" });
  const log: unknown[] = [];
  try {
    const tasks = [
      "Read DATA-1.txt and DATA-2.txt fully, then report record counts and the first and last identifier of each file.",
      "Read DATA-3.txt and DATA-4.txt fully, then report record counts and how many checksums start with the letter a.",
      "Read DATA-5.txt and DATA-6.txt fully, then report record counts and the longest identifier seen.",
      "Re-read DATA-1.txt and DATA-3.txt and cross-check: do any identifiers appear in both files? Report the method and result in detail.",
      "Run `grep -c nominal DATA-*.txt` and `wc -l DATA-*.txt` with bash, then give a per-file table of line counts and nominal counts.",
      "Summarize everything learned about all six datasets so far in at least 300 words, quoting several identifiers.",
    ];
    for (let i = 0; i < tasks.length; i++) {
      log.push({ at: `prompt-${i + 1}`, response: await client.request({ type: "prompt", message: tasks[i] }) });
      await waitForMatch(client, (e) => e.type === "agent_settled", 240_000);
      client.events.length = 0;
    }
    try {
      log.push({ at: "compact", response: await client.request({ type: "compact" }) });
      await waitForMatch(client, (e) => e.type === "agent_settled", 240_000);
    } catch (error) {
      log.push({ at: "compact", error: String(error) });
    }
  } finally {
    await save("compaction-full", client, sessionDir, log);
    await client.shutdown();
  }
}

console.log(`round2 root (inspect, then delete): ${root}`);
