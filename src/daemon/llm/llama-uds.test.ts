import { describe, expect, it } from "bun:test";
import http from "node:http";
import { mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  chatCompletion,
  defaultSocketPath,
  ensureServerBinary,
  startLlamaServer,
  stopServer,
  waitForHealth,
  type ServerProc,
} from "./llama-uds.ts";

async function tempDir(prefix: string): Promise<string> {
  return mkdtemp(join(tmpdir(), prefix));
}

type FakeProc = ServerProc & { kills: Array<string | number | undefined> };

/** Controllable stand-in for Bun.spawn's subprocess handle. */
function fakeProc(opts: { exitOnKill?: boolean } = {}): FakeProc {
  let resolveExited!: (code: number | null) => void;
  const exited = new Promise<number | null>((r) => (resolveExited = r));
  const proc: FakeProc = {
    pid: 4242,
    exited,
    exitCode: null,
    kills: [],
    kill: (signal) => {
      proc.kills.push(signal);
      if (opts.exitOnKill !== false) {
        proc.exitCode = 0;
        resolveExited(0);
      }
    },
  };
  return proc;
}

function listenOnSocket(
  sockPath: string,
  handler: (req: http.IncomingMessage, res: http.ServerResponse) => void,
): Promise<http.Server> {
  const server = http.createServer(handler);
  return new Promise((resolve) => server.listen(sockPath, () => resolve(server)));
}

async function closeServer(server: http.Server): Promise<void> {
  await new Promise<void>((resolve) => server.close(() => resolve()));
}

describe("defaultSocketPath", () => {
  it("ends in passage-llama.sock and stays short", () => {
    const sock = defaultSocketPath();
    expect(sock.endsWith("passage-llama.sock")).toBe(true);
    expect(sock.length).toBeLessThan(108);
  });
});

describe("chatCompletion", () => {
  it("POSTs the prompt and returns the content", async () => {
    const dir = await tempDir("passage-uds-chat-");
    try {
      const sock = join(dir, "s.sock");
      let seenBody = "";
      const server = await listenOnSocket(sock, (req, res) => {
        let raw = "";
        req.on("data", (c) => (raw += c));
        req.on("end", () => {
          seenBody = raw;
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ choices: [{ message: { content: "hello-uds" } }] }));
        });
      });
      try {
        const out = await chatCompletion(sock, "hi", { maxTokens: 20, temperature: 0 });
        expect(out).toBe("hello-uds");
        const body = JSON.parse(seenBody);
        expect(body.messages).toEqual([{ role: "user", content: "hi" }]);
        expect(body.max_tokens).toBe(20);
        expect(body.temperature).toBe(0);
      } finally {
        await closeServer(server);
      }
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("throws on non-200, bad JSON, and empty choices", async () => {
    const dir = await tempDir("passage-uds-err-");
    try {
      const sock = join(dir, "s.sock");
      let mode = "ok";
      const server = await listenOnSocket(sock, (_req, res) => {
        if (mode === "status") {
          res.writeHead(500);
          res.end("boom");
        } else if (mode === "json") {
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end("not json");
        } else {
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ choices: [] }));
        }
      });
      try {
        mode = "status";
        await expect(chatCompletion(sock, "hi", { maxTokens: 1, temperature: 0 })).rejects.toThrow("HTTP 500");
        mode = "json";
        await expect(chatCompletion(sock, "hi", { maxTokens: 1, temperature: 0 })).rejects.toThrow("bad JSON");
        mode = "empty";
        await expect(chatCompletion(sock, "hi", { maxTokens: 1, temperature: 0 })).rejects.toThrow("no content");
      } finally {
        await closeServer(server);
      }
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("waitForHealth", () => {
  it("resolves once /health reports ok", async () => {
    const dir = await tempDir("passage-uds-health-");
    try {
      const sock = join(dir, "s.sock");
      let calls = 0;
      const server = await listenOnSocket(sock, (_req, res) => {
        calls += 1;
        if (calls < 3) {
          res.writeHead(500);
          res.end("loading");
          return;
        }
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ status: "ok" }));
      });
      try {
        await waitForHealth(sock, { timeoutMs: 5000, intervalMs: 20 });
        expect(calls).toBeGreaterThanOrEqual(3);
      } finally {
        await closeServer(server);
      }
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("rejects on deadline when nothing listens", async () => {
    const dir = await tempDir("passage-uds-dead-");
    try {
      await expect(
        waitForHealth(join(dir, "missing.sock"), { timeoutMs: 300, intervalMs: 50 }),
      ).rejects.toThrow("did not become healthy");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("startLlamaServer", () => {
  it("spawns socket-only argv with no --port", async () => {
    const dir = await tempDir("passage-uds-spawn-");
    try {
      const sock = join(dir, "s.sock");
      const seen: Array<{ cmd: string[]; opts: { stdout: number; stderr: number } }> = [];
      const proc = fakeProc();
      const handle = await startLlamaServer({
        modelPath: "/models/qwen.gguf",
        binaryPath: "/bin/llama-server",
        sockPath: sock,
        logPath: join(dir, "server.log"),
        spawnImpl: (cmd, opts) => {
          seen.push({ cmd, opts });
          return proc;
        },
      });
      expect(handle.proc).toBe(proc);
      expect(handle.sockPath).toBe(sock);
      const cmd = seen[0]?.cmd ?? [];
      expect(cmd[0]).toBe("/bin/llama-server");
      expect(cmd).toContain("-m");
      expect(cmd).toContain("/models/qwen.gguf");
      expect(cmd).toContain("-c");
      expect(cmd).toContain("32768");
      expect(cmd).toContain("-ngl");
      expect(cmd).toContain("--host");
      expect(cmd).toContain(sock);
      expect(cmd).not.toContain("--port");
      expect(typeof seen[0]?.opts.stdout).toBe("number");
      expect(typeof seen[0]?.opts.stderr).toBe("number");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("stopServer", () => {
  it("SIGTERMs, waits, and removes the socket", async () => {
    const dir = await tempDir("passage-uds-stop-");
    try {
      const sock = join(dir, "s.sock");
      await writeFile(sock, "stale");
      const proc = fakeProc();
      await stopServer(proc, sock, { termTimeoutMs: 1000 });
      expect(proc.kills).toEqual(["SIGTERM"]);
      const gone = await Bun.file(sock).exists();
      expect(gone).toBe(false);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("escalates to SIGKILL when the child ignores SIGTERM", async () => {
    const dir = await tempDir("passage-uds-kill-");
    try {
      const sock = join(dir, "s.sock");
      const proc = fakeProc({ exitOnKill: false });
      await stopServer(proc, sock, { termTimeoutMs: 50 });
      expect(proc.kills).toEqual(["SIGTERM", "SIGKILL"]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("never throws and still cleans the socket", async () => {
    const dir = await tempDir("passage-uds-stoperr-");
    try {
      const sock = join(dir, "s.sock");
      await writeFile(sock, "stale");
      const proc = fakeProc();
      proc.kill = () => {
        throw new Error("kill failed");
      };
      await stopServer(proc, sock, { termTimeoutMs: 50 });
      expect(await Bun.file(sock).exists()).toBe(false);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("ensureServerBinary", () => {
  it("copies once, makes executable, then reuses", async () => {
    const dir = await tempDir("passage-uds-bin-");
    try {
      const embedded = join(dir, "embedded");
      const dest = join(dir, "cache", "llama-server");
      await writeFile(embedded, "#!/bin/sh\necho hi\n");
      const first = await ensureServerBinary({ embeddedPath: embedded, destPath: dest });
      expect(first).toBe(dest);
      expect((await stat(dest)).mode & 0o111).not.toBe(0);
      const before = (await stat(dest)).mtimeMs;
      const second = await ensureServerBinary({ embeddedPath: embedded, destPath: dest });
      expect(second).toBe(dest);
      expect((await stat(dest)).mtimeMs).toBe(before);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
