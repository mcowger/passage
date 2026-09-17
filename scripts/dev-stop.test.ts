import { describe, expect, it } from "bun:test";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isProcessAlive, resolvePidFile, stopDevServer } from "./dev-stop.ts";

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

  it("gracefully stops a running process and unlinks pidfile", async () => {
    const testDir = join(tmpdir(), `dev-stop-test-${Date.now()}`);
    mkdirSync(testDir, { recursive: true });
    const pidFile = join(testDir, "test.pid");

    // Spawn a long-running child process that responds to SIGTERM
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

    const result = await stopDevServer(pidFile);
    expect(result.stopped).toBe(true);
    expect(result.pid).toBe(child.pid);
    expect(result.message).toContain(`Stopped dev server (PID ${child.pid})`);

    // Verify process is terminated and pidfile removed
    expect(isProcessAlive(child.pid)).toBe(false);
    expect(existsSync(pidFile)).toBe(false);

    rmSync(testDir, { recursive: true, force: true });
  });
});
