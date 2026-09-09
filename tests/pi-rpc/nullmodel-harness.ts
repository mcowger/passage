import { mkdtemp, rm } from "node:fs/promises";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
// @ts-expect-error nullmodel is untyped JS
import { loadConfig } from "nullmodel/src/config.js";
// @ts-expect-error nullmodel is untyped JS
import { createNullModelServer } from "nullmodel/src/server.js";

export type NullModelHarness = {
  port: number;
  agentDir: string;
  server: Server;
  cleanup: () => Promise<void>;
};

export type NullModelHarnessOptions = {
  persona?: string;
  firstTokenMs?: number;
  perTokenMs?: number;
};

/**
 * Starts an in-process NullModel HTTP server on an ephemeral port,
 * writes an isolated Pi agent directory configuring `nullmodel/null-gpt`
 * as the default provider/model, and sets PI_CODING_AGENT_DIR.
 */
export async function startNullModelHarness(options: NullModelHarnessOptions = {}): Promise<NullModelHarness> {
  const root = await mkdtemp(join(tmpdir(), "passage-nullmodel-"));
  const agentDir = join(root, "agent");

  const config = loadConfig({
    port: 0,
    defaults: { persona: options.persona ?? "terse" },
    latency: {
      firstToken: options.firstTokenMs ?? 5,
      perToken: options.perTokenMs ?? 2,
      variance: 0,
    },
    chaos: { enabled: false },
    verbose: false,
  });

  const server: Server = createNullModelServer(config);
  await new Promise<void>((resolve, reject) => {
    server.listen(0, () => resolve());
    server.once("error", reject);
  });

  const address = server.address() as AddressInfo;
  const port = address.port;

  await Bun.write(
    join(agentDir, "models.json"),
    JSON.stringify({
      providers: {
        nullmodel: {
          baseUrl: `http://127.0.0.1:${port}/v1`,
          api: "openai-completions",
          apiKey: "fake-key",
          compat: { supportsDeveloperRole: false, supportsReasoningEffort: false },
          models: [{ id: "null-gpt" }],
        },
      },
    }, null, 2),
  );

  await Bun.write(
    join(agentDir, "settings.json"),
    JSON.stringify({
      defaultProvider: "nullmodel",
      defaultModel: "null-gpt",
      enabledProviders: ["nullmodel"],
      quietStartup: true,
    }, null, 2),
  );

  const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = agentDir;

  let cleaned = false;
  const cleanup = async () => {
    if (cleaned) return;
    cleaned = true;

    if (previousAgentDir !== undefined) {
      process.env.PI_CODING_AGENT_DIR = previousAgentDir;
    } else {
      delete process.env.PI_CODING_AGENT_DIR;
    }

    await new Promise<void>((resolve) => {
      server.close(() => resolve());
    });

    await rm(root, { recursive: true, force: true });
  };

  return { port, agentDir, server, cleanup };
}

/**
 * Runs the given async callback within an active NullModel harness.
 */
export async function withNullModelHarness<T>(
  action: (harness: NullModelHarness) => Promise<T>,
  options?: NullModelHarnessOptions,
): Promise<T> {
  const harness = await startNullModelHarness(options);
  try {
    return await action(harness);
  } finally {
    await harness.cleanup();
  }
}
