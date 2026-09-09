import { describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LfJsonlParser } from "../../src/shared/jsonl/parser.ts";
import { spawnPty } from "./pty.ts";
import { classifySend, createSocketServer, decodeBinaryFrame } from "./websocket.ts";

const OPERATION_TIMEOUT_MS = 5_000;
const IDLE_BEFORE_RESIZE_MS = 100;
const PTY_GATE_ENABLED = process.env.PASSAGE_PTY_LIVE === "1";
const ptyTest = PTY_GATE_ENABLED ? test : test.skip;

if (!PTY_GATE_ENABLED) console.info("SKIP: PASSAGE_PTY_LIVE is not 1; native PTY acceptance gate was not run");

async function waitFor(condition: () => boolean, message: string): Promise<void> {
  const deadline = Date.now() + OPERATION_TIMEOUT_MS;
  while (!condition() && Date.now() < deadline) await Bun.sleep(10);
  if (!condition()) throw new Error(message);
}

async function withTimeout<T>(promise: Promise<T>, message: string): Promise<T> {
  return Promise.race([
    promise,
    new Promise<never>((_, reject) => setTimeout(() => reject(new Error(message)), OPERATION_TIMEOUT_MS)),
  ]);
}

function shellScript(script: string): [string, string[]] {
  return process.platform === "win32" ? ["cmd.exe", ["/d", "/s", "/c", script]] : ["/bin/sh", ["-c", script]];
}

function openClient(port: number, subjectId: string): {
  socket: WebSocket;
  messages: MessageEvent[];
  opened: Promise<void>;
} {
  const socket = new WebSocket(`ws://localhost:${port}?subject=${encodeURIComponent(subjectId)}`);
  socket.binaryType = "arraybuffer";
  const messages: MessageEvent[] = [];
  const opened = new Promise<void>((resolve, reject) => {
    socket.addEventListener("open", () => resolve(), { once: true });
    socket.addEventListener("error", () => reject(new Error(`failed to open ${subjectId} WebSocket`)), { once: true });
  });
  socket.addEventListener("message", (event) => messages.push(event));
  return { socket, messages, opened };
}

describe("Bun native terminal compatibility", () => {
  ptyTest("spawns, handles input, resizes after idle, emits output, and terminates", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "passage-pty-"));
    const [file, args] = shellScript(
      process.platform === "win32"
        ? "echo ready & set /p value= & echo input:%value% & echo after-resize"
        : "printf 'ready\\n'; read value; printf 'input:%s\\n' \"$value\"; printf 'after-resize\\n'",
    );
    let output = "";
    const decoder = new TextDecoder();
    const terminal = spawnPty({ cwd, file, args, onData: (data) => { output += decoder.decode(data, { stream: true }); } });

    try {
      await waitFor(() => output.includes("ready"), "PTY did not emit initial output");
      await Bun.sleep(IDLE_BEFORE_RESIZE_MS);
      terminal.resize(100, 30);
      terminal.write("ok\n");
      await waitFor(() => output.includes("input:ok") && output.includes("after-resize"), "PTY did not emit output after input and resize");
      expect(terminal.columns).toBe(100);
      expect(terminal.rows).toBe(30);
    } finally {
      terminal.kill();
      await withTimeout(terminal.process.exited, "PTY did not exit after termination");
      terminal.close();
      await rm(cwd, { recursive: true, force: true });
    }
  });
});

describe("Bun WebSocket terminal transport", () => {
  test("preserves sequenced binary bytes, control frames, and subject isolation", async () => {
    const transport = createSocketServer();
    const port = transport.server.port;
    if (port === undefined) throw new Error("WebSocket server did not bind a port");
    const a = openClient(port, "terminal-a");
    const b = openClient(port, "terminal-b");
    try {
      await withTimeout(Promise.all([a.opened, b.opened]).then(() => undefined), "WebSocket clients did not open");
      await waitFor(() => transport.clients.size === 2, "server did not register WebSocket clients");

      const payloadA = new Uint8Array([0, 1, 127, 128, 255, 0xe2, 0x80, 0xa8, 0x1b, 0x5b, 0x6d]);
      const payloadB = new Uint8Array([9, 8, 7]);
      expect(transport.sendBinary("terminal-a", 41, payloadA)).toBe("sent");
      expect(transport.sendControl("terminal-a", 42, { type: "resize", columns: 100, rows: 30 })).toBe("sent");
      expect(transport.sendBinary("terminal-b", 7, payloadB)).toBe("sent");

      await waitFor(() => a.messages.length === 2 && b.messages.length === 1, "clients did not receive isolated frames");
      const [binaryMessageA, controlMessageA] = a.messages;
      const [binaryMessageB] = b.messages;
      if (!binaryMessageA || !controlMessageA || !binaryMessageB) throw new Error("expected WebSocket messages are missing");
      const frameA = decodeBinaryFrame(binaryMessageA.data as ArrayBuffer);
      const controlA = JSON.parse(controlMessageA.data as string);
      const frameB = decodeBinaryFrame(binaryMessageB.data as ArrayBuffer);
      expect(frameA).toEqual({ subjectId: "terminal-a", sequence: 41, payload: payloadA });
      expect(controlA).toEqual({ subjectId: "terminal-a", sequence: 42, value: { type: "resize", columns: 100, rows: 30 } });
      expect(frameB).toEqual({ subjectId: "terminal-b", sequence: 7, payload: payloadB });
      expect(classifySend(-1)).toBe("backpressure");
      expect(classifySend(0)).toBe("dropped");
      expect(classifySend(1)).toBe("sent");
    } finally {
      a.socket.close();
      b.socket.close();
      transport.server.stop(true);
    }
  });
});

describe("Bun child-process lifecycle", () => {
  test("isolates concurrent JSONL, stderr, crash, restart, and shutdown", async () => {
    const spawnHelper = (marker: string, exitCode: number, delayMs = 10_000) => Bun.spawn([
      process.execPath,
      "-e",
      `console.log(JSON.stringify({marker:${JSON.stringify(marker)}}));console.error(${JSON.stringify(`stderr:${marker}`)});await Bun.sleep(${delayMs});process.exit(${exitCode})`,
    ], { stdin: "ignore", stdout: "pipe", stderr: "pipe" });

    const first = spawnHelper("agent-a", 7, 20);
    const second = spawnHelper("agent-b", 0, 20);
    const [firstOut, firstErr, secondOut, secondErr, firstCode, secondCode] = await withTimeout(Promise.all([
      new Response(first.stdout).text(),
      new Response(first.stderr).text(),
      new Response(second.stdout).text(),
      new Response(second.stderr).text(),
      first.exited,
      second.exited,
    ]), "concurrent helper processes did not exit");

    const records: { marker: string }[] = [];
    const parser = new LfJsonlParser<{ marker: string }>((record) => records.push(record));
    parser.push(firstOut);
    parser.push(secondOut);
    parser.finish();
    expect(records).toEqual([{ marker: "agent-a" }, { marker: "agent-b" }]);
    expect(firstErr).toContain("stderr:agent-a");
    expect(firstErr).not.toContain("agent-b");
    expect(secondErr).toContain("stderr:agent-b");
    expect(secondErr).not.toContain("agent-a");
    expect(firstCode).toBe(7);
    expect(secondCode).toBe(0);

    const crashed = spawnHelper("generation-1", 0);
    await Bun.sleep(20);
    crashed.kill("SIGTERM");
    expect(await withTimeout(crashed.exited, "crashed helper did not exit")).not.toBe(0);
    expect(await new Response(crashed.stderr).text()).toContain("stderr:generation-1");

    const restarted = spawnHelper("generation-2", 0, 1);
    expect(await withTimeout(restarted.exited, "restarted helper did not exit")).toBe(0);
    expect(await new Response(restarted.stdout).text()).toContain("generation-2");

    const shutdown = spawnHelper("shutdown", 0);
    await Bun.sleep(20);
    shutdown.kill();
    await withTimeout(shutdown.exited, "shutdown helper did not exit");
    expect(shutdown.killed).toBe(true);
  });
});

describe("concurrent PTY and JSONL streaming", () => {
  ptyTest("keeps PTY bytes separate from child JSONL and stderr", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "passage-concurrent-"));
    const [file, args] = shellScript(process.platform === "win32" ? "echo pty-marker" : "printf 'pty-marker\\n'");
    let terminalOutput = "";
    const decoder = new TextDecoder();
    const terminal = spawnPty({ cwd, file, args, onData: (data) => { terminalOutput += decoder.decode(data, { stream: true }); } });
    const child = Bun.spawn([
      process.execPath,
      "-e",
      "console.log(JSON.stringify({marker:'jsonl-marker'}));console.error('stderr-marker')",
    ], { stdin: "ignore", stdout: "pipe", stderr: "pipe" });
    try {
      const [stdout, stderr, code] = await withTimeout(Promise.all([
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
        child.exited,
      ]), "JSONL helper did not exit");
      await waitFor(() => terminalOutput.includes("pty-marker"), "PTY stream did not emit its marker");
      expect(stdout).toContain("jsonl-marker");
      expect(stderr).toContain("stderr-marker");
      expect(terminalOutput).not.toContain("jsonl-marker");
      expect(code).toBe(0);
    } finally {
      terminal.kill();
      await withTimeout(terminal.process.exited, "concurrent PTY did not exit");
      terminal.close();
      await rm(cwd, { recursive: true, force: true });
    }
  });
});
