import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LfJsonlParser } from "../../shared/jsonl/parser.ts";
import { PiRpcClient } from "./client.ts";
import { readPiJsonl } from "./history.ts";

test("JSONL splits only on LF and preserves U+2028/U+2029", () => {
  const records: unknown[] = [];
  const parser = new LfJsonlParser((record) => records.push(record));
  parser.push('{"text":"a b c"}\n{"n":1}');
  parser.push("\n");
  expect(records).toEqual([{ text: "a b c" }, { n: 1 }]);
});

test("handles split UTF-8, CRLF, and incomplete records", () => {
  const records: unknown[] = [];
  const parser = new LfJsonlParser((record) => records.push(record));
  const bytes = new TextEncoder().encode('{"text":"🙂"}\r\n');
  parser.push(bytes.slice(0, 12));
  parser.push(bytes.slice(12));
  expect(records).toEqual([{ text: "🙂" }]);
  expect(() => { const incomplete = new LfJsonlParser(() => {}); incomplete.push('{"x":1}'); incomplete.finish(); }).toThrow("incomplete");
  expect(() => { const bounded = new LfJsonlParser(() => {}, 8); bounded.push('{"text":"too large"}\n'); }).toThrow("byte limit");
});

test("correlates responses while events arrive", async () => {
  const script = `process.stdin.on('data',d=>{const r=JSON.parse(d); process.stdout.write(JSON.stringify({type:'agent_start'})+'\\n'); process.stdout.write(JSON.stringify({type:'response',id:r.id,command:r.type,success:true,data:{ok:true}})+'\\n')})`;
  const client = new PiRpcClient({ cwd: "/tmp", sessionDir: "/tmp", sessionId: "offline", executable: process.execPath, executableArgs: ["-e", script] });
  const response = await client.request({ type: "get_state" });
  expect(response.data).toEqual({ ok: true });
  expect(client.events).toEqual([{ type: "agent_start" }]);
  await client.shutdown();
});

test("reads a bounded durable JSONL session directly", async () => {
  const directory = await mkdtemp(join(tmpdir(), "passage-pi-history-"));
  try {
    const path = join(directory, "session.jsonl");
    await Bun.write(path, '{"type":"session","id":"s1"}\n{"type":"message","text":"ok"}\n');
    expect(await readPiJsonl(path)).toHaveLength(2);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("rejects oversized commands before writing", async () => {
  const script = "await Bun.sleep(10000)";
  const client = new PiRpcClient({ cwd: "/tmp", sessionDir: "/tmp", sessionId: "offline", executable: process.execPath, executableArgs: ["-e", script] });
  try {
    await expect(client.request({ type: "prompt", message: "x".repeat(70_000) })).rejects.toThrow("byte limit");
  } finally {
    await client.shutdown();
  }
});
