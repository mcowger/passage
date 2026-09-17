import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { Hono } from "hono";
import { honoLogger } from "@logtape/hono";
import { AgentService } from "./agents/service.ts";
import { AgentEventHub } from "./agents/events/index.ts";
import { createAgentRoutes } from "./http/agents.ts";
import { createModelRoutes } from "./http/models.ts";
import { createWorkspaceRoutes } from "./http/workspaces.ts";
import { createGitRoutes, createTranscriptPreviewRoutes } from "./http/git.ts";
import { createFileRoutes } from "./http/files.ts";
import { createWorktreeRoutes } from "./http/worktrees.ts";
import { createTerminalRoutes } from "./http/terminals.ts";
import { MetadataRepositories, MetadataStore } from "./metadata/index.ts";
import { IdempotencyCache } from "./replay/index.ts";
import { WorkspaceService } from "./workspaces/service.ts";
import { WorkspaceEventHub } from "./workspaces/events.ts";
import { GitService } from "./workspaces/git.ts";
import { FileService } from "./workspaces/files.ts";
import { WorktreeService } from "./workspaces/worktrees.ts";
import { WorkspaceActionsService } from "./workspaces/actions.ts";
import { createWorkspaceActionRoutes } from "./http/actions.ts";
import { TerminalManager } from "./terminals/manager.ts";
import { WebPreviewManager } from "./previews/manager.ts";
import { isAllowedPreviewRequest } from "./previews/relay.ts";
import { createPreviewRoutes } from "./http/previews.ts";
import { configureLogging, errorFields, logger } from "./logging.ts";
import {
  MAX_PREVIEW_MESSAGE_BYTES,
  MAX_PREVIEW_UPSTREAM_BYTES,
  previewDownstreamMessageSchema,
  previewUpstreamMessageSchema,
} from "../shared/protocol/previews.ts";
import {
  PROTOCOL_VERSION,
  agentMessagePayloadSchema,
  agentModelPayloadSchema,
  agentSubscriptionPayloadSchema,
  agentTargetPayloadSchema,
  agentThinkingPayloadSchema,
  agentUiResponsePayloadSchema,
  clientTerminalMessageSchema,
  commandEnvelopeSchema,
  decodeBinaryFrame,
  opaqueIdSchema,
  WORKSPACES_SNAPSHOT_SUBJECT,
  workspaceSubscriptionPayloadSchema,
  workspaceTargetPayloadSchema,
  type Acknowledgement,
  type CommandEnvelope,
  type ProtocolError,
  type Response as ProtocolResponse,
} from "../shared/protocol/index.ts";
import homepage from "../web/index.html";
import manifest from "../web/manifest.webmanifest" with { type: "text" };
import icon from "../web/icon.svg" with { type: "text" };
import swScript from "../web/sw.js" with { type: "text" };

const DEFAULT_PORT = 3333;
const MAX_WEBSOCKET_COMMAND_BYTES = 64 * 1024;
const MAX_AGENT_SUBSCRIPTIONS_PER_SOCKET = 32;
const MAX_WORKSPACE_SUBSCRIPTIONS_PER_SOCKET = 32;
const MAX_INFLIGHT_COMMANDS = 256;
const UNKNOWN_REQUEST_ID = "unknown";
await configureLogging();
const log = logger("daemon");
const port = Number(process.env.PORT ?? DEFAULT_PORT);
const isStandaloneExecutable = (Bun as { isStandaloneExecutable?: boolean }).isStandaloneExecutable === true;
// Standalone binaries are portable: keep their data beside the working
// directory instead of resolving relative to the source tree layout.
const defaultDataRoot = isStandaloneExecutable
  ? join(process.cwd(), ".data")
  : join(import.meta.dir, "..", "..", ".data");
const metadataPath = process.env.PASSAGE_DB_PATH ?? join(defaultDataRoot, "passage.sqlite");
mkdirSync(dirname(metadataPath), { recursive: true });

const defaultPidPath = process.env.PASSAGE_DB_PATH ? null : join(defaultDataRoot, "dev.pid");
const pidPath = process.env.PASSAGE_PID_FILE ?? defaultPidPath;
// Records the port this server actually bound, so tooling in any shell can
// discover this worktree's dedicated port without trusting PORT/PASEO_PORT
// inherited from a different checkout. Written after Bun.serve binds.
const portPath = pidPath ? join(dirname(pidPath), "dev.port") : null;
if (pidPath) {
  mkdirSync(dirname(pidPath), { recursive: true });
  writeFileSync(pidPath, `${process.pid}\n`, "utf8");
}

const metadata = new MetadataStore(metadataPath);
const repositories = new MetadataRepositories(metadata.db);
const workspaceService = new WorkspaceService(repositories);
const gitService = new GitService();
const fileService = new FileService(workspaceService);
const workspaceEvents = new WorkspaceEventHub();
// Action runs are live daemon memory. Run start/settle is published as an
// `actions-changed` workspace invalidation (never-throw); receivers refetch
// the run snapshot over HTTP. Background completion has no HTTP request of
// its own, so the service emits through this callback instead of a route.
const workspaceActionsService = new WorkspaceActionsService(repositories, undefined, {
  onRunChanged: (run) => {
    workspaceEvents.emitActionsChanged({ workspaceId: run.workspaceId, runId: run.id });
  },
});
const worktreeService = new WorktreeService(repositories, gitService, undefined, workspaceActionsService);
const terminalManager = new TerminalManager(workspaceService);
const previewManager = new WebPreviewManager(repositories, workspaceService);
const agentService = new AgentService(repositories, {
  sessionsRoot: process.env.PASSAGE_SESSIONS_ROOT ?? join(dirname(metadataPath), "sessions"),
  ...(process.env.PASSAGE_MAX_ACTIVE_AGENTS ? { maxActiveAgents: Number(process.env.PASSAGE_MAX_ACTIVE_AGENTS) } : {}),
  // Agent tool calls (e.g. `git commit` via Pi's bash tool) mutate the repo
  // outside the Git HTTP routes, so the service reports likely Git mutations
  // here and the daemon publishes them as `git-status-changed` invalidations
  // (invalidation-only; receivers refetch). Never throws.
  onWorkspaceGitChanged: (workspaceId) => {
    workspaceEvents.emitGitStatus({ workspaceId, reason: "commit" });
  },
});
const agentEvents = new AgentEventHub(agentService);
const responses = new IdempotencyCache<{ fingerprint: string; response: string }>();
const inflightResponses = new Map<string, { fingerprint: string; response: Promise<string> }>();
const app = new Hono();
app.use("*", honoLogger({
  category: ["hono", "http"],
  context: { include: ["requestId", "method", "path", "userAgent"] },
  format: (context, responseTime) => ({
    event: "http.request",
    method: context.req.method,
    path: context.req.path,
    status: context.res.status,
    durationMs: responseTime,
    userAgent: context.req.header("user-agent"),
  }),
  skip: (context) => context.req.path === "/api/health",
}));
app.use("*", async (context, next) => {
  await next();
  if (context.res.status >= 400) {
    logger("http").warn("HTTP request returned an error status", {
      event: "http.error_status",
      method: context.req.method,
      path: context.req.path,
      status: context.res.status,
    });
  }
});
app.onError((error, context) => {
  logger("http").error("HTTP request failed", { event: "http.error", path: context.req.path, ...errorFields(error) });
  return context.json({ error: "internal-error" }, 500);
});
app.get("/api/health", (context) => context.json({ ok: true }));
app.get("/api/daemon/snapshot", (context) => context.json({
  protocolVersion: PROTOCOL_VERSION,
  metadataSchemaVersion: metadata.schemaVersion,
}));
/** Stop everything bound to a workspace before it is archived/removed:
 *  running setup actions, PTY terminals (+ children), live Pi processes,
 *  and agent-browser preview sessions (+ their chromium). Never throws so
 *  a teardown failure can't block the archival/removal itself. */
const teardownWorkspace = async (workspaceId: string): Promise<void> => {
  try {
    workspaceActionsService.cancelForWorkspace(workspaceId);
  } catch (error) {
    log.warn("Workspace action teardown failed", { event: "daemon.workspace_teardown_actions_failed", workspaceId, ...errorFields(error) });
  }
  try {
    terminalManager.terminateForWorkspace(workspaceId);
  } catch (error) {
    log.warn("Workspace terminal teardown failed", { event: "daemon.workspace_teardown_terminals_failed", workspaceId, ...errorFields(error) });
  }
  await Promise.allSettled([
    agentService.stopForWorkspace(workspaceId),
    previewManager.stopForWorkspace(workspaceId),
  ]).then((results) => {
    for (const result of results) {
      if (result.status === "rejected") {
        log.warn("Workspace teardown step failed", { event: "daemon.workspace_teardown_failed", workspaceId, ...errorFields(result.reason) });
      }
    }
  });
};
app.route("/", createWorkspaceRoutes(workspaceService, { onArchiveWorkspace: (workspaceId) => teardownWorkspace(workspaceId) }, workspaceEvents));
app.route("/", createGitRoutes(workspaceService, gitService, workspaceEvents));
app.route("/", createFileRoutes(fileService, workspaceEvents));
app.route("/", createWorktreeRoutes(worktreeService, { onRemoveWorkspace: (workspaceId) => teardownWorkspace(workspaceId) }, workspaceEvents));
app.route("/", createWorkspaceActionRoutes(workspaceActionsService));
app.route("/", createTerminalRoutes(terminalManager));
app.route("/", createPreviewRoutes(previewManager, workspaceEvents));
app.route("/", createAgentRoutes(agentService));
app.route("/", createModelRoutes());
app.route("/", createTranscriptPreviewRoutes());

function protocolError(requestId: string, code: string, message: string): ProtocolError {
  return { version: PROTOCOL_VERSION, requestId, ok: false, error: { code, message } };
}

type SocketData =
  | { kind: "agent"; subscriptions: Map<string, () => boolean>; workspaceSubscriptions: Map<string, () => boolean> }
  | { kind: "terminal"; terminalId: string; clientId: string }
  | { kind: "preview"; previewId: string; clientId: string };

const PREVIEW_UPSTREAM_FPS = 15;
/** Browser sockets for preview streams, each paired with one loopback upstream. */
const previewUpstreams = new WeakMap<Bun.ServerWebSocket<SocketData>, WebSocket>();

function sendPreviewError(socket: Bun.ServerWebSocket<SocketData>, message: string): void {
  try {
    socket.sendText(JSON.stringify({ type: "error", message: message.slice(0, 512) }));
  } catch (error) {
    logger("ws").warn("Preview error response could not be sent", { event: "ws.preview_error_send_failed", ...errorFields(error) });
  }
}

async function attachPreviewUpstream(socket: Bun.ServerWebSocket<SocketData>, previewId: string): Promise<void> {
  const previewLog = logger("preview").with({ previewId });
  // A disconnected preview may still have a live agent-browser session;
  // reattach to it so a suspended client resumes at the newest frame.
  if (previewManager.previewStatus(previewId) !== "ready") {
    const reattached = await previewManager.rediscover(previewId);
    if (!reattached) {
      previewLog.warn("Preview could not be rediscovered", { event: "preview.rediscover_failed" });
      sendPreviewError(socket, "Preview is not running");
      socket.close(1011, "preview is not running");
      return;
    }
  }
  const streamPort = previewManager.streamPortFor(previewId);
  if (streamPort === null) {
    previewLog.warn("Preview stream port is unavailable", { event: "preview.stream_unavailable" });
    sendPreviewError(socket, "Preview is not running");
    socket.close(1011, "preview is not running");
    return;
  }
  let upstream: WebSocket;
  try {
    upstream = new WebSocket(`ws://127.0.0.1:${streamPort}/?pacing=ack&maxFps=${PREVIEW_UPSTREAM_FPS}`);
  } catch {
    previewLog.warn("Preview stream connection failed", { event: "preview.upstream_connect_failed" });
    sendPreviewError(socket, "Preview stream is unavailable");
    socket.close(1011, "preview stream unavailable");
    return;
  }
  previewUpstreams.set(socket, upstream);
  upstream.addEventListener("message", (event) => {
    const text = typeof event.data === "string" ? event.data : null;
    if (!text || text.length > MAX_PREVIEW_UPSTREAM_BYTES) return;
    let value: unknown;
    try {
      value = JSON.parse(text);
    } catch {
      return;
    }
    // Allowlist only: drop everything Passage does not relay.
    if (!previewUpstreamMessageSchema.safeParse(value).success) return;
    try {
      if (socket.sendText(text) <= 0) {
        previewLog.warn("Preview client could not receive a frame", { event: "preview.client_slow" });
        try { upstream.close(); } catch {}
        socket.close(1013, "client cannot receive preview frames");
      }
    } catch {}
  });
  const dropUpstream = () => {
    previewLog.info("Preview upstream closed", { event: "preview.upstream_closed" });
    previewManager.markDisconnected(previewId);
    try { upstream.close(); } catch {}
    previewUpstreams.delete(socket);
    try { socket.close(1011, "preview stream disconnected"); } catch {}
  };
  upstream.addEventListener("close", dropUpstream);
  upstream.addEventListener("error", dropUpstream);
}

function handlePreviewSocketMessage(socket: Bun.ServerWebSocket<SocketData>, previewId: string, clientId: string, message: string | Uint8Array | ArrayBuffer): void {
  if (typeof message !== "string") {
    sendPreviewError(socket, "Preview messages must be JSON text");
    socket.close(1003, "preview messages must be JSON text");
    return;
  }
  if (message.length > MAX_PREVIEW_MESSAGE_BYTES) {
    socket.close(1009, "preview message is too large");
    return;
  }
  let value: unknown;
  try {
    value = JSON.parse(message);
  } catch {
    return;
  }
  const parsed = previewDownstreamMessageSchema.safeParse(value);
  if (!parsed.success) return;
  const upstream = previewUpstreams.get(socket);
  if (!upstream || upstream.readyState !== WebSocket.OPEN) return;
  const data = parsed.data;
  // Frame acks and pacing config always flow (they preserve latest-frame-wins
  // behavior for every client, including view-only ones). Input needs the lease.
  if (data.type !== "ack" && data.type !== "config") {
    const snapshot = previewManager.get(previewId, clientId);
    if (!snapshot || snapshot.status !== "ready" || snapshot.hasInputLease !== true) return;
  }
  try {
    upstream.send(JSON.stringify(data));
  } catch (error) {
    logger("ws").warn("Preview message could not be sent upstream", { event: "ws.preview_send_error", previewId, ...errorFields(error) });
  }
}

function sendSocketJson(socket: Bun.ServerWebSocket<SocketData>, value: unknown): void {
  if (socket.sendText(JSON.stringify(value)) <= 0) socket.close(1013, "client cannot receive events");
}

async function handleWorkspaceCommand(command: CommandEnvelope, socket: Bun.ServerWebSocket<SocketData>): Promise<ProtocolResponse> {
  if (socket.data.kind !== "agent") return protocolError(command.requestId, "invalid-channel", "Terminal sockets do not accept workspace commands");
  try {
    if (command.type === "subscribe") {
      const input = workspaceSubscriptionPayloadSchema.parse(command.payload);
      socket.data.workspaceSubscriptions.get(input.workspaceId)?.();
      if (!socket.data.workspaceSubscriptions.has(input.workspaceId) && socket.data.workspaceSubscriptions.size >= MAX_WORKSPACE_SUBSCRIPTIONS_PER_SOCKET) {
        return protocolError(command.requestId, "subscription-limit", "Maximum workspace subscriptions reached");
      }
      const subscription = workspaceEvents.subscribe(input.workspaceId, input.afterSequence, (event) => sendSocketJson(socket, event));
      socket.data.workspaceSubscriptions.set(input.workspaceId, subscription.unsubscribe);
      if (subscription.replay.kind === "replay") {
        for (const event of subscription.replay.events) sendSocketJson(socket, event);
      } else {
        sendSocketJson(socket, {
          version: PROTOCOL_VERSION,
          stream: "workspace",
          subjectId: input.workspaceId,
          kind: "snapshot-required",
          metadata: {
            snapshotUrl: input.workspaceId === WORKSPACES_SNAPSHOT_SUBJECT
              ? "/api/workspaces/snapshot"
              : `/api/workspaces/${input.workspaceId}/files?path=.`,
            sequence: String(workspaceEvents.currentSequence(input.workspaceId)),
          },
        });
      }
      subscription.activate();
    } else if (command.type === "unsubscribe") {
      const input = workspaceTargetPayloadSchema.parse(command.payload);
      socket.data.workspaceSubscriptions.get(input.workspaceId)?.();
      socket.data.workspaceSubscriptions.delete(input.workspaceId);
    } else {
      return protocolError(command.requestId, "unsupported-command", "Command is not implemented");
    }
  } catch (cause) {
    const message = cause instanceof Error ? cause.message.slice(0, 512) : "Workspace command failed";
    return protocolError(command.requestId, "workspace-command-failed", message);
  }
  return {
    version: PROTOCOL_VERSION,
    requestId: command.requestId,
    ok: true,
  } satisfies Acknowledgement;
}

async function handleCommand(command: CommandEnvelope, socket: Bun.ServerWebSocket<SocketData>): Promise<ProtocolResponse> {
  if (socket.data.kind !== "agent") return protocolError(command.requestId, "invalid-channel", "Only /ws sockets accept agent commands");
  if (command.channel === "daemon" && command.type === "ping") {
    return { version: PROTOCOL_VERSION, requestId: command.requestId, ok: true } satisfies Acknowledgement;
  }
  if (command.channel === "workspace") {
    return handleWorkspaceCommand(command, socket);
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
    } else if (command.type === "ui_response") {
      const input = agentUiResponsePayloadSchema.parse(command.payload);
      const { agentId, ...response } = input;
      await agentService.respondExtensionUi(agentId, response as any);
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
    "/manifest.webmanifest": new Response(manifest, {
      headers: { "Content-Type": "application/manifest+json", "Cache-Control": "public, max-age=86400" },
    }),
    "/icon.svg": new Response(icon, {
      headers: { "Content-Type": "image/svg+xml", "Cache-Control": "public, max-age=86400" },
    }),
    "/sw.js": new Response(swScript, {
      headers: {
        "Content-Type": "application/javascript",
        "Service-Worker-Allowed": "/",
        "Cache-Control": "no-cache",
      },
    }),
  },
  fetch(request, server) {
    const url = new URL(request.url);
    if (url.pathname === "/ws") {
      log.debug("WebSocket upgrade requested", { event: "ws.upgrade", path: url.pathname });
      return server.upgrade(request, { data: { kind: "agent", subscriptions: new Map(), workspaceSubscriptions: new Map() } })
        ? undefined
        : new Response("WebSocket upgrade failed", { status: 400 });
    }

    if (url.pathname.startsWith("/api/terminals/") && url.pathname.endsWith("/ws")) {
      const parts = url.pathname.split("/");
      const terminalId = parts[3];
      const clientId = url.searchParams.get("clientId") || `client_${crypto.randomUUID()}`;
      logger("ws").debug("Terminal WebSocket upgrade requested", { event: "ws.upgrade", channel: "terminal", terminalId });
      return server.upgrade(request, { data: { kind: "terminal", terminalId, clientId } })
        ? undefined
        : new Response("Terminal WebSocket upgrade failed", { status: 400 });
    }

    if (url.pathname.startsWith("/api/previews/") && url.pathname.endsWith("/ws")) {
      const parts = url.pathname.split("/");
      const previewId = parts[3];
      if (!previewId) return new Response("Missing preview ID", { status: 400 });
      if (!isAllowedPreviewRequest(request)) return new Response("Origin is not allowed", { status: 403 });
      // Ownership check: unknown IDs never reach the relay.
      if (previewManager.previewWorkspace(previewId) === null) return new Response("Preview not found", { status: 404 });
      const clientId = url.searchParams.get("clientId") || `client_${crypto.randomUUID()}`;
      logger("ws").debug("Preview WebSocket upgrade requested", { event: "ws.upgrade", channel: "preview", previewId });
      return server.upgrade(request, { data: { kind: "preview", previewId, clientId } })
        ? undefined
        : new Response("Preview WebSocket upgrade failed", { status: 400 });
    }

    return app.fetch(request);
  },
  websocket: {
    open(socket) {
      logger("ws").info("WebSocket opened", { event: "ws.open", channel: socket.data.kind, ...(socket.data.kind === "terminal" ? { terminalId: socket.data.terminalId } : {}), ...(socket.data.kind === "preview" ? { previewId: socket.data.previewId } : {}) });
      if (socket.data.kind === "terminal") {
        const { terminalId, clientId } = socket.data;
        terminalManager.attach(terminalId, {
          clientId,
          isHolder: false,
          sendBinary: (buf) => socket.sendBinary(buf),
          sendControl: (ctrl) => socket.sendText(JSON.stringify(ctrl)),
        });
      } else if (socket.data.kind === "preview") {
        void attachPreviewUpstream(socket, socket.data.previewId);
      }
    },
    async message(socket, message) {
      if (socket.data.kind === "preview") {
        handlePreviewSocketMessage(socket, socket.data.previewId, socket.data.clientId, message as string | Uint8Array | ArrayBuffer);
        return;
      }
      if (socket.data.kind === "terminal") {
        const { terminalId, clientId } = socket.data;
        if (typeof message === "string") {
          try {
            const parsed = clientTerminalMessageSchema.safeParse(JSON.parse(message));
            if (!parsed.success) return;
            const msg = parsed.data;
            if (msg.type === "input") {
              terminalManager.writeInput(terminalId, msg.data);
            } else if (msg.type === "resize") {
              terminalManager.resize(terminalId, msg.cols, msg.rows, clientId);
            } else if (msg.type === "lease") {
              if (msg.take) terminalManager.takeLease(terminalId, clientId);
            }
          } catch {}
        } else if (typeof message === "object" && message !== null) {
          try {
            const frame = decodeBinaryFrame(message as Uint8Array | ArrayBuffer);
            terminalManager.writeInput(terminalId, new TextDecoder().decode(frame.payload));
          } catch {}
        }
        return;
      }

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
      logger("ws").info("WebSocket closed", { event: "ws.close", channel: socket.data.kind, ...(socket.data.kind === "terminal" ? { terminalId: socket.data.terminalId } : {}), ...(socket.data.kind === "preview" ? { previewId: socket.data.previewId } : {}) });
      if (socket.data.kind === "terminal") {
        terminalManager.detach(socket.data.terminalId, socket.data.clientId);
      } else if (socket.data.kind === "preview") {
        try { previewUpstreams.get(socket)?.close(); } catch {}
        previewUpstreams.delete(socket);
        previewManager.releaseLease(socket.data.previewId, socket.data.clientId);
      } else {
        for (const unsubscribe of socket.data.subscriptions.values()) unsubscribe();
        socket.data.subscriptions.clear();
        for (const unsubscribe of socket.data.workspaceSubscriptions.values()) unsubscribe();
        socket.data.workspaceSubscriptions.clear();
      }
    },
  },
});

if (portPath) {
  try {
    writeFileSync(portPath, `${server.port}\n`, "utf8");
  } catch {}
}

log.warn("Passage has no application authentication; expose it only on a trusted network or behind an authenticated proxy/VPN.", { event: "daemon.authentication_disabled" });
log.info("Passage listening", { event: "daemon.started", port: server.port });

let shuttingDown = false;
async function shutdown(): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  log.info("Passage shutdown started", { event: "daemon.shutdown_started" });
  if (pidPath && existsSync(pidPath)) {
    try {
      if (readFileSync(pidPath, "utf8").trim() === String(process.pid)) {
        unlinkSync(pidPath);
        if (portPath) {
          try { unlinkSync(portPath); } catch {}
        }
      }
    } catch {}
  }
  agentEvents.dispose();
  workspaceEvents.dispose();
  await previewManager.shutdown();
  await agentService.shutdown();
  await server.stop(true);
  metadata.close();
  log.info("Passage shutdown completed", { event: "daemon.shutdown_completed" });
}

process.once("SIGINT", () => { void shutdown().finally(() => process.exit(0)); });
process.once("SIGTERM", () => { void shutdown().finally(() => process.exit(0)); });
