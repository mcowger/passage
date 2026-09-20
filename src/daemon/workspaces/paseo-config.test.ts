import { describe, expect, test } from "bun:test";
import { mkdtemp } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { writeFile } from "node:fs/promises";
import { readPaseoConfig } from "./paseo-config.ts";

async function dirWithConfig(config: unknown): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "passage-paseo-config-"));
  await writeFile(join(dir, "paseo.json"), JSON.stringify(config));
  return dir;
}

describe("readPaseoConfig", () => {
  test("returns empty defaults without a paseo.json file", async () => {
    const dir = await mkdtemp(join(tmpdir(), "passage-paseo-missing-"));
    expect(readPaseoConfig(dir)).toEqual({ setup: [], teardown: [], scripts: [], servicePorts: undefined });
  });

  test("returns empty defaults for invalid JSON", async () => {
    const dir = await mkdtemp(join(tmpdir(), "passage-paseo-invalid-"));
    await writeFile(join(dir, "paseo.json"), "{not json");
    expect(readPaseoConfig(dir)).toEqual({ setup: [], teardown: [], scripts: [], servicePorts: undefined });
  });

  test("reads setup and teardown as strings or arrays", async () => {
    const dir = await dirWithConfig({
      worktree: { setup: "npm ci", teardown: ["down-a", " ", "down-b"] },
    });
    const config = readPaseoConfig(dir);
    expect(config.setup).toEqual(["npm ci"]);
    expect(config.teardown).toEqual(["down-a", "down-b"]);
  });

  test("parses scripts with service/plain types and explicit ports", async () => {
    const dir = await dirWithConfig({
      scripts: {
        dev: { type: "service", command: "bun run dev" },
        tunnel: { command: "bun scripts/run-frpc.ts" },
        web: { type: "service", command: "npm run dev", port: 3000 },
        broken: { type: "service" },
        huge: { type: "service", command: "x", port: 99999 },
      },
    });
    const config = readPaseoConfig(dir);
    expect(config.scripts).toEqual([
      { name: "dev", type: "service", command: "bun run dev", port: null },
      { name: "tunnel", type: "script", command: "bun scripts/run-frpc.ts", port: null },
      { name: "web", type: "service", command: "npm run dev", port: 3000 },
      { name: "huge", type: "service", command: "x", port: null },
    ]);
  });

  test("parses servicePorts range and portScript, rejecting bad ranges", async () => {
    const good = await dirWithConfig({ worktree: { servicePorts: { range: "3000-4000" } } });
    expect(readPaseoConfig(good).servicePorts).toEqual({ range: "3000-4000" });

    const script = await dirWithConfig({ worktree: { servicePorts: { portScript: "./scripts/dev-port.ts" } } });
    expect(readPaseoConfig(script).servicePorts).toEqual({ portScript: "./scripts/dev-port.ts" });

    const bad = await dirWithConfig({ worktree: { servicePorts: { range: "4000-3000" } } });
    expect(readPaseoConfig(bad).servicePorts).toBeUndefined();

    const empty = await dirWithConfig({ worktree: { servicePorts: {} } });
    expect(readPaseoConfig(empty).servicePorts).toBeUndefined();
  });
});
