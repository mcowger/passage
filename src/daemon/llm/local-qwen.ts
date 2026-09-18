import { existsSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import {
  LOCAL_QWEN_LABEL,
  LOCAL_QWEN_MODEL_VALUE,
  isLocalQwenModelValue,
} from "../../shared/domain/settings.ts";
import { logger } from "../logging.ts";

export { LOCAL_QWEN_LABEL, LOCAL_QWEN_MODEL_VALUE };
export const LOCAL_QWEN_MODEL_URL =
  "https://huggingface.co/Qwen/Qwen2.5-0.5B-Instruct-GGUF/resolve/main/qwen2.5-0.5b-instruct-q4_k_m.gguf";
export const LOCAL_QWEN_FILENAME = "qwen2.5-0.5b-instruct-q4_k_m.gguf";
/** Default cap on generated tokens per one-shot suggestion call. */
export const LOCAL_QWEN_DEFAULT_MAX_TOKENS = 1000;
/** Hard ceiling even when a caller requests more. */
export const LOCAL_QWEN_MAX_TOKENS = 1000;
/** Context window sized for large inputs (up to ~50K input tokens) plus
 *  the max output budget and prompt overhead, aligned to a multiple of
 *  256 as llama.cpp requires. */
export const LOCAL_QWEN_CONTEXT_SIZE = 53248;

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

export type LocalQwenBackend = {
  llama: { gpu: unknown; dispose: () => unknown | Promise<unknown> };
  model: { createContext?: (...args: never[]) => unknown; dispose: () => unknown | Promise<unknown> };
  context: { getSequence: () => { dispose?: () => unknown | Promise<unknown> }; dispose: () => unknown | Promise<unknown> };
};

export type CreateLocalQwenBackend = (modelPath: string) => Promise<LocalQwenBackend>;

/** Default backend: auto-detected GPU (Vulkan/CUDA/Metal, else CPU),
 *  model + context kept loaded across calls. */
export const createDefaultBackend: CreateLocalQwenBackend = async (modelPath: string) => {
  const { getLlama, LlamaChatSession } = await import("node-llama-cpp");
  // Keep a module-level handle so generate() can construct sessions without
  // re-importing; stored on globalThis to survive singleton resets in tests.
  (globalThis as Record<string, unknown>).__passageLlamaChatSession = LlamaChatSession;
  const llama = await getLlama();
  const model = await llama.loadModel({ modelPath });
  const context = await model.createContext({ contextSize: LOCAL_QWEN_CONTEXT_SIZE });
  return {
    llama,
    model,
    context: context as unknown as LocalQwenBackend["context"],
  };
};

function getSessionCtor(): new (opts: { contextSequence: unknown }) => {
  prompt: (text: string, opts?: { maxTokens?: number; temperature?: number }) => Promise<string>;
  dispose: (opts?: { disposeSequence?: boolean }) => void | Promise<void>;
} {
  const ctor = (globalThis as Record<string, unknown>).__passageLlamaChatSession as
    | (new (opts: { contextSequence: unknown }) => {
        prompt: (text: string, opts?: { maxTokens?: number; temperature?: number }) => Promise<string>;
        dispose: (opts?: { disposeSequence?: boolean }) => void | Promise<void>;
      })
    | undefined;
  if (!ctor) throw new Error("Local Qwen backend is not initialized");
  return ctor;
}

export type LocalQwenGenerateOptions = {
  maxTokens?: number;
  temperature?: number;
};

/** In-process Qwen service. Model + context stay loaded; every generate()
 *  call uses its own fresh sequence/session so no chat history leaks
 *  between one-shot title/branch/commit prompts. Serializes concurrent
 *  calls through a chain so small contexts are never over-subscribed. */
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

  /** Load the model, log the selected GPU backend, and run one throwaway
   *  generation so the first real request isn't slow. */
  async init(): Promise<void> {
    if (this.backend) return;
    this.disposed = false;
    this.backend = await this.createBackend(this.modelPath);
    let gpu = "unknown";
    try {
      gpu = String(this.backend.llama.gpu ?? "unknown");
    } catch {}
    log.info("Local Qwen model loaded", { event: "llm.local_loaded", gpu, modelPath: this.modelPath });
    try {
      await this.generateInner("Hi", { maxTokens: 8 });
      log.info("Local Qwen warm-up generation completed", { event: "llm.local_warmup", gpu });
    } catch (error) {
      log.warn("Local Qwen warm-up generation failed", {
        event: "llm.local_warmup_failed",
        gpu,
        error: error instanceof Error ? error.message.slice(0, 256) : String(error).slice(0, 256),
      });
    }
  }

  /** Single-shot generation with a fresh sequence/session per call.
   *  `maxTokens` is capped to keep title/branch output short. */
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
    const sequence = backend.context.getSequence();
    const SessionCtor = getSessionCtor();
    const session = new SessionCtor({ contextSequence: sequence });
    try {
      const text = await session.prompt(prompt, { maxTokens, temperature: options.temperature ?? 0 });
      return text;
    } finally {
      try {
        await session.dispose({ disposeSequence: true });
      } catch {
        try {
          await (sequence as { dispose?: () => Promise<void> | void }).dispose?.();
        } catch {}
      }
    }
  }

  /** Clean disposal for graceful daemon shutdown: context/model/llama. */
  async dispose(): Promise<void> {
    this.disposed = true;
    const backend = this.backend;
    this.backend = undefined;
    if (!backend) return;
    // Reverse order of creation; each step is best-effort so one failure
    // never blocks releasing the rest.
    try {
      await backend.context.dispose();
    } catch {}
    try {
      await backend.model.dispose();
    } catch {}
    try {
      await backend.llama.dispose();
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
