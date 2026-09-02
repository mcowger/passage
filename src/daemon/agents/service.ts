import { mkdir, realpath } from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { agentCapabilitiesSchema, type AgentHistory, type AgentStatus } from "../../shared/domain/agents.ts";
import { agentImageSchema, type AgentImage } from "../../shared/protocol/agents.ts";
import { pageHistory, readPiHistory, type HistoryPage } from "./history/index.ts";
import {
  PiRpcManager,
  responseData,
  type PiEvent,
  type PiLifecycleEvent,
  type PiRpcOptions,
  type PiRpcProcess,
} from "./rpc/index.ts";
import { MetadataRepositories, type Agent } from "../metadata/repositories.ts";

const MAX_LIST = 100;
const MAX_LISTENERS = 64;
const MAX_MESSAGE_BYTES = 64 * 1024;
const MAX_SHORT_VALUE_LENGTH = 256;
const MAX_RUNTIME_DIAGNOSTICS = 100;
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

export type AgentCapabilities = ReturnType<typeof agentCapabilitiesSchema.parse>;

export type AgentSnapshot = Agent & {
  live: boolean;
  persisted: boolean;
  generation?: number;
  stderr?: string[];
  stderrTruncated?: boolean;
  exitStatus?: string;
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
  private readonly eventChains = new Map<string, Promise<void>>();
  private readonly manager: PiRpcManager;
  private readonly listLimit: number;
  private readonly pi: Omit<PiRpcOptions, "cwd" | "sessionDir" | "sessionId">;
  private readonly sessionsRoot: string;

  constructor(
    private readonly repositories: MetadataRepositories,
    options: {
      sessionsRoot: string;
      manager?: PiRpcManager;
      listLimit?: number;
      pi?: Omit<PiRpcOptions, "cwd" | "sessionDir" | "sessionId">;
    },
  ) {
    if (!options.sessionsRoot) throw new AgentError("invalid-input", "sessionsRoot is required");
    if (options.listLimit !== undefined && (!Number.isSafeInteger(options.listLimit) || options.listLimit < 1 || options.listLimit > MAX_LIST)) {
      throw new AgentError("invalid-input", "invalid list limit");
    }
    this.manager = options.manager ?? new PiRpcManager();
    this.listLimit = options.listLimit ?? MAX_LIST;
    this.pi = options.pi ?? {};
    this.sessionsRoot = resolve(options.sessionsRoot);
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
    return {
      ...agent,
      live: process !== undefined,
      persisted: agent.piSessionPath !== null,
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
      this.updateStatus(agent.id, "error", "attention", undefined, error);
    }
  }

  async prompt(agentId: string, text: string, images?: AgentImage[]): Promise<void> {
    this.validateMessage(text);
    if (this.requireAgent(agentId).lastKnownStatus === "running") {
      throw new AgentError("invalid-input", "agent is running; use steer or follow-up");
    }
    const validatedImages = images?.map((image) => agentImageSchema.parse(image));
    const process = await this.ensureProcess(agentId);
    this.updateStatus(agentId, "running", "status", process.generation);
    try {
      await process.request({ type: "prompt", message: text, ...(validatedImages?.length ? { images: validatedImages } : {}) });
    } catch (cause) {
      this.updateStatus(agentId, "error", "attention", process.generation, String(cause));
      throw cause;
    }
  }

  async steer(agentId: string, text: string, images?: AgentImage[]): Promise<void> {
    this.validateMessage(text);
    const validatedImages = images?.map((image) => agentImageSchema.parse(image));
    const process = await this.ensureProcess(agentId);
    await process.request({ type: "steer", message: text, ...(validatedImages?.length ? { images: validatedImages } : {}) });
  }

  async followUp(agentId: string, text: string, images?: AgentImage[]): Promise<void> {
    this.validateMessage(text);
    const validatedImages = images?.map((image) => agentImageSchema.parse(image));
    const process = await this.ensureProcess(agentId);
    await process.request({ type: "follow_up", message: text, ...(validatedImages?.length ? { images: validatedImages } : {}) });
  }

  async abort(agentId: string): Promise<void> {
    const process = this.manager.get(agentId);
    if (process) await process.request({ type: "abort" });
  }

  async capabilities(agentId: string): Promise<AgentCapabilities> {
    const process = await this.ensureProcess(agentId);
    const [modelsResponse, thinkingResponse] = await Promise.all([
      process.request({ type: "get_available_models" }),
      process.request({ type: "get_available_thinking_levels" }),
    ]);
    const modelsData = responseData<{ models?: unknown[] }>(modelsResponse);
    const thinkingData = responseData<{ levels?: unknown[] }>(thinkingResponse);
    const models = (modelsData?.models ?? []).flatMap((value) => {
      if (value === null || typeof value !== "object" || Array.isArray(value)) return [];
      const record = value as Record<string, unknown>;
      if (typeof record.provider !== "string" || typeof record.id !== "string") return [];
      return [{
        provider: record.provider,
        id: record.id,
        name: typeof record.name === "string" ? record.name : record.id,
        api: typeof record.api === "string" ? record.api : "unknown",
        input: Array.isArray(record.input) ? record.input.filter((item): item is string => typeof item === "string").slice(0, 8) : [],
        authenticated: record.authenticated !== false,
        supportedThinkingLevels: Array.isArray(record.supportedThinkingLevels)
          ? record.supportedThinkingLevels.filter((item): item is string => typeof item === "string").slice(0, 16)
          : [],
      }];
    }).slice(0, 100);
    const thinkingLevels = (thinkingData?.levels ?? [])
      .filter((value): value is string => typeof value === "string")
      .slice(0, 16);
    return agentCapabilitiesSchema.parse({ models, thinkingLevels });
  }

  async model(agentId: string, provider: string, modelId: string): Promise<void> {
    this.validateShortValue(provider, "provider");
    this.validateShortValue(modelId, "model");
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
      await this.reconcile(agentId);
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

  private enqueue(agentId: string, operation: () => Promise<void>): void {
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
  }

  private async onEvent(agentId: string, event: PiEvent): Promise<void> {
    if (this.subscriptions.get(agentId)?.generation !== event.generation) return;
    const agent = this.repositories.agents.get(agentId);
    if (!agent) return;

    if (!agent.piSessionPath) {
      await this.reconcile(agentId);
    }

    const currentStatus = (this.repositories.agents.get(agentId)?.lastKnownStatus as AgentStatus) ?? "running";
    const payload: Record<string, unknown> = {};
    if (event.message !== undefined) payload.message = event.message;
    if (event.assistantMessageEvent !== undefined) payload.assistantMessageEvent = event.assistantMessageEvent;
    if (event.toolCallId !== undefined) payload.toolCallId = event.toolCallId;
    if (event.toolName !== undefined) payload.toolName = event.toolName;
    if (event.args !== undefined) payload.args = event.args;
    if (event.result !== undefined) payload.result = event.result;
    if (event.isError !== undefined) payload.isError = event.isError;
    if (event.usage !== undefined) payload.usage = event.usage;
    if (event.level !== undefined) payload.level = event.level;

    if (event.type === "agent_settled") {
      await this.reconcile(agentId);
      const status = this.requireAgent(agentId).lastKnownStatus as AgentStatus;
      this.emit({ agentId, type: "settled", status, generation: event.generation, payload });
    } else if (event.type === "agent_start" || event.type === "turn_start") {
      this.updateStatus(agentId, "running", "status", event.generation, undefined, payload);
    } else if (["permission_request", "user_input_request", "extension_ui_request"].includes(String(event.type))) {
      this.updateStatus(agentId, "needs-attention", "attention", event.generation, undefined, payload);
    } else if (["error", "prompt_error", "extension_error"].includes(String(event.type))) {
      this.updateStatus(agentId, "error", "attention", event.generation, undefined, payload);
    } else {
      this.emit({ agentId, type: String(event.type ?? "event"), status: currentStatus, generation: event.generation, payload });
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
    this.detach(agentId);
    this.updateStatus(agentId, "error", "attention", event.generation, `Pi process exited (${event.exitCode})`);
  }

  private async reconcile(agentId: string): Promise<void> {
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
    if (!agent.piSessionPath && !sessionPath) {
      this.updateStatus(agentId, "initializing", "status", process.generation);
      return;
    }
    const persistedPath = this.repositories.agents.get(agentId)?.piSessionPath;
    if (!persistedPath) {
      this.updateStatus(agentId, "initializing", "status", process.generation);
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
      if (hasActiveError && data.isStreaming !== true) {
        this.updateStatus(agentId, "error", "attention", process.generation, String(latestItem.error));
        return;
      }
    } catch {
      this.updateStatus(agentId, "error", "attention", process.generation, "Unable to reconcile Pi session history");
      return;
    }
    const currentStatus = this.requireAgent(agentId).lastKnownStatus as AgentStatus;
    if (currentStatus === "needs-attention") return;
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
