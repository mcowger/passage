import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { MetadataRepositories, MetadataStore } from "../metadata/index.ts";
import { WorkspaceService } from "../workspaces/service.ts";
import { TerminalManager } from "./manager.ts";
import { decodeBinaryFrame } from "../../shared/protocol/terminals.ts";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((r) => rm(r, { recursive: true, force: true })));
});

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "passage-term-"));
  roots.push(root);
  const store = new MetadataStore(":memory:");
  const repos = new MetadataRepositories(store.db);
  const workspaces = new WorkspaceService(repos);
  const project = await workspaces.registerProject(root, "Test Repo");
  const workspace = await workspaces.createDirectoryWorkspace(project.id, { displayLabel: "Test WS" });
  const manager = new TerminalManager(workspaces);
  return { root, store, workspaces, project, workspace, manager };
}

async function waitForOutput(chunks: Uint8Array[], predicate: (text: string) => boolean, message: string): Promise<string> {
  const deadline = Date.now() + 10_000;
  for (;;) {
    const text = new TextDecoder().decode(Buffer.concat(chunks));
    if (predicate(text)) return text;
    if (Date.now() > deadline) throw new Error(message);
    await new Promise((r) => setTimeout(r, 25));
  }
}

describe("TerminalManager", () => {
  test("creates, lists, writes input, and terminates terminals", async () => {
    const f = await fixture();
    const summary = await f.manager.create(f.workspace.id, { title: "Shell 1", columns: 80, rows: 24 });
    expect(summary.id).toMatch(/^trm_/);
    expect(summary.status).toBe("running");
    expect(summary.title).toBe("Shell 1");

    const list = f.manager.list(f.workspace.id);
    expect(list.length).toBe(1);
    expect(list[0].id).toBe(summary.id);

    const receivedChunks: Uint8Array[] = [];
    const controlMessages: unknown[] = [];

    const attached = f.manager.attach(summary.id, {
      clientId: "client_1",
      isHolder: false,
      sendBinary: (buf) => {
        const frame = decodeBinaryFrame(buf);
        receivedChunks.push(frame.payload);
      },
      sendControl: (ctrl) => controlMessages.push(ctrl),
    });
    expect(attached).toBe(true);

    // Initial attached message received
    expect(controlMessages.some((m: any) => m.type === "attached" && m.hasSizeLease === true)).toBe(true);

    // Write input
    f.manager.writeInput(summary.id, "echo hello_passage\n");

    // Wait for output
    await new Promise((r) => setTimeout(r, 200));
    const fullText = new TextDecoder().decode(Buffer.concat(receivedChunks));
    expect(fullText).toContain("hello_passage");

    // Second client attaches and receives replay
    const client2Chunks: Uint8Array[] = [];
    f.manager.attach(summary.id, {
      clientId: "client_2",
      isHolder: false,
      sendBinary: (buf) => {
        const frame = decodeBinaryFrame(buf);
        client2Chunks.push(frame.payload);
      },
      sendControl: () => {},
    });
    const client2Text = new TextDecoder().decode(Buffer.concat(client2Chunks));
    expect(client2Text).toContain("hello_passage");

    // Size lease: client_2 cannot resize without taking lease
    const resizedByPassive = f.manager.resize(summary.id, 100, 30, "client_2");
    expect(resizedByPassive).toBe(false);

    // Client_2 takes lease and resizes successfully
    f.manager.takeLease(summary.id, "client_2");
    const resizedByHolder = f.manager.resize(summary.id, 100, 30, "client_2");
    expect(resizedByHolder).toBe(true);
    expect(f.manager.get(summary.id)?.columns).toBe(100);

    // Terminate
    f.manager.terminate(summary.id);
    expect(f.manager.get(summary.id)).toBeNull();

    f.store.close();
  });

  test("terminateForWorkspace kills only that workspace's terminals", async () => {
    const f = await fixture();
    const other = await f.workspaces.createDirectoryWorkspace(f.project.id, { displayLabel: "Other" });
    const a = await f.manager.create(f.workspace.id, { title: "A" });
    const b = await f.manager.create(f.workspace.id, { title: "B" });
    const c = await f.manager.create(other.id, { title: "C" });
    const killed = f.manager.terminateForWorkspace(f.workspace.id);
    expect(new Set(killed)).toEqual(new Set([a.id, b.id]));
    expect(f.manager.get(a.id)).toBeNull();
    expect(f.manager.get(b.id)).toBeNull();
    expect(f.manager.get(c.id)?.status).toBe("running");
    expect(f.manager.terminateForWorkspace(f.workspace.id)).toEqual([]);
    f.manager.terminate(c.id);
    f.store.close();
  });

  test("shell starts with a controlling terminal (job control, /dev/tty)", async () => {
    // Without a controlling terminal the shell reports "no job control",
    // /dev/tty is unavailable (ENXIO), Tab completion backed by /dev/tty
    // (e.g. fzf-tab) breaks, and Ctrl+C handling misbehaves, leaving the
    // terminal looking frozen.
    const f = await fixture();
    try {
      const summary = await f.manager.create(f.workspace.id, { title: "ctty", columns: 80, rows: 24 });
      const chunks: Uint8Array[] = [];
      f.manager.attach(summary.id, {
        clientId: "client_ctty",
        isHolder: false,
        sendBinary: (buf) => {
          chunks.push(decodeBinaryFrame(buf).payload);
        },
        sendControl: () => {},
      });

      f.manager.writeInput(summary.id, "exec 9<>/dev/tty && echo CTTY_RESULT_OK || echo CTTY_RESULT_FAIL\n");
      // NB: the PTY echoes the typed command line, which itself contains
      // both marker names, so match the markers as full output lines.
      const text = await waitForOutput(
        chunks,
        (t) => t.includes("\r\nCTTY_RESULT_OK\r\n") || t.includes("\r\nCTTY_RESULT_FAIL\r\n"),
        "shell did not report /dev/tty status",
      );
      expect(text).toContain("\r\nCTTY_RESULT_OK\r\n");
      expect(text).not.toContain("no job control");
      expect(text).not.toContain("cannot set terminal process group");

      f.manager.terminate(summary.id);
    } finally {
      f.store.close();
    }
  });

  test("recoverAfterRestart reattaches live shells and reaps the rest", async () => {
    const f = await fixture();
    try {
      // Interactive terminal with state worth keeping.
      const live = await f.manager.create(f.workspace.id, { title: "Keep Me Around", columns: 80, rows: 24 });
      const liveChunks: Uint8Array[] = [];
      f.manager.attach(live.id, {
        clientId: "client_before",
        isHolder: false,
        sendBinary: (buf) => {
          liveChunks.push(decodeBinaryFrame(buf).payload);
        },
        sendControl: () => {},
      });
      f.manager.writeInput(live.id, "export RECOVERY_MARKER=alive42\n");
      await waitForOutput(liveChunks, (t) => t.includes("alive42"), "shell did not echo marker setup");

      // Anonymous one-shot script session: intentionally not recoverable.
      const cmd = await f.manager.createCommand(f.workspace.id, {
        title: "one-shot",
        command: "sleep 30",
      });

      // Simulate a daemon restart: brand-new manager over the same tmux server.
      const resurrected = new TerminalManager(f.workspaces);
      const { reattached, reaped } = await resurrected.recoverAfterRestart();
      expect(reattached).toContain(live.id);
      expect(reaped).toContain(cmd.id);

      // The resurrected wrapper serves the same live shell: prior shell
      // state is visible without any history replay.
      expect(resurrected.get(live.id)?.workspaceId).toBe(f.workspace.id);
      expect(resurrected.get(live.id)?.title).toBe("Keep Me Around");
      expect(resurrected.list(f.workspace.id).map((t) => t.id)).toContain(live.id);
      const afterChunks: Uint8Array[] = [];
      resurrected.attach(live.id, {
        clientId: "client_after",
        isHolder: false,
        sendBinary: (buf) => {
          afterChunks.push(decodeBinaryFrame(buf).payload);
        },
        sendControl: () => {},
      });
      resurrected.writeInput(live.id, "echo $RECOVERY_MARKER\n");
      const text = await waitForOutput(afterChunks, (t) => t.includes("alive42"), "reattached shell lost its state");
      expect(text).toContain("alive42");

      // Anonymous session was reaped from the tmux server.
      expect(resurrected.get(cmd.id)).toBeNull();
      const hasGone = Bun.spawnSync(["tmux", "-L", "passage", "has-session", "-t", `passage-${cmd.id}`]);
      expect(hasGone.exitCode).not.toBe(0);

      // Recovery is idempotent: nothing left to do on a second sweep.
      const again = await resurrected.recoverAfterRestart();
      expect(again).toEqual({ reattached: [], reaped: [] });

      resurrected.terminate(live.id);
      f.manager.terminate(cmd.id);
    } finally {
      f.store.close();
    }
  });
});
