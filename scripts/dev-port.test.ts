import { describe, expect, test } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  fnv1a32,
  parseListeningInodes,
  parseListeningPorts,
  pidListeningPorts,
  portFileForPidFile,
  portScriptWorktreePath,
  readLivePid,
  readRecordedPort,
  resolveStart,
  stableBasePort,
} from "./dev-port.ts";

describe("dev-port", () => {
  test("fnv1a32 matches the standard empty-string vector", () => {
    expect(fnv1a32("")).toBe(0x811c9dc5);
  });

  test("stableBasePort is deterministic and inside 3000-3999", () => {
    const first = stableBasePort("/home/user/workspace/passage");
    const second = stableBasePort("/home/user/workspace/passage");
    expect(first).toBe(second);
    expect(first).toBeGreaterThanOrEqual(3000);
    expect(first).toBeLessThanOrEqual(3999);
  });

  test("distinct worktree paths map to distinct ports", () => {
    expect(stableBasePort("/home/user/workspace/passage")).not.toBe(
      stableBasePort("/home/user/workspace/paseo-worktrees/abc123/special-spider"),
    );
  });

  test("ambient PORT is ignored so worktrees stay isolated", () => {
    // A PORT inherited from another worktree must not override the hash.
    const hashPort = resolveStart({});
    expect(resolveStart({ PORT: "3333" })).toBe(hashPort);
    expect(resolveStart({ PORT: "9999" })).toBe(hashPort);
  });

  test("PASEO_PORT wins over the hash; invalid PASEO_PORT falls through", () => {
    expect(resolveStart({ PASEO_PORT: "3456" })).toBe(3456);
    expect(resolveStart({ PORT: "3333", PASEO_PORT: "3456" })).toBe(3456);
    const fallback = resolveStart({ PASEO_PORT: "nope" });
    expect(fallback).toBe(resolveStart({}));
    expect(fallback).toBeGreaterThanOrEqual(3000);
    expect(fallback).toBeLessThanOrEqual(3999);
  });

  test("portScript mode triggers on positional args, prefers PASEO_WORKTREE_PATH", () => {
    const argv = ["/bin/bun", "scripts/dev-port.ts", "dev", "ws1", "main", "/wt/a"];
    expect(portScriptWorktreePath(argv, {})).toBe("/wt/a");
    expect(portScriptWorktreePath(argv, { PASEO_WORKTREE_PATH: "/wt/b" })).toBe("/wt/b");
    expect(portScriptWorktreePath(["/bin/bun", "scripts/dev-port.ts"], {})).toBeNull();
    expect(portScriptWorktreePath(["/bin/bun", "scripts/dev-port.ts"], { PASEO_WORKTREE_PATH: "/wt/b" })).toBeNull();
  });

  test("parseListeningInodes identifies LISTEN sockets matching port in hex", () => {
    // 3333 = 0x0D05, 8080 = 0x1F90
    const fixture = [
      "  sl  local_address rem_address   st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode",
      "   0: 00000000:0D05 00000000:0000 0A 00000000:00000000 00:00000000 00000000  1000        0 111111 1 0000000000000000 100 0 0 10 0",
      "   1: 0100007F:1F90 00000000:0000 0A 00000000:00000000 00:00000000 00000000  1000        0 222222 1 0000000000000000 100 0 0 10 0",
      "   2: 00000000:0D05 00000000:0000 01 00000000:00000000 00:00000000 00000000  1000        0 333333 1 0000000000000000 100 0 0 10 0",
      "   3: 0100007F:0D05 00000000:0000 0A 00000000:00000000 00:00000000 00000000  1000        0 444444 1 0000000000000000 100 0 0 10 0",
    ].join("\n");

    const inodes3333 = parseListeningInodes(fixture, 3333);
    expect(inodes3333).toEqual(new Set(["111111", "444444"]));

    const inodes8080 = parseListeningInodes(fixture, 8080);
    expect(inodes8080).toEqual(new Set(["222222"]));

    const inodes3000 = parseListeningInodes(fixture, 3000);
    expect(inodes3000.size).toBe(0);
  });

  test("readLivePid returns current pid for living process, null for stale or missing", () => {
    const testDir = join(tmpdir(), `dev-port-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    mkdirSync(testDir, { recursive: true });
    try {
      const pidFile = join(testDir, "test.pid");
      // Missing file
      expect(readLivePid(pidFile)).toBeNull();

      // Current living process
      writeFileSync(pidFile, `${process.pid}\n`, "utf8");
      expect(readLivePid(pidFile)).toBe(process.pid);

      // Invalid contents
      writeFileSync(pidFile, "not-a-number\n", "utf8");
      expect(readLivePid(pidFile)).toBeNull();

      // Unlikely PID (e.g. 4194304 or high dead PID)
      writeFileSync(pidFile, "4194300\n", "utf8");
      expect(readLivePid(pidFile)).toBeNull();
    } finally {
      rmSync(testDir, { recursive: true, force: true });
    }
  });

  test("portFileForPidFile is a sibling dev.port record", () => {
    expect(portFileForPidFile("/wt/.data/dev.pid")).toBe("/wt/.data/dev.port");
    expect(portFileForPidFile("/tmp/custom.pid")).toBe("/tmp/dev.port");
  });

  test("readRecordedPort honors the record only for a living pid", () => {
    const testDir = join(tmpdir(), `dev-port-recorded-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    mkdirSync(testDir, { recursive: true });
    try {
      const pidFile = join(testDir, "dev.pid");
      const portFile = join(testDir, "dev.port");
      // No pidfile at all
      expect(readRecordedPort(pidFile)).toBeNull();

      // Living pid with a valid record
      writeFileSync(pidFile, `${process.pid}\n`, "utf8");
      expect(readRecordedPort(pidFile)).toBeNull(); // no port file yet
      writeFileSync(portFile, "3641\n", "utf8");
      expect(readRecordedPort(pidFile)).toBe(3641);

      // Invalid record content
      writeFileSync(portFile, "not-a-port\n", "utf8");
      expect(readRecordedPort(pidFile)).toBeNull();

      // Stale pidfile: record must not be trusted
      writeFileSync(pidFile, "4194300\n", "utf8");
      writeFileSync(portFile, "3641\n", "utf8");
      expect(readRecordedPort(pidFile)).toBeNull();
    } finally {
      rmSync(testDir, { recursive: true, force: true });
    }
  });

  test("parseListeningPorts maps LISTEN inodes to ports", () => {
    // 3333 = 0x0D05
    const fixture = [
      "  sl  local_address rem_address   st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode",
      "   0: 00000000:0D05 00000000:0000 0A 00000000:00000000 00:00000000 00000000  1000        0 111111 1 0000000000000000 100 0 0 10 0",
      "   1: 00000000:0D05 00000000:0000 01 00000000:00000000 00:00000000 00000000  1000        0 333333 1 0000000000000000 100 0 0 10 0",
    ].join("\n");
    expect(parseListeningPorts(fixture)).toEqual(new Map([["111111", 3333]]));
  });

  test("pidListeningPorts finds a socket this process holds", () => {
    const server = Bun.listen({
      hostname: "127.0.0.1",
      port: 0,
      socket: { data() {} },
    });
    try {
      expect(pidListeningPorts(process.pid)).toContain(server.port);
    } finally {
      server.stop();
    }
  });

  test("main outputs CRITICAL to both stdout and stderr on foreign port conflict", async () => {
    const server = Bun.listen({
      hostname: "127.0.0.1",
      port: 0,
      socket: { data() {} },
    });
    const testDir = join(tmpdir(), `dev-port-critical-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    mkdirSync(testDir, { recursive: true });
    try {
      const port = server.port;
      const proc = Bun.spawn(["bun", "scripts/dev-port.ts"], {
        env: {
          ...process.env,
          PASEO_PORT: String(port),
          PASSAGE_PID_FILE: join(testDir, "dev.pid"),
        },
        stdout: "pipe",
        stderr: "pipe",
      });
      const exitCode = await proc.exited;
      const stdout = await new Response(proc.stdout).text();
      const stderr = await new Response(proc.stderr).text();

      expect(exitCode).toBe(1);
      expect(stdout).toContain(`CRITICAL: dev-port: port ${port} is occupied`);
      expect(stderr).toContain(`CRITICAL: dev-port: port ${port} is occupied`);
      expect(stdout).toContain("Each worktree has its own dedicated port");
      expect(stderr).toContain("differs from this worktree's stable port");
    } finally {
      server.stop();
      rmSync(testDir, { recursive: true, force: true });
    }
  });

  test("main prefers the recorded port over a stale PASEO_PORT", async () => {
    const testDir = join(tmpdir(), `dev-port-recorded-main-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    mkdirSync(testDir, { recursive: true });
    try {
      writeFileSync(join(testDir, "dev.pid"), `${process.pid}\n`, "utf8");
      writeFileSync(join(testDir, "dev.port"), "3456\n", "utf8");
      const proc = Bun.spawn(["bun", "scripts/dev-port.ts"], {
        env: {
          ...process.env,
          PASEO_PORT: "3700",
          PASSAGE_PID_FILE: join(testDir, "dev.pid"),
        },
        stdout: "pipe",
        stderr: "pipe",
      });
      const exitCode = await proc.exited;
      const stdout = await new Response(proc.stdout).text();
      expect(exitCode).toBe(0);
      expect(stdout.trim()).toBe("3456");
    } finally {
      rmSync(testDir, { recursive: true, force: true });
    }
  });
});
