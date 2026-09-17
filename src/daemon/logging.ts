import { AsyncLocalStorage } from "node:async_hooks";
import {
  configure,
  getConsoleSink,
  getJsonLinesFormatter,
  getLogger,
  type Logger,
} from "@logtape/logtape";
import { redactByField, redactByPattern, JWT_PATTERN } from "@logtape/redaction";

const MAX_ERROR_MESSAGE_LENGTH = 512;
const contextLocalStorage = new AsyncLocalStorage<Record<string, unknown>>();

function createSink() {
  const formatter = redactByPattern(
    getJsonLinesFormatter({ categorySeparator: ".", properties: "flatten" }),
    [JWT_PATTERN],
  );
  return redactByField(
    getConsoleSink({ formatter }),
    {
      fieldPatterns: [
        /authorization/i,
        /cookie/i,
        /password/i,
        /secret/i,
        /token/i,
        /api[-_]?key/i,
        /prompt/i,
        /completion/i,
        /content/i,
        /data/i,
      ],
      action: (value) => typeof value === "string" ? `[redacted:${value.length}]` : "[redacted]",
      maxDepth: 12,
      maxProperties: 256,
    },
  );
}

export async function configureLogging(): Promise<void> {
  const sink = createSink();
  await configure({
    sinks: { console: sink },
    contextLocalStorage,
    loggers: [
      { category: ["passage"], sinks: ["console"], lowestLevel: "debug" },
      { category: ["hono"], sinks: ["console"], lowestLevel: "info" },
      { category: ["logtape"], sinks: ["console"], lowestLevel: "error" },
    ],
  });
}

export function createRedactedSinkForTesting() {
  return createSink();
}

export function logger(...category: string[]): Logger {
  return getLogger(["passage", ...category]);
}

export function errorFields(error: unknown): Record<string, string> {
  if (error instanceof Error) {
    return {
      errorType: error.name,
      errorMessage: error.message.slice(0, MAX_ERROR_MESSAGE_LENGTH),
    };
  }
  return {
    errorType: typeof error,
    errorMessage: String(error).slice(0, MAX_ERROR_MESSAGE_LENGTH),
  };
}
