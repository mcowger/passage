import { describe, expect, test } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  fnv1a32,
  parseListeningInodes,
  portScriptWorktreePath,
  readLivePid,
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

  test("explicit PORT wins over PASEO_PORT, PASEO_PORT wins over hash", () => {
    expect(resolveStart({ PORT: "3333", PASEO_PORT: "3456" })).toBe(3333);
    expect(resolveStart({ PASEO_PORT: "3456" })).toBe(3456);
    expect(resolveStart({ PORT: "9999" })).toBe(9999);
  });

  test("invalid PORT falls through to PASEO_PORT, then hash", () => {
    expect(resolveStart({ PORT: "nope", PASEO_PORT: "3456" })).toBe(3456);
    const fallback = resolveStart({});
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

  test("main outputs CRITICAL to both stdout and stderr on foreign port conflict", async () => {
    const server = Bun.listen({
      hostname: "127.0.0.1",
      port: 0,
      socket: { data() {} },
    });
    try {
      const port = server.port;
      const proc = Bun.spawn(["bun", "scripts/dev-port.ts"], {
        env: {
          ...process.env,
          PORT: String(port),
          PASSAGE_PID_FILE: `/tmp/dev-port-test-nonexistent-${Date.now()}.pid`,
        },
        stdout: "pipe",
        stderr: "pipe",
      });
      const exitCode = await proc.exited;
      const stdout = await new Response(proc.stdout).text();
      const stderr = await new Response(proc.stderr).text();

      expect(exitCode).toBe(1);
      expect(stdout).toContain(`CRITICAL: dev-port: intended port ${port} for this worktree is occupied`);
      expect(stderr).toContain(`CRITICAL: dev-port: intended port ${port} for this worktree is occupied`);
    } finally {
      server.stop();
    }
  });
});
