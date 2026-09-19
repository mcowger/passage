import { readdir, readFile } from "node:fs/promises";
import { resolve } from "node:path";
import {
  type CreateTerminalInput,
  type TerminalDimensions,
  type TerminalSummary,
  terminalSummarySchema,
} from "../../shared/domain/terminals.ts";
import {
  type BinaryFrame,
  encodeBinaryFrame,
  type ServerTerminalControl,
} from "../../shared/protocol/terminals.ts";
import { WorkspaceError, type WorkspaceService } from "../workspaces/service.ts";
import { errorFields, logger } from "../logging.ts";
import { sanitizedSubprocessEnv } from "../env.ts";

const DEFAULT_COLS = 80;
const DEFAULT_ROWS = 24;
const MAX_REPLAY_BYTES = 128 * 1024; // 128 KB ring buffer per terminal
const DEFAULT_SHELL = "/bin/bash";

/**
 * Build the argv used to launch an interactive shell on the PTY.
 *
 * Bun attaches the PTY slave to the child's stdio but does not make it the
 * child's controlling terminal. Without one the shell starts with
 * "no job control", /dev/tty is unavailable (ENXIO), Tab completion backed
 * by /dev/tty (e.g. fzf-tab) breaks, and Ctrl+C handling misbehaves, which
 * leaves the terminal looking frozen. On Linux, prefix with util-linux
 * `setsid --ctty` so the shell becomes a session leader with the PTY slave
 * as its controlling terminal (setsid execs directly when the child is not
 * already a process-group leader, so kill()/exited semantics are unchanged).
 * Everywhere else, or when setsid is missing, fall back to a direct spawn.
 */
export function resolvePtyShellArgv(shell = process.env.SHELL || DEFAULT_SHELL): string[] {
  if (process.platform === "linux") {
    try {
      if (Bun.which("setsid")) return ["setsid", "--ctty", shell];
    } catch {}
  }
  return [shell];
}

export type TerminalSubscriber = {
  clientId: string;
  isHolder: boolean;
  sendBinary: (data: Uint8Array) => void;
  sendControl: (control: ServerTerminalControl) => void;
};

class TerminalInstance {
  readonly id: string;
  readonly workspaceId: string;
  readonly title: string;
  readonly cwd: string;
  columns: number;
  rows: number;
  status: "running" | "exited" = "running";
  exitCode: number | null = null;
  readonly createdAt: string;

  private terminal: Bun.Terminal;
  private process: Bun.Subprocess;
  private sequence = 0;
  private replayFrames: BinaryFrame[] = [];
  private replayBytes = 0;
  private leaseHolderId: string | null = null;
  private subscribers = new Map<string, TerminalSubscriber>();

  constructor(
    id: string,
    workspaceId: string,
    title: string,
    cwd: string,
    columns = DEFAULT_COLS,
    rows = DEFAULT_ROWS,
  ) {
    this.id = id;
    this.workspaceId = workspaceId;
    this.title = title;
    this.cwd = cwd;
    this.columns = columns;
    this.rows = rows;
    this.createdAt = new Date().toISOString();

    const shell = process.env.SHELL || DEFAULT_SHELL;
    this.terminal = new Bun.Terminal({
      name: "xterm-256color",
      cols: columns,
      rows,
      data: (_term, data) => {
        this.onPtyData(data);
      },
    });

    try {
      this.process = Bun.spawn(resolvePtyShellArgv(shell), {
        cwd,
        // Strip the daemon's own PORT/PASEO_PORT so shells (and everything
        // they launch, e.g. Vite honoring PORT) never inherit this
        // worktree's bind port from a different checkout's launch env.
        env: sanitizedSubprocessEnv({
          TERM: "xterm-256color",
          COLORTERM: "truecolor",
        }),
        terminal: this.terminal,
      });

      void this.process.exited.then((code) => {
        this.status = "exited";
        this.exitCode = code;
        logger("terminal").info("PTY process exited", { event: "terminal.process_exited", terminalId: this.id, exitCode: code });
        this.broadcastControl({ type: "exit", exitCode: code });
        try {
          if (!this.terminal.closed) this.terminal.close();
        } catch {}
      });
    } catch (err) {
      this.status = "exited";
      this.exitCode = -1;
      logger("terminal").error("PTY process could not start", { event: "terminal.start_failed", terminalId: this.id, ...errorFields(err) });
      throw err;
    }
  }

  summary(forClientId?: string): TerminalSummary {
    return terminalSummarySchema.parse({
      id: this.id,
      workspaceId: this.workspaceId,
      title: this.title,
      cwd: this.cwd,
      columns: this.columns,
      rows: this.rows,
      status: this.status,
      exitCode: this.exitCode,
      hasSizeLease: forClientId ? this.leaseHolderId === forClientId : this.leaseHolderId !== null,
      createdAt: this.createdAt,
    });
  }

  private onPtyData(data: Uint8Array) {
    if (this.status !== "running" || data.byteLength === 0) return;
    this.sequence += 1;
    const frame: BinaryFrame = {
      subjectId: this.id,
      sequence: this.sequence,
      payload: new Uint8Array(data),
    };

    // Store in ring buffer
    this.replayFrames.push(frame);
    this.replayBytes += data.byteLength;
    while (this.replayBytes > MAX_REPLAY_BYTES && this.replayFrames.length > 1) {
      const removed = this.replayFrames.shift();
      if (removed) this.replayBytes -= removed.payload.byteLength;
    }

    const encoded = encodeBinaryFrame(frame);
    for (const sub of this.subscribers.values()) {
      try {
        sub.sendBinary(encoded);
      } catch {}
    }
  }

  attach(sub: TerminalSubscriber) {
    if (this.subscribers.size === 0 || this.leaseHolderId === null) {
      this.leaseHolderId = sub.clientId;
    }
    sub.isHolder = this.leaseHolderId === sub.clientId;
    this.subscribers.set(sub.clientId, sub);

    // Send attached control message
    sub.sendControl({
      type: "attached",
      terminalId: this.id,
      cols: this.columns,
      rows: this.rows,
      hasSizeLease: sub.isHolder,
      lastSequence: this.sequence,
    });

    // Replay buffer
    for (const frame of this.replayFrames) {
      try {
        sub.sendBinary(encodeBinaryFrame(frame));
      } catch {}
    }

    if (this.status === "exited") {
      sub.sendControl({ type: "exit", exitCode: this.exitCode });
    }
  }

  detach(clientId: string) {
    this.subscribers.delete(clientId);
    if (this.leaseHolderId === clientId) {
      // Pass lease to next active subscriber if any
      const next = this.subscribers.values().next().value as TerminalSubscriber | undefined;
      this.leaseHolderId = next ? next.clientId : null;
      if (next) {
        next.isHolder = true;
        next.sendControl({ type: "lease_change", hasSizeLease: true });
      }
    }
  }

  writeInput(data: string) {
    if (this.status !== "running") return;
    try {
      this.terminal.write(data);
    } catch {}
  }

  resize(cols: number, rows: number, fromClientId: string): boolean {
    if (this.status !== "running") return false;
    // Only lease holder can resize
    if (this.leaseHolderId && this.leaseHolderId !== fromClientId) {
      // Send current dimensions back to passive client
      const sub = this.subscribers.get(fromClientId);
      sub?.sendControl({ type: "resized", cols: this.columns, rows: this.rows });
      return false;
    }

    if (this.columns === cols && this.rows === rows) return true;

    try {
      this.terminal.resize(cols, rows);
      this.columns = cols;
      this.rows = rows;
      this.broadcastControl({ type: "resized", cols, rows });
      return true;
    } catch {
      return false;
    }
  }

  takeLease(clientId: string) {
    if (!this.subscribers.has(clientId)) return;
    const prevHolder = this.leaseHolderId;
    this.leaseHolderId = clientId;

    for (const sub of this.subscribers.values()) {
      const isHolder = sub.clientId === clientId;
      sub.isHolder = isHolder;
      if (sub.clientId === clientId || sub.clientId === prevHolder) {
        sub.sendControl({ type: "lease_change", hasSizeLease: isHolder });
      }
    }
  }

  private broadcastControl(control: ServerTerminalControl) {
    for (const sub of this.subscribers.values()) {
      try {
        sub.sendControl(control);
      } catch {}
    }
  }

  /** PID of the shell spawned for this terminal (null when unavailable). */
  get pid(): number | null {
    try {
      const pid = this.process.pid;
      return typeof pid === "number" && Number.isSafeInteger(pid) && pid > 0 ? pid : null;
    } catch {
      return null;
    }
  }

  kill() {
    logger("terminal").info("PTY termination requested", { event: "terminal.termination_requested", terminalId: this.id });
    this.status = "exited";
    const pid = this.pid;
    if (pid !== null) {
      // SIGTERM the whole tree (children first) so nested builds/servers
      // die with the shell; a SIGKILL sweep follows for ignorers.
      killProcessTree(pid, "SIGTERM");
      setTimeout(() => {
        try {
          if (this.process.exitCode === null) killProcessTree(pid, "SIGKILL");
        } catch {}
      }, 2000).unref?.();
    }
    if (this.process.exitCode === null) {
      try {
        this.process.kill();
      } catch {}
    }
    try {
      if (!this.terminal.closed) this.terminal.close();
    } catch {}
  }
}

export class TerminalManager {
  private terminals = new Map<string, TerminalInstance>();

  constructor(private readonly workspaces: WorkspaceService) {}

  async create(workspaceId: string, input?: CreateTerminalInput): Promise<TerminalSummary> {
    const cwd = await this.workspaces.resolvePath(workspaceId, input?.cwd ?? ".");
    const id = `trm_${crypto.randomUUID()}`;
    const count = Array.from(this.terminals.values()).filter((t) => t.workspaceId === workspaceId).length + 1;
    const title = input?.title?.trim() || `Terminal ${count}`;
    const cols = input?.columns ?? DEFAULT_COLS;
    const rows = input?.rows ?? DEFAULT_ROWS;

    const instance = new TerminalInstance(id, workspaceId, title, cwd, cols, rows);
    this.terminals.set(id, instance);
    return instance.summary();
  }

  list(workspaceId: string): TerminalSummary[] {
    const result: TerminalSummary[] = [];
    for (const term of this.terminals.values()) {
      if (term.workspaceId === workspaceId) {
        result.push(term.summary());
      }
    }
    return result;
  }

  get(terminalId: string, clientId?: string): TerminalSummary | null {
    const term = this.terminals.get(terminalId);
    return term ? term.summary(clientId) : null;
  }

  terminate(terminalId: string): boolean {
    const term = this.terminals.get(terminalId);
    if (!term) return false;
    term.kill();
    this.terminals.delete(terminalId);
    return true;
  }

  /** Kill every terminal belonging to a workspace (shell + descendants).
   *  Used before workspace archival/removal so no PTY child outlives the
   *  worktree directory. Never throws; returns the terminated terminal IDs. */
  terminateForWorkspace(workspaceId: string): string[] {
    const ids: string[] = [];
    for (const term of this.terminals.values()) {
      if (term.workspaceId === workspaceId) ids.push(term.id);
    }
    for (const id of ids) {
      try {
        this.terminals.get(id)?.kill();
      } catch (error) {
        logger("terminal").warn("Workspace terminal termination failed", { event: "terminal.workspace_termination_failed", terminalId: id, workspaceId, ...errorFields(error) });
      }
      this.terminals.delete(id);
    }
    if (ids.length > 0) {
      logger("terminal").info("Terminals terminated for workspace", { event: "terminal.workspace_terminated", workspaceId, count: ids.length });
    }
    return ids;
  }

  attach(terminalId: string, subscriber: TerminalSubscriber): boolean {
    const term = this.terminals.get(terminalId);
    if (!term) return false;
    term.attach(subscriber);
    return true;
  }

  detach(terminalId: string, clientId: string) {
    const term = this.terminals.get(terminalId);
    term?.detach(clientId);
  }

  writeInput(terminalId: string, data: string) {
    const term = this.terminals.get(terminalId);
    term?.writeInput(data);
  }

  resize(terminalId: string, cols: number, rows: number, clientId: string): boolean {
    const term = this.terminals.get(terminalId);
    return term ? term.resize(cols, rows, clientId) : false;
  }

  takeLease(terminalId: string, clientId: string) {
    const term = this.terminals.get(terminalId);
    term?.takeLease(clientId);
  }
}

/** Best-effort parent→children map from /proc (Linux only). */
async function readParentMap(): Promise<Map<number, number[]> | null> {
  if (process.platform !== "linux") return null;
  let entries: string[];
  try {
    entries = await readdir("/proc");
  } catch {
    return null;
  }
  const children = new Map<number, number[]>();
  await Promise.all(entries.filter((e) => /^\d+$/.test(e)).slice(0, 4096).map(async (pid) => {
    let status: string;
    try {
      status = await readFile(`/proc/${pid}/status`, "utf8");
    } catch {
      return;
    }
    const match = /^PPid:\s*(\d+)/m.exec(status);
    if (!match) return;
    const ppid = Number(match[1]);
    const child = Number(pid);
    if (!Number.isSafeInteger(ppid) || !Number.isSafeInteger(child)) return;
    const list = children.get(ppid);
    if (list) list.push(child);
    else children.set(ppid, [child]);
  }));
  return children;
}

function signalPid(pid: number, signal: NodeJS.Signals): void {
  try {
    process.kill(pid, signal);
  } catch {}
}

/** Signal a process tree (descendants first, then the root). Best-effort:
 *  uses /proc on Linux; elsewhere signals only the root. Never throws. */
export function killProcessTree(rootPid: number, signal: NodeJS.Signals): void {
  if (!Number.isSafeInteger(rootPid) || rootPid <= 0) return;
  void (async () => {
    try {
      const parentMap = await readParentMap();
      if (!parentMap) {
        signalPid(rootPid, signal);
        return;
      }
      const descendants: number[] = [];
      const queue = [...(parentMap.get(rootPid) ?? [])];
      while (queue.length > 0) {
        const pid = queue.pop()!;
        descendants.push(pid);
        for (const child of parentMap.get(pid) ?? []) queue.push(child);
      }
      for (const pid of descendants) signalPid(pid, signal);
      signalPid(rootPid, signal);
    } catch {
      signalPid(rootPid, signal);
    }
  })();
}
