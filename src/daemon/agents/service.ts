import { mkdir, realpath } from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { agentCapabilitiesSchema, type AgentHistory, type AgentStatus } from "../../shared/domain/agents.ts";
import { getSlashCommands } from "./slash-commands.ts";
import { agentImageSchema, type AgentImage } from "../../shared/protocol/agents.ts";
import { pageHistory, readPiHistory, type HistoryPage } from "./history/index.ts";
import {
  PiRpcManager,
  responseData,
  type PiEvent,
  type PiExtensionUiResponse,
  type PiLifecycleEvent,
  type PiRpcOptions,
  type PiRpcProcess,
} from "./rpc/index.ts";
import { MetadataRepositories, type Agent } from "../metadata/repositories.ts";
import { normalizeAvailableModels } from "../models/catalog.ts";
import { parsePiExtensionUiDialog } from "./ui.ts";
import { errorFields, logger } from "../logging.ts";

const MAX_LIST = 100;
const MAX_LISTENERS = 64;
const MAX_MESSAGE_BYTES = 64 * 1024;
const MAX_SHORT_VALUE_LENGTH = 256;
const MAX_RUNTIME_DIAGNOSTICS = 100;
const DEFAULT_ABORT_TIMEOUT_MS = 30_000;
const ID = /^[A-Za-z0-9_-]{1,128}$/;
const encoder = new TextEncoder();

type RuntimeSubscription = {
  generation: number;
  unsubscribeEvents: () => boolean;
  unsubscribeLifecycle: () => boolean;
};

type RuntimeDiagnostic = {
  generation: number;
  exitStatus: string;
  stderr: string[];
  stderrTruncated: boolean;
};

type Cancellation = {
  process: PiRpcProcess;
  generation: number;
};

export type AgentCapabilities = ReturnType<typeof agentCapabilitiesSchema.parse>;

export type AgentSnapshot = Agent & {
  live: boolean;
  persisted: boolean;
  generation?: number;
  stderr?: string[];
  stderrTruncated?: boolean;
  exitStatus?: string;
  pendingUiRequest?: Record<string, unknown>;
};

export type AgentServiceEvent = {
  agentId: string;
  type: "status" | "settled" | "attention" | string;
  status: AgentStatus;
  generation?: number;
  error?: string;
  payload?: Record<string, unknown>;
};

export type AgentHistoryResult = HistoryPage | { unpersisted: true; history: null };

export class AgentError extends Error {
  constructor(readonly code: "not-found" | "archived" | "not-running" | "invalid-input" | "limit", message: string) {
    super(message);
    this.name = "AgentError";
  }
}

export class AgentService {
  private readonly listeners = new Set<(event: AgentServiceEvent) => void>();
  private readonly subscriptions = new Map<string, RuntimeSubscription>();
  private readonly previousRevisions = new Map<string, AgentHistory["revision"]>();
  private readonly leaves = new Map<string, string>();
  private readonly diagnostics = new Map<string, RuntimeDiagnostic>();
  private readonly pendingUiRequests = new Map<string, Record<string, unknown>>();
  private readonly cancellations = new Map<string, Cancellation>();
  private readonly eventChains = new Map<string, Promise<void>>();
  private readonly manager: PiRpcManager;
  private readonly listLimit: number;
  private readonly pi: Omit<PiRpcOptions, "cwd" | "sessionDir" | "sessionId">;
  private readonly sessionsRoot: string;
  private readonly abortTimeoutMs: number;

  constructor(
    private readonly repositories: MetadataRepositories,
    options: {
      sessionsRoot: string;
      manager?: PiRpcManager;
      listLimit?: number;
      abortTimeoutMs?: number;
      pi?: Omit<PiRpcOptions, "cwd" | "sessionDir" | "sessionId">;
    },
  ) {
    if (!options.sessionsRoot) throw new AgentError("invalid-input", "sessionsRoot is required");
    if (options.listLimit !== undefined && (!Number.isSafeInteger(options.listLimit) || options.listLimit < 1 || options.listLimit > MAX_LIST)) {
      throw new AgentError("invalid-input", "invalid list limit");
    }
    if (options.abortTimeoutMs !== undefined && (!Number.isSafeInteger(options.abortTimeoutMs) || options.abortTimeoutMs < 1)) {
      throw new AgentError("invalid-input", "invalid abort timeout");
    }
    this.manager = options.manager ?? new PiRpcManager();
    this.listLimit = options.listLimit ?? MAX_LIST;
    this.pi = options.pi ?? {};
    this.sessionsRoot = resolve(options.sessionsRoot);
    this.abortTimeoutMs = options.abortTimeoutMs ?? DEFAULT_ABORT_TIMEOUT_MS;
  }

  subscribe(listener: (event: AgentServiceEvent) => void): () => boolean {
    if (this.listeners.size >= MAX_LISTENERS) throw new AgentError("limit", "maximum agent listeners reached");
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  snapshot(agentId: string): AgentSnapshot {
    const agent = this.requireAgent(agentId);
    const process = this.manager.get(agentId);
    const diagnostic = this.diagnostics.get(agentId);
    const pendingUiRequest = agent.lastKnownStatus === "stopping"
      ? undefined
      : (() => {
          const pending = process?.getPendingUiRequest();
          return pending ? parsePiExtensionUiDialog(pending) : undefined;
        })() ?? this.pendingUiRequests.get(agentId);
    const lastKnownStatus = pendingUiRequest ? "needs-attention" : agent.lastKnownStatus;
    return {
      ...agent,
      lastKnownStatus,
      live: process !== undefined,
      persisted: agent.piSessionPath !== null,
      ...(pendingUiRequest ? { pendingUiRequest } : {}),
      ...(process ? {
        generation: process.generation,
        stderr: [...process.stderr],
        stderrTruncated: process.stderrTruncated,
      } : diagnostic),
    };
  }

  list(workspaceId: string, limit = this.listLimit): AgentSnapshot[] {
    this.requireWorkspace(workspaceId);
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > this.listLimit) throw new AgentError("invalid-input", "invalid list limit");
    return this.repositories.agents.listForWorkspace(workspaceId, limit).map((agent) => ({
      ...agent,
      live: this.manager.get(agent.id) !== undefined,
      persisted: agent.piSessionPath !== null,
    }));
  }

  async create(workspaceId: string, title = "Agent"): Promise<AgentSnapshot> {
    this.validateShortValue(title, "title");
    this.requireWorkspace(workspaceId);
    const agent: Agent = {
      id: `agt_${crypto.randomUUID()}`,
      workspaceId,
      piSessionId: `pi_${crypto.randomUUID()}`,
      piSessionPath: null,
      title,
      titleOverridden: title !== "Agent",
      modelPreference: null,
      thinkingPreference: null,
      lastKnownStatus: "initializing",
      archivedAt: null,
    };
    this.repositories.agents.save(agent);
    await this.start(agent.id);
    return this.snapshot(agent.id);
  }

  async start(agentId: string): Promise<void> {
    const agent = this.requireAgent(agentId);
    if (agent.lastKnownStatus === "stopping") {
      if (this.cancellations.has(agentId)) throw new AgentError("invalid-input", "agent cancellation is in progress");
      this.updateStatus(agentId, "initializing", "status");
    }
    const workspace = this.requireWorkspace(agent.workspaceId);
    const sessionDir = this.sessionDirectory(agent.id);
    try {
      await mkdir(sessionDir, { recursive: true });
      const process = await this.manager.start(agent.id, {
        ...this.pi,
        cwd: workspace.cwd,
        sessionDir,
        sessionId: agent.piSessionId,
      });
      this.diagnostics.delete(agent.id);
      this.attach(agent.id, process);
      await this.reconcile(agent.id);
    } catch (cause) {
      const error = cause instanceof Error ? cause.message : String(cause);
      logger("agent").error("Agent could not start", { event: "agent.start_failed", agentId: agent.id, ...errorFields(cause) });
      this.updateStatus(agent.id, "error", "attention", undefined, error);
    }
  }

  async prompt(agentId: string, text: string, images?: AgentImage[]): Promise<void> {
    this.validateMessage(text);
    const agent = this.requireAgent(agentId);
    this.rejectWhileStopping(agent);
    if (agent.lastKnownStatus === "running") {
      throw new AgentError("invalid-input", "agent is active; use steer or follow-up, or wait for cancellation");
    }
    const validatedImages = images?.map((image) => agentImageSchema.parse(image));
    const process = await this.ensureProcess(agentId);
    this.updateStatus(agentId, "running", "status", process.generation);
    try {
      await process.request({ type: "prompt", message: text, ...(validatedImages?.length ? { images: validatedImages } : {}) });
    } catch (cause) {
      logger("agent").error("Agent prompt failed", { event: "agent.prompt_failed", agentId, generation: process.generation, ...errorFields(cause) });
      this.updateStatus(agentId, "error", "attention", process.generation, String(cause));
      throw cause;
    }
  }

  async steer(agentId: string, text: string, images?: AgentImage[]): Promise<void> {
    this.validateMessage(text);
    this.rejectWhileStopping(this.requireAgent(agentId));
    const validatedImages = images?.map((image) => agentImageSchema.parse(image));
    const process = await this.ensureProcess(agentId);
    await process.request({ type: "steer", message: text, ...(validatedImages?.length ? { images: validatedImages } : {}) });
  }

  async followUp(agentId: string, text: string, images?: AgentImage[]): Promise<void> {
    this.validateMessage(text);
    this.rejectWhileStopping(this.requireAgent(agentId));
    const validatedImages = images?.map((image) => agentImageSchema.parse(image));
    const process = await this.ensureProcess(agentId);
    await process.request({ type: "follow_up", message: text, ...(validatedImages?.length ? { images: validatedImages } : {}) });
  }

  async abort(agentId: string): Promise<void> {
    this.pendingUiRequests.delete(agentId);
    const agent = this.requireAgent(agentId);
    const process = this.manager.get(agentId);
    if (!process) {
      if (agent.lastKnownStatus === "running" || agent.lastKnownStatus === "stopping") {
        this.updateStatus(agentId, "error", "attention", undefined, "Pi process is not running");
      }
      return;
    }
    if (agent.lastKnownStatus === "stopping" && this.cancellations.has(agentId)) return;
    const cancellation = { process, generation: process.generation };
    this.cancellations.set(agentId, cancellation);
    this.updateStatus(agentId, "stopping", "status", process.generation);
    void this.completeAbort(agentId, cancellation);
  }

  async respondExtensionUi(agentId: string, response: PiExtensionUiResponse): Promise<void> {
    this.rejectWhileStopping(this.requireAgent(agentId));
    const process = this.requireProcess(agentId);
    process.respondExtensionUi(response);
    this.pendingUiRequests.delete(agentId);
    this.updateStatus(agentId, "running", "status", process.generation);
  }

  async capabilities(agentId: string): Promise<AgentCapabilities> {
    const process = await this.ensureProcess(agentId);
    const [modelsResponse, thinkingResponse] = await Promise.all([
      process.request({ type: "get_available_models" }),
      process.request({ type: "get_available_thinking_levels" }),
    ]);
    const modelsData = responseData<{ models?: unknown[] }>(modelsResponse);
    const thinkingData = responseData<{ levels?: unknown[] }>(thinkingResponse);
    const models = normalizeAvailableModels(modelsData);
    const thinkingLevels = (thinkingData?.levels ?? [])
      .filter((value): value is string => typeof value === "string")
      .slice(0, 16);
    // All workspaces are untrusted until an explicit persisted trust decision
    // exists (see slash-commands.ts): Pi built-ins only, no skill entries.
    return agentCapabilitiesSchema.parse({ models, thinkingLevels, slashCommands: getSlashCommands(), skillsAvailable: false });
  }

  async compact(agentId: string, customInstructions?: string): Promise<void> {
    if (customInstructions !== undefined) this.validateShortValue(customInstructions, "instructions");
    this.rejectWhileStopping(this.requireAgent(agentId));
    const process = await this.ensureProcess(agentId);
    await process.request(customInstructions ? { type: "compact", customInstructions } : { type: "compact" });
  }

  async model(agentId: string, provider: string, modelId: string): Promise<void> {
    this.validateShortValue(provider, "provider");
    this.validateShortValue(modelId, "model");
    this.rejectWhileStopping(this.requireAgent(agentId));
    const capabilities = await this.capabilities(agentId);
    if (!capabilities.models.some((model) => model.provider === provider && model.id === modelId)) {
      throw new AgentError("invalid-input", "model is unavailable");
    }
    const process = await this.ensureProcess(agentId);
    await process.request({ type: "set_model", provider, modelId });
    this.repositories.agents.updateModelPreference(agentId, `${provider}/${modelId}`);
  }

  async thinking(agentId: string, level: string): Promise<void> {
    this.validateShortValue(level, "thinking level");
    this.rejectWhileStopping(this.requireAgent(agentId));
    const capabilities = await this.capabilities(agentId);
    if (!capabilities.thinkingLevels.includes(level)) {
      throw new AgentError("invalid-input", "thinking level is unavailable");
    }
    const process = await this.ensureProcess(agentId);
    await process.request({ type: "set_thinking_level", level });
    this.repositories.agents.updateThinkingPreference(agentId, level);
  }

  async history(agentId: string, before?: number, limit = 100): Promise<AgentHistoryResult> {
    let agent = this.requireAgent(agentId);
    if (!agent.piSessionPath) {
      await this.reconcile(agentId, !this.cancellations.has(agentId));
      agent = this.requireAgent(agentId);
    }
    if (!agent.piSessionPath) return { unpersisted: true, history: null };
    const history = await readPiHistory(agent.piSessionPath, {
      previousRevision: this.previousRevisions.get(agentId),
      leafId: this.leaves.get(agentId),
    });
    this.rememberRevision(agentId, history.revision);
    return pageHistory(history, before, limit);
  }

  async archive(agentId: string): Promise<void> {
    const agent = this.repositories.agents.get(agentId);
    if (!agent) throw new AgentError("not-found", "agent not found");
    this.detach(agentId);
    await this.manager.stop(agentId);
    const archivedAt = new Date().toISOString();
    this.repositories.agents.archive(agentId, archivedAt);
    this.repositories.agents.updateStatus(agentId, "archived");
    this.previousRevisions.delete(agentId);
    this.leaves.delete(agentId);
    this.diagnostics.delete(agentId);
    this.emit({ agentId, type: "status", status: "archived" });
  }

  async stop(agentId: string): Promise<void> {
    this.requireAgent(agentId);
    this.detach(agentId);
    await this.manager.stop(agentId);
  }

  async shutdown(): Promise<void> {
    for (const agentId of this.subscriptions.keys()) this.detach(agentId);
    this.listeners.clear();
    this.previousRevisions.clear();
    this.leaves.clear();
    this.diagnostics.clear();
    this.eventChains.clear();
    await this.manager.shutdown();
  }

  private attach(agentId: string, process: PiRpcProcess): void {
    const current = this.subscriptions.get(agentId);
    if (current?.generation === process.generation) return;
    this.detach(agentId);
    this.subscriptions.set(agentId, {
      generation: process.generation,
      unsubscribeEvents: process.subscribe((event) => this.enqueueEvent(agentId, event)),
      unsubscribeLifecycle: process.subscribeLifecycle((event) => this.enqueueLifecycle(agentId, event)),
    });
  }

  private detach(agentId: string): void {
    this.pendingUiRequests.delete(agentId);
    const subscription = this.subscriptions.get(agentId);
    if (!subscription) return;
    subscription.unsubscribeEvents();
    subscription.unsubscribeLifecycle();
    this.subscriptions.delete(agentId);
  }

  private enqueueEvent(agentId: string, event: PiEvent): void {
    this.enqueue(agentId, () => this.onEvent(agentId, event));
  }

  private enqueueLifecycle(agentId: string, event: PiLifecycleEvent): void {
    this.enqueue(agentId, async () => this.onLifecycle(agentId, event));
  }

  private enqueue(agentId: string, operation: () => Promise<void>): Promise<void> {
    const previous = this.eventChains.get(agentId) ?? Promise.resolve();
    const next = previous.catch(() => undefined).then(operation);
    this.eventChains.set(agentId, next);
    while (this.eventChains.size > MAX_LIST) this.eventChains.delete(this.eventChains.keys().next().value!);
    void next.catch(() => {
      const process = this.manager.get(agentId);
      this.updateStatus(agentId, "error", "attention", process?.generation, "Agent event reconciliation failed");
    }).finally(() => {
      if (this.eventChains.get(agentId) === next) this.eventChains.delete(agentId);
    });
    return next;
  }

  private sanitizeEventPayload(value: unknown): unknown {
    if (value === null || typeof value !== "object") return value;
    if (Array.isArray(value)) {
      return value.map((item) => this.sanitizeEventPayload(item));
    }
    const record = value as Record<string, unknown>;
    if (record.type === "image" && typeof record.data === "string" && typeof record.mimeType === "string") {
      return { type: "image", mimeType: record.mimeType };
    }
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(record)) {
      out[k] = this.sanitizeEventPayload(v);
    }
    return out;
  }

  private async onEvent(agentId: string, event: PiEvent): Promise<void> {
    if (this.subscriptions.get(agentId)?.generation !== event.generation) return;
    const agent = this.repositories.agents.get(agentId);
    if (!agent) return;

    if (!agent.piSessionPath) {
      await this.reconcile(agentId);
    }

    const currentStatus = (this.repositories.agents.get(agentId)?.lastKnownStatus as AgentStatus) ?? "running";
    const rawPayload: Record<string, unknown> = {};
    if (event.id !== undefined) rawPayload.id = event.id;
    if (event.method !== undefined) rawPayload.method = event.method;
    if (event.title !== undefined) rawPayload.title = event.title;
    if (event.options !== undefined) rawPayload.options = event.options;
    if (event.placeholder !== undefined) rawPayload.placeholder = event.placeholder;
    if (event.prefill !== undefined) rawPayload.prefill = event.prefill;
    if (event.timeout !== undefined) rawPayload.timeout = event.timeout;
    if (event.questions !== undefined) rawPayload.questions = event.questions;
    if (event.statusKey !== undefined) rawPayload.statusKey = event.statusKey;
    if (event.statusText !== undefined) rawPayload.statusText = event.statusText;
    if (event.widgetKey !== undefined) rawPayload.widgetKey = event.widgetKey;
    if (event.widgetLines !== undefined) rawPayload.widgetLines = event.widgetLines;
    if (event.message !== undefined) rawPayload.message = event.message;
    if (event.assistantMessageEvent !== undefined) rawPayload.assistantMessageEvent = event.assistantMessageEvent;
    if (event.toolCallId !== undefined) rawPayload.toolCallId = event.toolCallId;
    if (event.toolName !== undefined) rawPayload.toolName = event.toolName;
    if (event.args !== undefined) rawPayload.args = event.args;
    if (event.result !== undefined) rawPayload.result = event.result;
    if (event.partialResult !== undefined) rawPayload.partialResult = event.partialResult;
    if (event.isError !== undefined) rawPayload.isError = event.isError;
    if (event.usage !== undefined) rawPayload.usage = event.usage;
    if (event.level !== undefined) rawPayload.level = event.level;
    if (event.delta !== undefined) rawPayload.delta = event.delta;
    if (event.text !== undefined) rawPayload.text = event.text;
    if (event.content !== undefined) rawPayload.content = event.content;
    if (event.thinking !== undefined) rawPayload.thinking = event.thinking;

    const payload = this.sanitizeEventPayload(rawPayload) as Record<string, unknown>;

    if (event.type === "agent_settled") {
      this.pendingUiRequests.delete(agentId);
      await this.reconcile(agentId);
      const status = this.requireAgent(agentId).lastKnownStatus as AgentStatus;
      this.emit({ agentId, type: "settled", status, generation: event.generation, payload });
    } else if (currentStatus === "stopping") {
      this.emit({ agentId, type: String(event.type ?? "event"), status: currentStatus, generation: event.generation, payload });
    } else if (event.type === "agent_start" || event.type === "turn_start") {
      this.updateStatus(agentId, "running", "status", event.generation, undefined, payload);
    } else {
      const dialog = parsePiExtensionUiDialog(event);
      if (dialog) {
        this.pendingUiRequests.set(agentId, dialog);
        this.updateStatus(agentId, "needs-attention", "attention", event.generation, undefined, dialog);
      } else if (["error", "prompt_error", "extension_error"].includes(String(event.type))) {
        this.updateStatus(agentId, "error", "attention", event.generation, undefined, payload);
      } else {
        if (event.type === "thinking_level_changed" && typeof event.level === "string") {
          this.repositories.agents.updateThinkingPreference(agentId, event.level);
        }
        this.emit({ agentId, type: String(event.type ?? "event"), status: currentStatus, generation: event.generation, payload });
      }
    }
  }

  private async onLifecycle(agentId: string, event: PiLifecycleEvent): Promise<void> {
    if (this.subscriptions.get(agentId)?.generation !== event.generation) return;
    this.diagnostics.set(agentId, {
      generation: event.generation,
      exitStatus: `${event.lifecycle} (${event.exitCode})`,
      stderr: [...event.stderr],
      stderrTruncated: event.stderrTruncated,
    });
    while (this.diagnostics.size > MAX_RUNTIME_DIAGNOSTICS) this.diagnostics.delete(this.diagnostics.keys().next().value!);
    logger("agent").error("Agent Pi process ended", { event: "agent.process_ended", agentId, generation: event.generation, exitStatus: `${event.lifecycle} (${event.exitCode})`, exitCode: event.exitCode, stderrBytes: event.stderr.reduce((total, part) => total + encoder.encode(part).byteLength, 0), stderrTruncated: event.stderrTruncated });
    this.detach(agentId);
    this.updateStatus(agentId, "error", "attention", event.generation, `Pi process exited (${event.exitCode})`);
  }

  private async completeAbort(agentId: string, cancellation: Cancellation): Promise<void> {
    const { process, generation } = cancellation;
    try {
      const clearQueue = process.request({ type: "clear_queue" }, this.abortTimeoutMs);
      const abort = process.request({ type: "abort" }, this.abortTimeoutMs);
      await Promise.all([clearQueue, abort]);
      if (this.manager.get(agentId) !== process || process.generation !== generation) return;
      await this.enqueue(agentId, () => this.reconcile(agentId, true));
    } catch (cause) {
      if (this.manager.get(agentId) !== process || process.generation !== generation) return;
      if (this.requireAgent(agentId).lastKnownStatus === "idle") return;
      const message = cause instanceof Error ? cause.message : "Unable to confirm agent cancellation";
      await this.manager.stop(agentId).catch(() => undefined);
      this.updateStatus(agentId, "error", "attention", generation, `Unable to confirm agent cancellation: ${message}`);
    } finally {
      if (this.cancellations.get(agentId) === cancellation) this.cancellations.delete(agentId);
    }
  }

  private async reconcile(agentId: string, allowStoppingToSettle = false): Promise<void> {
    const process = this.manager.get(agentId);
    if (!process) {
      this.updateStatus(agentId, "error", "attention", undefined, "Pi process is not running");
      return;
    }
    const [stateRecord, entriesRecord] = await Promise.all([
      process.request({ type: "get_state" }).catch(() => undefined),
      process.request({ type: "get_entries" }).catch(() => undefined),
    ]);
    if (!stateRecord || !entriesRecord) {
      this.updateStatus(agentId, "error", "attention", process.generation, "Unable to read Pi state");
      return;
    }
    const data = (responseData<Record<string, unknown>>(stateRecord) ?? stateRecord) as Record<string, unknown>;
    const entries = responseData<{ leafId?: unknown }>(entriesRecord);
    if (typeof entries?.leafId === "string") {
      this.remember(this.leaves, agentId, entries.leafId);
    }
    const sessionPath = typeof data.sessionFile === "string"
      ? data.sessionFile
      : typeof data.sessionPath === "string"
        ? data.sessionPath
        : undefined;
    if (sessionPath) {
      let canonical: string;
      try {
        canonical = await realpath(sessionPath);
      } catch {
        canonical = "";
      }
      if (canonical) {
        const directory = await realpath(this.sessionDirectory(agentId));
        const pathFromDirectory = relative(directory, canonical);
        const escapes = pathFromDirectory === ".." || pathFromDirectory.startsWith(`..${sep}`) || isAbsolute(pathFromDirectory);
        if (!escapes) this.repositories.agents.updateSessionPath(agentId, canonical);
        else {
          this.updateStatus(agentId, "error", "attention", process.generation, "Pi session path is outside its session directory");
          return;
        }
      }
    }
    const agent = this.requireAgent(agentId);
    const stateModel = data.model && typeof data.model === "object" ? data.model as Record<string, unknown> : undefined;
    if (stateModel && typeof stateModel.provider === "string" && typeof stateModel.id === "string") {
      if (!agent.modelPreference) {
        this.repositories.agents.updateModelPreference(agentId, `${stateModel.provider}/${stateModel.id}`);
      }
    }
    if (typeof data.thinkingLevel === "string" && !agent.thinkingPreference) {
      this.repositories.agents.updateThinkingPreference(agentId, data.thinkingLevel);
    }
    if (!agent.piSessionPath && !sessionPath) {
      const currentStatus = this.requireAgent(agentId).lastKnownStatus as AgentStatus;
      const status = data.isStreaming === true
        ? currentStatus === "stopping" ? "stopping" : "running"
        : currentStatus === "initializing" ? "initializing" : currentStatus === "stopping" && !allowStoppingToSettle ? "stopping" : "idle";
      this.updateStatus(agentId, status, "status", process.generation);
      return;
    }
    const persistedPath = this.repositories.agents.get(agentId)?.piSessionPath;
    if (!persistedPath) {
      const currentStatus = this.requireAgent(agentId).lastKnownStatus as AgentStatus;
      const status = data.isStreaming === true
        ? currentStatus === "stopping" ? "stopping" : "running"
        : currentStatus === "initializing" ? "initializing" : currentStatus === "stopping" && !allowStoppingToSettle ? "stopping" : "idle";
      this.updateStatus(agentId, status, "status", process.generation);
      return;
    }
    try {
      const history = await readPiHistory(persistedPath, {
        previousRevision: this.previousRevisions.get(agentId),
        leafId: this.leaves.get(agentId),
      });
      this.rememberRevision(agentId, history.revision);
      const latestItem = history.timeline.at(-1);
      const hasActiveError = latestItem && "error" in latestItem && Boolean(latestItem.error);
      const currentStatus = this.requireAgent(agentId).lastKnownStatus as AgentStatus;
      if (currentStatus === "needs-attention") return;
      if (currentStatus === "stopping" && !allowStoppingToSettle) return;
      const confirmedCancellation = allowStoppingToSettle && currentStatus === "stopping" && data.isStreaming === false;
      if (hasActiveError && data.isStreaming !== true && !confirmedCancellation) {
        this.updateStatus(agentId, "error", "attention", process.generation, String(latestItem.error));
        return;
      }
    } catch (cause) {
      logger("agent").error("Agent history reconciliation failed", { event: "agent.reconcile_failed", agentId, generation: process.generation, ...errorFields(cause) });
      this.updateStatus(agentId, "error", "attention", process.generation, "Unable to reconcile Pi session history");
      return;
    }
    const currentStatus = this.requireAgent(agentId).lastKnownStatus as AgentStatus;
    if (currentStatus === "needs-attention" || (currentStatus === "stopping" && (data.isStreaming === true || !allowStoppingToSettle))) return;
    this.updateStatus(agentId, data.isStreaming === true ? "running" : "idle", "status", process.generation);
  }

  private updateStatus(agentId: string, status: AgentStatus, type: AgentServiceEvent["type"], generation?: number, error?: string, payload?: Record<string, unknown>): void {
    this.repositories.agents.updateStatus(agentId, status);
    this.emit({ agentId, type, status, ...(generation ? { generation } : {}), ...(error ? { error } : {}), ...(payload ? { payload } : {}) });
  }

  private emit(event: AgentServiceEvent): void {
    for (const listener of this.listeners) {
      try { listener(event); } catch {}
    }
  }

  private requireWorkspace(workspaceId: string) {
    const workspace = this.repositories.workspaces.get(workspaceId);
    if (!workspace) throw new AgentError("not-found", "workspace not found");
    if (workspace.archivedAt) throw new AgentError("archived", "workspace archived");
    return workspace;
  }

  private requireAgent(agentId: string): Agent {
    if (!ID.test(agentId)) throw new AgentError("invalid-input", "invalid agent id");
    const agent = this.repositories.agents.get(agentId);
    if (!agent) throw new AgentError("not-found", "agent not found");
    if (agent.archivedAt) throw new AgentError("archived", "agent archived");
    return agent;
  }

  private rejectWhileStopping(agent: Agent): void {
    if (agent.lastKnownStatus === "stopping") {
      throw new AgentError("invalid-input", "agent cancellation is in progress");
    }
  }

  private async ensureProcess(agentId: string): Promise<PiRpcProcess> {
    this.requireAgent(agentId);
    let process = this.manager.get(agentId);
    if (!process) {
      await this.start(agentId);
      process = this.manager.get(agentId);
    }
    if (!process) throw new AgentError("not-running", "agent process could not be started");
    return process;
  }

  private requireProcess(agentId: string): PiRpcProcess {
    this.requireAgent(agentId);
    const process = this.manager.get(agentId);
    if (!process) throw new AgentError("not-running", "agent process is not running");
    return process;
  }

  private sessionDirectory(agentId: string): string {
    return join(this.sessionsRoot, agentId);
  }

  private validateMessage(value: string): void {
    if (!value || encoder.encode(value).byteLength > MAX_MESSAGE_BYTES) throw new AgentError("invalid-input", "invalid message");
  }

  private validateShortValue(value: string, name: string): void {
    if (!value.trim() || value.length > MAX_SHORT_VALUE_LENGTH) throw new AgentError("invalid-input", `invalid ${name}`);
  }

  private rememberRevision(agentId: string, revision: AgentHistory["revision"]): void {
    this.remember(this.previousRevisions, agentId, revision);
  }

  private remember<T>(entries: Map<string, T>, key: string, value: T): void {
    entries.delete(key);
    entries.set(key, value);
    while (entries.size > MAX_LIST) entries.delete(entries.keys().next().value!);
  }
}
