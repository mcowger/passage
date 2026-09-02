import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { Hono } from "hono";
import { AgentService } from "./agents/service.ts";
import { AgentEventHub } from "./agents/events/index.ts";
import { createAgentRoutes } from "./http/agents.ts";
import { createWorkspaceRoutes } from "./http/workspaces.ts";
import { createGitRoutes } from "./http/git.ts";
import { createFileRoutes } from "./http/files.ts";
import { createWorktreeRoutes } from "./http/worktrees.ts";
import { MetadataRepositories, MetadataStore } from "./metadata/index.ts";
import { IdempotencyCache } from "./replay/index.ts";
import { WorkspaceService } from "./workspaces/service.ts";
import { GitService } from "./workspaces/git.ts";
import { FileService } from "./workspaces/files.ts";
import { WorktreeService } from "./workspaces/worktrees.ts";
import {
  PROTOCOL_VERSION,
  agentMessagePayloadSchema,
  agentModelPayloadSchema,
  agentSubscriptionPayloadSchema,
  agentTargetPayloadSchema,
  agentThinkingPayloadSchema,
  commandEnvelopeSchema,
  opaqueIdSchema,
  type Acknowledgement,
  type CommandEnvelope,
  type ProtocolError,
  type Response as ProtocolResponse,
} from "../shared/protocol/index.ts";
import homepage from "../web/index.html";

const DEFAULT_PORT = 3000;
const MAX_WEBSOCKET_COMMAND_BYTES = 64 * 1024;
const MAX_AGENT_SUBSCRIPTIONS_PER_SOCKET = 32;
const MAX_INFLIGHT_COMMANDS = 256;
const UNKNOWN_REQUEST_ID = "unknown";
const port = Number(process.env.PORT ?? DEFAULT_PORT);
const defaultDataRoot = join(process.env.XDG_DATA_HOME ?? join(homedir(), ".local", "share"), "passage");
const metadataPath = process.env.PASSAGE_DB_PATH ?? join(defaultDataRoot, "passage.sqlite");
mkdirSync(dirname(metadataPath), { recursive: true });

const metadata = new MetadataStore(metadataPath);
const repositories = new MetadataRepositories(metadata.db);
const workspaceService = new WorkspaceService(repositories);
const gitService = new GitService();
const fileService = new FileService(workspaceService);
const worktreeService = new WorktreeService(repositories, gitService);
const agentService = new AgentService(repositories, {
  sessionsRoot: process.env.PASSAGE_SESSIONS_ROOT ?? join(dirname(metadataPath), "sessions"),
});
const agentEvents = new AgentEventHub(agentService);
const responses = new IdempotencyCache<{ fingerprint: string; response: string }>();
const inflightResponses = new Map<string, { fingerprint: string; response: Promise<string> }>();
const app = new Hono();
app.get("/api/health", (context) => context.json({ ok: true }));
app.get("/api/daemon/snapshot", (context) => context.json({
  protocolVersion: PROTOCOL_VERSION,
  metadataSchemaVersion: metadata.schemaVersion,
}));
app.route("/", createWorkspaceRoutes(workspaceService));
app.route("/", createGitRoutes(workspaceService, gitService));
app.route("/", createFileRoutes(fileService));
app.route("/", createWorktreeRoutes(worktreeService));
app.route("/", createAgentRoutes(agentService));

function protocolError(requestId: string, code: string, message: string): ProtocolError {
  return { version: PROTOCOL_VERSION, requestId, ok: false, error: { code, message } };
}

type SocketData = { subscriptions: Map<string, () => boolean> };

function sendSocketJson(socket: Bun.ServerWebSocket<SocketData>, value: unknown): void {
  if (socket.sendText(JSON.stringify(value)) <= 0) socket.close(1013, "client cannot receive events");
}

async function handleCommand(command: CommandEnvelope, socket: Bun.ServerWebSocket<SocketData>): Promise<ProtocolResponse> {
  if (command.channel === "daemon" && command.type === "ping") {
    return { version: PROTOCOL_VERSION, requestId: command.requestId, ok: true } satisfies Acknowledgement;
  }
  if (command.channel !== "pi") {
    return protocolError(command.requestId, "unsupported-command", "Command is not implemented");
  }

  try {
    if (command.type === "subscribe") {
      const input = agentSubscriptionPayloadSchema.parse(command.payload);
      agentService.snapshot(input.agentId);
      socket.data.subscriptions.get(input.agentId)?.();
      if (!socket.data.subscriptions.has(input.agentId) && socket.data.subscriptions.size >= MAX_AGENT_SUBSCRIPTIONS_PER_SOCKET) {
        return protocolError(command.requestId, "subscription-limit", "Maximum agent subscriptions reached");
      }
      const subscription = agentEvents.subscribe(input.agentId, input.afterSequence, (event) => sendSocketJson(socket, event));
      socket.data.subscriptions.set(input.agentId, subscription.unsubscribe);
      if (subscription.replay.kind === "replay") {
        for (const event of subscription.replay.events) sendSocketJson(socket, event);
      } else {
        sendSocketJson(socket, {
          version: PROTOCOL_VERSION,
          stream: "pi",
          subjectId: input.agentId,
          kind: "snapshot-required",
          metadata: {
            snapshotUrl: `/api/agents/${input.agentId}`,
            sequence: String(agentEvents.currentSequence(input.agentId)),
          },
        });
      }
      subscription.activate();
    } else if (command.type === "unsubscribe") {
      const input = agentTargetPayloadSchema.parse(command.payload);
      socket.data.subscriptions.get(input.agentId)?.();
      socket.data.subscriptions.delete(input.agentId);
    } else if (command.type === "start") {
      const input = agentTargetPayloadSchema.parse(command.payload);
      await agentService.start(input.agentId);
    } else if (command.type === "prompt" || command.type === "steer" || command.type === "follow-up") {
      const input = agentMessagePayloadSchema.parse(command.payload);
      if (command.type === "prompt") await agentService.prompt(input.agentId, input.message);
      else if (command.type === "steer") await agentService.steer(input.agentId, input.message);
      else await agentService.followUp(input.agentId, input.message);
    } else if (command.type === "abort") {
      const input = agentTargetPayloadSchema.parse(command.payload);
      await agentService.abort(input.agentId);
    } else if (command.type === "model") {
      const input = agentModelPayloadSchema.parse(command.payload);
      await agentService.model(input.agentId, input.provider, input.modelId);
    } else if (command.type === "thinking") {
      const input = agentThinkingPayloadSchema.parse(command.payload);
      await agentService.thinking(input.agentId, input.level);
    } else {
      return protocolError(command.requestId, "unsupported-command", "Command is not implemented");
    }
  } catch (cause) {
    const message = cause instanceof Error ? cause.message.slice(0, 512) : "Agent command failed";
    return protocolError(command.requestId, "agent-command-failed", message);
  }
  return {
    version: PROTOCOL_VERSION,
    requestId: command.requestId,
    ok: true,
  } satisfies Acknowledgement;
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value !== null && typeof value === "object") {
    return `{${Object.entries(value).sort(([left], [right]) => left.localeCompare(right)).map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

export const server = Bun.serve<SocketData>({
  port,
  development: process.env.NODE_ENV !== "production",
  routes: {
    "/": homepage,
  },
  fetch(request, server) {
    if (new URL(request.url).pathname === "/ws") {
      return server.upgrade(request, { data: { subscriptions: new Map() } })
        ? undefined
        : new Response("WebSocket upgrade failed", { status: 400 });
    }
    return app.fetch(request);
  },
  websocket: {
    async message(socket, message) {
      if (typeof message !== "string") {
        socket.sendText(JSON.stringify(protocolError(UNKNOWN_REQUEST_ID, "binary-command", "Commands must be JSON text")));
        return;
      }
      if (new TextEncoder().encode(message).byteLength > MAX_WEBSOCKET_COMMAND_BYTES) {
        socket.sendText(JSON.stringify(protocolError(UNKNOWN_REQUEST_ID, "command-too-large", "Command exceeds the byte limit")));
        return;
      }

      let value: unknown;
      try {
        value = JSON.parse(message);
      } catch {
        socket.sendText(JSON.stringify(protocolError(UNKNOWN_REQUEST_ID, "invalid-json", "Command must be valid JSON")));
        return;
      }

      const parsed = commandEnvelopeSchema.safeParse(value);
      if (!parsed.success) {
        const candidate = typeof value === "object" && value !== null && "requestId" in value
          ? opaqueIdSchema.safeParse(value.requestId)
          : undefined;
        const requestId = candidate?.success ? candidate.data : UNKNOWN_REQUEST_ID;
        socket.sendText(JSON.stringify(protocolError(requestId, "invalid-command", "Command does not match protocol version 1")));
        return;
      }

      const requestId = parsed.data.requestId;
      const fingerprint = canonicalJson(parsed.data);
      const cached = responses.get(requestId);
      if (cached) {
        socket.sendText(cached.fingerprint === fingerprint
          ? cached.response
          : JSON.stringify(protocolError(requestId, "request-id-conflict", "Request ID was already used for a different command")));
        return;
      }
      const inflight = inflightResponses.get(requestId);
      if (inflight) {
        socket.sendText(inflight.fingerprint === fingerprint
          ? await inflight.response
          : JSON.stringify(protocolError(requestId, "request-id-conflict", "Request ID was already used for a different command")));
        return;
      }
      if (inflightResponses.size >= MAX_INFLIGHT_COMMANDS) {
        socket.sendText(JSON.stringify(protocolError(requestId, "daemon-busy", "Too many commands are in flight")));
        return;
      }

      const pendingResponse = handleCommand(parsed.data, socket)
        .then((response) => JSON.stringify(response))
        .catch(() => JSON.stringify(protocolError(requestId, "command-failed", "Command failed")));
      inflightResponses.set(requestId, { fingerprint, response: pendingResponse });
      try {
        const response = await pendingResponse;
        responses.set(requestId, { fingerprint, response });
        socket.sendText(response);
      } finally {
        if (inflightResponses.get(requestId)?.response === pendingResponse) inflightResponses.delete(requestId);
      }
    },
    close(socket) {
      for (const unsubscribe of socket.data.subscriptions.values()) unsubscribe();
      socket.data.subscriptions.clear();
    },
  },
});

console.warn("Passage has no application authentication; expose it only on a trusted network or behind an authenticated proxy/VPN.");
console.log(`Passage listening on ${server.url}`);

let shuttingDown = false;
async function shutdown(): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  agentEvents.dispose();
  await agentService.shutdown();
  await server.stop(true);
  metadata.close();
}

process.once("SIGINT", () => { void shutdown().finally(() => process.exit(0)); });
process.once("SIGTERM", () => { void shutdown().finally(() => process.exit(0)); });
