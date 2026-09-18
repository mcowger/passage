import { describe, expect, test } from "bun:test";
import { createModelRoutes } from "./models.ts";
import { normalizeAvailableModels } from "../models/catalog.ts";

const fakePi = `
let buffer = "";
process.stdin.on("data", chunk => {
  buffer += chunk.toString();
  let newline;
  while ((newline = buffer.indexOf("\\n")) !== -1) {
    const line = buffer.slice(0, newline);
    buffer = buffer.slice(newline + 1);
    if (!line) continue;
    const command = JSON.parse(line);
    const data = command.type === "get_available_thinking_levels"
      ? { levels: ["off", "minimal", "low", "medium", "high"] }
      : { models: [{ provider: "test", id: "model", name: "Model", api: "test", input: ["text"], authenticated: true, supportedThinkingLevels: ["medium", "high"] }] };
    process.stdout.write(JSON.stringify({ type: "response", id: command.id, command: command.type, success: true, data }) + "\\n");
  }
});`;

const request = (path: string, init?: RequestInit) => new Request(`http://localhost${path}`, init);

describe("models HTTP API", () => {
  test("probes pi for the model catalog", async () => {
    const app = createModelRoutes({ executable: process.execPath, executableArgs: ["-e", fakePi], timeoutMs: 10_000 });
    const res = await app.fetch(request("/api/models"));
    expect(res.status).toBe(200);
    const json = (await res.json()) as { models: Array<{ provider: string; id: string; name: string }>; thinkingLevels: string[] };
    expect(json.models).toHaveLength(1);
    expect(json.models[0]).toMatchObject({ provider: "test", id: "model", name: "Model" });
    expect(json.thinkingLevels).toEqual(["off", "minimal", "low", "medium", "high"]);
  });

  test("proceeds without a fallback when pi never answers the levels probe", async () => {
    const modelsOnlyPi = `
let buffer = "";
process.stdin.on("data", chunk => {
  buffer += chunk.toString();
  let newline;
  while ((newline = buffer.indexOf("\\n")) !== -1) {
    const line = buffer.slice(0, newline);
    buffer = buffer.slice(newline + 1);
    if (!line) continue;
    const command = JSON.parse(line);
    if (command.type !== "get_available_models") continue;
    const data = { models: [{ provider: "test", id: "model", name: "Model", api: "test", input: ["text"], authenticated: true }] };
    process.stdout.write(JSON.stringify({ type: "response", id: command.id, command: command.type, success: true, data }) + "\\n");
  }
});`;
    const app = createModelRoutes({ executable: process.execPath, executableArgs: ["-e", modelsOnlyPi], timeoutMs: 10_000 });
    const start = Date.now();
    const res = await app.fetch(request("/api/models"));
    expect(res.status).toBe(200);
    const json = (await res.json()) as { models: unknown[]; thinkingLevels: string[] };
    expect(json.models).toHaveLength(1);
    expect(json.thinkingLevels).toEqual([]);
    // Must use the short best-effort grace period, not the full probe timeout.
    expect(Date.now() - start).toBeLessThan(10_000);
  });

  test("returns 502 when pi is unavailable", async () => {
    const app = createModelRoutes({ executable: "/nonexistent-pi-binary-for-test", timeoutMs: 1000 });
    const res = await app.fetch(request("/api/models"));
    expect(res.status).toBe(502);
    const json = (await res.json()) as { error: string };
    expect(json.error).toBe("models-unavailable");
  });

  test("normalizes thinkingLevelMap and drops invalid entries", () => {
    const models = normalizeAvailableModels({
      models: [
        { provider: "p", id: "m", thinkingLevelMap: { low: "low", off: null } },
        { provider: "p" },
        null,
      ],
    });
    expect(models).toHaveLength(1);
    expect(models[0]).toMatchObject({ provider: "p", id: "m", name: "m", supportedThinkingLevels: ["low"] });
  });
});
