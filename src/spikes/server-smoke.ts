const START_TIMEOUT_MS = 10_000;
const REQUEST_INTERVAL_MS = 50;

async function reservePort(): Promise<number> {
  const reservation = Bun.serve({ port: 0, fetch: () => new Response() });
  const port = reservation.port;
  reservation.stop(true);
  if (port === undefined) throw new Error("failed to reserve a production smoke-test port");
  return port;
}

async function waitForServer(url: string, process: Bun.Subprocess): Promise<Response> {
  const deadline = Date.now() + START_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (process.exitCode !== null) throw new Error(`daemon exited before startup (${process.exitCode})`);
    try {
      const response = await fetch(url);
      if (response.ok) return response;
    } catch {}
    await Bun.sleep(REQUEST_INTERVAL_MS);
  }
  throw new Error("daemon did not start before the timeout");
}

async function verifyWebSocket(url: string, origin: string): Promise<void> {
  const WebSocketWithOptions = WebSocket as unknown as new (url: string, options: Bun.WebSocketOptions) => WebSocket;
  const socket = new WebSocketWithOptions(url, { headers: { Origin: origin } });
  const opened = new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error("WebSocket did not open before the timeout")), START_TIMEOUT_MS);
    socket.addEventListener("open", () => { clearTimeout(timeout); resolve(); }, { once: true });
    socket.addEventListener("error", () => { clearTimeout(timeout); reject(new Error("WebSocket failed")); }, { once: true });
  });

  const exchange = (command: unknown): Promise<Record<string, unknown>> => new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error("WebSocket did not respond before the timeout")), START_TIMEOUT_MS);
    socket.addEventListener("message", (event) => {
      clearTimeout(timeout);
      resolve(JSON.parse(String(event.data)) as Record<string, unknown>);
    }, { once: true });
    socket.send(typeof command === "string" ? command : JSON.stringify(command));
  });

  try {
    await opened;
    const command = { version: 1, requestId: "smoke-request", channel: "daemon", type: "ping", payload: {} };
    const acknowledged = await exchange(command);
    if (acknowledged.ok !== true || acknowledged.requestId !== command.requestId) throw new Error("WebSocket returned an unexpected acknowledgement");
    if ((await exchange(command)).ok !== true) throw new Error("WebSocket idempotent retry failed");
    const conflict = await exchange({ ...command, type: "different" });
    if ((conflict.error as { code?: string } | undefined)?.code !== "request-id-conflict") throw new Error("WebSocket request ID conflict was not rejected");
    const invalid = await exchange("not-json");
    if ((invalid.error as { code?: string } | undefined)?.code !== "invalid-json") throw new Error("WebSocket malformed input was not rejected");
  } finally {
    socket.close();
  }
}

async function verifyAgentSubscription(url: string, origin: string, agentId: string): Promise<void> {
  const WebSocketWithOptions = WebSocket as unknown as new (url: string, options: Bun.WebSocketOptions) => WebSocket;
  const socket = new WebSocketWithOptions(url, { headers: { Origin: origin } });
  const received: Array<Record<string, unknown>> = [];
  const opened = new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error("agent WebSocket did not open before the timeout")), START_TIMEOUT_MS);
    socket.addEventListener("open", () => { clearTimeout(timeout); resolve(); }, { once: true });
    socket.addEventListener("error", () => { clearTimeout(timeout); reject(new Error("agent WebSocket failed")); }, { once: true });
  });
  socket.addEventListener("message", (event) => {
    try { received.push(JSON.parse(String(event.data)) as Record<string, unknown>); } catch {}
  });
  try {
    await opened;
    socket.send(JSON.stringify({
      version: 1,
      requestId: "agent-subscribe",
      channel: "pi",
      type: "subscribe",
      payload: { agentId, afterSequence: 0 },
    }));
    const deadline = Date.now() + START_TIMEOUT_MS;
    while (Date.now() < deadline && !received.some((record) => record.ok === true && record.requestId === "agent-subscribe")) {
      await Bun.sleep(REQUEST_INTERVAL_MS);
    }
    if (!received.some((record) => record.ok === true && record.requestId === "agent-subscribe")) {
      throw new Error("agent subscription was not acknowledged");
    }
    const agentEvents = received.filter((record) => record.stream === "pi" && record.subjectId === agentId);
    if (agentEvents.length === 0) throw new Error("agent subscription did not replay a normalized event");
    if (agentEvents.some((record) => JSON.stringify(record).includes("sessionFile") || JSON.stringify(record).includes("stderr"))) {
      throw new Error("agent event leaked raw runtime data");
    }
  } finally {
    socket.close();
  }
}

const port = await reservePort();
const root = import.meta.dir + "/../..";
const dist = import.meta.dir + "/../../dist";
const temporaryData = await mkdtemp(join(tmpdir(), "passage-server-smoke-"));
const origin = `http://localhost:${port}`;
const source = process.argv.includes("--source");
const command = source
  ? [process.execPath, "run", "src/daemon/index.ts"]
  : process.argv.includes("--compiled")
    ? [dist + "/passage"]
    : [process.execPath, "run", "./index.js"];
const daemon = Bun.spawn(command, {
  cwd: source ? root : dist,
  env: {
    ...process.env,
    NODE_ENV: source ? "development" : "production",
    PASSAGE_DB_PATH: join(temporaryData, "passage.sqlite"),
    PASSAGE_PUBLIC_ORIGIN: origin,
    PORT: String(port),
  },
  stdin: "ignore",
  stdout: "pipe",
  stderr: "pipe",
});

try {
  const homepage = await waitForServer(`http://localhost:${port}/`, daemon);
  if (!(await homepage.text()).includes('id="root"')) throw new Error("homepage is not the Passage HTML shell");

  const health = await fetch(`http://localhost:${port}/api/health`);
  if (!health.ok || (await health.json() as { ok?: boolean }).ok !== true) throw new Error("health endpoint failed");

  const snapshot = await fetch(`http://localhost:${port}/api/daemon/snapshot`);
  const snapshotData = await snapshot.json() as { protocolVersion?: number; metadataSchemaVersion?: number };
  if (!snapshot.ok || snapshotData.protocolVersion !== 1 || (snapshotData.metadataSchemaVersion ?? 0) < 1) {
    throw new Error("daemon snapshot endpoint failed");
  }

  const projectResponse = await fetch(`http://localhost:${port}/api/projects`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ configuredRootPath: temporaryData, displayLabel: "Smoke project" }),
  });
  const project = await projectResponse.json() as { id?: string };
  if (projectResponse.status !== 201 || !project.id) throw new Error("project registration failed");

  const workspaceResponse = await fetch(`http://localhost:${port}/api/projects/${project.id}/workspaces`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ displayLabel: "Smoke workspace" }),
  });
  const workspace = await workspaceResponse.json() as { id?: string };
  if (workspaceResponse.status !== 201 || !workspace.id) throw new Error("directory workspace creation failed");

  const workspaceSnapshot = await fetch(`http://localhost:${port}/api/workspaces/snapshot`);
  const workspaceData = await workspaceSnapshot.json() as { projects?: unknown[]; workspaces?: unknown[] };
  if (workspaceData.projects?.length !== 1 || workspaceData.workspaces?.length !== 1) {
    throw new Error("workspace snapshot did not include created resources");
  }

  const agentResponse = await fetch(`http://localhost:${port}/api/workspaces/${workspace.id}/agents`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: "{}",
  });
  const agent = await agentResponse.json() as { id?: string; live?: boolean };
  if (agentResponse.status !== 201 || !agent.id || agent.live !== true) throw new Error("agent creation failed");

  const agents = await (await fetch(`http://localhost:${port}/api/workspaces/${workspace.id}/agents`)).json() as unknown[];
  if (agents.length !== 1) throw new Error("agent snapshot did not include the created agent");

  await verifyWebSocket(`ws://localhost:${port}/ws`, origin);
  await verifyAgentSubscription(`ws://localhost:${port}/ws`, origin, agent.id);
} finally {
  if (!daemon.killed) daemon.kill();
  await daemon.exited;
  await rm(temporaryData, { recursive: true, force: true });
}
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
