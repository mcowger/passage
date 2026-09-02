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
  const store = new MetadataStore(join(root, "metadata.sqlite"));
  const repos = new MetadataRepositories(store.db);
  const workspaces = new WorkspaceService(repos);
  const project = await workspaces.registerProject(root, "Test Repo");
  const workspace = await workspaces.createDirectoryWorkspace(project.id, { displayLabel: "Test WS" });
  const manager = new TerminalManager(workspaces);
  return { root, store, workspaces, project, workspace, manager };
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
});
