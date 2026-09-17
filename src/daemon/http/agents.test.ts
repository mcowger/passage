import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AgentService } from "../agents/service.ts";
import { PiRpcManager } from "../agents/rpc/index.ts";
import { MetadataRepositories, MetadataStore } from "../metadata/index.ts";
import { createAgentRoutes } from "./agents.ts";
import { MAX_AGENT_IMAGE_DATA_BYTES } from "../../shared/protocol/agents.ts";

const fakePi = `
let buffer = "";
console.error("private-stderr-marker");
process.stdin.on("data", chunk => {
  buffer += chunk.toString();
  let newline;
  while ((newline = buffer.indexOf("\\n")) !== -1) {
    const line = buffer.slice(0, newline);
    buffer = buffer.slice(newline + 1);
    if (!line) continue;
    const command = JSON.parse(line);
    if (command.type === "prompt") process.stdout.write(JSON.stringify({ type: "agent_start" }) + "\\n");
    const data = command.type === "get_available_models"
      ? { models: [{ provider: "test", id: "model", name: "Model", api: "test", input: ["text"], authenticated: true, supportedThinkingLevels: ["medium", "high"] }] }
      : command.type === "get_available_thinking_levels" ? { levels: ["medium", "high"] }
      : command.type === "get_commands" ? { commands: [{ name: "skill:gh-cli", description: "GitHub CLI help", source: "skill" }] } : {};
    process.stdout.write(JSON.stringify({ type: "response", id: command.id, success: true, data }) + "\\n");
    if (command.type === "prompt") setTimeout(() => process.stdout.write(JSON.stringify({ type: "agent_settled" }) + "\\n"), 5);
  }
});`;

const fixtures: Array<{ root: string; store: MetadataStore; service: AgentService }> = [];

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "passage-agent-http-"));
  const store = new MetadataStore(join(root, "metadata.sqlite"));
  const repositories = new MetadataRepositories(store.db);
  repositories.projects.save({ id: "project-1", configuredRootPath: root, canonicalRootPath: root, displayLabel: "Project", archivedAt: null });
  repositories.workspaces.save({
    id: "workspace-1", projectId: "project-1", kind: "directory", cwd: root,
    checkoutRoot: root, mainRepositoryRoot: root, branchRef: null, displayLabel: "Workspace",
    locationId: null, ownershipState: "not-owned", archivedAt: null,
  });
  const service = new AgentService(repositories, {
    sessionsRoot: join(root, "sessions"),
    manager: new PiRpcManager(4),
    pi: { executable: process.execPath, executableArgs: ["-e", fakePi] },
  });
  fixtures.push({ root, store, service });
  return { app: createAgentRoutes(service), repositories };
}

function request(path: string, init?: RequestInit): Request {
  return new Request(`http://localhost${path}`, init);
}

async function json(response: Response): Promise<Record<string, unknown>> {
  return response.json() as Promise<Record<string, unknown>>;
}

afterEach(async () => {
  for (const value of fixtures.splice(0)) {
    await value.service.shutdown();
    value.store.close();
    await rm(value.root, { recursive: true, force: true });
  }
});

describe("agent HTTP API", () => {
  test("creates, lists, snapshots, and keeps stderr private", async () => {
    const { app } = await fixture();
    const createdResponse = await app.fetch(request("/api/workspaces/workspace-1/agents", {
      method: "POST",
      body: JSON.stringify({ title: "Implementation" }),
    }));
    expect(createdResponse.status).toBe(201);
    const created = await json(createdResponse);
    expect(created.title).toBe("Implementation");
    expect(created.persisted).toBe(false);
    expect(JSON.stringify(created)).not.toContain("private-stderr-marker");

    const list = await (await app.fetch(request("/api/workspaces/workspace-1/agents"))).json() as unknown[];
    expect(list).toHaveLength(1);
    // create() returns before the Pi boot finishes (so the New Agent pane
    // can open immediately); the snapshot goes live once boot completes.
    let snapshot: Record<string, unknown> | undefined;
    for (let attempt = 0; attempt < 100; attempt++) {
      snapshot = await json(await app.fetch(request(`/api/agents/${created.id}`)));
      if (snapshot.live === true) break;
      await Bun.sleep(20);
    }
    expect(snapshot?.live).toBe(true);
  });

  test("admits commands and persists model and thinking preferences", async () => {
    const { app } = await fixture();
    const created = await json(await app.fetch(request("/api/workspaces/workspace-1/agents", { method: "POST", body: "{}" })));
    const agentId = String(created.id);
    for (const [operation, message] of [["prompt", "Do work"], ["steer", "Change course"], ["follow-up", "Then verify"]]) {
      const response = await app.fetch(request(`/api/agents/${agentId}/${operation}`, { method: "POST", body: JSON.stringify({ message }) }));
      expect(response.status).toBe(202);
    }
    expect((await app.fetch(request(`/api/agents/${agentId}/model`, { method: "POST", body: JSON.stringify({ provider: "test", modelId: "model" }) }))).status).toBe(200);
    expect((await app.fetch(request(`/api/agents/${agentId}/thinking`, { method: "POST", body: JSON.stringify({ level: "high" }) }))).status).toBe(200);
    const snapshot = await json(await app.fetch(request(`/api/agents/${agentId}`)));
    expect(snapshot.modelPreference).toBe("test/model");
    expect(snapshot.thinkingPreference).toBe("high");
  });

  test("accepts an abort while cancellation settles asynchronously", async () => {
    const { app } = await fixture();
    const created = await json(await app.fetch(request("/api/workspaces/workspace-1/agents", { method: "POST", body: "{}" })));
    const response = await app.fetch(request(`/api/agents/${created.id}/abort`, { method: "POST" }));
    expect(response.status).toBe(202);
    expect(await response.json()).toEqual({ accepted: true });
    expect((await json(await app.fetch(request(`/api/agents/${created.id}`)))).status).toBe("stopping");
  });

  test("returns explicit unpersisted history and validates cursors", async () => {
    const { app } = await fixture();
    const created = await json(await app.fetch(request("/api/workspaces/workspace-1/agents", { method: "POST", body: "{}" })));
    const history = await app.fetch(request(`/api/agents/${created.id}/history`));
    expect(await history.json()).toEqual({ unpersisted: true, history: null });
    expect((await app.fetch(request(`/api/agents/${created.id}/history?limit=invalid`))).status).toBe(400);
  });

  test("returns bounded Pi model and thinking capabilities", async () => {
    const { app } = await fixture();
    const created = await json(await app.fetch(request("/api/workspaces/workspace-1/agents", { method: "POST", body: "{}" })));
    const capabilities = await json(await app.fetch(request(`/api/agents/${created.id}/capabilities`)));
    expect(capabilities).toMatchObject({ models: [{ provider: "test", id: "model" }], thinkingLevels: ["medium", "high"] });
  });

  test("archives agents separately and rejects later commands", async () => {
    const { app } = await fixture();
    const created = await json(await app.fetch(request("/api/workspaces/workspace-1/agents", { method: "POST", body: "{}" })));
    expect((await app.fetch(request(`/api/agents/${created.id}/archive`, { method: "POST" }))).status).toBe(200);
    expect((await app.fetch(request(`/api/agents/${created.id}`))).status).toBe(409);
    expect((await app.fetch(request(`/api/agents/${created.id}/prompt`, { method: "POST", body: JSON.stringify({ message: "No" }) }))).status).toBe(409);
  });

  test("rejects missing agents, malformed JSON, and oversized bodies", async () => {
    const { app } = await fixture();
    expect((await app.fetch(request("/api/agents/missing"))).status).toBe(404);
    expect((await app.fetch(request("/api/workspaces/workspace-1/agents", { method: "POST", body: "{" }))).status).toBe(400);
    expect((await app.fetch(request("/api/workspaces/workspace-1/agents", { method: "POST", body: "x".repeat(6 * 1024 * 1024) }))).status).toBe(413);
  });

  test("rejects invalid and oversized decoded image attachments", async () => {
    const { app } = await fixture();
    const created = await json(await app.fetch(request("/api/workspaces/workspace-1/agents", { method: "POST", body: "{}" })));
    const invalid = await app.fetch(request(`/api/agents/${created.id}/prompt`, {
      method: "POST",
      body: JSON.stringify({ message: "Look", images: [{ type: "image", data: "not-base64!", mimeType: "image/png" }] }),
    }));
    expect(invalid.status).toBe(400);
    const oversized = await app.fetch(request(`/api/agents/${created.id}/prompt`, {
      method: "POST",
      body: JSON.stringify({ message: "Look", images: [{ type: "image", data: btoa("x".repeat(MAX_AGENT_IMAGE_DATA_BYTES + 1)), mimeType: "image/png" }] }),
    }));
    expect(oversized.status).toBe(400);
  });

  test("prompt with images journals refs and serves the bytes", async () => {
    const { app } = await fixture();
    const created = await json(await app.fetch(request("/api/workspaces/workspace-1/agents", { method: "POST", body: "{}" })));
    const agentId = String(created.id);
    const data = Buffer.from("test-image-bytes").toString("base64");
    const sent = await app.fetch(request(`/api/agents/${agentId}/prompt`, {
      method: "POST",
      body: JSON.stringify({ message: "Look", images: [{ type: "image", name: "shot.png", data, mimeType: "image/png" }] }),
    }));
    expect(sent.status).toBe(202);

    const history = await json(await app.fetch(request(`/api/agents/${agentId}/history`)));
    const userRow = (history.history as { timeline: Array<{ kind: string; images?: Array<{ hash: string; mimeType: string; name: string }> }> }).timeline.find((row) => row.kind === "user");
    expect(userRow?.images).toHaveLength(1);
    expect(userRow?.images?.[0]).toMatchObject({ mimeType: "image/png", name: "shot.png" });
    const hash = String(userRow?.images?.[0]?.hash);
    expect(hash).toMatch(/^[a-f0-9]{64}$/);

    const served = await app.fetch(request(`/api/agents/${agentId}/images/${hash}`));
    expect(served.status).toBe(200);
    expect(served.headers.get("content-type")).toBe("image/png");
    expect(served.headers.get("cache-control")).toContain("immutable");
    expect(Buffer.from(await served.arrayBuffer()).toString("base64")).toBe(data);

    expect((await app.fetch(request(`/api/agents/${agentId}/images/not-a-hash`))).status).toBe(400);
    expect((await app.fetch(request(`/api/agents/${agentId}/images/${"0".repeat(64)}`))).status).toBe(404);
  });

  test("prompt with files journals refs, serves the bytes, and rejects bad uploads", async () => {
    const { app } = await fixture();
    const created = await json(await app.fetch(request("/api/workspaces/workspace-1/agents", { method: "POST", body: "{}" })));
    const agentId = String(created.id);
    const data = Buffer.from("col1,col2\n1,2\n").toString("base64");
    const sent = await app.fetch(request(`/api/agents/${agentId}/prompt`, {
      method: "POST",
      body: JSON.stringify({ message: "Analyze", files: [{ type: "file", name: "data.csv", data, mimeType: "text/csv" }] }),
    }));
    expect(sent.status).toBe(202);

    const history = await json(await app.fetch(request(`/api/agents/${agentId}/history`)));
    const userRow = (history.history as { timeline: Array<{ kind: string; files?: Array<{ hash: string; name: string; path: string; size: number; mimeType: string }> }> }).timeline.find((row) => row.kind === "user");
    expect(userRow?.files).toHaveLength(1);
    expect(userRow?.files?.[0]).toMatchObject({ name: "data.csv", mimeType: "text/csv" });
    const hash = String(userRow?.files?.[0]?.hash);
    expect(hash).toMatch(/^[a-f0-9]{64}$/);
    expect(String(userRow?.files?.[0]?.path)).toContain(hash);

    const served = await app.fetch(request(`/api/agents/${agentId}/files/${hash}`));
    expect(served.status).toBe(200);
    expect(served.headers.get("content-type")).toBe("text/csv");
    expect(served.headers.get("content-disposition")).toContain('filename="data.csv"');
    expect(Buffer.from(await served.arrayBuffer()).toString("base64")).toBe(data);

    expect((await app.fetch(request(`/api/agents/${agentId}/files/not-a-hash`))).status).toBe(400);
    expect((await app.fetch(request(`/api/agents/${agentId}/files/${"0".repeat(64)}`))).status).toBe(404);
    const invalid = await app.fetch(request(`/api/agents/${agentId}/prompt`, {
      method: "POST",
      body: JSON.stringify({ message: "Bad", files: [{ type: "file", name: "x.txt", data: "not-base64!", mimeType: "text/plain" }] }),
    }));
    expect(invalid.status).toBe(400);
  });

  test("handles extension UI responses", async () => {
    const { app } = await fixture();
    const created = await json(await app.fetch(request("/api/workspaces/workspace-1/agents", { method: "POST", body: "{}" })));
    const agentId = String(created.id);
    const res = await app.fetch(request(`/api/agents/${agentId}/ui-response`, {
      method: "POST",
      body: JSON.stringify({ id: "req-1", value: "Option A" }),
    }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
  });

  test("compacts through the typed endpoint and exposes the slash allowlist", async () => {
    const { app } = await fixture();
    const created = await json(await app.fetch(request("/api/workspaces/workspace-1/agents", { method: "POST", body: "{}" })));
    const agentId = String(created.id);
    const compact = await app.fetch(request(`/api/agents/${agentId}/compact`, { method: "POST" }));
    expect(compact.status).toBe(202);
    expect(await compact.json()).toEqual({ accepted: true });
    const capabilities = await json(await app.fetch(request(`/api/agents/${agentId}/capabilities`)));
    const slashCommands = (capabilities as { slashCommands: Array<{ name: string; kind: string }> }).slashCommands;
    expect((capabilities as { skillsAvailable: boolean }).skillsAvailable).toBe(true);
    expect((capabilities as { skillsSupported: boolean }).skillsSupported).toBe(true);
    expect(slashCommands[0]).toMatchObject({
      name: "compact",
      kind: "action",
    });
    expect(slashCommands).toContainEqual(expect.objectContaining({ name: "skill:gh-cli", kind: "prompt-text" }));
  });
});
