/**
 * Synthesize committed fixtures from raw live harvests in /tmp/pi-fixture-raw*.
 * Deterministic structural remap + hand-approved prose table. Fails loudly on
 * anything unmapped (new shapes must be a deliberate choice, not silent passthrough).
 *
 * Usage: bun scripts/synthesize-fixtures.ts
 * Output: tests/fixtures/pi/{history/*.jsonl, manifest.json} (RPC scripts follow separately)
 */
import { createHash } from "node:crypto";
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

const RAW = "/tmp/pi-fixture-raw";
const OUT = new URL("../tests/fixtures/pi/history/", import.meta.url).pathname;

// Fixed fixture clock: base + 1s per record in file order.
const BASE_MS = Date.UTC(2026, 0, 1, 0, 0, 0);
let clock = 0;
const tick = () => new Date(BASE_MS + clock++ * 1000).toISOString();

// ---- deterministic ID remap (encounter order, chain-preserving) ----
const idMap = new Map<string, string>();
let entryCounter = 0;
function remapId(raw: string): string {
  let mapped = idMap.get(raw);
  if (!mapped) {
    entryCounter += 1;
    mapped = `e${entryCounter}`;
    idMap.set(raw, mapped);
  }
  return mapped;
}
let toolCounter = 0;
let msgCounter = 0;
const toolIdMap = new Map<string, string>();
function remapToolId(raw: string): string {
  // Preserve the real compound `call_<hex>|fc_<hex>` shape with fake hex.
  // Memoized: a toolResult must resolve to the same fixture ID as its call.
  const known = toolIdMap.get(raw);
  if (known) return known;
  toolCounter += 1;
  const hex = toolCounter.toString(16).padStart(32, "a");
  const fake = /^call_[0-9a-f]+\|fc_[0-9a-f]+$/.test(raw) ? `call_${hex}|fc_${hex}` : `tool-${toolCounter}`;
  toolIdMap.set(raw, fake);
  return fake;
}

// ---- sensitive-value guards ----
function scrubString(s: string, ctx: string): string {
  s = maybeTruncate(s);
  if (s.includes("/tmp/pi-harvest") || s.includes("/tmp/pi-fixture-harvest") || s.includes("/tmp/pi-probe")) {
    s = s.replace(/\/tmp\/pi-[a-z0-9-]+\/[a-z0-9-]+/g, "/fixture").replace(/\/tmp\/[^\s\"']*/g, "/fixture");
  }
  if (s.includes(".home.cowger.us")) s = s.split("https://plexus.home.cowger.us").join("https://fixture-model.local");
  if (/\/home\/[a-z_.]+/.test(s)) throw new Error(`home path leaked in ${ctx}: ${s.slice(0, 120)}`);
  if (/\/Users\//.test(s)) throw new Error(`macOS home path leaked in ${ctx}`);
  return s;
}

// ---- hand-approved prose: [scenario, role, index] -> replacement (undefined = keep) ----
// All harvest prompts were already synthetic; assistant outputs below are kept
// only when generic, else replaced with deliberately fake text of similar size.
const PROSE = new Map<string, string>([
  ["steer-followup|assistant|thinking|Evaluating whether to use process start",
    "Considering how to run the counting loop within this turn."],
  ["steer-followup|assistant|thinking|Appending the requested final token",
    "Adding the steered closing token after the counting output."],
  ["abort|assistant|text|Distributed consensus is one of",
    "Fixture consensus essay lead sentence one. Fixture consensus essay lead sentence two."],
  ["basic|assistant|thinking|", ""],
  ["tools|assistant|thinking|", ""],
]);

function proseFor(scenario: string, role: string, kind: string, text: string): string {
  if (text === "") return "";
  for (const [key, replacement] of PROSE) {
    const [s, r, k, prefix] = key.split("|");
    if (s === scenario && r === role && k === kind && text.startsWith(prefix)) {
      if (kind === "text" && replacement !== "" && !text.startsWith(replacement)) {
        // Keep short generic outputs whole; only the known-long ones are replaced.
        return replacement;
      }
      return replacement;
    }
  }
  // Default: keep — harvest content was synthetic by construction. The manual
  // review step before commit is the backstop for anything surprising.
  return text;
}

// compaction-full carries ~800KB of echoed dataset content in tool args/results.
// The compaction regression needs structure + linkage, not bulk (bulk lives in
// long-output.jsonl), so cap long strings for that scenario only.
const TRUNC_SCENARIOS = new Set(["compaction-full"]);
let activeScenario = "";
function maybeTruncate(s: string): string {
  if (TRUNC_SCENARIOS.has(activeScenario) && s.length > 500) {
    return `${s.slice(0, 200)}\n…[fixture trimmed ${s.length} chars to 200]`;
  }
  return s;
}

function scrubValue(value: unknown, ctx: string): unknown {
  if (typeof value === "string") return scrubString(value, ctx);
  if (Array.isArray(value)) return value.map((v) => scrubValue(v, ctx));
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, scrubValue(v, `${ctx}.${k}`)]));
  }
  return value;
}

function sanitizeContentBlock(block: unknown, scenario: string, role: string): unknown {
  if (!block || typeof block !== "object" || Array.isArray(block)) return scrubValue(block, `${scenario}.block`);
  const b = { ...(block as Record<string, unknown>) };
  if (b.type === "thinking") {
    if (typeof b.thinking === "string") b.thinking = proseFor(scenario, role, "thinking", b.thinking);
    if (typeof b.thinkingSignature === "string") b.thinkingSignature = '{"encrypted_content":"FIXTURE"}';
  }
  if (b.type === "text" && typeof b.text === "string") b.text = proseFor(scenario, role, "text", b.text);
  if (typeof b.textSignature === "string") { msgCounter += 1; b.textSignature = `{"v":1,"id":"msg_fixture${String(msgCounter).padStart(4, "0")}"}`; }
  if (typeof b.timestamp === "number") b.timestamp = BASE_MS + clock * 1000;
  if (b.type === "toolCall") {
    if (typeof b.id === "string") b.id = remapToolId(b.id);
    b.arguments = scrubValue(b.arguments, `${scenario}.args`);
  }
  return scrubValue(b, `${scenario}.block-rest`);
}

function sanitizeMessageObject(raw: Record<string, unknown>, scenario: string): Record<string, unknown> {
  const m = { ...raw };
  const role = m.role as string;
  if (role === "system") {
    m.content = "";
    m.sections = { preamble: "Fixture system preamble.", tools: "Fixture tool catalog." };
    // toolsAdded carries the full local tool inventory (26 tools with
    // descriptions and schemas). Keep a 2-tool skeleton preserving shape.
    m.toolsAdded = [
      { name: "read", description: "Fixture read tool.", parameters: "{'type': 'object'}", constrainedSampling: "{'type': 'json_schema'}" },
      { name: "bash", description: "Fixture bash tool.", parameters: "{'type': 'object'}", constrainedSampling: "{'type': 'json_schema'}" },
    ];
    if (typeof m.timestamp === "number") m.timestamp = BASE_MS;
    return m;
  }
  const content = m.content;
  m.content = Array.isArray(content)
    ? content.map((b) => sanitizeContentBlock(b, scenario, role))
    : sanitizeContentBlock(content, scenario, role);
  if (typeof m.toolCallId === "string") m.toolCallId = remapToolId(m.toolCallId);
  if (typeof m.responseId === "string") { msgCounter += 1; m.responseId = `resp_fixture${String(msgCounter).padStart(4, "0")}`; }
  if (typeof m.timestamp === "number") m.timestamp = BASE_MS + clock * 1000;
  return scrubValue(m, `${scenario}.message`) as Record<string, unknown>;
}

function sanitizeSessionRecord(raw: Record<string, unknown>, scenario: string): Record<string, unknown> {
  const r = { ...raw };
  if (typeof r.id === "string") r.id = remapId(r.id);
  if (typeof r.parentId === "string") r.parentId = remapId(r.parentId);
  if (typeof r.timestamp === "string") r.timestamp = tick();
  switch (r.type) {
    case "session":
      return { type: "session", version: r.version, id: `fixture-${scenario}`, timestamp: r.timestamp, cwd: "/fixture" };
    case "model_change":
    case "thinking_level_change":
      return scrubValue(r, scenario) as Record<string, unknown>;
    case "message": {
      const m = sanitizeMessageObject(r.message as Record<string, unknown>, scenario);
      return { ...scrubValue({ ...r, message: undefined }, scenario) as Record<string, unknown>, message: m };
    }
    case "compaction": {
      // summary/systemMessage carry session-specific content (71KB rebuilt
      // prompt in the raw capture). Keep shape + accounting, fake the prose.
      return {
        ...scrubValue({ ...r, summary: undefined, systemMessage: undefined, details: undefined }, scenario) as Record<string, unknown>,
        firstKeptEntryId: remapId(String(r.firstKeptEntryId)),
        summary: "Fixture compaction summary: synthetic datasets surveyed, record counts noted, cross-checks recorded. Ready to continue.",
        systemMessage: "Fixture compacted system prompt.",
        details: { compactor: "pi-vcc", version: 2, sections: ["Session Goal", "Files And Changes"], sourceMessageCount: r.details ? (r.details as Record<string, unknown>).sourceMessageCount : 0, previousSummaryUsed: false, reason: "manual", willRetry: false },
      };
    }
    default:
      throw new Error(`unmapped session entry type in ${scenario}: ${String(r.type)} (add a deliberate case)`);
  }
}

const SCENARIOS = ["basic", "tools", "tool-error", "long-output", "edit-flow", "abort", "steer-followup", "thinking-levels", "compaction-full"] as const;
const HISTORY_NAME: Record<(typeof SCENARIOS)[number], string> = {
  basic: "basic-settled",
  tools: "sequential-tools",
  "tool-error": "tool-error",
  "long-output": "long-output",
  "edit-flow": "significant-edit",
  abort: "aborted-run",
  "steer-followup": "steer-followup",
  "thinking-levels": "thinking-levels",
  "compaction-full": "compaction",
};

await mkdir(OUT, { recursive: true });
const manifestEntries: unknown[] = [];

for (const scenario of SCENARIOS) {
  activeScenario = scenario;
  idMap.clear();
  toolIdMap.clear();
  entryCounter = 0;
  toolCounter = 0;
  clock = 0;
  // Round-1 harvests live at /tmp/pi-fixture-raw-<scenario>/, harvest-all at /tmp/pi-fixture-raw/<scenario>/.
  const dir = scenario === "basic" || scenario === "tools" ? `${RAW}-${scenario}` : join(RAW, scenario);
  const files = (await readdir(dir)).filter((f) => f.startsWith("session-"));
  if (files.length !== 1) throw new Error(`${scenario}: expected 1 session file, found ${files.length}`);
  const lines = (await readFile(join(dir, files[0]), "utf8")).split("\n").filter(Boolean);
  const out = lines.map((line) => JSON.stringify(sanitizeSessionRecord(JSON.parse(line) as Record<string, unknown>, scenario))).join("\n") + "\n";
  const name = `${HISTORY_NAME[scenario]}.jsonl`;
  await writeFile(join(OUT, name), out);
  const hash = createHash("sha256").update(out).digest("hex");
  manifestEntries.push({ name, scenario, kind: "history", bytes: out.length, sha256: hash });
  console.log(`wrote history/${name} (${out.length} bytes, sha256 ${hash.slice(0, 12)}…)`);
}

console.log("history done");

// ================= RPC scenarios =================
const RPC_OUT = new URL("../tests/fixtures/pi/rpc/", import.meta.url).pathname;
await mkdir(RPC_OUT, { recursive: true });

let dialogCounter = 0;
function remapDialogId(): string {
  dialogCounter += 1;
  return `fixture-dialog-${dialogCounter}`;
}

function sanitizeRpcEvent(raw: Record<string, unknown>, scenario: string): Record<string, unknown> | null {
  const ev = { ...raw };
  delete ev.sequence;
  delete ev.generation;
  if (ev.type === "extension_ui_request" && (ev.method === "setStatus" || ev.method === "setWidget")) {
    return null; // startup widget noise from locally loaded packages; not scenario signal
  }
  if (typeof ev.id === "string" && ev.type === "extension_ui_request") ev.id = remapDialogId();
  if (typeof ev.toolCallId === "string") ev.toolCallId = remapToolId(ev.toolCallId);
  if (ev.message && typeof ev.message === "object") ev.message = sanitizeMessageObject(ev.message as Record<string, unknown>, scenario);
  if (ev.messages && Array.isArray(ev.messages)) {
    ev.messages = (ev.messages as unknown[]).map((m) => sanitizeMessageObject(m as Record<string, unknown>, scenario));
  }
  const ame = ev.assistantMessageEvent as Record<string, unknown> | undefined;
  if (ame && typeof ame === "object") {
    if (typeof ame.id === "string") ame.id = remapToolId(ame.id);
    if (ame.toolCall && typeof ame.toolCall === "object") {
      const tc = { ...(ame.toolCall as Record<string, unknown>) };
      if (typeof tc.id === "string") tc.id = remapToolId(tc.id);
      tc.arguments = scrubValue(tc.arguments, `${scenario}.tc-args`);
      ame.toolCall = tc;
    }
  }
  if (Array.isArray(ev.toolResults)) {
    ev.toolResults = (ev.toolResults as unknown[]).map((t) => {
      const tr = { ...(t as Record<string, unknown>) };
      if (typeof tr.timestamp === "number") tr.timestamp = BASE_MS + clock * 1000;
      return scrubValue(tr, `${scenario}.toolresult`);
    });
  }
  if (ev.args && typeof ev.args === "object") ev.args = scrubValue(ev.args, `${scenario}.exec-args`);
  if (ev.result && typeof ev.result === "object") ev.result = scrubValue(ev.result, `${scenario}.exec-result`);
  if (ev.partialResult && typeof ev.partialResult === "object") ev.partialResult = scrubValue(ev.partialResult, `${scenario}.exec-partial`);
  return scrubValue(ev, `${scenario}.event`) as Record<string, unknown>;
}

function loadRawEvents(scenario: string): Record<string, unknown>[] {
  const dir = scenario === "basic" || scenario === "tools" ? `${RAW}-${scenario}` : join(RAW, scenario);
  return JSON.parse(readFileSync(join(dir, "rpc-events.json"), "utf8")) as Record<string, unknown>[];
}
import { readFileSync } from "node:fs";

function resetMaps() {
  idMap.clear();
  toolIdMap.clear();
  entryCounter = 0;
  toolCounter = 0;
  msgCounter = 0;
  dialogCounter = 0;
  clock = 0;
}

function ack(command: string): Record<string, unknown> {
  return { type: "response", id: "$id", command, success: true };
}

// Canonical get_state response, cloned from the real basic-capture admission
// state (same model/thinking/queue modes for every scenario) with session
// identity templated. Built once — several harvests never logged get_state.
let canonicalState: Record<string, unknown> | undefined;
function getStateStep(scenario: string): Record<string, unknown> {
  if (!canonicalState) {
    const raw = JSON.parse(readFileSync(join(`${RAW}-basic`, "driver-log.json"), "utf8")) as Array<Record<string, unknown>>;
    const entry = raw.find((e) => e.at === "get_state" && e.response);
    if (!entry) throw new Error("basic harvest lacks get_state");
    const response = JSON.parse(JSON.stringify(entry.response)) as Record<string, unknown>;
    const data = response.data as Record<string, unknown>;
    data.sessionId = "$sessionId";
    data.sessionFile = "$sessionDir/$sessionId.jsonl";
    data.messageCount = 0;
    data.pendingMessageCount = 0;
    data.isStreaming = false;
    data.isCompacting = false;
    canonicalState = response;
  }
  const response = JSON.parse(JSON.stringify(canonicalState)) as Record<string, unknown>;
  response.id = "$id";
  return { expect: { type: "get_state" }, respond: scrubValue(response, `${scenario}.state`) as Record<string, unknown> };
}

const rpcManifest: unknown[] = [];
function writeRpc(name: string, scenario: string, steps: Record<string, unknown>[], sessionFixture?: string, note?: string) {
  const doc = { name, scenario, ...(sessionFixture ? { sessionFixture } : {}), ...(note ? { note } : {}), steps };
  const out = JSON.stringify(doc, null, 2) + "\n";
  const path = join(RPC_OUT, `${name}.json`);
  require("node:fs").writeFileSync(path, out);
  rpcManifest.push({ name, scenario, steps: steps.length, bytes: out.length, sha256: createHash("sha256").update(out).digest("hex") });
  console.log(`wrote rpc/${name}.json (${steps.length} steps, ${out.length} bytes)`);
}
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);

// --- prompt-stream (basic) + sequential-tools (tools): get_state, prompt, full emission ---
for (const [scenario, name] of [["basic", "prompt-stream"], ["tools", "sequential-tools"]] as const) {
  resetMaps();
  const dir = `${RAW}-${scenario}`;
  const events = loadRawEvents(scenario).map((e) => sanitizeRpcEvent(e, scenario)).filter((e) => e !== null);
  const promptText = scenario === "basic" ? "Reply with exactly the word PASSAGE" : undefined;
  writeRpc(name, scenario, [
    getStateStep(scenario),
    {
      expect: promptText ? { type: "prompt", match: { message: promptText } } : { type: "prompt" },
      respond: ack("prompt"),
      emit: events,
    },
  ], `../history/${HISTORY_NAME[scenario]}.jsonl`);
}

// --- abort-settlement: prompt emits up to 3rd text delta, abort emits the rest ---
{
  resetMaps();
  const scenario = "abort";
  const dir = join(RAW, scenario);
  const events = loadRawEvents(scenario).map((e) => sanitizeRpcEvent(e, scenario)).filter((e) => e !== null) as Record<string, unknown>[];
  const updates = events.filter((e) => e.type === "message_update");
  const splitAt = events.indexOf(updates[3] ?? updates.at(-1)!);
  writeRpc("abort-settlement", scenario, [
    getStateStep(scenario),
    {
      expect: { type: "prompt" },
      respond: ack("prompt"),
      emit: events.slice(0, splitAt),
    },
    { expect: { type: "abort" }, respond: ack("abort"), emit: events.slice(splitAt) },
  ], "../history/aborted-run.jsonl", "prompt emission truncated at 3rd text delta; abort step carries the aborted tail");
}

// --- steer-followup: split at queue_update and second turn_end; trim bash partial spam ---
{
  resetMaps();
  const scenario = "steer-followup";
  const dir = join(RAW, scenario);
  let events = loadRawEvents(scenario).map((e) => sanitizeRpcEvent(e, scenario)).filter((e) => e !== null) as Record<string, unknown>[];
  // Keep first 2 + last partialResult update; the 30-number loop is one ordered barrier either way.
  const partialIdx = events.map((e, i) => (e.type === "tool_execution_update" ? i : -1)).filter((i) => i >= 0);
  const drop = new Set(partialIdx.slice(2, -1));
  events = events.filter((_, i) => !drop.has(i));
  const firstQueue = events.findIndex((e) => e.type === "queue_update");
  const turnEnds = events.map((e, i) => (e.type === "turn_end" ? i : -1)).filter((i) => i >= 0);
  const followSplit = turnEnds[1] !== undefined ? turnEnds[1] + 1 : turnEnds[0] + 1;
  writeRpc("prompt-steer-follow-up", scenario, [
    getStateStep(scenario),
    { expect: { type: "prompt" }, respond: ack("prompt"), emit: events.slice(0, firstQueue) },
    { expect: { type: "steer" }, respond: ack("steer"), emit: events.slice(firstQueue, followSplit) },
    { expect: { type: "follow_up" }, respond: ack("follow_up"), emit: events.slice(followSplit) },
  ], "../history/steer-followup.jsonl", `trimmed ${drop.size} bash partialResult updates; steering/follow-up text kept`);
}

// --- extension flows ---
function extensionSteps(scenario: string, dir: string, withInput: boolean): Record<string, unknown>[] {
  const events = loadRawEvents(scenario).map((e) => sanitizeRpcEvent(e, scenario)).filter((e) => e !== null) as Record<string, unknown>[];
  const selectIdx = events.findIndex((e) => e.type === "extension_ui_request" && (e as { method?: string }).method === "select");
  const inputIdx = events.findIndex((e) => e.type === "extension_ui_request" && (e as { method?: string }).method === "input");
  const steps: Record<string, unknown>[] = [
    getStateStep(scenario),
    { expect: { type: "prompt" }, respond: ack("prompt"), emit: events.slice(0, selectIdx + 1) },
  ];
  if (withInput && inputIdx > 0) {
    steps.push({ expect: { type: "extension_ui_response" }, emit: events.slice(selectIdx + 1, inputIdx + 1) });
    steps.push({ expect: { type: "extension_ui_response" }, emit: events.slice(inputIdx + 1) });
  } else {
    steps.push({ expect: { type: "extension_ui_response" }, emit: events.slice(selectIdx + 1) });
  }
  return steps;
}
{
  resetMaps();
  writeRpc("extension-select", "extension-select", extensionSteps("extension-select", join(RAW, "extension-select"), false));
}
{
  resetMaps();
  writeRpc("extension-custom-answer", "extension-custom", extensionSteps("extension-custom", join(RAW, "extension-custom"), true),
    undefined, "select answered with free-text row; input follow-up carries the typed answer");
}

// --- compact-failure: real refusal shape ---
{
  resetMaps();
  const scenario = "compaction";
  const dir = join(RAW, scenario);
  const events = loadRawEvents(scenario).map((e) => sanitizeRpcEvent(e, scenario)).filter((e) => e !== null);
  writeRpc("compact-refused", scenario, [
    getStateStep(scenario),
    {
      expect: { type: "compact" },
      respond: { type: "response", id: "$id", command: "compact", success: false, error: "Nothing to compact (session too small)" },
      emit: events,
    },
  ], undefined, "compaction_start/end emitted around a failed compact; error string is the real Pi refusal");
}

// --- thinking-levels: set low, prompt, set high ---
{
  resetMaps();
  const scenario = "thinking-levels";
  const dir = join(RAW, scenario);
  const events = loadRawEvents(scenario).map((e) => sanitizeRpcEvent(e, scenario)).filter((e) => e !== null) as Record<string, unknown>[];
  const changedIdx = events.map((e, i) => (e.type === "thinking_level_changed" ? i : -1)).filter((i) => i >= 0);
  const firstChanged = changedIdx[0] ?? 0;
  const secondChanged = changedIdx[1] ?? events.length;
  writeRpc("thinking-levels", scenario, [
    getStateStep(scenario),
    { expect: { type: "set_thinking_level", match: { level: "low" } }, respond: ack("set_thinking_level"), emit: events.slice(0, firstChanged + 1) },
    { expect: { type: "prompt" }, respond: ack("prompt"), emit: events.slice(firstChanged + 1, secondChanged) },
    { expect: { type: "set_thinking_level", match: { level: "high" } }, respond: ack("set_thinking_level"), emit: events.slice(secondChanged) },
  ], "../history/thinking-levels.jsonl");
}

// --- crash-after-response: synthetic (no live kill needed) ---
{
  resetMaps();
  const scenario = "basic";
  const dir = `${RAW}-${scenario}`;
  const stateStep = getStateStep(scenario);
  writeRpc("crash-after-response", "synthetic", [
    stateStep,
    { expect: { type: "prompt" }, respond: ack("prompt"), emit: [{ type: "agent_start" }] },
  ], undefined, "SYNTHETIC: replayer exits 1 with stderr after the prompt step; no live kill was needed");
  // Patch crash semantics onto the doc: stderr + exit code live beside the script.
  const crashPath = join(RPC_OUT, "crash-after-response.json");
  const crashDoc = JSON.parse(readFileSync(crashPath, "utf8")) as Record<string, unknown>;
  crashDoc.stderrLines = ["[pi-rpc] fatal: simulated crash", "Error: connection reset"];
  crashDoc.exitCode = 1;
  require("node:fs").writeFileSync(crashPath, JSON.stringify(crashDoc, null, 2) + "\n");
}

console.log("rpc done");

// ================= unified manifest.json =================
const FIXTURE_META: Record<string, { purpose: string; expects: Record<string, unknown> }> = {
  "history/basic-settled.jsonl": { purpose: "Basic settled turn: session header, model/thinking changes, user/assistant messages, usage.", expects: { roles: ["system", "user", "assistant"], model: "plexus/muse-spark-1.3", contextTokens: 17645 } },
  "history/sequential-tools.jsonl": { purpose: "Sequential tools: write then bash tool-call/result pairing and completed grouping.", expects: { tools: ["write", "bash"], toolStatus: "complete" } },
  "history/tool-error.jsonl": { purpose: "Tool error: ENOENT read and failing bash stay visible as error tool rows.", expects: { tools: ["read", "bash"], toolStatus: "error" } },
  "history/long-output.jsonl": { purpose: "Long output: large bash result for byte limits, paging, and lazy disclosure.", expects: { tools: ["bash"], largeResult: true } },
  "history/significant-edit.jsonl": { purpose: "Significant write/edit: read plus edit tool flow with prominent activity rendering.", expects: { tools: ["read", "edit"], toolStatus: "complete" } },
  "history/aborted-run.jsonl": { purpose: "Aborted run: mid-stream abort tombstone retained with provider terminal error.", expects: { stopReason: "aborted", agentErrorCount: 1 } },
  "history/steer-followup.jsonl": { purpose: "Steer and follow-up as durable user entries on one chain (counting loop, STEERED token, FOLLOWED reply).", expects: { userEntries: 3, finalText: "FOLLOWED" } },
  "history/thinking-levels.jsonl": { purpose: "Thinking levels: low-then-high thinking_level_change entries around a settled turn.", expects: { thinkingLevels: ["low", "high"] } },
  "history/compaction.jsonl": { purpose: "Compaction: real pi-vcc summary entry, firstKept linkage, unknown post-compaction occupancy.", expects: { summaryType: "compaction", contextTokens: null, tokensBefore: 132741 } },
  "history/branch-selection.jsonl": { purpose: "SYNTHETIC: two assistant branches off one user message; explicit leaf vs file-order fallback.", expects: { synthetic: true, branches: ["old", "new"], fileLastId: "meta" } },
  "history/unknown-entry.jsonl": { purpose: "SYNTHETIC: future entry type projects as unknown without exposing its payload.", expects: { synthetic: true, entryType: "future_widget", unknownRecordCount: 1 } },
  "history/partial-tail.jsonl": { purpose: "SYNTHETIC: torn final write flags partialTail without malformed-record noise.", expects: { synthetic: true, partialTail: true, malformedRecordCount: 0 } },
  "rpc/prompt-stream.json": { purpose: "Prompt admission distinct from settlement; thinking/text streaming deltas finalize one message.", expects: { lifecycle: ["agent_start", "turn_start", "message_update", "turn_end", "agent_end", "agent_settled"], sessionFixture: "history/basic-settled.jsonl" } },
  "rpc/sequential-tools.json": { purpose: "Tool streaming (toolcall deltas) plus tool_execution start/end pairing across two tools.", expects: { tools: ["write", "bash"], events: ["tool_execution_start", "tool_execution_end"], sessionFixture: "history/sequential-tools.jsonl" } },
  "rpc/abort-settlement.json": { purpose: "Abort mid-text-stream: stopping state held until abort confirmation plus non-streaming settle.", expects: { splitStep: "abort", terminal: "agent_settled", sessionFixture: "history/aborted-run.jsonl" } },
  "rpc/prompt-steer-follow-up.json": { purpose: "Pi queue semantics: steer admission, queue_update steering state, queued follow-up turn.", expects: { queueEvent: "queue_update", bashPartialUpdatesTrimmed: true, sessionFixture: "history/steer-followup.jsonl" } },
  "rpc/extension-select.json": { purpose: "Extension select dialog answered with an offered row; tool result carries details.answers.", expects: { dialogMethod: "select", escapeRow: "3. Type something." } },
  "rpc/extension-custom-answer.json": { purpose: "Select answered with the free-text row; input follow-up carries the typed answer (Gamma).", expects: { dialogMethods: ["select", "input"], typedAnswer: "Gamma" } },
  "rpc/compact-refused.json": { purpose: "Real Pi refusal: compact returns success:false with imbalance error; start/end events bracket it.", expects: { success: false, error: "Nothing to compact (session too small)" } },
  "rpc/thinking-levels.json": { purpose: "set_thinking_level low/high around a settled turn; thinking_level_changed events observed.", expects: { levels: ["low", "high"], sessionFixture: "history/thinking-levels.jsonl" } },
  "rpc/crash-after-response.json": { purpose: "SYNTHETIC: prompt admitted and agent started, then stderr plus exit 1; pending fails, crash state.", expects: { synthetic: true, exitCode: 1 } },
};
{
  const root = join(OUT, "..");
  const names = [
    ...(await readdir(OUT)).filter((f) => f.endsWith(".jsonl")).map((f) => `history/${f}`),
    ...(await readdir(RPC_OUT)).filter((f) => f.endsWith(".json")).map((f) => `rpc/${f}`),
  ].sort();
  const fixtures = [];
  for (const name of names) {
    const meta = FIXTURE_META[name];
    if (!meta) throw new Error(`manifest metadata missing for ${name} (add a deliberate entry)`);
    const content = await readFile(join(root, name));
    fixtures.push({
      name,
      kind: name.startsWith("history/") ? "history" : "rpc",
      purpose: meta.purpose,
      expects: meta.expects,
      bytes: content.byteLength,
      sha256: createHash("sha256").update(content).digest("hex"),
    });
  }
  await writeFile(join(root, "manifest.json"), JSON.stringify({
    version: 1,
    piCliVersion: "0.85.1-patch",
    sessionFormatVersion: 3,
    fixtures,
  }, null, 2) + "\n");
  console.log(`manifest.json (${fixtures.length} fixtures) — REVIEW every file before commit`);
}
