import { createHash } from "node:crypto";
import { readFile, readdir, readlink } from "node:fs/promises";
import {
  normalizePreviewUrl,
  previewViewportSchema,
  webPreviewSchema,
  type CreatePreviewInput,
  type PreviewStatus,
  type PreviewViewport,
  type UpdatePreviewInput,
  type WebPreview,
} from "../../shared/domain/previews.ts";
import type { MetadataRepositories } from "../metadata/repositories.ts";
import type { WorkspaceService } from "../workspaces/service.ts";
import type { WorkspaceScriptsService } from "../workspaces/scripts.ts";
import { errorFields, logger } from "../logging.ts";
import { sanitizedSubprocessEnv } from "../env.ts";

export const PREVIEW_SESSION_NAMESPACE = "passage";
export const PREVIEW_SESSION_PREFIX = "pp-";
export const PREVIEW_IDLE_TIMEOUT_MS = 30 * 60 * 1000;
const DEFAULT_VIEWPORT: PreviewViewport = { width: 1280, height: 800, deviceScaleFactor: 1 };
const MAX_STDERR_BYTES = 16 * 1024;
const COMMAND_TIMEOUT_MS = 30_000;

export type PreviewRuntime = {
  status: PreviewStatus;
  currentUrl: string | null;
  streamPort: number | null;
  lastError: string | null;
  leaseHolderId: string | null;
};

export type PortCandidate = {
  port: number;
  confidence: "high" | "uncertain";
  processName: string | null;
  pid: number | null;
  /** Where the candidate came from: `script` = a `paseo.json` service port
   *  (running or declared), `process` = a loopback listener found by
   *  scanning /proc. Clients prefer script ports for preview defaults. */
  source: "script" | "process";
};

export type AgentBrowserRunner = {
  run: (args: string[], options?: { timeoutMs?: number }) => Promise<{ stdout: string; stderr: string; exitCode: number }>;
  version: () => Promise<string | null>;
};

function sessionNameFor(previewId: string): string {
  // Agent-browser derives a Unix socket path from the session name (max 103
  // bytes), so use a short stable hash instead of the raw opaque preview ID.
  const digest = createHash("sha256").update(previewId).digest("hex").slice(0, 16);
  return `${PREVIEW_SESSION_PREFIX}${digest}`;
}

function bounded(value: string, max: number): string {
  return value.length > max ? value.slice(0, max) : value;
}

class RealAgentBrowserRunner implements AgentBrowserRunner {
  constructor(private readonly binary: string) {}
  async version(): Promise<string | null> {
    try {
      const { stdout } = await this.run(["--version"], { timeoutMs: 10_000 });
      return bounded(stdout.trim(), 64) || null;
    } catch {
      return null;
    }
  }
  async run(args: string[], options?: { timeoutMs?: number }): Promise<{ stdout: string; stderr: string; exitCode: number }> {
    const timeoutMs = options?.timeoutMs ?? COMMAND_TIMEOUT_MS;
    const child = Bun.spawn([this.binary, ...args], {
      stdout: "pipe",
      stderr: "pipe",
      env: sanitizedSubprocessEnv({
        AGENT_BROWSER_NAMESPACE: PREVIEW_SESSION_NAMESPACE,
        AGENT_BROWSER_IDLE_TIMEOUT_MS: String(PREVIEW_IDLE_TIMEOUT_MS),
        AGENT_BROWSER_ALLOWED_DOMAINS: "localhost,127.0.0.1,::1",
      }),
    });
    const timeout = setTimeout(() => {
      try {
        if (child.exitCode === null) child.kill();
      } catch {}
    }, timeoutMs);
    try {
      const [stdout, stderr, exitCode] = await Promise.all([
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
        child.exited,
      ]);
      return {
        stdout: stdout.slice(0, 256 * 1024),
        stderr: stderr.slice(-MAX_STDERR_BYTES),
        exitCode,
      };
    } finally {
      clearTimeout(timeout);
    }
  }
}

export function resolveAgentBrowserBinary(): string {
  return process.env.PASSAGE_AGENT_BROWSER_BIN ?? "agent-browser";
}

type PreviewRecord = {
  meta: { id: string; workspaceId: string; label: string; targetUrl: string; viewport: PreviewViewport; createdAt: string; updatedAt: string };
  runtime: PreviewRuntime;
  queue: Promise<void>;
};

const now = () => new Date().toISOString();
const previewId = () => `prv_${crypto.randomUUID()}`;

export class WebPreviewManager {
  private readonly previews = new Map<string, PreviewRecord>();
  private readonly runner: AgentBrowserRunner;
  readonly binary: string;

  constructor(
    private readonly repositories: MetadataRepositories,
    private readonly workspaces: WorkspaceService,
    runner?: AgentBrowserRunner,
    private readonly scripts?: WorkspaceScriptsService,
  ) {
    this.binary = resolveAgentBrowserBinary();
    this.runner = runner ?? new RealAgentBrowserRunner(this.binary);
  }

  /** Load durable preview rows into memory (runtime starts stopped; sessions reattach on open). */
  hydrate(): void {
    // Rows are read lazily per workspace via list(); runtime always starts fresh.
  }

  private recordFor(id: string): PreviewRecord | null {
    const existing = this.previews.get(id);
    if (existing) return existing;
    const row = this.repositories.webPreviews.get(id);
    if (!row) return null;
    const viewport = previewViewportSchema.safeParse(row.viewport).success
      ? previewViewportSchema.parse(row.viewport)
      : DEFAULT_VIEWPORT;
    const record: PreviewRecord = {
      meta: { id: row.id, workspaceId: row.workspaceId, label: row.displayLabel, targetUrl: row.targetUrl, viewport, createdAt: row.createdAt, updatedAt: row.updatedAt },
      runtime: { status: "stopped", currentUrl: null, streamPort: null, lastError: null, leaseHolderId: null },
      queue: Promise.resolve(),
    };
    this.previews.set(id, record);
    return record;
  }

  private snapshot(record: PreviewRecord, leaseRequester?: string): WebPreview {
    return webPreviewSchema.parse({
      id: record.meta.id,
      workspaceId: record.meta.workspaceId,
      label: record.meta.label,
      targetUrl: record.meta.targetUrl,
      viewport: record.meta.viewport,
      status: record.runtime.status,
      currentUrl: record.runtime.currentUrl,
      hasInputLease: leaseRequester ? record.runtime.leaseHolderId === leaseRequester : record.runtime.leaseHolderId !== null,
      createdAt: record.meta.createdAt,
      updatedAt: record.meta.updatedAt,
    });
  }

  private persist(record: PreviewRecord): void {
    this.repositories.webPreviews.save({
      id: record.meta.id,
      workspaceId: record.meta.workspaceId,
      displayLabel: record.meta.label,
      targetUrl: record.meta.targetUrl,
      viewport: record.meta.viewport,
      createdAt: record.meta.createdAt,
      updatedAt: record.meta.updatedAt,
    });
  }

  private serialize<T>(record: PreviewRecord, work: () => Promise<T>): Promise<T> {
    const next = record.queue.then(work, work);
    record.queue = next.then(() => undefined, () => undefined);
    return next;
  }

  list(workspaceId: string, leaseRequester?: string): WebPreview[] {
    const rows = this.repositories.webPreviews.listForWorkspace(workspaceId, 100);
    return rows.map((row) => {
      const record = this.recordFor(row.id);
      if (!record) {
        return webPreviewSchema.parse({
          id: row.id, workspaceId: row.workspaceId, label: row.displayLabel,
          targetUrl: row.targetUrl, viewport: previewViewportSchema.parse(row.viewport),
          status: "stopped" as const, currentUrl: null,
          hasInputLease: false, createdAt: row.createdAt, updatedAt: row.updatedAt,
        });
      }
      return this.snapshot(record, leaseRequester);
    });
  }

  get(previewId: string, leaseRequester?: string): WebPreview | null {
    const record = this.recordFor(previewId);
    return record ? this.snapshot(record, leaseRequester) : null;
  }

  async create(workspaceId: string, input: CreatePreviewInput): Promise<WebPreview> {
    await this.workspaces.resolvePath(workspaceId, ".");
    const targetUrl = normalizePreviewUrl(input.targetUrl);
    const viewport = { ...DEFAULT_VIEWPORT, ...input.viewport };
    previewViewportSchema.parse(viewport);
    const timestamp = now();
    const count = this.repositories.webPreviews.listForWorkspace(workspaceId, 100).length + 1;
    const record: PreviewRecord = {
      meta: {
        id: previewId(),
        workspaceId,
        label: input.label?.trim() || `Preview ${count}`,
        targetUrl,
        viewport,
        createdAt: timestamp,
        updatedAt: timestamp,
      },
      runtime: { status: "stopped", currentUrl: null, streamPort: null, lastError: null, leaseHolderId: null },
      queue: Promise.resolve(),
    };
    this.persist(record);
    this.previews.set(record.meta.id, record);
    return this.snapshot(record);
  }

  async update(id: string, input: UpdatePreviewInput): Promise<WebPreview | null> {
    const record = this.recordFor(id);
    if (!record) return null;
    return this.serialize(record, async () => {
      if (input.label !== undefined) record.meta.label = input.label.trim() || record.meta.label;
      if (input.targetUrl !== undefined) record.meta.targetUrl = normalizePreviewUrl(input.targetUrl);
      if (input.viewport !== undefined) {
        record.meta.viewport = previewViewportSchema.parse({ ...record.meta.viewport, ...input.viewport });
        if (record.runtime.status === "ready") {
          await this.applyViewport(record);
        }
      }
      record.meta.updatedAt = now();
      this.persist(record);
      return this.snapshot(record);
    });
  }

  /** Open a stopped preview: start its agent-browser session and navigate to targetUrl. */
  async open(id: string): Promise<WebPreview | null> {
    const record = this.recordFor(id);
    if (!record) return null;
    return this.serialize(record, async () => {
      const running = record.runtime.status === "ready" && record.runtime.streamPort !== null;
      if (running || record.runtime.status === "starting") return this.snapshot(record);
      record.runtime.status = "starting";
      record.runtime.lastError = null;
      try {
        await this.ensureStream(record, record.meta.targetUrl);
        record.runtime.status = "ready";
        record.runtime.currentUrl = record.meta.targetUrl;
      } catch (cause) {
        record.runtime.status = "error";
        record.runtime.lastError = cause instanceof Error ? cause.message.slice(0, 512) : "Preview failed to start";
        logger("preview").error("Preview failed to start", { event: "preview.start_failed", previewId: record.meta.id, ...errorFields(cause) });
      }
      return this.snapshot(record);
    });
  }

  async stop(id: string): Promise<WebPreview | null> {
    const record = this.recordFor(id);
    if (!record) return null;
    return this.serialize(record, async () => {
      if (record.runtime.status === "stopped" || record.runtime.status === "stopping") return this.snapshot(record);
      record.runtime.status = "stopping";
      try {
        await this.runner.run(["--session", sessionNameFor(record.meta.id), "close"], { timeoutMs: 15_000 });
      } catch (cause) {
        logger("preview").warn("Preview close command failed", { event: "preview.stop_failed", previewId: record.meta.id, ...errorFields(cause) });
      }
      record.runtime.status = "stopped";
      record.runtime.streamPort = null;
      record.runtime.currentUrl = null;
      record.runtime.leaseHolderId = null;
      logger("preview").info("Preview stopped", { event: "preview.stopped", previewId: record.meta.id });
      return this.snapshot(record);
    });
  }

  async remove(id: string): Promise<boolean> {
    const record = this.recordFor(id);
    if (!record) return this.repositories.webPreviews.get(id) ? (this.repositories.webPreviews.delete(id), true) : false;
    await this.stop(id);
    this.repositories.webPreviews.delete(id);
    this.previews.delete(id);
    return true;
  }

  async navigate(id: string, url: string): Promise<WebPreview | null> {
    const record = this.recordFor(id);
    if (!record) return null;
    return this.serialize(record, async () => {
      const target = normalizePreviewUrl(url);
      try {
        await this.ensureStream(record, target);
      } catch (cause) {
        record.runtime.lastError = cause instanceof Error ? cause.message.slice(0, 512) : "Navigation failed";
        logger("preview").error("Preview navigation failed", { event: "preview.navigate_failed", previewId: record.meta.id, ...errorFields(cause) });
        // A failed navigation leaves the previous page (and its stream) intact,
        // so keep the runtime state rather than marking a running preview dead.
        throw cause;
      }
      record.meta.targetUrl = target;
      record.meta.updatedAt = now();
      record.runtime.status = "ready";
      record.runtime.currentUrl = target;
      this.persist(record);
      return this.snapshot(record);
    });
  }

  async back(id: string): Promise<WebPreview | null> {
    return this.simpleCommand(id, ["back"]);
  }

  async forward(id: string): Promise<WebPreview | null> {
    return this.simpleCommand(id, ["forward"]);
  }

  async reload(id: string): Promise<WebPreview | null> {
    return this.simpleCommand(id, ["reload"]);
  }

  private async simpleCommand(id: string, args: string[]): Promise<WebPreview | null> {
    const record = this.recordFor(id);
    if (!record) return null;
    return this.serialize(record, async () => {
      if (record.runtime.status !== "ready") throw new Error("Preview is not running");
      const result = await this.runner.run(["--session", sessionNameFor(record.meta.id), ...args]);
      if (result.exitCode !== 0) throw new Error(bounded(result.stderr || "Preview command failed", 512));
      return this.snapshot(record);
    });
  }

  /** Navigate the browser to `target`, apply the viewport, and (re)discover the
   *  loopback stream port. Keeps `status` and `streamPort` consistent so a
   *  preview is never advertised as ready without a reachable stream. */
  private async ensureStream(record: PreviewRecord, target: string): Promise<void> {
    await this.navigateSession(record, target);
    await this.applyViewport(record);
    record.runtime.streamPort = await this.discoverStreamPort(record);
  }

  private async navigateSession(record: PreviewRecord, url: string): Promise<void> {
    const session = sessionNameFor(record.meta.id);
    // Fixed argument array; never a shell string. No --profile/--restore/--state.
    const result = await this.runner.run(["--session", session, "open", "--json", url]);
    if (result.exitCode !== 0) {
      throw new Error(bounded(result.stderr || "Browser failed to open the target URL", 512));
    }
    const parsed = tryParseJson(result.stdout);
    if (parsed && typeof parsed === "object" && "error" in parsed && typeof (parsed as { error: unknown }).error === "string") {
      throw new Error(bounded((parsed as { error: string }).error, 512));
    }
  }

  private async applyViewport(record: PreviewRecord): Promise<void> {
    const { width, height } = record.meta.viewport;
    const result = await this.runner.run(["--session", sessionNameFor(record.meta.id), "set", "viewport", String(width), String(height)]);
    if (result.exitCode !== 0) {
      throw new Error(bounded(result.stderr || "Failed to set viewport", 256));
    }
  }

  /** Discover the loopback stream port via `stream status --json` (bounded, validated). */
  async discoverStreamPort(record: PreviewRecord): Promise<number> {
    const enable = await this.runner.run(["--session", sessionNameFor(record.meta.id), "stream", "enable"]);
    // `stream enable` is not idempotent: exit 1 with "already enabled" just
    // means a previous open left the stream up. Only fail on other errors.
    if (enable.exitCode !== 0 && !/already enabled/i.test(enable.stderr)) {
      throw new Error(bounded(enable.stderr || "Failed to enable preview stream", 256));
    }
    const status = await this.runner.run(["--session", sessionNameFor(record.meta.id), "stream", "status", "--json"]);
    if (status.exitCode !== 0) throw new Error(bounded(status.stderr || "Failed to read preview stream status", 256));
    const parsed = tryParseJson(status.stdout);
    const port = (parsed as { data?: { port?: unknown } } | null)?.data?.port;
    if (typeof port !== "number" || !Number.isInteger(port) || port < 1 || port > 65535) {
      throw new Error("Preview stream did not report a valid loopback port");
    }
    return port;
  }

  streamPortFor(id: string): number | null {
    return this.previews.get(id)?.runtime.streamPort ?? null;
  }

  /** Try to reattach to a preview's surviving agent-browser session and recover
   *  its loopback stream port. Also repairs a `ready` record whose port was lost
   *  (for example after a daemon restart), so the relay never rejects a preview
   *  the snapshot still calls ready. Returns true when the stream is usable. */
  async rediscover(id: string): Promise<boolean> {
    const record = this.recordFor(id);
    if (!record) return false;
    if (record.runtime.status === "ready" && record.runtime.streamPort !== null) return true;
    return this.serialize(record, async () => {
      try {
        const status = await this.runner.run(["--session", sessionNameFor(record.meta.id), "stream", "status", "--json"]);
        if (status.exitCode !== 0) return false;
        const parsed = tryParseJson(status.stdout);
        const port = (parsed as { data?: { port?: unknown } } | null)?.data?.port;
        if (typeof port !== "number" || !Number.isInteger(port) || port < 1 || port > 65535) return false;
        record.runtime.streamPort = port;
        record.runtime.status = "ready";
        return true;
      } catch {
        logger("preview").warn("Preview rediscovery failed", { event: "preview.rediscover_failed", previewId: record.meta.id });
        return false;
      }
    });
  }

  previewWorkspace(id: string): string | null {
    return this.recordFor(id)?.meta.workspaceId ?? null;
  }

  previewStatus(id: string): PreviewStatus | null {
    return this.recordFor(id)?.runtime.status ?? null;
  }

  takeLease(id: string, clientId: string): boolean {
    const record = this.recordFor(id);
    if (!record || record.runtime.status !== "ready") return false;
    record.runtime.leaseHolderId = clientId;
    return true;
  }

  releaseLease(id: string, clientId: string): void {
    const record = this.recordFor(id);
    if (record?.runtime.leaseHolderId === clientId) record.runtime.leaseHolderId = null;
  }

  markDisconnected(id: string): void {
    const record = this.previews.get(id);
    if (record?.runtime.status === "ready") record.runtime.status = "disconnected";
  }

  markReconnected(id: string, port: number): void {
    const record = this.previews.get(id);
    if (record && (record.runtime.status === "disconnected" || record.runtime.status === "error")) {
      record.runtime.status = "ready";
      record.runtime.streamPort = port;
    }
  }

  /** Stop all previews in a workspace (called before workspace archival/worktree removal). */
  async stopForWorkspace(workspaceId: string): Promise<void> {
    const rows = this.repositories.webPreviews.listForWorkspace(workspaceId, 100);
    for (const row of rows) {
      try {
        await this.stop(row.id);
      } catch {}
    }
  }

  /** Close known preview sessions during clean daemon shutdown. */
  async shutdown(): Promise<void> {
    for (const id of [...this.previews.keys()]) {
      try {
        await this.stop(id);
      } catch {}
    }
  }

  /** Suggest loopback dev-server candidates related to this workspace.
   *  `paseo.json` service ports come first: running services at high
   *  confidence, stopped-but-known ports (planned or explicit) as
   *  uncertain. Loopback listeners from /proc follow, minus duplicates and
   *  excluded ports. Never throws — failures yield fewer candidates. */
  async portCandidates(workspaceId: string, excludedPorts: number[] = []): Promise<PortCandidate[]> {
    const workspace = await this.workspaces.resolvePath(workspaceId, ".").catch(() => null);
    if (!workspace) return [];
    const excluded = new Set(excludedPorts);
    const scriptCandidates = await this.scriptCandidates(workspaceId, excluded).catch(() => []);
    const seen = new Set(scriptCandidates.map((c) => c.port));
    if (process.platform !== "linux") return scriptCandidates;
    try {
      const listening = await listLoopbackListeners();
      const inodeToListener = new Map(listening.map((item) => [item.inode, item.port]));
      const pidOf = await mapSocketInodesToPids([...inodeToListener.keys()]);
      const candidates: PortCandidate[] = [...scriptCandidates];
      for (const [inode, port] of inodeToListener) {
        if (excluded.has(port) || seen.has(port)) continue;
        seen.add(port);
        const pid = pidOf.get(inode);
        if (!pid) {
          candidates.push({ port, confidence: "uncertain", processName: null, pid: null, source: "process" });
          continue;
        }
        const meta = await processMeta(pid);
        const related = meta && (meta.cwd === workspace || meta.cwd.startsWith(`${workspace}/`));
        candidates.push({
          port,
          confidence: related ? "high" : "uncertain",
          processName: meta?.name ?? null,
          pid,
          source: "process",
        });
      }
      return candidates.sort((left, right) =>
        left.source === right.source ? left.port - right.port : left.source === "script" ? -1 : 1,
      );
    } catch {
      return scriptCandidates;
    }
  }

  /** `paseo.json` service ports for a workspace, in manifest order: running
   *  services (high confidence) first, then stopped services whose port is
   *  known from the retained plan or an explicit manifest `port`
   *  (uncertain — nothing may be listening yet). Services with no known
   *  port are skipped: allocating just to suggest would pollute the plan.
   *  Never throws. */
  private async scriptCandidates(
    workspaceId: string,
    excluded: ReadonlySet<number>,
  ): Promise<PortCandidate[]> {
    if (!this.scripts) return [];
    const runtimes = await this.scripts.list(workspaceId);
    const declared = this.scripts.declaredServicePorts(workspaceId);
    const declaredByName = new Map(declared.map((d) => [d.name, d.port]));
    const seen = new Set<number>();
    const running: PortCandidate[] = [];
    const stopped: PortCandidate[] = [];
    for (const runtime of runtimes) {
      if (runtime.type !== "service") continue;
      const port = runtime.port ?? declaredByName.get(runtime.name) ?? null;
      if (port === null || excluded.has(port) || seen.has(port)) continue;
      seen.add(port);
      const candidate: PortCandidate = {
        port,
        confidence: runtime.lifecycle === "running" ? "high" : "uncertain",
        processName: null,
        pid: null,
        source: "script",
      };
      (runtime.lifecycle === "running" ? running : stopped).push(candidate);
    }
    return [...running, ...stopped];
  }

  sessionName(id: string): string {
    return sessionNameFor(id);
  }
}

function tryParseJson(stdout: string): unknown {
  try {
    return JSON.parse(stdout.slice(0, 64 * 1024));
  } catch {
    return null;
  }
}

type Listener = { port: number; inode: string };

/** Parse `/proc/net/tcp[6]` text into loopback listeners. Exported for tests. */
export function parseProcNetTcp(text: string, isV6: boolean): Listener[] {
  const results: Listener[] = [];
  for (const line of text.split("\n").slice(1)) {
    const parts = line.trim().split(/\s+/);
    // Columns: sl local_address rem_address st ... inode.
    if (parts.length < 10) continue;
    const [, local, , state, , , , , , inode] = parts;
    if (state !== "0A" || !inode || inode === "0") continue;
    const port = parseLoopbackPort(local, isV6);
    if (port !== null) results.push({ port, inode });
  }
  return results;
}

async function listLoopbackListeners(): Promise<Listener[]> {
  const results: Listener[] = [];
  for (const file of ["/proc/net/tcp", "/proc/net/tcp6"]) {
    let text: string;
    try {
      text = await readFile(file, "utf8");
    } catch {
      continue;
    }
    results.push(...parseProcNetTcp(text, file.endsWith("tcp6")));
  }
  return results;
}

function parseLoopbackPort(localAddress: string, isV6: boolean): number | null {
  const [hexHost, hexPort] = localAddress.split(":");
  if (!hexHost || !hexPort) return null;
  const port = parseInt(hexPort, 16);
  if (!Number.isInteger(port) || port < 1 || port > 65535) return null;
  if (!isV6) {
    // /proc/net/tcp stores IPv4 hex little-endian per 32-bit word.
    if (hexHost === "0100007F" || hexHost === "00000000") return port;
    return null;
  }
  // tcp6: 32 hex chars; loopback ::1 ends with ...01.
  const normalized = hexHost.toUpperCase();
  if (normalized === "00000000000000000000000001000000" || normalized === "0000000000000000FFFF00000100007F") return port;
  return null;
}

async function mapSocketInodesToPids(inodes: string[]): Promise<Map<string, number>> {
  const wanted = new Set(inodes);
  const result = new Map<string, number>();
  let entries: string[];
  try {
    entries = await readdir("/proc");
  } catch {
    return result;
  }
  const pids = entries.filter((entry) => /^\d+$/.test(entry)).slice(0, 4096);
  await Promise.all(pids.map(async (pid) => {
    let links: string[];
    try {
      links = await readdir(`/proc/${pid}/fd`);
    } catch {
      return;
    }
    for (const fd of links.slice(0, 256)) {
      if (result.size >= wanted.size) return;
      try {
        const target = await readlink(`/proc/${pid}/fd/${fd}`);
        const match = /^socket:\[(\d+)\]$/.exec(target);
        if (match && wanted.has(match[1]) && !result.has(match[1])) {
          result.set(match[1], Number(pid));
        }
      } catch {}
    }
  }));
  return result;
}

async function processMeta(pid: number): Promise<{ cwd: string; name: string } | null> {
  try {
    const [cwd, cmdline] = await Promise.all([
      readlink(`/proc/${pid}/cwd`),
      readFile(`/proc/${pid}/cmdline`, "utf8").catch(() => ""),
    ]);
    const name = cmdline.split("\0").filter(Boolean).slice(0, 2).join(" ").slice(0, 256) || `pid ${pid}`;
    return { cwd, name };
  } catch {
    return null;
  }
}

