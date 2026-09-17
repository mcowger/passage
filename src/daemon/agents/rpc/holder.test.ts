import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PiRpcManager } from "./index.ts";

// Fake pi: answers get_state/get_entries, settles prompts. No live APIs.
const script = `process.stdin.on('data',d=>{for(const l of d.toString().split('\\n')){if(!l)continue;const r=JSON.parse(l);if(r.type==='prompt')setTimeout(()=>process.stdout.write(JSON.stringify({type:'agent_settled'})+'\\n'),10);const data=r.type==='get_state'?{isStreaming:false,sessionFile:null}:r.type==='get_entries'?{leafId:null}:{};process.stdout.write(JSON.stringify({type:'response',id:r.id,command:r.type,success:true,data})+'\\n')}})`;

test(
  "holder-backed agents survive a daemon restart and stop cleanly",
  async () => {
    process.env.PASSAGE_HOLDER_NO_SYSTEMD = "1";
    const root = mkdtempSync(join(tmpdir(), "passage-mgr-holder-"));
    const sessionsRoot = join(root, "sessions");
    const sessionDir = join(sessionsRoot, "agt_1");
    const piDefaults = { executable: process.execPath, executableArgs: ["-e", script] };
    try {
      // First daemon boots a holder for a new agent.
      const daemonA = new PiRpcManager(4, { sessionsRoot, piDefaults });
      const handle = await daemonA.start("agt_1", { cwd: root, sessionDir, sessionId: "pi_1" });
      expect(handle.transport).toBe("holder");
      expect(handle.generation).toBe(1);
      await handle.request({ type: "prompt", message: "hello" });

      // Daemon restart: detach drops the socket client-side, the holder
      // (and its pi) keeps running.
      await daemonA.detachAll();
      expect(daemonA.get("agt_1")).toBeUndefined();

      // New daemon process re-attaches to the same run, same generation.
      const daemonB = new PiRpcManager(4, { sessionsRoot, piDefaults });
      const reattached = await daemonB.attach("agt_1", { sessionDir });
      expect(reattached.transport).toBe("holder");
      expect(reattached.generation).toBe(1);
      const state = await reattached.request({ type: "get_state" });
      expect(state.type).toBe("response");

      // Per-agent stop still ends the resource: passage_stop tears down
      // the holder and its pi, and removes the socket files.
      await daemonB.stop("agt_1");
      expect(daemonB.get("agt_1")).toBeUndefined();
      const { existsSync } = await import("node:fs");
      expect(existsSync(join(sessionDir, "rpc.sock"))).toBe(false);
      await daemonB.detachAll();
    } finally {
      delete process.env.PASSAGE_HOLDER_NO_SYSTEMD;
      rmSync(root, { recursive: true, force: true });
    }
  },
  60_000,
);
