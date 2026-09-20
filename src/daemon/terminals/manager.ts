import {
  type CreateTerminalInput,
  type TerminalSummary,
  terminalSummarySchema,
} from "../../shared/domain/terminals.ts";
import {
  type BinaryFrame,
  encodeBinaryFrame,
  type ServerTerminalControl,
} from "../../shared/protocol/terminals.ts";
import { type WorkspaceService } from "../workspaces/service.ts";
import { errorFields, logger } from "../logging.ts";
import { sanitizedSubprocessEnv } from "../env.ts";
import {
  ensureTmuxAvailable,
  setTmuxSocketName,
  tmuxAttachArgv,
  tmuxCapturePane,
  tmuxEnsureDetachedSession,
  tmuxGetSessionMeta,
  tmuxHasSession,
  tmuxKillSession,
  tmuxListPaneStates,
  tmuxListTerminalIds,
  tmuxPaneState,
  tmuxSessionName,
  tmuxSetSessionMetaItem,
  type TmuxPaneStates,
  type TmuxSessionMeta,
} from "./tmux.ts";

const DEFAULT_COLS = 80;
const DEFAULT_ROWS = 24;
const MAX_REPLAY_BYTES = 128 * 1024; // 128 KB ring buffer per terminal
const DEFAULT_SHELL = "/bin/bash";

/**
 * Passage terminals are tmux-backed (hard requirement, no direct-spawn fallback).
 *
 * Process model: one isolated tmux server per data root (socket
 * `passage-<hash>`, user tmux.conf never loaded) hosts one tmux session
 * tmux.conf never loaded) hosts one tmux session per Passage terminal
 * (`passage-<terminalId>`). The daemon holds exactly one tmux client per
 * session via Bun.Terminal, so live output streams push with no polling.
 * The tmux server outlives Passage, so a daemon restart reattaches to the
 * same live shell with `new-session -A` semantics. External attach works
 * from any terminal: `tmux -L <socket> attach -t passage-<terminalId>`
 * (socket from `tmuxSocketName()`; `PASSAGE_TMUX_SOCKET` overrides).
 *
 * tmux provides the PTY + controlling terminal for the inner shell, so no
 * `setsid --ctty` wrapper is needed (that was only for direct spawn).
 */
function tmuxShellEnv(extra?: Record<string, string | undefined>): Record<string, string | undefined> {
  const env = sanitizedSubprocessEnv({
    TERM: "xterm-256color",
    COLORTERM: "truecolor",
    ...extra,
  });
  // Never nest inside a user tmux: the daemon is a tmux client of its own
  // isolated server, not of whatever TMUX the daemon inherited.
  delete env.TMUX;
  delete env.TMUX_PANE;
  return env;
}

export type TerminalSubscriber = {
  clientId: string;
  isHolder: boolean;
  sendBinary: (data: Uint8Array) => void;
  sendControl: (control: ServerTerminalControl) => void;
};

export type TerminalExitListener = (terminalId: string, exitCode: number | null) => void;

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
  private closed = false;
  private readonly onExitCb?: (exitCode: number | null) => void;
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
    spawn?: { argv: string[]; env?: Record<string, string | undefined> },
    onExit?: (exitCode: number | null) => void,
    opts?: { meta?: TmuxSessionMeta; createdAt?: string },
  ) {
    this.id = id;
    this.workspaceId = workspaceId;
    this.title = title;
    this.cwd = cwd;
    this.columns = columns;
    this.rows = rows;
    this.createdAt = opts?.createdAt ?? new Date().toISOString();
    this.onExitCb = onExit;

    const shell = process.env.SHELL || DEFAULT_SHELL;
    // Inner command runs inside the tmux session (which owns the PTY and
    // controlling terminal). Outer tmux client needs no shell wrapper.
    const shellArgv = spawn?.argv ?? [shell];
    const sessionEnv = spawn?.env ? tmuxShellEnv(spawn.env) : tmuxShellEnv();
    ensureTmuxAvailable();
    // No-op when the session already exists (recovery path): metadata
    // already persisted in the session's user options is left untouched.
    // Remember ownership: on spawn failure below, only reap sessions this
    // constructor created, never pre-existing ones.
    const preexisted = tmuxHasSession(id);
    tmuxEnsureDetachedSession(id, shellArgv, cwd, columns, rows, sessionEnv, opts?.meta);
    this.terminal = new Bun.Terminal({
      name: "xterm-256color",
      cols: columns,
      rows,
      data: (_term, data) => {
        this.onPtyData(data);
      },
    });

    try {
      this.process = Bun.spawn(tmuxAttachArgv(id), {
        env: tmuxShellEnv(),
        terminal: this.terminal,
      });

      void this.process.exited.then(() => {
        this.onClientExit();
      });
    } catch (err) {
      this.status = "exited";
      this.exitCode = -1;
      if (!preexisted) {
        try {
          tmuxKillSession(id);
        } catch {}
      }
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

    // Replay buffer (live output seen while the daemon was up). When empty
    // (e.g. reattach to a session that outlived us), paint the current
    // tmux pane directly so no history replay loop is needed.
    if (this.replayFrames.length === 0 && this.status === "running") {
      try {
        const snapshot = tmuxCapturePane(this.id);
        if (snapshot && snapshot.length > 0) {
          this.sequence += 1;
          let payload = new TextEncoder().encode(snapshot);
          // Bound the rehydrate frame: xterm resyncs on the next live
          // output, so a truncated tail beats a multi-MB first paint.
          if (payload.byteLength > MAX_REPLAY_BYTES) payload = payload.slice(-MAX_REPLAY_BYTES);
          const frame: BinaryFrame = {
            subjectId: this.id,
            sequence: this.sequence,
            payload,
          };
          this.replayFrames.push(frame);
          this.replayBytes += frame.payload.byteLength;
        }
      } catch {}
    }
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
      // Persist dims so restart recovery rebuilds the client at the current
      // size instead of the creation size. Best-effort: resize already won.
      try {
        tmuxSetSessionMetaItem(this.id, "cols", String(cols));
        tmuxSetSessionMetaItem(this.id, "rows", String(rows));
      } catch {}
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

  /** Single poll-tick check; the manager batches pane state for all
   *  instances into one tmux query. Settle detection: with remain-on-exit
   *  the session persists after the shell dies, so dead panes settle with
   *  real exit codes; missing sessions settle unknown. A dead client on a
   *  live pane is reattached (retried every tick until it sticks). */
  checkTick(state: { dead: boolean; exitStatus: number | null } | null): void {
    if (this.status !== "running" || this.closed) return;
    if (state === null) {
      this.settleExited(null);
      return;
    }
    if (state.dead) {
      this.settleExited(state.exitStatus);
      return;
    }
    if (this.process.exitCode !== null) this.tryReattachClient();
  }

  private tryReattachClient(): void {
    try {
      this.process = Bun.spawn(tmuxAttachArgv(this.id), {
        env: tmuxShellEnv(),
        terminal: this.terminal,
      });
      void this.process.exited.then(() => this.onClientExit());
    } catch (error) {
      // Retried on the next poll tick; the pane stays marked running so no
      // output is acknowledged as settled while detached.
      logger("terminal").warn("tmux client reattach failed; retrying", { event: "terminal.reattach_failed", terminalId: this.id, ...errorFields(error) });
    }
  }

  private onClientExit(): void {
    if (this.closed || this.status !== "running") return;
    // Client exit alone means nothing (detach also exits the client). Only
    // settle when the pane itself is dead or the session is gone;
    // otherwise reattach the client so the live session keeps streaming.
    let state: { dead: boolean; exitStatus: number | null } | null = null;
    try {
      state = tmuxPaneState(this.id);
    } catch {
      return;
    }
    if (state === null) {
      this.settleExited(null);
      return;
    }
    if (state.dead) {
      this.settleExited(state.exitStatus);
      return;
    }
    this.tryReattachClient();
  }

  private settleExited(exitCode: number | null): void {
    if (this.status === "exited") return;
    this.status = "exited";
    this.exitCode = exitCode;
    logger("terminal").info("tmux session exited", { event: "terminal.process_exited", terminalId: this.id, exitCode });
    this.broadcastControl({ type: "exit", exitCode });
    // Reap the server side: with remain-on-exit the dead session would
    // otherwise accumulate until explicit termination. The ring buffer is
    // retained, so replay and scrollback viewing keep working.
    try {
      tmuxKillSession(this.id);
    } catch {}
    try {
      if (!this.terminal.closed) this.terminal.close();
    } catch {}
    try {
      this.onExitCb?.(exitCode);
    } catch {}
  }

  private broadcastControl(control: ServerTerminalControl) {
    for (const sub of this.subscribers.values()) {
      try {
        sub.sendControl(control);
      } catch {}
    }
  }

  kill() {
    if (this.closed) return;
    this.closed = true;
    logger("terminal").info("tmux session termination requested", { event: "terminal.termination_requested", terminalId: this.id, tmuxSession: tmuxSessionName(this.id) });
    // Killing the tmux session ends the shell and descendants. Killing the
    // client alone would only detach, leaving the session running.
    try {
      if (!tmuxKillSession(this.id) && tmuxHasSession(this.id)) {
        logger("terminal").warn("tmux session survived kill; state may be unmanaged", { event: "terminal.kill_failed", terminalId: this.id });
      }
    } catch {}
    try {
      if (this.process.exitCode === null) this.process.kill();
    } catch {}
    // Route explicit termination through the single-shot exit path so
    // subscribers see `exit` and `onExit` listeners (scripts) settle.
    this.settleExited(null);
  }
}

export class TerminalManager {
  private terminals = new Map<string, TerminalInstance>();
  private readonly exitListeners = new Set<TerminalExitListener>();
  private pollTimer: ReturnType<typeof setInterval> | null = null;

  constructor(
    private readonly workspaces: WorkspaceService,
    opts?: { tmuxSocketName?: string },
  ) {
    // Scope the tmux server (dot-separated checkouts must never share one;
    // see tmux.ts). No availability check here: without tmux only terminal
    // creation/recovery fails, the rest of the daemon keeps serving.
    if (opts?.tmuxSocketName) setTmuxSocketName(opts.tmuxSocketName);
  }

  /** One batched `list-panes` per tick for all instances (see tmux.ts),
   *  started lazily and stopped with the last terminal. */
  private ensurePoll(): void {
    if (this.pollTimer || this.terminals.size === 0) return;
    this.pollTimer = setInterval(() => {
      try {
        this.pollTick();
      } catch {}
    }, 1000);
    if (this.pollTimer.unref) this.pollTimer.unref();
  }

  private maybeStopPoll(): void {
    if (this.pollTimer && this.terminals.size === 0) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
  }

  private pollTick(): void {
    let states: TmuxPaneStates;
    try {
      states = tmuxListPaneStates();
    } catch {
      return;
    }
    for (const term of this.terminals.values()) {
      try {
        // tmuxListPaneStates keys are terminal IDs (session prefix stripped).
        term.checkTick(states.get(term.id) ?? null);
      } catch {}
    }
  }

  /** Subscribe to PTY exits (fired once per terminal when its process
   *  settles). Used by the scripts service to mark runs stopped. */
  onExit(listener: TerminalExitListener): () => boolean {
    this.exitListeners.add(listener);
    return () => this.exitListeners.delete(listener);
  }

  private notifyExit(terminalId: string, exitCode: number | null): void {
    for (const listener of [...this.exitListeners]) {
      try {
        listener(terminalId, exitCode);
      } catch {}
    }
  }

  /** Spawn a workspace command attached to a PTY (script/service run).
   *  The command executes under `bash -c` inside its tmux session with the
   *  provided env so project scripts see the same service variables Paseo
   *  provides. When the command exits the tmux session ends and the
   *  terminal settles to `exited`.
   *
   *  `persistent` opts the session into restart recovery: metadata is stored
   *  in the tmux session so a post-restart sweep reattaches it instead of
   *  reaping it. Used for long-running services; one-shots stay anonymous. */
  async createCommand(
    workspaceId: string,
    input: { title: string; command: string; env?: Record<string, string | undefined>; cwd?: string; columns?: number; rows?: number; persistent?: boolean; scriptName?: string },
  ): Promise<TerminalSummary> {
    const cwd = await this.workspaces.resolvePath(workspaceId, input.cwd ?? ".");
    const id = `trm_${crypto.randomUUID()}`;
    const cols = input.columns ?? DEFAULT_COLS;
    const rows = input.rows ?? DEFAULT_ROWS;
    const base = tmuxShellEnv();
    const env: Record<string, string | undefined> = { ...base, ...(input.env ?? {}) };
    delete env.TMUX;
    delete env.TMUX_PANE;
    const createdAt = new Date().toISOString();
    const instance = new TerminalInstance(id, workspaceId, input.title, cwd, cols, rows, {
      argv: ["/bin/bash", "-c", input.command],
      env,
    }, (exitCode) => this.notifyExit(id, exitCode), input.persistent ? {
      meta: {
        workspace: workspaceId,
        title: input.title,
        cwd,
        cols: String(cols),
        rows: String(rows),
        created: createdAt,
        ...(input.scriptName ? { script: input.scriptName } : {}),
      },
      createdAt,
    } : undefined);
    this.terminals.set(id, instance);
    this.ensurePoll();
    return instance.summary();
  }

  async create(workspaceId: string, input?: CreateTerminalInput): Promise<TerminalSummary> {
    const cwd = await this.workspaces.resolvePath(workspaceId, input?.cwd ?? ".");
    const id = `trm_${crypto.randomUUID()}`;
    const count = Array.from(this.terminals.values()).filter((t) => t.workspaceId === workspaceId).length + 1;
    const title = input?.title?.trim() || `Terminal ${count}`;
    const cols = input?.columns ?? DEFAULT_COLS;
    const rows = input?.rows ?? DEFAULT_ROWS;
    const createdAt = new Date().toISOString();

    const instance = new TerminalInstance(id, workspaceId, title, cwd, cols, rows, undefined, (exitCode) => this.notifyExit(id, exitCode), {
      meta: { workspace: workspaceId, title, cwd, cols: String(cols), rows: String(rows), created: createdAt },
      createdAt,
    });
    this.terminals.set(id, instance);
    this.ensurePoll();
    return instance.summary();
  }

  /** Boot-time recovery: reattach Passage-owned tmux sessions that outlived
   *  a daemon restart. Sessions with complete metadata whose workspace still
   *  exists (and is not archived) get a fresh tmux client wrapper; the live
   *  shell keeps running untouched. Anything else (one-shot script sessions
   *  with no metadata, unknown/archived workspaces) is reaped so nothing
   *  leaks. Idempotent: already-tracked sessions are skipped. */
  async recoverAfterRestart(): Promise<{ reattached: string[]; reaped: string[] }> {
    const reattached: string[] = [];
    const reaped: string[] = [];
    let ids: string[];
    try {
      ids = tmuxListTerminalIds();
    } catch {
      return { reattached, reaped };
    }
    for (const id of ids) {
      if (this.terminals.has(id)) continue;
      let meta: TmuxSessionMeta | null = null;
      try {
        meta = tmuxGetSessionMeta(id);
      } catch {
        meta = null;
      }
      if (meta === null) {
        try {
          tmuxKillSession(id);
        } catch {}
        reaped.push(id);
        continue;
      }
      try {
        await this.workspaces.resolvePath(meta.workspace, ".");
      } catch {
        try {
          tmuxKillSession(id);
        } catch {}
        reaped.push(id);
        continue;
      }
      try {
        const cols = Number(meta.cols);
        const rows = Number(meta.rows);
        const instance = new TerminalInstance(
          id,
          meta.workspace,
          meta.title,
          meta.cwd,
          Number.isSafeInteger(cols) ? cols : DEFAULT_COLS,
          Number.isSafeInteger(rows) ? rows : DEFAULT_ROWS,
          undefined,
          (exitCode) => this.notifyExit(id, exitCode),
          { createdAt: meta.created },
        );
        this.terminals.set(id, instance);
        reattached.push(id);
      } catch (error) {
        logger("terminal").warn("Terminal reattach failed; reaping session", { event: "terminal.reattach_failed", terminalId: id, ...errorFields(error) });
        try {
          tmuxKillSession(id);
        } catch {}
        reaped.push(id);
      }
    }
    if (reattached.length > 0 || reaped.length > 0) {
      logger("terminal").info("Terminal recovery completed", { event: "terminal.recovery_completed", reattached: reattached.length, reaped: reaped.length });
    }
    this.ensurePoll();
    return { reattached, reaped };
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
    this.maybeStopPoll();
    return true;
  }

  /** Kill every terminal belonging to a workspace (tmux session + client).
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
    this.maybeStopPoll();
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

  /** External attach target for out-of-band access (debugging, pi parity):
   *  `tmux -L <socket> attach -t <name>` (see `tmuxSocketName()`). */
  tmuxTarget(terminalId: string): string | null {
    return this.terminals.has(terminalId) ? tmuxSessionName(terminalId) : null;
  }
}

