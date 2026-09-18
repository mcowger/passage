import { describe, expect, it, afterEach } from "bun:test";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { mkdtemp, rm } from "node:fs/promises";
import {
  LOCAL_QWEN_CONTEXT_SIZE,
  LOCAL_QWEN_DEFAULT_MAX_TOKENS,
  LOCAL_QWEN_MAX_TOKENS,
  LocalQwenService,
  disposeSharedLocalQwen,
  ensureLocalModelFile,
  initSharedLocalQwen,
  isLocalQwenModel,
  resolveLocalModelPath,
  setSharedLocalQwenForTesting,
  type LocalQwenBackend,
} from "./local-qwen.ts";

afterEach(async () => {
  await disposeSharedLocalQwen();
  setSharedLocalQwenForTesting(undefined);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  delete (globalThis as any).__passageLlamaChatSession;
});

describe("isLocalQwenModel", () => {
  it("matches the local value and trims whitespace", () => {
    expect(isLocalQwenModel("local/qwen2.5-0.5b-instruct")).toBe(true);
    expect(isLocalQwenModel("  local/qwen2.5-0.5b-instruct  ")).toBe(true);
    expect(isLocalQwenModel("anthropic/claude-haiku")).toBe(false);
    expect(isLocalQwenModel("")).toBe(false);
    expect(isLocalQwenModel(undefined)).toBe(false);
  });
});

describe("resolveLocalModelPath", () => {
  it("places the GGUF beside the DB path", () => {
    expect(resolveLocalModelPath("/data/passage.sqlite")).toBe("/data/qwen2.5-0.5b-instruct-q4_k_m.gguf");
  });
});

describe("ensureLocalModelFile", () => {
  it("cache-hit: never re-downloads when the file is present", async () => {
    let fetchCalls = 0;
    const result = await ensureLocalModelFile("/models/qwen.gguf", {
      existsImpl: () => true,
      fetchImpl: (async () => {
        fetchCalls += 1;
        throw new Error("must not fetch on cache-hit");
      }) as unknown as typeof fetch,
    });
    expect(result).toEqual({ path: "/models/qwen.gguf", downloaded: false });
    expect(fetchCalls).toBe(0);
  });

  it("cold start: downloads the model when missing", async () => {
    const dir = await mkdtemp(join(tmpdir(), "passage-qwen-cold-"));
    try {
      const modelPath = join(dir, "qwen2.5-0.5b-instruct-q4_k_m.gguf");
      const payload = new TextEncoder().encode("fake-gguf-bytes");
      let fetchedUrl = "";
      const result = await ensureLocalModelFile(modelPath, {
        existsImpl: () => false,
        fetchImpl: (async (url: string) => {
          fetchedUrl = url;
          return new Response(payload, { status: 200 });
        }) as unknown as typeof fetch,
      });
      expect(result.downloaded).toBe(true);
      expect(result.path).toBe(modelPath);
      expect(fetchedUrl).toContain("huggingface.co/Qwen/Qwen2.5-0.5B-Instruct-GGUF");
      const stored = await Bun.file(modelPath).arrayBuffer();
      expect(new Uint8Array(stored)).toEqual(payload);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("throws when the download fails", async () => {
    await expect(
      ensureLocalModelFile("/tmp/missing-qwen.gguf", {
        existsImpl: () => false,
        fetchImpl: (async () => new Response("nope", { status: 404 })) as unknown as typeof fetch,
      }),
    ).rejects.toThrow();
  });
});

function makeFakeBackend(seen: { sequences: number; prompts: Array<{ text: string; maxTokens?: number }> }): LocalQwenBackend {
  // Minimal chat-session constructor: fresh session per generate() call.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (globalThis as any).__passageLlamaChatSession = class {
    constructor(private readonly opts: { contextSequence: unknown }) {}
    async prompt(text: string, promptOpts?: { maxTokens?: number }): Promise<string> {
      seen.prompts.push({ text, maxTokens: promptOpts?.maxTokens });
      return `title for ${text.slice(0, 12)}`;
    }
    async dispose() {
      await (this.opts.contextSequence as { dispose?: () => Promise<void> }).dispose?.();
    }
  };
  const context = {
    getSequence: () => {
      seen.sequences += 1;
      return { dispose: async () => undefined };
    },
    dispose: async () => undefined,
  };
  return {
    llama: { gpu: "cpu", dispose: async () => undefined },
    model: { dispose: async () => undefined },
    context,
  };
}

describe("LocalQwenService.generate", () => {
  it("produces output without throwing and uses a fresh sequence per call", async () => {
    const seen = { sequences: 0, prompts: [] as Array<{ text: string; maxTokens?: number }> };
    const service = new LocalQwenService("/models/qwen.gguf", async () => makeFakeBackend(seen));
    await service.init();
    // init() runs one throwaway warm-up generation.
    expect(seen.sequences).toBe(1);
    const out = await service.generate("Suggest a short title for: fix login retry");
    expect(typeof out).toBe("string");
    expect(out.length).toBeGreaterThan(0);
    expect(seen.sequences).toBe(2);
    expect(seen.prompts.at(-1)?.maxTokens).toBeLessThanOrEqual(LOCAL_QWEN_DEFAULT_MAX_TOKENS);
    await service.dispose();
    expect(service.ready).toBe(false);
  });

  it("caps maxTokens to the output budget", async () => {
    const seen = { sequences: 0, prompts: [] as Array<{ text: string; maxTokens?: number }> };
    const service = new LocalQwenService("/models/qwen.gguf", async () => makeFakeBackend(seen));
    await service.init();
    await service.generate("hello", { maxTokens: 2000 });
    expect(seen.prompts.at(-1)?.maxTokens).toBe(LOCAL_QWEN_MAX_TOKENS);
    await service.generate("hello");
    expect(seen.prompts.at(-1)?.maxTokens).toBe(LOCAL_QWEN_DEFAULT_MAX_TOKENS);
    expect(LOCAL_QWEN_DEFAULT_MAX_TOKENS).toBe(1000);
    expect(LOCAL_QWEN_MAX_TOKENS).toBe(1000);
    await service.dispose();
  });

  it("sizes the context window for large inputs", () => {
    // ~50K input tokens + output budget + overhead, llama.cpp-aligned.
    expect(LOCAL_QWEN_CONTEXT_SIZE).toBeGreaterThanOrEqual(51000);
    expect(LOCAL_QWEN_CONTEXT_SIZE % 256).toBe(0);
  });

  it("dispose is safe to call twice", async () => {
    const seen = { sequences: 0, prompts: [] as Array<{ text: string; maxTokens?: number }> };
    const service = new LocalQwenService("/models/qwen.gguf", async () => makeFakeBackend(seen));
    await service.init();
    await service.dispose();
    await service.dispose();
  });
});

describe("initSharedLocalQwen", () => {
  it("cold start triggers a download then initializes", async () => {
    const dir = await mkdtemp(join(tmpdir(), "passage-qwen-shared-"));
    try {
      const dbPath = join(dir, "passage.sqlite");
      const seen = { sequences: 0, prompts: [] as Array<{ text: string; maxTokens?: number }> };
      let fetchCalls = 0;
      const service = await initSharedLocalQwen(dbPath, {
        createBackend: async () => makeFakeBackend(seen),
        ensureDeps: {
          existsImpl: () => false,
          fetchImpl: (async () => {
            fetchCalls += 1;
            return new Response(new TextEncoder().encode("gguf"), { status: 200 });
          }) as unknown as typeof fetch,
        },
      });
      expect(service?.ready).toBe(true);
      expect(fetchCalls).toBe(1);
      // Warm-up ran once during init.
      expect(seen.sequences).toBe(1);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
