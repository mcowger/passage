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

const DEFAULT_COLS = 80;
const DEFAULT_ROWS = 24;
const MAX_REPLAY_BYTES = 128 * 1024; // 128 KB ring buffer per terminal

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

    const shell = process.env.SHELL || "/bin/bash";
    this.terminal = new Bun.Terminal({
      name: "xterm-256color",
      cols: columns,
      rows,
      data: (_term, data) => {
        this.onPtyData(data);
      },
    });

    try {
      this.process = Bun.spawn([shell], {
        cwd,
        env: {
          ...process.env,
          TERM: "xterm-256color",
          COLORTERM: "truecolor",
        },
        terminal: this.terminal,
      });

      void this.process.exited.then((code) => {
        this.status = "exited";
        this.exitCode = code;
        this.broadcastControl({ type: "exit", exitCode: code });
        try {
          if (!this.terminal.closed) this.terminal.close();
        } catch {}
      });
    } catch (err) {
      this.status = "exited";
      this.exitCode = -1;
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

  kill() {
    this.status = "exited";
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
