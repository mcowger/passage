import { existsSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import {
  LOCAL_QWEN_LABEL,
  LOCAL_QWEN_MODEL_VALUE,
  isLocalQwenModelValue,
} from "../../shared/domain/settings.ts";
import { logger } from "../logging.ts";
import {
  CHARS_PER_TOKEN_ESTIMATE,
  LLAMA_CTX_TOKENS,
  LLAMA_PROMPT_MARGIN_TOKENS,
  LLAMA_SERVER_BUILD,
  LLAMA_GPU_LAYERS,
  chatCompletion,
  defaultSocketPath,
  ensureServerBinary,
  startLlamaServer,
  stopServer,
  waitForHealth,
  type ServerProc,
} from "./llama-uds.ts";

export { LOCAL_QWEN_LABEL, LOCAL_QWEN_MODEL_VALUE };
export const LOCAL_QWEN_MODEL_URL =
  "https://huggingface.co/Qwen/Qwen2.5-0.5B-Instruct-GGUF/resolve/main/qwen2.5-0.5b-instruct-q4_k_m.gguf";
export const LOCAL_QWEN_FILENAME = "qwen2.5-0.5b-instruct-q4_k_m.gguf";
/** Default cap on generated tokens per one-shot suggestion call. */
export const LOCAL_QWEN_DEFAULT_MAX_TOKENS = 1000;
/** Hard ceiling even when a caller requests more. */
export const LOCAL_QWEN_MAX_TOKENS = 1000;
/** Server context window (llama.cpp multiple-of-256 aligned). Prompts are
 *  truncated client-side to fit within ctx minus output budget and margin. */
export const LOCAL_QWEN_CONTEXT_SIZE = LLAMA_CTX_TOKENS;

const log = logger("llm");

/** True when the configured suggestion model selects the local Qwen path.
 *  Trims defensively so stored whitespace never bypasses the local route. */
export function isLocalQwenModel(model?: string | null): boolean {
  return isLocalQwenModelValue(model);
}

/** Model file lives beside the Passage DB so standalone binaries and dev
 *  checkouts each keep their own copy. */
export function resolveLocalModelPath(dbPath: string): string {
  return join(dirname(dbPath), LOCAL_QWEN_FILENAME);
}

export type EnsureLocalModelDeps = {
  existsImpl?: (path: string) => boolean | Promise<boolean>;
  fetchImpl?: typeof fetch;
  writeImpl?: (path: string, bytes: Uint8Array) => Promise<void>;
};

/** Ensure the GGUF file exists, downloading it on first start only. Never
 *  re-downloads when the file is already present (cache-hit). Throws only
 *  when the download itself fails so callers can fall back to Pi. */
export async function ensureLocalModelFile(
  modelPath: string,
  opts: { url?: string } & EnsureLocalModelDeps = {},
): Promise<{ path: string; downloaded: boolean }> {
  const existsImpl = opts.existsImpl ?? ((p: string) => existsSync(p));
  if (await existsImpl(modelPath)) return { path: modelPath, downloaded: false };
  const url = opts.url ?? LOCAL_QWEN_MODEL_URL;
  const fetchImpl = opts.fetchImpl ?? fetch;
  const response = await fetchImpl(url);
  if (!response.ok) {
    throw new Error(`Local model download failed: HTTP ${response.status} for ${url}`);
  }
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (bytes.length === 0) throw new Error("Local model download returned an empty body");
  await mkdir(dirname(modelPath), { recursive: true });
  if (opts.writeImpl) {
    await opts.writeImpl(modelPath, bytes);
  } else {
    await writeFile(modelPath, bytes);
  }
  return { path: modelPath, downloaded: true };
}

export type LocalQwenChatFn = (
  prompt: string,
  opts: { maxTokens: number; temperature: number },
) => Promise<string>;

export type LocalQwenBackend = {
  chat: LocalQwenChatFn;
  dispose: () => unknown | Promise<unknown>;
};

export type CreateLocalQwenBackend = (modelPath: string) => Promise<LocalQwenBackend>;

function isConnectionDown(error: unknown): boolean {
  const code = (error as { code?: unknown })?.code;
  return code === "ECONNREFUSED" || code === "ENOENT" || code === "EPIPE";
}

/** Default backend: static llama-server binary over a unix socket.
 *  One restart is attempted when the server dies mid-flight; anything else
 *  throws and the suggestion callers fall back to Pi/deterministic output. */
export const createDefaultBackend: CreateLocalQwenBackend = async (modelPath: string) => {
  const binaryPath = await ensureServerBinary();
  let current = await startLlamaServer({ modelPath, binaryPath });
  await waitForHealth(current.sockPath);

  const chat: LocalQwenChatFn = async (prompt, opts) => {
    try {
      return await chatCompletion(current.sockPath, prompt, opts);
    } catch (error) {
      if (!isConnectionDown(error)) throw error;
      log.warn("llama-server connection lost; restarting once", {
        event: "llm.server_restart",
        error: error instanceof Error ? error.message.slice(0, 256) : String(error).slice(0, 256),
      });
      await stopServer(current.proc, current.sockPath).catch(() => undefined);
      current = await startLlamaServer({ modelPath, binaryPath });
      await waitForHealth(current.sockPath);
      return chatCompletion(current.sockPath, prompt, opts);
    }
  };

  return {
    chat,
    dispose: async () => {
      await stopServer(current.proc, current.sockPath);
    },
  };
};

export type LocalQwenGenerateOptions = {
  maxTokens?: number;
  temperature?: number;
};

/** Shrink an over-long prompt to fit ctx minus the output budget and the
 *  template margin, using a conservative chars-per-token estimate. */
export function fitPromptToContext(
  prompt: string,
  maxTokens: number,
): { text: string; truncated: boolean } {
  const budget = LOCAL_QWEN_CONTEXT_SIZE - maxTokens - LLAMA_PROMPT_MARGIN_TOKENS;
  if (Math.ceil(prompt.length / CHARS_PER_TOKEN_ESTIMATE) <= budget) {
    return { text: prompt, truncated: false };
  }
  return { text: prompt.slice(0, Math.max(0, budget * CHARS_PER_TOKEN_ESTIMATE)), truncated: true };
}

/** Local Qwen service. The server stays up across calls; every generate()
 *  is one stateless HTTP turn so no chat history leaks between one-shot
 *  title/branch/commit prompts. Serializes concurrent calls through a
 *  chain so a slow request never overlaps the next. */
export class LocalQwenService {
  private backend: LocalQwenBackend | undefined;
  private chain: Promise<void> = Promise.resolve();
  private disposed = false;

  constructor(
    private readonly modelPath: string,
    private readonly createBackend: CreateLocalQwenBackend = createDefaultBackend,
  ) {}

  get ready(): boolean {
    return this.backend !== undefined && !this.disposed;
  }

  /** Start the server, log the build, and run one throwaway generation
   *  so the first real request isn't slow. */
  async init(): Promise<void> {
    if (this.backend) return;
    this.disposed = false;
    this.backend = await this.createBackend(this.modelPath);
    log.info("Local Qwen model loaded", {
      event: "llm.local_loaded",
      build: LLAMA_SERVER_BUILD,
      ctx: LOCAL_QWEN_CONTEXT_SIZE,
      ngl: LLAMA_GPU_LAYERS,
      sockPath: defaultSocketPath(),
      modelPath: this.modelPath,
    });
    try {
      await this.generateInner("Hi", { maxTokens: 8 });
      log.info("Local Qwen warm-up generation completed", { event: "llm.local_warmup" });
    } catch (error) {
      log.warn("Local Qwen warm-up generation failed", {
        event: "llm.local_warmup_failed",
        error: error instanceof Error ? error.message.slice(0, 256) : String(error).slice(0, 256),
      });
    }
  }

  /** Single-shot generation. `maxTokens` is capped to the output budget
   *  and the prompt is truncated to leave room for that output. */
  async generate(prompt: string, options: LocalQwenGenerateOptions = {}): Promise<string> {
    const run = this.chain.then(() => this.generateInner(prompt, options));
    // Keep the chain alive across failures; the caller's `run` still rejects.
    this.chain = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  private async generateInner(prompt: string, options: LocalQwenGenerateOptions): Promise<string> {
    const backend = this.backend;
    if (!backend || this.disposed) throw new Error("Local Qwen service is not initialized");
    const maxTokens = Math.min(
      Math.max(1, Math.floor(options.maxTokens ?? LOCAL_QWEN_DEFAULT_MAX_TOKENS)),
      LOCAL_QWEN_MAX_TOKENS,
    );
    const fitted = fitPromptToContext(prompt, maxTokens);
    if (fitted.truncated) {
      log.warn("Local Qwen prompt truncated to fit context", {
        event: "llm.prompt_truncated",
        originalChars: prompt.length,
        keptChars: fitted.text.length,
        maxTokens,
      });
    }
    return backend.chat(fitted.text, { maxTokens, temperature: options.temperature ?? 0 });
  }

  /** Clean shutdown for daemon stop: SIGTERM the server, remove the socket. */
  async dispose(): Promise<void> {
    this.disposed = true;
    const backend = this.backend;
    this.backend = undefined;
    if (!backend) return;
    try {
      await backend.dispose();
    } catch {}
  }
}

let shared: LocalQwenService | undefined;

/** Shared singleton used by the suggestion generators. */
export function getSharedLocalQwen(): LocalQwenService | undefined {
  return shared?.ready ? shared : undefined;
}

/** For tests: install a pre-initialized service as the shared singleton. */
export function setSharedLocalQwenForTesting(service: LocalQwenService | undefined): void {
  shared = service;
}

/** Daemon startup hook: ensure the file (download on cold start only),
 *  then load + warm up. Never throws -- a failure only disables the local
 *  path and generators fall back to Pi/deterministic output. */
export async function initSharedLocalQwen(
  dbPath: string,
  opts: {
    modelPath?: string;
    url?: string;
    createBackend?: CreateLocalQwenBackend;
    ensureDeps?: EnsureLocalModelDeps;
  } = {},
): Promise<LocalQwenService | undefined> {
  if (shared?.ready) return shared;
  const modelPath = opts.modelPath ?? resolveLocalModelPath(dbPath);
  try {
    await ensureLocalModelFile(modelPath, { url: opts.url, ...(opts.ensureDeps ?? {}) });
  } catch (error) {
    log.warn("Local Qwen model is unavailable; suggestion fallback will be used", {
      event: "llm.local_unavailable",
      modelPath,
      error: error instanceof Error ? error.message.slice(0, 512) : String(error).slice(0, 512),
    });
    return undefined;
  }
  const service = new LocalQwenService(modelPath, opts.createBackend);
  try {
    await service.init();
  } catch (error) {
    log.warn("Local Qwen model failed to load; suggestion fallback will be used", {
      event: "llm.local_load_failed",
      modelPath,
      error: error instanceof Error ? error.message.slice(0, 512) : String(error).slice(0, 512),
    });
    await service.dispose().catch(() => undefined);
    return undefined;
  }
  shared = service;
  return service;
}

/** Daemon shutdown hook. Never throws. */
export async function disposeSharedLocalQwen(): Promise<void> {
  const service = shared;
  shared = undefined;
  if (!service) return;
  await service.dispose().catch(() => undefined);
}

export type { ServerProc };
