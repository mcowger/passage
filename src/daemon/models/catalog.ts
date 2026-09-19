import { z } from "zod";
import { agentCapabilitiesSchema } from "../../shared/domain/agents.ts";
import { sanitizedSubprocessEnv } from "../env.ts";

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
  data?: { models?: unknown[]; levels?: unknown[] };
  error?: unknown;
};

export type ModelCatalog = {
  models: CatalogModel[];
  thinkingLevels: string[];
};

function normalizeThinkingLevels(data: { levels?: unknown[] } | undefined): string[] {
  return (data?.levels ?? [])
    .filter((value): value is string => typeof value === "string")
    .slice(0, 16);
}

/** Probe `pi --mode rpc` for its model catalog plus the global thinking
 * levels with a fixed timeout. A single probe session issues both RPCs so
 * `/api/models` and per-agent capabilities agree. Models without an
 * explicit `thinkingLevelMap` normalize to an empty
 * `supportedThinkingLevels` list, which callers must treat as "supports
 * the global levels" (not "supports none") -- pi's TUI falls back to
 * the global list for exactly those models. Throws when pi is missing,
 * times out, or answers with a failure. */
export async function queryModelCatalog(options: ModelCatalogProbeOptions = {}): Promise<ModelCatalog> {
  const timeoutMs = options.timeoutMs ?? MODELS_TIMEOUT_MS;
  const executable = options.executable ?? process.env.PASSAGE_PI_PATH ?? Bun.which("pi");
  if (!executable) throw new Error("Pi CLI was not found; set PASSAGE_PI_PATH");

  const proc = Bun.spawn([executable, ...(options.executableArgs ?? []), "--mode", "rpc"], {
    cwd: options.cwd,
    env: sanitizedSubprocessEnv({ NO_COLOR: "1" }),
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

  const rpcPromise = (async (): Promise<ModelCatalog | null> => {
    try {
      const stdin = proc.stdin;
      if (!stdin) return null;
      stdin.write(JSON.stringify({ type: "get_available_models", id: "req_models_1" }) + "\n");
      stdin.write(JSON.stringify({ type: "get_available_thinking_levels", id: "req_thinking_1" }) + "\n");
      await stdin.flush?.();

      const reader = (proc.stdout as ReadableStream<Uint8Array>).getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      let modelsData: { models?: unknown[] } | undefined;
      let thinkingData: { levels?: unknown[] } | undefined;
      const handleLine = (line: string): boolean => {
        if (!line.trim()) return false;
        let parsed: PiRpcResponse;
        try {
          parsed = JSON.parse(line) as PiRpcResponse;
        } catch {
          return false;
        }
        if (parsed.type !== "response") return false;
        if (parsed.id === "req_models_1") {
          if (!parsed.success) throw new Error(String(parsed.error ?? "Pi model probe failed"));
          modelsData = parsed.data;
        } else if (parsed.id === "req_thinking_1") {
          thinkingData = parsed.success ? parsed.data : {};
        }
        return Boolean(modelsData && thinkingData);
      };
      try {
        // Phase 1 (required): wait for the model list.
        while (!modelsData) {
          const { done, value } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value);
          if (buffer.length > MAX_RESPONSE_BYTES) return null;
          const lines = buffer.split("\n");
          buffer = lines.pop() ?? "";
          for (const line of lines) {
            if (handleLine(line)) break;
          }
        }
        if (!modelsData) return null;
        // Phase 2 (best-effort): older pi releases may not know
        // `get_available_thinking_levels` and never answer it. Give
        // the levels a brief grace period, then proceed without a
        // fallback rather than holding Settings for the full probe
        // timeout. Cancel the stream on timeout so no read is left
        // pending on the released reader.
        while (!thinkingData) {
          const timeout = new Promise<"timed-out">((resolve) =>
            setTimeout(() => resolve("timed-out"), 1500),
          );
          const outcome = await Promise.race([reader.read(), timeout]);
          if (outcome === "timed-out") {
            try { await reader.cancel(); } catch {}
            break;
          }
          const { done, value } = outcome;
          if (done) break;
          buffer += decoder.decode(value);
          if (buffer.length > MAX_RESPONSE_BYTES) return null;
          const lines = buffer.split("\n");
          buffer = lines.pop() ?? "";
          for (const line of lines) {
            if (handleLine(line)) break;
          }
        }
      } finally {
        reader.releaseLock();
      }
      if (!modelsData) return null;
      return {
        models: normalizeAvailableModels(modelsData),
        thinkingLevels: normalizeThinkingLevels(thinkingData),
      };
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

/** Back-compat wrapper: model list only. Prefer `queryModelCatalog` so
 *  callers also get the global thinking-level fallback. */
export async function queryAvailableModels(options: ModelCatalogProbeOptions = {}): Promise<CatalogModel[]> {
  return (await queryModelCatalog(options)).models;
}
