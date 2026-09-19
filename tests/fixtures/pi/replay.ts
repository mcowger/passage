/**
 * Fixture RPC replay process (test-only).
 *
 * Behaves enough like `pi --mode rpc` to exercise Passage's real subprocess
 * and JSONL framing boundary: reads LF-delimited command objects from stdin,
 * strictly validates type/order against a scenario script, and writes the
 * recorded/sanitized stdout records. Fails loudly on any unrecorded command.
 *
 * Usage: bun tests/fixtures/pi/replay.ts --scenario <file> --session-dir <dir> --session-id <id>
 */
import { readFile, writeFile } from "node:fs/promises";

type Step = {
  expect: { type: string; match?: Record<string, unknown> };
  respond?: Record<string, unknown>;
  emit?: Record<string, unknown>[];
};

type Scenario = {
  name: string;
  sessionFixture?: string;
  stderrLines?: string[];
  exitCode?: number;
  steps: Step[];
};

function arg(name: string): string {
  const i = process.argv.indexOf(name);
  if (i === -1 || !process.argv[i + 1]) throw new Error(`missing ${name}`);
  return process.argv[i + 1];
}

function substitute(value: unknown, vars: Record<string, string>): unknown {
  if (typeof value === "string") {
    let out = value;
    for (const [k, v] of Object.entries(vars)) out = out.split(`$${k}`).join(v);
    return out;
  }
  if (Array.isArray(value)) return value.map((v) => substitute(v, vars));
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, substitute(v, vars)]));
  }
  return value;
}

function matches(record: Record<string, unknown>, expect: Step["expect"]): boolean {
  if (record.type !== expect.type) return false;
  if (expect.match) {
    for (const [k, v] of Object.entries(expect.match)) {
      if (JSON.stringify(record[k]) !== JSON.stringify(v)) return false;
    }
  }
  return true;
}

const scenarioPath = arg("--scenario");
const scenarioDir = scenarioPath.includes("/") ? scenarioPath.slice(0, scenarioPath.lastIndexOf("/")) : ".";
const scenario: Scenario = JSON.parse(await readFile(scenarioPath, "utf8"));
const sessionDir = arg("--session-dir");
const sessionId = arg("--session-id");
const vars = { sessionDir, sessionId };

if (scenario.sessionFixture) {
  const fixturePath = scenario.sessionFixture.startsWith(".") ? `${scenarioDir}/${scenario.sessionFixture}` : scenario.sessionFixture;
  const fixture = (await readFile(fixturePath, "utf8")) as string;
  await writeFile(`${sessionDir}/${sessionId}.jsonl`, substitute(fixture, vars) as string);
}
for (const line of scenario.stderrLines ?? []) {
  process.stderr.write(`${line}\n`);
}

let buffer = "";
let stepIndex = 0;
const decoder = new TextDecoder();
const encoder = new TextEncoder();

function fail(message: string): never {
  process.stderr.write(`fixture-replay[${scenario.name}]: ${message}\n`);
  process.exit(1);
}

function handleLine(line: string) {
  const clean = line.endsWith("\r") ? line.slice(0, -1) : line;
  if (!clean.trim()) return;
  let record: Record<string, unknown>;
  try {
    record = JSON.parse(clean) as Record<string, unknown>;
  } catch {
    fail(`invalid JSON on stdin: ${clean.slice(0, 120)}`);
  }
  const step = scenario.steps[stepIndex];
  if (!step) fail(`unexpected command ${String(record!.type)} (scenario exhausted at step ${stepIndex})`);
  if (!matches(record!, step.expect)) {
    fail(`step ${stepIndex}: expected ${step!.expect.type} but got ${String(record!.type)}`);
  }
  stepIndex += 1;
  const id = typeof record!.id === "string" ? record!.id : "";
  const stepVars = { ...vars, id };
  if (step!.respond) {
    process.stdout.write(`${JSON.stringify(substitute(step!.respond, stepVars))}\n`);
  }
  for (const event of step!.emit ?? []) {
    process.stdout.write(`${JSON.stringify(substitute(event, stepVars))}\n`);
  }
  if (stepIndex >= scenario.steps.length && scenario.exitCode !== undefined) {
    process.exit(scenario.exitCode);
  }
}

process.stdin.on("data", (chunk: Uint8Array | string) => {
  buffer += typeof chunk === "string" ? chunk : decoder.decode(chunk as Uint8Array, { stream: true });
  let nl: number;
  while ((nl = buffer.indexOf("\n")) !== -1) {
    const line = buffer.slice(0, nl);
    buffer = buffer.slice(nl + 1);
    if (encoder.encode(line).byteLength > 4 * 1024 * 1024) fail("stdin record exceeds byte limit");
    handleLine(line);
  }
});
