import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { Hono } from "hono";
import { z } from "zod";
import { honoLogger } from "@logtape/hono";
import { AgentError } from "./agents/errors.ts";
import { AgentService } from "./agents/service.ts";
import { AgentEventHub } from "./agents/events/index.ts";
import { DaemonLifecycle } from "./lifecycle/index.ts";
import { DaemonEventHub } from "./lifecycle/events.ts";
import { runSafeShutdown } from "./lifecycle/shutdown.ts";
import { HttpInputError, readJsonBody } from "./http/body.ts";
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
import { CommitGenerator } from "./workspaces/commit-generator.ts";
import { FileService } from "./workspaces/files.ts";
import { WorktreeService } from "./workspaces/worktrees.ts";
import { WorkspaceActionsService } from "./workspaces/actions.ts";
import { createWorkspaceActionRoutes } from "./http/actions.ts";
import { TerminalManager } from "./terminals/manager.ts";
import { WebPreviewManager } from "./previews/manager.ts";
import { isAllowedPreviewRequest } from "./previews/relay.ts";
import { createPreviewRoutes } from "./http/previews.ts";
import { PushService } from "./push/service.ts";
import { createPushRoutes } from "./push/routes.ts";
import { wireAgentPushNotifications } from "./push/notifier.ts";
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
  DAEMON_SNAPSHOT_SUBJECT,
  daemonSubscriptionPayloadSchema,
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
import { getBuildInfo } from "./build-info.ts";
import { resolveDaemonPort } from "./env.ts";

const MAX_WEBSOCKET_COMMAND_BYTES = 64 * 1024;
const MAX_AGENT_SUBSCRIPTIONS_PER_SOCKET = 32;
const MAX_WORKSPACE_SUBSCRIPTIONS_PER_SOCKET = 32;
const MAX_INFLIGHT_COMMANDS = 256;
const UNKNOWN_REQUEST_ID = "unknown";
/** `POST /api/daemon/shutdown` body. Bare
 *  `{}`/empty body is the plain safe path; `force: true` is a separate,
 *  clearly-labeled interruption; the identity fields are for a validated
 *  commit against a drain the caller already observed reach `ready`. */
const shutdownInputSchema = z.object({
  force: z.boolean().optional(),
  instanceId: z.string().min(1).max(64).optional(),
  drainId: z.string().min(1).max(64).nullable().optional(),
  readinessRevision: z.number().int().nonnegative().safe().optional(),
}).strict();
/** Safe drain has no automatic kill deadline by design; overridden by
 *  explicit product decision (see AGENTS.md Pi process ownership) to
 *  bound how long a safe shutdown request waits for an idle boundary
 *  before escalating to a forced stop. Does not bound a manually held
 *  drain (`POST /api/daemon/drain` without a shutdown request behind it)
 *  -- only an actual shutdown attempt (HTTP, SIGINT/SIGTERM). */
const DEFAULT_SHUTDOWN_TIMEOUT_MINUTES = 60;
await configureLogging();
const log = logger("daemon");
function resolveShutdownTimeoutMs(): number {
  const raw = process.env.PASSAGE_SHUTDOWN_TIMEOUT_MINUTES;
  if (raw === undefined || raw.trim() === "") return DEFAULT_SHUTDOWN_TIMEOUT_MINUTES * 60_000;
  const minutes = Number(raw);
  if (!Number.isFinite(minutes) || minutes <= 0) {
    log.warn("Ignoring invalid PASSAGE_SHUTDOWN_TIMEOUT_MINUTES", { event: "daemon.invalid_shutdown_timeout", value: raw });
    return DEFAULT_SHUTDOWN_TIMEOUT_MINUTES * 60_000;
  }
  return minutes * 60_000;
}
const shutdownTimeoutMs = resolveShutdownTimeoutMs();
// `--port` wins over `PORT` so a stale PORT inherited from a different
// checkout's shell can never steal this worktree's bind. Fails fast on an
// invalid value instead of binding 0/NaN.
const port = resolveDaemonPort(process.env, Bun.argv.slice(1));
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
const commitGenerator = new CommitGenerator();
const terminalManager = new TerminalManager(workspaceService);
const previewManager = new WebPreviewManager(repositories, workspaceService);
const sessionsRoot = process.env.PASSAGE_SESSIONS_ROOT ?? join(dirname(metadataPath), "sessions");
// DaemonLifecycle needs AgentService's blocker methods; AgentService needs
// the lifecycle's admission gate. Bridge the cycle with a forward
// reference the gate closure resolves lazily -- it is only ever called
// after both are fully constructed below.
let lifecycleRef: DaemonLifecycle | undefined;
const agentService = new AgentService(repositories, {
  sessionsRoot,
  ...(process.env.PASSAGE_MAX_ACTIVE_AGENTS ? { maxActiveAgents: Number(process.env.PASSAGE_MAX_ACTIVE_AGENTS) } : {}),
  // Agent tool calls (e.g. `git commit` via Pi's bash tool) mutate the repo
  // outside the Git HTTP routes, so the service reports likely Git mutations
  // here and the daemon publishes them as `git-status-changed` invalidations
  // (invalidation-only; receivers refetch). Never throws.
  onWorkspaceGitChanged: (workspaceId) => {
    workspaceEvents.emitGitStatus({ workspaceId, reason: "commit" });
  },
  // Drain lifecycle: closed synchronously the instant a drain begins. Defaults to open before the lifecycle below exists
  // (construction order), never after.
  admissionGate: () => lifecycleRef?.isAdmissionOpen() ?? true,
  // Auto-titles use the workspace's configured suggestion model + thinking
  // level + prompt template (Settings); empty fields mean the suggestion
  // backend's defaults.
  getSuggestConfig: (workspaceId) => {
    try {
      const settings = workspaceService.getSettings(workspaceId);
      return { model: settings.suggestModel, thinkingLevel: settings.suggestThinkingLevel, titlePrompt: settings.titlePrompt };
    } catch {
      return undefined;
    }
  },
});
// Boot-time restart recovery, before serving agent commands: any agent
// still persisted as running/stopping/initializing/needs-attention belonged
// to a Pi process this fresh daemon does not own (see AGENTS.md Pi
// process ownership). Normalize it to `interrupted` (not
// `error`: Pi reported nothing wrong) instead of a stale spinner or an
// unanswerable pending question.
try {
  const restart = await agentService.reconcileAfterRestart();
  if (restart.interrupted.length > 0) {
    log.warn("Interrupted agent runtime state normalized on boot", { event: "agent.restart_swept", count: restart.interrupted.length });
  }
} catch {}
const agentEvents = new AgentEventHub(agentService);
// One lifecycle controller: admission closed synchronously on beginDrain(); readiness is recomputed from live
// agent state only -- see AgentService.listQuickBlockers/listBlockers.
// Only agents block drain readiness; terminals, previews, and workspace
// Git/file/worktree operations do not (explicit product decision).
const daemonEvents = new DaemonEventHub();
const lifecycle = new DaemonLifecycle({
  listQuickBlockers: () => agentService.listQuickBlockers(),
  listBlockers: () => agentService.listBlockers(),
  onPhaseChanged: (phase) => {
    log.info("Daemon lifecycle phase changed", { event: "daemon.phase_changed", phase });
    daemonEvents.emit({ reason: phase === "draining" ? "drain-begin" : phase === "running" ? "drain-cancel" : "readiness-changed" });
  },
});
lifecycleRef = lifecycle;
// Web Push for installed PWAs (iOS 16.4+ standalone + Android/desktop):
// env-provided VAPID keys, multi-device fanout, prune on 404/410.
const pushService = new PushService(repositories);
wireAgentPushNotifications({ agentService, workspaceService, push: pushService });
// Cheap, synchronous: only ever revokes an already-reached `ready`, and
// (while draining) kicks off the coalesced authoritative recompute.
agentService.subscribe(() => lifecycle.onActivity());
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
app.get("/api/health", (context) => context.json({ ok: true, build: getBuildInfo() }));
app.get("/api/daemon/snapshot", async (context) => context.json({
  protocolVersion: PROTOCOL_VERSION,
  metadataSchemaVersion: metadata.schemaVersion,
  build: getBuildInfo(),
  ...await lifecycle.snapshot(),
}));
// Begin/cancel drain. Both return the fresh snapshot inline (HTTP =
// snapshots) and the phase-change callback above publishes a
// `daemon-changed` WS invalidation for every other window (WS =
// invalidations only). Draining itself stops nothing and closes no
// agent tabs; it only closes new-work admission (the shutdown route adds
// the actual stop/commit path).
app.post("/api/daemon/drain", async (context) => {
  lifecycle.beginDrain();
  return context.json(await lifecycle.snapshot());
});
app.delete("/api/daemon/drain", async (context) => {
  lifecycle.cancelDrain();
  return context.json(await lifecycle.snapshot());
});
// `force: true` interrupts active work immediately (a separate, clearly-labeled action). Without it, this is a
// safe request: begin/join a drain, wait for `ready`, and commit -- no
// overall kill deadline, so this can take a while or (if the drain gets
// cancelled) never happen at all. Supplying `instanceId`/`drainId`/
// `readinessRevision` (the deploy tool holding a drain at `ready`) instead
// synchronously validates and commits exactly that observed snapshot,
// failing fast with 409 on a stale or not-yet-ready one rather than
// silently accepting and doing nothing. Acknowledgement means accepted,
// not "already shut down"; a dropped connection around the moment of
// actual exit is not proof either way -- verify independently (health
// check / port probe), not via this response.
app.post("/api/daemon/shutdown", async (context) => {
  let body: unknown = {};
  try {
    body = await readJsonBody(context.req.raw, 1024);
  } catch (cause) {
    if (!(cause instanceof HttpInputError && cause.code === "invalid-json")) {
      return context.json({ error: cause instanceof HttpInputError ? cause.code : "invalid-request" }, 400);
    }
  }
  const parsed = shutdownInputSchema.safeParse(body);
  if (!parsed.success) return context.json({ error: "invalid-request" }, 400);
  const input = parsed.data;

  if (input.force) {
    void finishShutdown({ interrupted: true });
    return context.json({ ok: true as const, accepted: true });
  }
  const hasIdentity = input.instanceId !== undefined || input.drainId !== undefined || input.readinessRevision !== undefined;
  if (!hasIdentity) {
    void finishShutdown({ interrupted: false });
    return context.json({ ok: true as const, accepted: true });
  }
  const commitResult = await lifecycle.commit({ instanceId: input.instanceId, drainId: input.drainId, readinessRevision: input.readinessRevision });
  if (!commitResult.committed) return context.json({ ok: false as const, error: commitResult.reason }, 409);
  void finishShutdown({ interrupted: false, alreadyCommitted: true });
  return context.json({ ok: true as const, accepted: true });
});
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
app.route("/", createGitRoutes(workspaceService, gitService, workspaceEvents, commitGenerator, (workspaceId, agentId) => agentService.getCommitConversation(workspaceId, agentId)));
app.route("/", createFileRoutes(fileService, workspaceEvents));
app.route("/", createWorktreeRoutes(worktreeService, { onRemoveWorkspace: (workspaceId) => teardownWorkspace(workspaceId) }, workspaceEvents));
app.route("/", createWorkspaceActionRoutes(workspaceActionsService));
app.route("/", createTerminalRoutes(terminalManager));
app.route("/", createPreviewRoutes(previewManager, workspaceEvents, { serverPort: port }));
app.route("/", createPushRoutes(pushService));
app.route("/", createAgentRoutes(agentService));
app.route("/", createModelRoutes());
app.route("/", createTranscriptPreviewRoutes());

function protocolError(requestId: string, code: string, message: string): ProtocolError {
  return { version: PROTOCOL_VERSION, requestId, ok: false, error: { code, message } };
}

type SocketData =
  | { kind: "agent"; subscriptions: Map<string, () => boolean>; workspaceSubscriptions: Map<string, () => boolean>; daemonUnsubscribe?: () => boolean }
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
  // A disconnected (or portless) preview may still have a live agent-browser
  // session; reattach to it so a suspended client resumes at the newest frame.
  let streamPort = previewManager.streamPortFor(previewId);
  if (streamPort === null) {
    const reattached = await previewManager.rediscover(previewId);
    if (!reattached) {
      previewLog.warn("Preview could not be rediscovered", { event: "preview.rediscover_failed" });
      sendPreviewError(socket, "Preview is not running");
      socket.close(1011, "preview is not running");
      return;
    }
    streamPort = previewManager.streamPortFor(previewId);
  }
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

/** `subscribe`/`unsubscribe` to daemon lifecycle invalidations. There is
 *  only ever one subject (`DAEMON_SNAPSHOT_SUBJECT`), so unlike `pi`/
 *  `workspace` this needs no per-subject map -- one optional unsubscribe
 *  per socket is enough. */
async function handleDaemonCommand(command: CommandEnvelope, socket: Bun.ServerWebSocket<SocketData>): Promise<ProtocolResponse> {
  if (socket.data.kind !== "agent") return protocolError(command.requestId, "invalid-channel", "Terminal/preview sockets do not accept daemon commands");
  try {
    if (command.type === "subscribe") {
      const input = daemonSubscriptionPayloadSchema.parse(command.payload);
      socket.data.daemonUnsubscribe?.();
      const subscription = daemonEvents.subscribe(input.afterSequence, (event) => sendSocketJson(socket, event));
      socket.data.daemonUnsubscribe = subscription.unsubscribe;
      if (subscription.replay.kind === "replay") {
        for (const event of subscription.replay.events) sendSocketJson(socket, event);
      } else {
        sendSocketJson(socket, {
          version: PROTOCOL_VERSION,
          stream: "daemon",
          subjectId: DAEMON_SNAPSHOT_SUBJECT,
          kind: "snapshot-required",
          metadata: {
            snapshotUrl: "/api/daemon/snapshot",
            sequence: String(daemonEvents.currentSequence()),
          },
        });
      }
      subscription.activate();
    } else if (command.type === "unsubscribe") {
      socket.data.daemonUnsubscribe?.();
      socket.data.daemonUnsubscribe = undefined;
    } else {
      return protocolError(command.requestId, "unsupported-command", "Command is not implemented");
    }
  } catch (cause) {
    const message = cause instanceof Error ? cause.message.slice(0, 512) : "Daemon command failed";
    return protocolError(command.requestId, "daemon-command-failed", message);
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
  if (command.channel === "daemon") {
    return handleDaemonCommand(command, socket);
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
    // Preserve AgentError's stable code (in particular "draining", so a
    // drained daemon refuses new agent work identically over HTTP and WS)
    // instead of collapsing every failure into one generic code.
    const code = cause instanceof AgentError ? `agent-${cause.code}` : "agent-command-failed";
    return protocolError(command.requestId, code, message);
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
    "/index.html": homepage,
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
        socket.data.daemonUnsubscribe?.();
        socket.data.daemonUnsubscribe = undefined;
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

// Teardown order: (1) admission is already
// sealed by this point (lifecycle phase is draining/ready/stopping, which
// closes AgentService.admissionGate); (2) stop Pi children while SQLite is
// still open, so final diagnostics/status persist; (3) clean up remaining
// owned resources, aggregating failures instead of abandoning later owners
// after the first error; (4) dispose event hubs, stop HTTP/WS, close
// SQLite only after callbacks that use them have finished; (5) remove this
// daemon's PID/port artifacts last. Shutdown stops processes but does not
// archive agent records, remove canvas tabs, delete history, or move
// session files.
let teardownRan = false;
async function teardown(options: { interrupted: boolean }): Promise<void> {
  if (teardownRan) return;
  teardownRan = true;
  log.info("Passage shutdown started", { event: "daemon.shutdown_started", interrupted: options.interrupted });

  try {
    await agentService.shutdown({ interrupted: options.interrupted });
  } catch (error) {
    log.warn("Agent shutdown failed", { event: "daemon.shutdown_agents_failed", ...errorFields(error) });
  }

  const cleanupResults = await Promise.allSettled([
    previewManager.shutdown(),
  ]);
  for (const result of cleanupResults) {
    if (result.status === "rejected") {
      log.warn("Shutdown cleanup step failed", { event: "daemon.shutdown_cleanup_failed", ...errorFields(result.reason) });
    }
  }

  agentEvents.dispose();
  workspaceEvents.dispose();
  daemonEvents.dispose();
  // `server.stop(true)` force-closes active connections immediately,
  // including the socket carrying this very shutdown request's own
  // response. A brief pause lets that response actually reach the caller
  // first; the caller must still treat a dropped connection as inconclusive
  // and verify independently, not as proof either way.
  await new Promise((resolve) => setTimeout(resolve, 100));
  await server.stop(true);
  metadata.close();

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
  log.info("Passage shutdown completed", { event: "daemon.shutdown_completed", interrupted: options.interrupted });
}

// The daemon's one shutdown path, safe by default. Duplicate calls (repeated HTTP requests, a signal arriving
// while another is already in flight) share this same in-flight promise
// instead of racing a second teardown. A safe (non-force,
// non-already-committed) attempt that gets cancelled -- the drain was
// cancelled, or superseded by a fresh one -- leaves the daemon running and
// clears the in-flight promise so a later call can try again. A safe
// attempt that instead runs past PASSAGE_SHUTDOWN_TIMEOUT_MINUTES escalates
// to an explicit forced stop rather than waiting forever.
let finishShutdownPromise: Promise<void> | undefined;
function finishShutdown(options: { interrupted: boolean; alreadyCommitted?: boolean }): Promise<void> {
  if (finishShutdownPromise) return finishShutdownPromise;
  finishShutdownPromise = (async () => {
    let interrupted = options.interrupted;
    try {
      if (interrupted) {
        lifecycle.forceStop();
      } else if (!options.alreadyCommitted) {
        const result = await runSafeShutdown(lifecycle, { timeoutMs: shutdownTimeoutMs });
        if (!result.committed) {
          if (result.reason === "timeout") {
            log.warn("Safe shutdown timed out waiting for an idle boundary; escalating to a forced stop", {
              event: "daemon.shutdown_timeout_forced",
              timeoutMinutes: shutdownTimeoutMs / 60_000,
            });
            lifecycle.forceStop();
            interrupted = true;
          } else {
            log.warn("Safe shutdown was cancelled before commit; daemon remains running", { event: "daemon.shutdown_cancelled", reason: result.reason });
            return;
          }
        }
      }
      await teardown({ interrupted });
      process.exit(0);
    } finally {
      finishShutdownPromise = undefined;
    }
  })();
  return finishShutdownPromise;
}

// Safe by default; a second signal while the first is still waiting on an
// idle boundary forces an immediate, clearly-labeled interruption instead
// of falling through to Node/Bun's raw, teardown-skipping default handler.
for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, () => {
    void finishShutdown({ interrupted: false });
    process.once(signal, () => { void finishShutdown({ interrupted: true }); });
  });
}
