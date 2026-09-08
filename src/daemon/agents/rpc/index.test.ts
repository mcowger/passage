import { expect, test } from "bun:test";
import { PiRpcManager, responseData } from "./index.ts";

const script = `let b='';process.stdin.on('data',d=>{b+=d;let a=b.split('\\n');b=a.pop();for(const l of a){if(!l)continue;const r=JSON.parse(l);process.stdout.write(JSON.stringify({type:'queue_update',queued:r.type})+'\\n');if(r.type==='bash')setTimeout(()=>process.stdout.write(JSON.stringify({type:'bash_output',data:'out'})+'\\n'),2);setTimeout(()=>process.stdout.write(JSON.stringify({type:'response',id:r.id,command:r.type,success:true,data:{echo:r}})+'\\n'),r.type==='get_entries'?8:0);if(r.type==='prompt')setTimeout(()=>process.stdout.write(JSON.stringify({type:'agent_settled'})+'\\n'),4)}})`;
const options = (sessionId: string) => ({ cwd: "/tmp", sessionDir: "/tmp", sessionId, executable: process.execPath, executableArgs: ["-e", script] });

test("frames supported commands and correlates responses", async () => {
  const manager = new PiRpcManager(2); const p = await manager.start("a", options("a")); const seen: string[] = [];
  const off = p.subscribe(e => seen.push(e.type ?? ""));
  const commands = [
    { type: "get_entries", start: 1, limit: 2 }, { type: "get_tree" }, { type: "prompt", message: "hello", images: [{ type: "image", data: "AA", mimeType: "image/png" }], streamingBehavior: "steer" as const }, { type: "steer", message: "s" }, { type: "follow_up", message: "f" }, { type: "abort" }, { type: "set_steering_mode", mode: "all" as const }, { type: "set_follow_up_mode", mode: "one-at-a-time" as const }, { type: "get_available_models" }, { type: "set_model", provider: "p", modelId: "m" }, { type: "get_available_thinking_levels" }, { type: "set_thinking_level", level: "high" }, { type: "compact", customInstructions: "short" }, { type: "bash", command: "printf ok", excludeFromContext: true }, { type: "abort_bash" },
  ] as const;
  await Promise.all(commands.map(command => p.request(command)));
  expect(responseData<{ echo: { type: string } }>(await p.request({ type: "get_state" }))?.echo.type).toBe("get_state");
  expect(seen).toContain("queue_update"); expect(seen).toContain("bash_output"); off(); await manager.shutdown();
});

// @ts-expect-error legacy commands are intentionally absent
const unsupported: Parameters<import("./index.ts").PiRpcProcess["request"]>[0] = { type: "clear_queue" };
void unsupported;

test("prompt acknowledgement is distinct from settlement and replay is ordered", async () => {
  const manager = new PiRpcManager(1); const p = await manager.start("a", options("a")); const events: string[] = [];
  p.subscribe(event => events.push(event.type ?? "")); await p.request({ type: "prompt", message: "x" }); await new Promise(resolve => setTimeout(resolve, 10));
  expect(events).toContain("agent_settled"); expect(p.replay().events.every((e, i, a) => i === 0 || e.sequence > a[i - 1].sequence)).toBe(true); await manager.shutdown();
});

test("isolates agents and enforces capacity", async () => { const manager = new PiRpcManager(2); await Promise.all([manager.start("a", options("a")), manager.start("b", options("b"))]); await expect(manager.start("c", options("c"))).rejects.toThrow("maximum"); await manager.shutdown(); });
test("rejects oversized commands before writing", async () => { const manager = new PiRpcManager(1); const p = await manager.start("a", { ...options("a"), maxCommandBytes: 100 }); await expect(p.request({ type: "prompt", message: "x".repeat(200) })).rejects.toThrow("byte limit"); await manager.shutdown(); });
test("captures non-JSON stdout lines into stderr without breaking protocol", async () => {
  const noisyScript = `process.stdin.on('data',d=>{const r=JSON.parse(d); process.stdout.write('[MCP-UI] non-json log\\n'); process.stdout.write(JSON.stringify({type:'response',id:r.id,command:r.type,success:true,data:{ok:true}})+'\\n')})`;
  const noisyOptions = (id: string) => ({ cwd: "/tmp", sessionDir: "/tmp", sessionId: id, executable: process.execPath, executableArgs: ["-e", noisyScript] });
  const manager = new PiRpcManager(1);
  const p = await manager.start("noise", noisyOptions("noise"));
  const res = await p.request({ type: "get_state" });
  expect(responseData<{ ok: boolean }>(res)?.ok).toBe(true);
  expect(p.stderr.some((s) => s.includes("[MCP-UI]"))).toBe(true);
  await manager.shutdown();
});
