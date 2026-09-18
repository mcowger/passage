/** llama-server over a Unix-domain socket, managed with Bun.spawn.
 *
 *  No TCP ports (nothing to collide, no get-port), no supervisor library:
 *  Bun.spawn gives us pid, exited, kill(), and file-backed stdio.
 *  Readiness is a /health poll over the socket; shutdown is
 *  SIGTERM -> exited -> SIGKILL. The static build (-ngl 99) offloads to
 *  Vulkan when a device exists and degrades to CPU otherwise.
 */
import { chmod, mkdir, stat, unlink } from "node:fs/promises";
import { closeSync, openSync } from "node:fs";
import http from "node:http";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import serverBinEmbedded from "./vendor/llama-server.bin" with { type: "file" };
import { logger } from "../logging.ts";

const log = logger("llm");

/** llama.cpp build baked into the binary (see scripts/vendor-llama-server.ts). */
export const LLAMA_SERVER_BUILD = "b11045";
/** Server context window. llama.cpp requires multiples of 256. */
export const LLAMA_CTX_TOKENS = 32768;
/** Full GPU offload; the build falls back to CPU when no Vulkan device exists. */
export const LLAMA_GPU_LAYERS = 99;
/** Tokens held back for the chat template + safety when sizing prompts. */
export const LLAMA_PROMPT_MARGIN_TOKENS = 512;
/** Conservative chars-per-token estimate for truncation (no tokenizer client-side). */
export const CHARS_PER_TOKEN_ESTIMATE = 3;

export function llamaCacheDir(): string {
  return join(homedir(), ".cache", "passage", "llama", LLAMA_SERVER_BUILD);
}

/** Unix socket path. XDG_RUNTIME_DIR when available, else the cache dir.
 *  Well under the ~108-char sun_path limit in both cases. */
export function defaultSocketPath(): string {
  const dir = process.env.XDG_RUNTIME_DIR?.trim() || join(homedir(), ".cache", "passage");
  return join(dir, "passage-llama.sock");
}

export type EnsureBinaryDeps = {
  embeddedPath?: string;
  destPath?: string;
};

/** Extract the embedded llama-server to the versioned cache dir on first
 *  run (copy + chmod 755); reuse when the cached copy matches in size.
 *  Embedded files lose the exec bit, so the copy is required even when
 *  Bun hands us a directly-executable path. */
export async function ensureServerBinary(deps: EnsureBinaryDeps = {}): Promise<string> {
  const embedded = deps.embeddedPath ?? serverBinEmbedded;
  const dest = deps.destPath ?? join(llamaCacheDir(), "llama-server");
  // NOTE: inside the compiled binary `embedded` is a $bunfs virtual path.
  // Bun.file/Bun.write understand it; node:fs copyFile does not.
  const want = Bun.file(embedded).size;
  const have = await stat(dest).catch(() => undefined);
  if (!have || have.size !== want) {
    await mkdir(dirname(dest), { recursive: true });
    await Bun.write(dest, Bun.file(embedded));
    await chmod(dest, 0o755);
    log.info("llama-server extracted", { event: "llm.server_extracted", dest, bytes: want });
  }
  return dest;
}

/** Minimal surface we need from Bun.spawn; Bun.Subprocess satisfies it. */
export type ServerProc = {
  readonly pid: number;
  readonly exited: Promise<number | null>;
  kill(signal?: string | number): void;
  exitCode: number | null;
};

export type SpawnFn = (
  cmd: string[],
  opts: { stdout: number; stderr: number },
) => ServerProc;

const defaultSpawn: SpawnFn = (cmd, opts) => Bun.spawn(cmd, opts) as unknown as ServerProc;

export type StartServerOpts = {
  modelPath: string;
  binaryPath: string;
  sockPath?: string;
  logPath?: string;
  spawnImpl?: SpawnFn;
};

/** Spawn llama-server listening ONLY on the unix socket (no --port).
 *  Server logs append to logPath. Returns the child handle + socket path. */
export async function startLlamaServer(opts: StartServerOpts): Promise<{ proc: ServerProc; sockPath: string }> {
  const sockPath = opts.sockPath ?? defaultSocketPath();
  const logPath = opts.logPath ?? join(llamaCacheDir(), "llama-server.log");
  await mkdir(join(logPath, ".."), { recursive: true });
  // A stale socket from an unclean exit makes bind fail; clear it first.
  await unlink(sockPath).catch(() => undefined);
  const fd = openSync(logPath, "a");
  try {
    const proc = (opts.spawnImpl ?? defaultSpawn)(
      [
        opts.binaryPath,
        "-m", opts.modelPath,
        "-c", String(LLAMA_CTX_TOKENS),
        "-ngl", String(LLAMA_GPU_LAYERS),
        "-rea", "off",
        "--no-webui",
        "--host", sockPath,
      ],
      { stdout: fd, stderr: fd },
    );
    log.info("llama-server spawned", { event: "llm.server_started", pid: proc.pid, sockPath });
    return { proc, sockPath };
  } finally {
    closeSync(fd);
  }
}

type UdsResponse = { status: number; body: string };

function udsRequest(
  sockPath: string,
  method: string,
  path: string,
  body?: string,
  timeoutMs = 120_000,
): Promise<UdsResponse> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        socketPath: sockPath,
        path,
        method,
        headers: body
          ? { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(body) }
          : undefined,
      },
      (res) => {
        let raw = "";
        res.on("data", (chunk) => (raw += chunk));
        res.on("end", () => resolve({ status: res.statusCode ?? 0, body: raw }));
      },
    );
    req.on("error", reject);
    req.setTimeout(timeoutMs, () => req.destroy(new Error(`llama-server request timed out after ${timeoutMs}ms`)));
    if (body) req.write(body);
    req.end();
  });
}

/** Poll GET /health until the server reports ok or the deadline passes. */
export async function waitForHealth(
  sockPath: string,
  opts: { timeoutMs?: number; intervalMs?: number } = {},
): Promise<void> {
  const timeoutMs = opts.timeoutMs ?? 60_000;
  const intervalMs = opts.intervalMs ?? 200;
  const deadline = Date.now() + timeoutMs;
  let lastError = "no attempt yet";
  while (Date.now() < deadline) {
    try {
      const res = await udsRequest(sockPath, "GET", "/health", undefined, 5000);
      if (res.status === 200 && res.body.includes('"ok"')) return;
      lastError = `HTTP ${res.status}: ${res.body.slice(0, 160)}`;
    } catch (error) {
      lastError = error instanceof Error ? error.message.slice(0, 160) : String(error).slice(0, 160);
    }
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  throw new Error(`llama-server did not become healthy within ${timeoutMs}ms: ${lastError}`);
}

export type ChatOptions = { maxTokens: number; temperature: number };

/** Single /v1/chat/completions turn. Throws on transport errors,
 *  non-200 status, bad JSON, or an empty choices array. */
export async function chatCompletion(
  sockPath: string,
  prompt: string,
  opts: ChatOptions,
  timeoutMs = 120_000,
): Promise<string> {
  const res = await udsRequest(
    sockPath,
    "POST",
    "/v1/chat/completions",
    JSON.stringify({
      messages: [{ role: "user", content: prompt }],
      max_tokens: opts.maxTokens,
      temperature: opts.temperature,
    }),
    timeoutMs,
  );
  if (res.status !== 200) {
    throw new Error(`llama-server HTTP ${res.status}: ${res.body.slice(0, 256)}`);
  }
  let parsed: { choices?: Array<{ message?: { content?: unknown } }> };
  try {
    parsed = JSON.parse(res.body);
  } catch {
    throw new Error(`llama-server returned bad JSON: ${res.body.slice(0, 256)}`);
  }
  const content = parsed.choices?.[0]?.message?.content;
  if (typeof content !== "string" || content.length === 0) {
    throw new Error(`llama-server returned no content: ${res.body.slice(0, 256)}`);
  }
  return content;
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T | undefined> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<undefined>((resolve) => {
    timer = setTimeout(() => resolve(undefined), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

/** Graceful shutdown: SIGTERM, wait for exit, SIGKILL on timeout, then
 *  remove the socket. Never throws (daemon shutdown path). */
export async function stopServer(
  proc: ServerProc | undefined,
  sockPath: string,
  opts: { termTimeoutMs?: number } = {},
): Promise<void> {
  const termTimeoutMs = opts.termTimeoutMs ?? 10_000;
  try {
    if (proc && proc.exitCode === null) {
      try {
        proc.kill("SIGTERM");
      } catch {}
      const exited = await withTimeout(proc.exited, termTimeoutMs);
      if (exited === undefined && proc.exitCode === null) {
        try {
          proc.kill("SIGKILL");
        } catch {}
        await withTimeout(proc.exited, termTimeoutMs);
      }
    }
  } catch {}
  await unlink(sockPath).catch(() => undefined);
}
