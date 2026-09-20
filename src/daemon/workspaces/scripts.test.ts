import { afterEach, describe, expect, test } from "bun:test";
import net from "node:net";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { MetadataRepositories, MetadataStore } from "../metadata/index.ts";
import { WorkspaceService } from "./service.ts";
import { TerminalManager } from "../terminals/manager.ts";
import { WorkspaceScriptError, WorkspaceScriptsService } from "./scripts.ts";
import { decodeBinaryFrame } from "../../shared/protocol/terminals.ts";
import type { WorkspaceScriptRuntime } from "../../shared/domain/workspace-actions.ts";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((r) => rm(r, { recursive: true, force: true })));
});

async function fixture(paseoJson: unknown) {
  const root = await mkdtemp(join(tmpdir(), "passage-scripts-test-"));
  roots.push(root);
  const store = new MetadataStore(join(root, "metadata.sqlite"));
  const repositories = new MetadataRepositories(store.db);
  const workspaceService = new WorkspaceService(repositories);
  const terminals = new TerminalManager(workspaceService);
  const changed: { workspaceId: string; runtime: WorkspaceScriptRuntime }[] = [];
  const scripts = new WorkspaceScriptsService(repositories, terminals, {
    onScriptsChanged: (workspaceId, runtime) => {
      changed.push({ workspaceId, runtime });
    },
  });
  const dir = join(root, `ws-${crypto.randomUUID()}`);
  await mkdir(dir, { recursive: true });
  const project = await workspaceService.registerProject(root, "Project");
  await writeFile(join(dir, "paseo.json"), JSON.stringify(paseoJson));
  const workspace = await workspaceService.createDirectoryWorkspace(project.id, {
    cwd: dir,
    displayLabel: "Scripts",
  });
  return { root, dir, store, repositories, workspaceService, terminals, scripts, workspace, changed };
}

async function waitFor(
  check: () => boolean | Promise<boolean>,
  message: string,
  timeoutMs = 15_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await check()) return;
    if (Date.now() > deadline) throw new Error(message);
    await Bun.sleep(50);
  }
}

function attachCapture(terminals: TerminalManager, terminalId: string): { chunks: Uint8Array[]; text: () => string } {
  const chunks: Uint8Array[] = [];
  terminals.attach(terminalId, {
    clientId: `test_${crypto.randomUUID()}`,
    isHolder: false,
    sendBinary: (buf) => {
      chunks.push(decodeBinaryFrame(buf).payload);
    },
    sendControl: () => {},
  });
  return { chunks, text: () => new TextDecoder().decode(Buffer.concat(chunks)) };
}

describe("WorkspaceScriptsService list", () => {
  test("returns no scripts without paseo.json entries", async () => {
    const f = await fixture({ worktree: { setup: ["echo hi"] } });
    expect(await f.scripts.list(f.workspace.id)).toEqual([]);
    f.store.close();
  });

  test("lists stopped snapshots for declared scripts", async () => {
    const f = await fixture({
      scripts: {
        dev: { type: "service", command: "bun run dev" },
        test: { command: "bun test" },
      },
    });
    expect(await f.scripts.list(f.workspace.id)).toEqual([
      { name: "dev", type: "service", lifecycle: "stopped", terminalId: null, exitCode: null, port: null, url: null, health: null },
      { name: "test", type: "script", lifecycle: "stopped", terminalId: null, exitCode: null, port: null, url: null, health: null },
    ]);
    f.store.close();
  });

  test("rejects unknown workspaces and scripts", async () => {
    const f = await fixture({ scripts: { dev: { type: "service", command: "x" } } });
    await expect(f.scripts.list("wsp_missing")).rejects.toThrow(
      expect.objectContaining({ code: "not-found" }),
    );
    await expect(f.scripts.get(f.workspace.id, "nope")).rejects.toThrow(
      expect.objectContaining({ code: "unknown-script" }),
    );
    f.store.close();
  });
});

describe("WorkspaceScriptsService runs", () => {
  test("one-shot runs in a PTY and settles stopped with its exit code", async () => {
    const f = await fixture({ scripts: { hello: { command: "echo script_hello_marker" } } });
    const started = await f.scripts.start(f.workspace.id, "hello");
    expect(started.lifecycle).toBe("running");
    expect(started.terminalId).toMatch(/^trm_/);
    expect(started.port).toBeNull();
    const capture = attachCapture(f.terminals, started.terminalId!);
    await waitFor(() => capture.text().includes("script_hello_marker"), "one-shot output never appeared");
    await waitFor(
      async () => (await f.scripts.get(f.workspace.id, "hello")).lifecycle === "stopped",
      "one-shot never settled",
    );
    const settled = await f.scripts.get(f.workspace.id, "hello");
    expect(settled.exitCode).toBe(0);
    expect(settled.terminalId).toBeNull();
    // Portless one-shots never probe: health stays null.
    expect(settled.health).toBeNull();
    expect(f.changed.length).toBeGreaterThanOrEqual(2);
    f.store.close();
  });

  test("services get a port, direct URL, and service env", async () => {
    const f = await fixture({
      worktree: { servicePorts: { range: "48900-48909" } },
      scripts: {
        api: { type: "service", command: "sleep 30" },
        web: { type: "service", command: "echo WEB_SELF_$PASEO_PORT PEER_$PASEO_SERVICE_API_PORT HOST_$HOST; sleep 30" },
      },
    });
    const api = await f.scripts.start(f.workspace.id, "api");
    expect(api.port).toBeGreaterThanOrEqual(48900);
    expect(api.port).toBeLessThanOrEqual(48909);
    expect(api.url).toBe(`http://127.0.0.1:${api.port}`);

    const web = await f.scripts.start(f.workspace.id, "web");
    expect(web.port).not.toBe(api.port);
    const capture = attachCapture(f.terminals, web.terminalId!);
    await waitFor(
      () => capture.text().includes(`WEB_SELF_${web.port}`),
      `service env never appeared: ${capture.text().slice(-500)}`,
    );
    expect(capture.text()).toContain(`PEER_${api.port}`);
    expect(capture.text()).toContain("HOST_0.0.0.0");
    f.scripts.stopForWorkspace(f.workspace.id);
    f.store.close();
  });

  test("explicit ports win and survive restarts via the stable plan", async () => {
    const f = await fixture({
      scripts: {
        web: { type: "service", command: "sleep 30", port: 48771 },
        api: { type: "service", command: "sleep 30" },
      },
    });
    const first = await f.scripts.start(f.workspace.id, "web");
    expect(first.port).toBe(48771);
    await f.scripts.restart(f.workspace.id, "web");
    const second = await f.scripts.get(f.workspace.id, "web");
    expect(second.lifecycle).toBe("running");
    expect(second.port).toBe(48771);
    expect(second.terminalId).not.toBe(first.terminalId);

    const api = await f.scripts.start(f.workspace.id, "api");
    expect(api.port).not.toBe(48771);
    const again = await f.scripts.restart(f.workspace.id, "api");
    expect(again.port).toBe(api.port);
    f.scripts.stopForWorkspace(f.workspace.id);
    f.store.close();
  });

  test("rejects a second start while running and stops idempotently", async () => {
    const f = await fixture({ scripts: { dev: { type: "service", command: "sleep 30" } } });
    const first = await f.scripts.start(f.workspace.id, "dev");
    const failure = await f.scripts.start(f.workspace.id, "dev").then(
      () => null,
      (error: unknown) => error,
    );
    expect(failure).toBeInstanceOf(WorkspaceScriptError);
    expect(failure).toMatchObject({ code: "script-running", terminalId: first.terminalId });
    const stopped = await f.scripts.stop(f.workspace.id, "dev");
    expect(stopped.lifecycle).toBe("stopped");
    expect(f.terminals.get(first.terminalId!)).toBeNull();
    // Second stop is a no-op returning the stopped snapshot.
    expect((await f.scripts.stop(f.workspace.id, "dev")).lifecycle).toBe("stopped");
    f.store.close();
  });

  test("stopForWorkspace terminates every running script", async () => {
    const f = await fixture({
      scripts: {
        a: { type: "service", command: "sleep 30" },
        b: { command: "sleep 30" },
      },
    });
    await f.scripts.start(f.workspace.id, "a");
    await f.scripts.start(f.workspace.id, "b");
    const stopped = f.scripts.stopForWorkspace(f.workspace.id);
    expect(new Set(stopped)).toEqual(new Set(["a", "b"]));
    expect((await f.scripts.list(f.workspace.id)).every((s) => s.lifecycle === "stopped")).toBe(true);
    expect(f.scripts.stopForWorkspace(f.workspace.id)).toEqual([]);
    f.store.close();
  });
});

describe("WorkspaceScriptsService restart recovery", () => {
  test("services re-link to reattached PTYs with stable ports", async () => {
    const f = await fixture({
      worktree: { servicePorts: { range: "48920-48929" } },
      scripts: { api: { type: "service", command: "sleep 30" } },
    });
    try {
      const started = await f.scripts.start(f.workspace.id, "api");
      expect(started.lifecycle).toBe("running");

      // Simulate a daemon restart: fresh managers over the same tmux server
      // and sqlite, terminal sweep first, then scripts re-link.
      const manager2 = new TerminalManager(f.workspaceService);
      await manager2.recoverAfterRestart();
      const scripts2 = new WorkspaceScriptsService(f.repositories, manager2, {});
      const { reattached, dropped } = await scripts2.recoverAfterRestart();
      expect(reattached).toEqual([`${f.workspace.id}:api`]);
      expect(dropped).toEqual([]);

      const recovered = await scripts2.get(f.workspace.id, "api");
      expect(recovered.lifecycle).toBe("running");
      expect(recovered.terminalId).toBe(started.terminalId);
      expect(recovered.port).toBe(started.port);
      expect(recovered.url).toBe(started.url);

      // The re-linked terminal is live: output flows through the new manager.
      const capture = attachCapture(manager2, recovered.terminalId!);
      manager2.writeInput(recovered.terminalId!, "echo recovery_ping\n");
      await waitFor(() => capture.text().includes("recovery_ping"), "re-linked terminal is not live");

      // Port plan survived: restart keeps the port, stop clears persistence.
      const restarted = await scripts2.restart(f.workspace.id, "api");
      expect(restarted.port).toBe(started.port);
      expect(restarted.terminalId).not.toBe(started.terminalId);
      await scripts2.stop(f.workspace.id, "api");
      expect(f.repositories.scriptRuntimes.listAll()).toEqual([]);
      f.scripts.stopForWorkspace(f.workspace.id);
      scripts2.stopForWorkspace(f.workspace.id);
    } finally {
      f.store.close();
    }
  });

  test("one-shots never persist and stale rows are dropped", async () => {
    const f = await fixture({ scripts: { quick: { command: "echo one_shot_marker" } } });
    try {
      const started = await f.scripts.start(f.workspace.id, "quick");
      const capture = attachCapture(f.terminals, started.terminalId!);
      await waitFor(() => capture.text().includes("one_shot_marker"), "one-shot output never appeared");
      await waitFor(
        async () => (await f.scripts.get(f.workspace.id, "quick")).lifecycle === "stopped",
        "one-shot never settled",
      );
      // Settled one-shots leave no persistence behind.
      expect(f.repositories.scriptRuntimes.listAll()).toEqual([]);
      // Settle reaps the server-side session (remain-on-exit would otherwise
      // accumulate dead sessions) while the ring buffer stays viewable.
      const hasGone = Bun.spawnSync(["tmux", "-L", "passage", "has-session", "-t", `passage-${started.terminalId}`]);
      expect(hasGone.exitCode).not.toBe(0);
      expect(capture.text()).toContain("one_shot_marker");

      // A row pointing at a dead terminal is dropped on recovery.
      f.repositories.scriptRuntimes.save({
        workspaceId: f.workspace.id,
        scriptName: "quick",
        terminalId: "trm_missing",
        port: null,
        startedAt: new Date().toISOString(),
      });
      const manager2 = new TerminalManager(f.workspaceService);
      await manager2.recoverAfterRestart();
      const scripts2 = new WorkspaceScriptsService(f.repositories, manager2, {});
      const { reattached, dropped } = await scripts2.recoverAfterRestart();
      expect(reattached).toEqual([]);
      expect(dropped).toEqual([`${f.workspace.id}:quick`]);
      expect(f.repositories.scriptRuntimes.listAll()).toEqual([]);
    } finally {
      f.store.close();
    }
  });

  test("terminating a service terminal settles the runtime via exit notification", async () => {
    const f = await fixture({ scripts: { api: { type: "service", command: "sleep 30" } } });
    try {
      const started = await f.scripts.start(f.workspace.id, "api");
      expect(started.lifecycle).toBe("running");
      // Terminate out-of-band, as the terminal UI would: kill routes through
      // the single-shot exit path, so the runtime settles instead of going stale.
      expect(f.terminals.terminate(started.terminalId!)).toBe(true);
      await waitFor(
        async () => (await f.scripts.get(f.workspace.id, "api")).lifecycle === "stopped",
        "runtime never settled after terminal termination",
      );
      expect(f.repositories.scriptRuntimes.listAll()).toEqual([]);
    } finally {
      f.store.close();
    }
  });
});

describe("WorkspaceScriptsService port health", () => {
  test("healthy when the port accepts, unhealthy when nothing listens", async () => {
    // Hold a real listener so one declared port is genuinely open.
    const server = net.createServer();
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
    const address = server.address();
    const livePort = typeof address === "object" && address ? address.port : 0;
    expect(livePort).toBeGreaterThan(0);
    try {
      const f = await fixture({
        scripts: {
          live: { type: "service", command: "sleep 30", port: livePort },
          quiet: { type: "service", command: "sleep 30", port: 48781 },
        },
      });
      await f.scripts.start(f.workspace.id, "live");
      await f.scripts.start(f.workspace.id, "quiet");
      const list = await f.scripts.list(f.workspace.id);
      expect(list.find((s) => s.name === "live")?.health).toBe("healthy");
      expect(list.find((s) => s.name === "quiet")?.health).toBe("unhealthy");
      // Stopped entries report null even while a listener is held.
      await f.scripts.stop(f.workspace.id, "live");
      expect((await f.scripts.get(f.workspace.id, "live")).health).toBeNull();
      f.scripts.stopForWorkspace(f.workspace.id);
      f.store.close();
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});
