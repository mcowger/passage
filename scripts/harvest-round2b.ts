/**
 * Round 2b: custom-answer path — answer the select with the free-text row,
 * capture the `input` follow-up, answer it, let the run settle.
 * Usage: PASSAGE_PI_LIVE=real bun scripts/harvest-round2b.ts
 */
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PiRpcClient } from "../tests/pi-rpc/client.ts";

const OUT_ROOT = "/tmp/pi-fixture-raw";
const root = join(tmpdir(), `pi-harvest-r2b-${Date.now()}`);
await mkdir(root, { recursive: true });

function waitFor(client: PiRpcClient, pred: (e: { type?: string; [k: string]: unknown }) => boolean, timeoutMs: number) {
  return (async () => {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (client.events.some(pred)) return true;
      await Bun.sleep(250);
    }
    return false;
  })();
}

{
  const cwd = join(root, "ext-custom");
  const sessionDir = join(root, "sessions", "harvest-extcustom");
  await mkdir(cwd, { recursive: true });
  await mkdir(sessionDir, { recursive: true });
  const client = new PiRpcClient({ cwd, sessionDir, sessionId: "harvest-extcustom" });
  const log: unknown[] = [];
  try {
    log.push({ at: "prompt", response: await client.request({ type: "prompt", message: "Use the ask_user_question tool to ask me which fixture to write next, offering options Alpha and Beta. Wait for my answer before doing anything else." }) });
    const sawSelect = await waitFor(client, (e) => e.type === "extension_ui_request" && (e as { method?: string }).method === "select", 120_000);
    log.push({ sawSelect });
    const dialog = client.events.find((e) => e.type === "extension_ui_request" && (e as unknown as { method?: string }).method === "select") as unknown as { id?: string; options?: unknown } | undefined;
    const escape = Array.isArray(dialog?.options) ? (dialog.options as unknown[]).find((o) => typeof o === "string" && /type something/i.test(o)) : undefined;
    log.push({ escape });
    if (dialog?.id && typeof escape === "string") {
      client.process.stdin.write(JSON.stringify({ type: "extension_ui_response", id: dialog.id, value: escape }) + "\n");
      log.push({ answeredSelect: escape });
      const sawInput = await waitFor(client, (e) => e.type === "extension_ui_request" && (e as { method?: string }).method === "input", 120_000);
      log.push({ sawInput });
      const input = client.events.filter((e) => e.type === "extension_ui_request").at(-1) as unknown as { id?: string; method?: string; prompt?: unknown; placeholder?: unknown } | undefined;
      log.push({ inputDialog: input });
      if (sawInput && input?.id) {
        client.process.stdin.write(JSON.stringify({ type: "extension_ui_response", id: input.id, value: "Gamma" }) + "\n");
        log.push({ answeredInput: "Gamma" });
      }
      await waitFor(client, (e) => e.type === "agent_settled", 120_000);
    }
  } finally {
    const outDir = join(OUT_ROOT, "extension-custom");
    await mkdir(outDir, { recursive: true });
    await writeFile(join(outDir, "rpc-events.json"), JSON.stringify(client.events, null, 2));
    await writeFile(join(outDir, "driver-log.json"), JSON.stringify(log, null, 2));
    for (const f of await readdir(sessionDir)) {
      await writeFile(join(outDir, `session-${f}`), await readFile(join(sessionDir, f)));
    }
    console.log(`[saved extension-custom] events=${client.events.length} types=${[...new Set(client.events.map((e) => e.type))].join(",")}`);
    await client.shutdown();
  }
}
console.log(`round2b root (inspect, then delete): ${root}`);
