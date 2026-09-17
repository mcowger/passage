import { z } from "zod";
import { agentCapabilitiesSchema } from "../../shared/domain/agents.ts";

export type CatalogModel = z.infer<typeof agentCapabilitiesSchema>["models"][number];

const MODELS_TIMEOUT_MS = 10_000;
const MAX_RESPONSE_BYTES = 4 * 1024 * 1024;

export type ModelCatalogProbeOptions = {
  executable?: string;
  executableArgs?: string[];
  timeoutMs?: number;
  cwd?: string;
};

/** Normalize raw `get_available_models` payloads into validated catalog models.
 * Shared by the agent capabilities flow and the global `/api/models` probe so
 * both surfaces agree on what pi reports. */
export function normalizeAvailableModels(data: { models?: unknown[] } | undefined): CatalogModel[] {
  const models = (data?.models ?? []).flatMap((value) => {
    if (value === null || typeof value !== "object" || Array.isArray(value)) return [];
    const record = value as Record<string, unknown>;
    if (typeof record.provider !== "string" || typeof record.id !== "string") return [];

    let supportedThinkingLevels: string[] = [];
    if (Array.isArray(record.supportedThinkingLevels)) {
      supportedThinkingLevels = record.supportedThinkingLevels.filter((item): item is string => typeof item === "string").slice(0, 16);
    } else if (record.thinkingLevelMap && typeof record.thinkingLevelMap === "object" && !Array.isArray(record.thinkingLevelMap)) {
      const map = record.thinkingLevelMap as Record<string, unknown>;
      supportedThinkingLevels = Object.keys(map).filter((k) => map[k] !== null).slice(0, 16);
    }

    return [{
      provider: record.provider,
      id: record.id,
      name: typeof record.name === "string" ? record.name : record.id,
      api: typeof record.api === "string" ? record.api : "unknown",
      input: Array.isArray(record.input) ? record.input.filter((item): item is string => typeof item === "string").slice(0, 8) : [],
      authenticated: record.authenticated !== false,
      supportedThinkingLevels,
      ...(typeof record.contextWindow === "number" && Number.isSafeInteger(record.contextWindow) && record.contextWindow > 0
        ? { contextWindow: record.contextWindow }
        : {}),
      ...(typeof record.maxTokens === "number" && Number.isSafeInteger(record.maxTokens) && record.maxTokens > 0
        ? { maxTokens: record.maxTokens }
        : {}),
    }];
  }).slice(0, 100);
  return agentCapabilitiesSchema.shape.models.parse(models);
}

type PiRpcResponse = {
  type?: string;
  id?: string;
  command?: string;
  success?: boolean;
  data?: { models?: unknown[] };
  error?: unknown;
};

/** Probe `pi --mode rpc` for its model catalog with a fixed timeout. Throws
 * when pi is missing, times out, or answers with a failure. */
export async function queryAvailableModels(options: ModelCatalogProbeOptions = {}): Promise<CatalogModel[]> {
  const timeoutMs = options.timeoutMs ?? MODELS_TIMEOUT_MS;
  const executable = options.executable ?? process.env.PASSAGE_PI_PATH ?? Bun.which("pi");
  if (!executable) throw new Error("Pi CLI was not found; set PASSAGE_PI_PATH");

  const proc = Bun.spawn([executable, ...(options.executableArgs ?? []), "--mode", "rpc"], {
    cwd: options.cwd,
    env: { ...process.env, NO_COLOR: "1" },
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
  });

  let timeoutId: ReturnType<typeof setTimeout> | undefined;
  const timeoutPromise = new Promise<null>((resolve) => {
    timeoutId = setTimeout(() => {
      try { proc.kill(); } catch {}
      resolve(null);
    }, timeoutMs);
  });

  const rpcPromise = (async (): Promise<CatalogModel[] | null> => {
    try {
      const stdin = proc.stdin;
      if (!stdin) return null;
      stdin.write(JSON.stringify({ type: "get_available_models", id: "req_models_1" }) + "\n");
      await stdin.flush?.();

      const reader = (proc.stdout as ReadableStream<Uint8Array>).getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value);
          if (buffer.length > MAX_RESPONSE_BYTES) return null;
          const lines = buffer.split("\n");
          buffer = lines.pop() ?? "";
          for (const line of lines) {
            if (!line.trim()) continue;
            let parsed: PiRpcResponse;
            try {
              parsed = JSON.parse(line) as PiRpcResponse;
            } catch {
              continue;
            }
            if (parsed.type === "response" && parsed.id === "req_models_1") {
              if (!parsed.success) throw new Error(String(parsed.error ?? "Pi model probe failed"));
              return normalizeAvailableModels(parsed.data);
            }
          }
        }
      } finally {
        reader.releaseLock();
      }
      return null;
    } catch (error) {
      if (error instanceof Error && /probe failed|Pi CLI/.test(error.message)) throw error;
      return null;
    }
  })();

  try {
    const result = await Promise.race([rpcPromise, timeoutPromise]);
    if (!result) throw new Error("Pi model probe timed out or returned no models");
    return result;
  } finally {
    if (timeoutId) clearTimeout(timeoutId);
    try { proc.kill(); } catch {}
  }
}
