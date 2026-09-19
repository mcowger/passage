/**
 * One-shot live harvest of real Pi RPC + JSONL shapes for fixture authoring.
 * Output goes to /tmp (gitignored) as raw material — never committed directly.
 * Usage: bun scripts/capture-pi-fixture.ts <scenario> (basic | tools | compact)
 */
import { mkdtemp, mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PiRpcClient } from "../tests/pi-rpc/client.ts";

const scenario = process.argv[2] ?? "basic";
const root = await mkdtemp(join(tmpdir(), "pi-fixture-harvest-"));
const cwd = join(root, "workspace");
const sessionDir = join(root, "sessions");
await mkdir(cwd, { recursive: true });
await mkdir(sessionDir, { recursive: true });
await writeFile(join(cwd, ".keep"), "");

const sessionId = `harvest-${scenario}`;
const client = new PiRpcClient({ cwd, sessionDir, sessionId });
const log: unknown[] = [];
const origReceive = (client as unknown as { receive: (r: unknown) => void }).receive.bind(client);

try {
  const state = await client.request({ type: "get_state" });
  log.push({ at: "get_state", response: state });
  console.log("session:", JSON.stringify((state.data as { sessionId?: string; sessionFile?: string })?.sessionId));

  if (scenario === "basic") {
    const prompt = await client.request({ type: "prompt", message: "Reply with exactly the word PASSAGE" });
    log.push({ at: "prompt-accepted", response: prompt });
    await waitFor(client, "agent_settled", 120_000);
  } else if (scenario === "tools") {
    const prompt = await client.request({
      type: "prompt",
      message: "Create file FIXTURE_NOTE.txt containing exactly the text 'fixture hello' then run `echo fixture-done` with bash. Keep your final message under 20 words.",
    });
    log.push({ at: "prompt-accepted", response: prompt });
    await waitFor(client, "agent_settled", 180_000);
  } else if (scenario === "compact") {
    const prompt = await client.request({ type: "prompt", message: "Reply with exactly the word PASSAGE" });
    log.push({ at: "prompt-accepted", response: prompt });
    await waitFor(client, "agent_settled", 120_000);
    const compact = await client.request({ type: "compact" });
    log.push({ at: "compact-accepted", response: compact });
    await waitForTypeAfter(client, "compaction_end", 120_000);
    await waitFor(client, "agent_settled", 120_000);
  }

  const endState = await client.request({ type: "get_state" });
  log.push({ at: "get_state-end", response: endState });

  const outDir = join("/tmp", `pi-fixture-raw-${scenario}`);
  await mkdir(outDir, { recursive: true });
  await writeFile(join(outDir, "rpc-events.json"), JSON.stringify(client.events, null, 2));
  await writeFile(join(outDir, "driver-log.json"), JSON.stringify(log, null, 2));
  // Copy session JSONL files
  for (const f of await readdir(sessionDir)) {
    const content = await readFile(join(sessionDir, f));
    await writeFile(join(outDir, `session-${f}`), content);
  }
  console.log(`wrote ${outDir}`);
  console.log(`events: ${client.events.length} types: ${[...new Set(client.events.map((e) => e.type))].join(",")}`);
  console.log(`workspace root (inspect, then delete): ${root}`);
} finally {
  await client.shutdown();
}

async function waitFor(client: PiRpcClient, type: string, timeoutMs: number) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (client.events.some((e) => e.type === type)) return;
    await Bun.sleep(250);
  }
  throw new Error(`timed out waiting for ${type}`);
}

async function waitForTypeAfter(client: PiRpcClient, type: string, timeoutMs: number) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (client.events.some((e) => e.type === type)) return;
    await Bun.sleep(250);
  }
  console.log(`note: no ${type} observed; continuing`);
}
