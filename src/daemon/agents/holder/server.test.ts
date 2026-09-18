import { expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { connect, type Socket } from "node:net";
import { HolderServer } from "./server.ts";
import { HolderPiProcess } from "../rpc/holder-transport.ts";
import { logPathFor, metaPathFor, parseHolderMeta, pidPathFor, socketPathFor } from "./protocol.ts";
import { decideSweep, pingHolder, readGeneration, stopHolder, sweepHolders, tryHello } from "./spawn.ts";

/** Fake pi: echoes commands as responses, emits a pid marker + events. */
const FAKE_PI = `let b='';process.stdout.write(JSON.stringify({type:'holder_test_pid',pid:process.pid})+'\\n');process.stdin.on('data',d=>{b+=d;let a=b.split('\\n');b=a.pop();for(const l of a){if(!l)continue;const r=JSON.parse(l);if(r.type&&r.type.startsWith('passage_'))continue;process.stdout.write(JSON.stringify({type:'queue_update',queued:r.type})+'\\n');setTimeout(()=>process.stdout.write(JSON.stringify({type:'response',id:r.id,command:r.type,success:true,data:{echo:r}})+'\\n'),5);if(r.type==='prompt')setTimeout(()=>process.stdout.write(JSON.stringify({type:'agent_settled'})+'\\n'),10);if(r.type==='get_state')setTimeout(()=>process.stdout.write(JSON.stringify({type:'agent_start'})+'\\n'),2);}})`;

type Started = {
  server: HolderServer;
  sessionDir: string;
  socketPath: string;
  exitCode: Promise<number>;
  root: string;
  agentId: string;
};

let agentCounter = 0;

async function startServer(extra?: Partial<ConstructorParameters<typeof HolderServer>[0]>): Promise<Started> {
  const root = mkdtempSync(join(tmpdir(), "passage-holder-test-"));
  const agentId = `agt_test${++agentCounter}`;
  const sessionDir = join(root, agentId);
  mkdirSync(sessionDir, { recursive: true });
  const socketPath = socketPathFor(sessionDir);
  let resolveExit!: (code: number) => void;
  const exitCode = new Promise<number>((resolve) => {
    resolveExit = resolve;
  });
  const server = new HolderServer({
    agentId,
    sessionDir,
    sessionId: `pi_${agentId}`,
    cwd: tmpdir(),
    socketPath,
    generation: 1,
    executable: process.execPath,
    executableArgs: ["-e", FAKE_PI],
    onExit: resolveExit,
    ...extra,
  });
  await server.start();
  return { server, sessionDir, socketPath, exitCode, root, agentId };
}

function rawConnect(socketPath: string): Promise<Socket> {
  return new Promise((resolve, reject) => {
    const socket = connect(socketPath);
    socket.once("connect", () => resolve(socket));
    socket.once("error", reject);
  });
}

function readFrames(socket: Socket, count: number, timeoutMs = 5_000): Promise<unknown[]> {
  return new Promise((resolve, reject) => {
    const frames: unknown[] = [];
    let buffer = "";
    const timer = setTimeout(() => reject(new Error(`timed out waiting for ${count} frames`)), timeoutMs);
    socket.on("data", (chunk) => {
      buffer += chunk.toString("utf8");
      let newline: number;
      while ((newline = buffer.indexOf("\n")) !== -1) {
        const line = buffer.slice(0, newline).replace(/\r$/, "");
        buffer = buffer.slice(newline + 1);
        if (!line.trim()) continue;
        try {
          frames.push(JSON.parse(line));
        } catch {}
        if (frames.length >= count) {
          clearTimeout(timer);
          resolve(frames);
          return;
        }
      }
    });
    socket.on("error", reject);
  });
}

test("handshake proxies pi records verbatim in both directions", async () => {
  const started = await startServer();
  try {
    // Let the fake pi's startup marker reach the holder buffer first.
    await new Promise((resolve) => setTimeout(resolve, 150));
    const socket = await rawConnect(started.socketPath);
    const pending = readFrames(socket, 3);
    socket.write(`${JSON.stringify({ type: "passage_hello", agentId: started.agentId })}\n`);
    const [ack, ...rest] = await pending;
    expect((ack as { type: string }).type).toBe("passage_hello_ack");
    expect((ack as { holderVersion: number }).holderVersion).toBe(1);
    expect((ack as { generation: number }).generation).toBe(1);
    expect((ack as { piAlive: boolean }).piAlive).toBe(true);
    // Buffered pid marker replays on hello, then the stderr snapshot.
    expect(rest.some((frame) => (frame as { type?: string }).type === "holder_test_pid")).toBe(true);
    expect(rest.some((frame) => (frame as { type?: string }).type === "passage_stderr")).toBe(true);

    // Data frame → pi → response + event, verbatim.
    const frames = readFrames(socket, 3);
    socket.write(`${JSON.stringify({ type: "get_state", id: "probe-1" })}\n`);
    const received = await frames;
    const response = received.find((frame) => (frame as { type?: string }).type === "response");
    expect((response as { id?: string }).id).toBe("probe-1");
    const log = readFileSync(logPathFor(started.sessionDir), "utf8");
    expect(log).toContain('"event":"holder.hello"');
    expect(log).toContain('"event":"pi.stdin_forwarded"');
    socket.destroy();
  } finally {
    await started.server.gracefulStop();
    await started.exitCode;
    rmSync(started.root, { recursive: true, force: true });
  }
});

test("after-offset replay resends only missed lines", async () => {
  const started = await startServer();
  try {
    await new Promise((resolve) => setTimeout(resolve, 150));
    const first = await rawConnect(started.socketPath);
    const helloed = readFrames(first, 3);
    first.write(`${JSON.stringify({ type: "passage_hello", agentId: started.agentId })}\n`);
    const [ack] = (await helloed) as [{ latestSeq: number }];
    const latestSeq = ack.latestSeq;
    expect(latestSeq).toBeGreaterThan(0);
    first.destroy();

    // Second connection resumes after the previous offset: only lines newer
    // than `after` are replayed (here: none yet, then a fresh command).
    const second = await rawConnect(started.socketPath);
    const resumed = readFrames(second, 2);
    second.write(`${JSON.stringify({ type: "passage_hello", agentId: started.agentId, after: latestSeq })}\n`);
    const [ack2, stderr] = await resumed;
    expect((ack2 as { latestSeq: number }).latestSeq).toBe(latestSeq);
    expect((stderr as { type: string }).type).toBe("passage_stderr");
    second.destroy();
  } finally {
    await started.server.gracefulStop();
    await started.exitCode;
    rmSync(started.root, { recursive: true, force: true });
  }
});

test("transport reconnects and reconciles after the daemon handle dies", async () => {
  const started = await startServer();
  try {
    const first = new HolderPiProcess({ agentId: started.agentId, socketPath: started.socketPath, generation: 1 });
    await first.connect();
    const seen: string[] = [];
    first.subscribe((event) => {
      seen.push(String(event.type));
    });
    await first.request({ type: "prompt", message: "hello" });
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(seen).toContain("agent_settled");
    // Daemon death: destroy the socket without stopping the holder.
    first.destroy();

    // New daemon process re-attaches; the run continued (pi still alive)
    // and buffered events replay on hello.
    const second = new HolderPiProcess({ agentId: started.agentId, socketPath: started.socketPath, generation: 1 });
    await second.connect();
    const replayed: string[] = [];
    second.subscribe((event) => {
      replayed.push(String(event.type));
    });
    expect(replayed).toContain("agent_settled");
    // And new commands still work against the same pi.
    const state = await second.request({ type: "get_state" });
    expect(state.type).toBe("response");
    await second.shutdown();
  } finally {
    await started.exitCode;
    rmSync(started.root, { recursive: true, force: true });
  }
});

test("passage_stop tears down the full pi tree and removes holder files", async () => {
  const started = await startServer();
  const transport = new HolderPiProcess({ agentId: started.agentId, socketPath: started.socketPath, generation: 1 });
  await transport.connect();
  // Hello replay arrives just after the ack resolves the handshake; poll.
  let piPid = 0;
  for (let attempt = 0; attempt < 100 && !piPid; attempt += 1) {
    piPid = (transport.events.find((event) => event.type === "holder_test_pid") as unknown as { pid: number } | undefined)?.pid ?? 0;
    if (!piPid) await new Promise((resolve) => setTimeout(resolve, 30));
  }
  expect(piPid).toBeGreaterThan(0);

  await transport.shutdown(5_000);
  const code = await started.exitCode;
  expect(code).toBe(0);
  expect(existsSync(started.socketPath)).toBe(false);
  expect(existsSync(pidPathFor(started.sessionDir))).toBe(false);
  expect(existsSync(metaPathFor(started.sessionDir))).toBe(false);
  // Full tree teardown: the pi PID is gone.
  expect(() => process.kill(piPid, 0)).toThrow();
  rmSync(started.root, { recursive: true, force: true });
});

test("stale sockets, generation tracking, and stopHolder", async () => {
  const root = mkdtempSync(join(tmpdir(), "passage-holder-stale-"));
  try {
    // No socket file at all → hello rejects (stale/dead holder).
    await expect(tryHello(join(root, "agt_nope", "rpc.sock"), "agt_nope", 0, 300)).rejects.toThrow();
    expect(await pingHolder(root, "agt_nope", 300)).toBe(false);
    expect(readGeneration(join(root, "agt_nope"))).toBe(0);

    const started = await startServer();
    try {
      // Live holder answers; meta records generation 1.
      expect(await pingHolder(started.root, started.agentId, 2_000)).toBe(true);
      const ack = await tryHello(started.socketPath, started.agentId, 0, 2_000);
      expect(ack.piAlive).toBe(true);
      const meta = parseHolderMeta(JSON.parse(readFileSync(metaPathFor(started.sessionDir), "utf8")));
      expect(meta?.generation).toBe(1);
      expect(readGeneration(started.sessionDir)).toBe(1);

      expect(await stopHolder(started.root, started.agentId, 8_000)).toBe(true);
      await started.exitCode;
      expect(existsSync(started.socketPath)).toBe(false);
      // Dead holder → stale socket detection (same as a crashed pi).
      expect(await pingHolder(started.root, started.agentId, 300)).toBe(false);
    } finally {
      rmSync(started.root, { recursive: true, force: true });
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("sweep kills orphans and spares live agents", async () => {
  const started = await startServer();
  try {
    const sessionsRoot = started.sessionDir.slice(0, started.sessionDir.lastIndexOf("/"));
    const stopped: string[] = [];
    // Live, unarchived agent with a live holder → keep.
    let result = await sweepHolders(
      sessionsRoot,
      (agentId) => (agentId === started.agentId ? { archived: false } : undefined),
      async (agentId) => {
        stopped.push(agentId);
      },
    );
    expect(result.kept).toContain(started.agentId);
    expect(stopped).toEqual([]);

    // Archived agent with a live holder → kill.
    result = await sweepHolders(
      sessionsRoot,
      (agentId) => (agentId === started.agentId ? { archived: true } : undefined),
      async (agentId) => {
        stopped.push(agentId);
        await stopHolder(sessionsRoot, agentId, 8_000);
      },
    );
    expect(result.killed).toContain(started.agentId);
    expect(stopped).toContain(started.agentId);
    await started.exitCode;
  } finally {
    rmSync(started.root, { recursive: true, force: true });
  }
  expect(decideSweep).toBeDefined();
});
