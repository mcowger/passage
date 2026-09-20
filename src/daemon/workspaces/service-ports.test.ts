import { describe, expect, test } from "bun:test";
import { mkdtemp } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { chmod, writeFile } from "node:fs/promises";
import {
  allocateWorkspaceServicePort,
  assertNoServiceEnvNameCollisions,
  buildWorkspaceServiceEnv,
  normalizeServiceEnvName,
} from "./service-ports.ts";

describe("normalizeServiceEnvName", () => {
  test("uppercases and collapses non-alphanumerics", () => {
    expect(normalizeServiceEnvName("app-server")).toBe("APP_SERVER");
    expect(normalizeServiceEnvName("app.server")).toBe("APP_SERVER");
    expect(normalizeServiceEnvName("web")).toBe("WEB");
  });

  test("collisions throw", () => {
    expect(() => assertNoServiceEnvNameCollisions(["app-server", "app.server"])).toThrow(/collision/);
    expect(() => assertNoServiceEnvNameCollisions(["api", "web"])).not.toThrow();
  });
});

describe("buildWorkspaceServiceEnv", () => {
  test("sets self plus peer vars with direct localhost URLs", () => {
    const env = buildWorkspaceServiceEnv({
      scriptName: "web",
      peers: [
        { scriptName: "web", port: 3000 },
        { scriptName: "api", port: 4000 },
      ],
    });
    expect(env.HOST).toBe("0.0.0.0");
    expect(env.PASEO_PORT).toBe("3000");
    expect(env.PASEO_URL).toBe("http://127.0.0.1:3000");
    expect(env.PASEO_SERVICE_API_PORT).toBe("4000");
    expect(env.PASEO_SERVICE_API_URL).toBe("http://127.0.0.1:4000");
    expect(env.PASEO_SERVICE_WEB_PORT).toBe("3000");
  });

  test("requires the requesting service in peers", () => {
    expect(() => buildWorkspaceServiceEnv({ scriptName: "missing", peers: [] })).toThrow(/missing/);
  });
});

describe("allocateWorkspaceServicePort", () => {
  test("allocates inside the configured range skipping reserved ports", async () => {
    const port = await allocateWorkspaceServicePort({
      allocation: { range: "48800-48805" },
      cwd: tmpdir(),
      scriptName: "web",
      workspaceId: "wsp_test",
      branchName: null,
      reservedPorts: new Set([48800, 48801, 48802, 48803, 48804]),
    });
    expect(port).toBe(48805);
  });

  test("fails when the range is exhausted", async () => {
    await expect(
      allocateWorkspaceServicePort({
        allocation: { range: "48810-48810" },
        cwd: tmpdir(),
        scriptName: "web",
        workspaceId: "wsp_test",
        branchName: null,
        reservedPorts: new Set([48810]),
      }),
    ).rejects.toThrow(/No available service port/);
  });

  test("trusts portScript output without availability checks", async () => {
    const dir = await mkdtemp(join(tmpdir(), "passage-portscript-"));
    const scriptPath = join(dir, "port.sh");
    await writeFile(scriptPath, "#!/bin/sh\necho 48999\n");
    await chmod(scriptPath, 0o755);
    const port = await allocateWorkspaceServicePort({
      allocation: { portScript: scriptPath },
      cwd: dir,
      scriptName: "web",
      workspaceId: "wsp_test",
      branchName: "feature/x",
    });
    expect(port).toBe(48999);
  });

  test("rejects non-numeric portScript output", async () => {
    const dir = await mkdtemp(join(tmpdir(), "passage-portscript-bad-"));
    const scriptPath = join(dir, "port.sh");
    await writeFile(scriptPath, "#!/bin/sh\necho hello\n");
    await chmod(scriptPath, 0o755);
    await expect(
      allocateWorkspaceServicePort({
        allocation: { portScript: scriptPath },
        cwd: dir,
        scriptName: "web",
        workspaceId: "wsp_test",
        branchName: null,
      }),
    ).rejects.toThrow(/exactly one TCP port/);
  });

  test("falls back to an ephemeral port without allocation config", async () => {
    const port = await allocateWorkspaceServicePort({
      allocation: undefined,
      cwd: tmpdir(),
      scriptName: "web",
      workspaceId: "wsp_test",
      branchName: null,
    });
    expect(port).toBeGreaterThan(0);
    expect(port).toBeLessThan(65536);
  });
});
