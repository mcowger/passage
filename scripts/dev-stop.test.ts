import { describe, expect, it } from "bun:test";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isProcessAlive, portFileForPidFile, removePidArtifacts, resolvePidFile, stopDevServer } from "./dev-stop.ts";

describe("dev-stop", () => {
  it("resolves default pidfile or honors PASSAGE_PID_FILE", () => {
    expect(resolvePidFile({})).toContain(".data/dev.pid");
    expect(resolvePidFile({ PASSAGE_PID_FILE: "/tmp/custom.pid" })).toBe("/tmp/custom.pid");
  });

  it("checks if process is alive", () => {
    expect(isProcessAlive(process.pid)).toBe(true);
    expect(isProcessAlive(9999999)).toBe(false);
  });

  it("returns not running when pidfile does not exist", async () => {
    const nonExistent = join(tmpdir(), `non-existent-${Date.now()}.pid`);
    const result = await stopDevServer(nonExistent);
    expect(result.stopped).toBe(false);
    expect(result.message).toContain("not running");
  });

  it("removes invalid pidfile content", async () => {
    const tempPidFile = join(tmpdir(), `invalid-${Date.now()}.pid`);
    writeFileSync(tempPidFile, "not-a-pid\n", "utf8");

    const result = await stopDevServer(tempPidFile);
    expect(result.stopped).toBe(false);
    expect(result.message).toContain("Removed invalid pidfile");
    expect(existsSync(tempPidFile)).toBe(false);
  });

  it("cleans up stale pidfile for dead process", async () => {
    const tempPidFile = join(tmpdir(), `stale-${Date.now()}.pid`);
    writeFileSync(tempPidFile, "9999999\n", "utf8");

    const result = await stopDevServer(tempPidFile);
    expect(result.stopped).toBe(false);
    expect(result.message).toContain("cleaned up stale pidfile");
    expect(existsSync(tempPidFile)).toBe(false);
  });

  it("removes the sibling recorded-port file alongside the pidfile", async () => {
    const testDir = join(tmpdir(), `dev-stop-port-${Date.now()}`);
    mkdirSync(testDir, { recursive: true });
    try {
      const pidFile = join(testDir, "dev.pid");
      writeFileSync(pidFile, "9999999\n", "utf8");
      writeFileSync(portFileForPidFile(pidFile), "3641\n", "utf8");
      expect(portFileForPidFile(pidFile)).toBe(join(testDir, "dev.port"));

      const result = await stopDevServer(pidFile);
      expect(result.stopped).toBe(false);
      expect(existsSync(pidFile)).toBe(false);
      expect(existsSync(portFileForPidFile(pidFile))).toBe(false);
    } finally {
      rmSync(testDir, { recursive: true, force: true });
    }
  });

  it("removePidArtifacts clears both files without throwing", () => {
    const testDir = join(tmpdir(), `dev-stop-artifacts-${Date.now()}`);
    mkdirSync(testDir, { recursive: true });
    try {
      const pidFile = join(testDir, "dev.pid");
      writeFileSync(pidFile, "123\n", "utf8");
      writeFileSync(portFileForPidFile(pidFile), "3641\n", "utf8");
      removePidArtifacts(pidFile);
      expect(existsSync(pidFile)).toBe(false);
      expect(existsSync(portFileForPidFile(pidFile))).toBe(false);
      removePidArtifacts(pidFile);
    } finally {
      rmSync(testDir, { recursive: true, force: true });
    }
  });

  it("--force falls back to signal escalation when the lifecycle API port cannot be resolved", async () => {
    const testDir = join(tmpdir(), `dev-stop-test-${Date.now()}`);
    mkdirSync(testDir, { recursive: true });
    const pidFile = join(testDir, "test.pid");

    // No sibling dev.port file is written, mirroring a stale/foreign pid
    // record the lifecycle API can't be reached through -- --force must
    // still stop it via SIGTERM/SIGKILL, same as this script always used
    // to behave unconditionally.
    const child = Bun.spawn(
      [
        process.execPath,
        "-e",
        `
        process.on("SIGTERM", () => { process.exit(0); });
        setInterval(() => {}, 1000);
      `,
      ],
      { stdout: "ignore", stderr: "ignore" },
    );

    writeFileSync(pidFile, `${child.pid}\n`, "utf8");
    expect(existsSync(pidFile)).toBe(true);
    expect(isProcessAlive(child.pid)).toBe(true);

    const result = await stopDevServer(pidFile, { force: true });
    expect(result.stopped).toBe(true);
    expect(result.pid).toBe(child.pid);
    expect(result.message).toContain("Force stopped");

    expect(isProcessAlive(child.pid)).toBe(false);
    expect(existsSync(pidFile)).toBe(false);

    rmSync(testDir, { recursive: true, force: true });
  });

  it("default (safe) stop uses the lifecycle API, not a signal, and never touches the process directly", async () => {
    const testDir = join(tmpdir(), `dev-stop-api-${Date.now()}`);
    mkdirSync(testDir, { recursive: true });
    const pidFile = join(testDir, "test.pid");
    let sawSigterm = false;

    // Grab a free ephemeral port, then release it immediately for the child
    // (spawned below) to bind -- this test only needs a real port number,
    // not a server in this process.
    const portProbe = Bun.serve({ port: 0, fetch: () => new Response("") });
    const port = portProbe.port;
    portProbe.stop(true);

    const child = Bun.spawn(
      [
        process.execPath,
        "-e",
        `
        const server = Bun.serve({ port: ${port}, fetch(request) {
          if (request.method === "POST" && new URL(request.url).pathname === "/api/daemon/shutdown") {
            setTimeout(() => process.exit(0), 20);
            return Response.json({ ok: true, accepted: true });
          }
          return new Response("not found", { status: 404 });
        } });
        process.on("SIGTERM", () => { process.stderr.write("unexpected SIGTERM\\n"); process.exit(1); });
      `,
      ],
      { stdout: "ignore", stderr: "ignore" },
    );
    writeFileSync(pidFile, `${child.pid}\n`, "utf8");
    writeFileSync(portFileForPidFile(pidFile), `${port}\n`, "utf8");
    await Bun.sleep(50);
    expect(isProcessAlive(child.pid)).toBe(true);

    const originalKill = process.kill.bind(process);
    const killSpy = (pid: number, signal?: string | number) => {
      if (pid === child.pid && (signal === "SIGTERM" || signal === "SIGKILL")) sawSigterm = true;
      return originalKill(pid, signal);
    };
    (process as unknown as { kill: typeof process.kill }).kill = killSpy as typeof process.kill;

    try {
      const result = await stopDevServer(pidFile);
      expect(result.stopped).toBe(true);
      expect(result.pid).toBe(child.pid);
    } finally {
      process.kill = originalKill;
    }

    expect(sawSigterm).toBe(false);
    expect(isProcessAlive(child.pid)).toBe(false);
    expect(existsSync(pidFile)).toBe(false);

    rmSync(testDir, { recursive: true, force: true });
  });

  it("default (safe) stop refuses to guess a port and never signals when none is recorded", async () => {
    const testDir = join(tmpdir(), `dev-stop-noport-${Date.now()}`);
    mkdirSync(testDir, { recursive: true });
    const pidFile = join(testDir, "test.pid");
    const child = Bun.spawn([process.execPath, "-e", "setInterval(() => {}, 1000);"], { stdout: "ignore", stderr: "ignore" });
    writeFileSync(pidFile, `${child.pid}\n`, "utf8");

    try {
      const result = await stopDevServer(pidFile);
      expect(result.stopped).toBe(false);
      expect(result.message).toContain("refusing to guess");
      expect(isProcessAlive(child.pid)).toBe(true);
    } finally {
      child.kill("SIGKILL");
      rmSync(testDir, { recursive: true, force: true });
    }
  });
});
