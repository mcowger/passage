import { LfJsonlParser } from "../../src/shared/jsonl/parser.ts";

export type PiRecord = { type?: string; id?: string; [key: string]: unknown };
export type PiCommand = { type: string; id?: string; [key: string]: unknown };

const DEFAULT_TIMEOUT_MS = 25_000;
const DEFAULT_STDERR_BYTES = 32 * 1024;
const DEFAULT_EVENT_BYTES = 4 * 1024 * 1024;
const DEFAULT_COMMAND_BYTES = 64 * 1024;

function defaultPiCommand(): string[] {
  const piExecutable = process.env.PASSAGE_PI_PATH ?? Bun.which("pi");
  if (!piExecutable) throw new Error("Pi CLI was not found; set PASSAGE_PI_PATH");
  return [piExecutable];
}

async function consumeStream(stream: ReadableStream<Uint8Array>, onChunk: (chunk: Uint8Array) => void): Promise<void> {
  const reader = stream.getReader();
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) return;
      onChunk(value);
    }
  } finally {
    reader.releaseLock();
  }
}

export class PiRpcClient {
  readonly process: Bun.Subprocess<"pipe", "pipe", "pipe">;
  readonly events: PiRecord[] = [];
  readonly stderr: string[] = [];
  eventsTruncated = false;
  private nextId = 0;
  private eventBytes = 0;
  private pending = new Map<string, { resolve: (r: PiRecord) => void; reject: (e: Error) => void; timer: ReturnType<typeof setTimeout> }>();
  private exit: Promise<void>;

  private stderrBytes = 0;

  constructor(options: { cwd: string; sessionDir: string; sessionId: string; executable?: string; executableArgs?: string[] }) {
    const command = options.executable
      ? [options.executable, ...(options.executableArgs ?? [])]
      : defaultPiCommand();
    const child = Bun.spawn([...command, "--mode", "rpc", "--session-dir", options.sessionDir, "--session-id", options.sessionId, "--no-skills", "--no-prompt-templates", "--no-themes", "--no-context-files", "--no-approve"], {
      cwd: options.cwd,
      env: { ...process.env },
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
    });
    this.process = child;
    const parser = new LfJsonlParser<PiRecord>(
      (record) => this.receive(record),
      undefined,
      (line) => this.captureStderrChunk(new TextEncoder().encode(line + "\n")),
    );
    this.exit = (async () => {
      await consumeStream(child.stdout, (chunk) => parser.push(chunk));
      parser.finish();
    })().catch((error) => {
      this.failAll(error);
      if (child.exitCode === null) child.kill();
    });
    void child.exited.then((code) => this.failAll(new Error(`Pi process exited (${code})`)));
    void this.captureStderr();
  }

  private receive(record: PiRecord): void {
    if (record.type === "response" && typeof record.id === "string") {
      const request = this.pending.get(record.id);
      if (!request) return;
      clearTimeout(request.timer);
      this.pending.delete(record.id);
      if (record.success === false) request.reject(new Error(String(record.error ?? "Pi command failed")));
      else request.resolve(record);
    } else {
      const bytes = new TextEncoder().encode(JSON.stringify(record)).byteLength;
      this.events.push(record);
      this.eventBytes += bytes;
      while (this.eventBytes > DEFAULT_EVENT_BYTES && this.events.length > 0) {
        const removed = this.events.shift();
        this.eventBytes -= new TextEncoder().encode(JSON.stringify(removed)).byteLength;
        this.eventsTruncated = true;
      }
    }
  }

  async request(command: Omit<PiCommand, "id">, timeoutMs = DEFAULT_TIMEOUT_MS): Promise<PiRecord> {
    if (this.process.exitCode !== null) throw new Error(`Pi process is not running (${this.process.exitCode})`);
    const id = `passage-${++this.nextId}`;
    const record = { ...command, id };
    const serialized = JSON.stringify(record) + "\n";
    if (new TextEncoder().encode(serialized).byteLength > DEFAULT_COMMAND_BYTES) {
      throw new Error("Pi command exceeds byte limit");
    }
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error(`Pi request timed out: ${command.type}`)); }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      try {
        this.process.stdin.write(serialized);
      } catch (error) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(error);
      }
    });
  }

  async shutdown(timeoutMs = 2_000): Promise<"clean" | "forced"> {
    this.process.stdin.end();
    let forced = false;
    await Promise.race([this.process.exited, new Promise<void>((resolve) => setTimeout(() => { forced = true; resolve(); }, timeoutMs))]);
    if (forced && !this.process.killed) this.process.kill();
    await this.process.exited;
    return forced ? "forced" : "clean";
  }

  private captureStderrChunk(chunk: Uint8Array): void {
    if (this.stderrBytes < DEFAULT_STDERR_BYTES) {
      const kept = chunk.slice(0, DEFAULT_STDERR_BYTES - this.stderrBytes);
      this.stderr.push(new TextDecoder().decode(kept));
      this.stderrBytes += kept.byteLength;
    }
  }

  private async captureStderr(): Promise<void> {
    await consumeStream(this.process.stderr, (data) => {
      this.captureStderrChunk(data);
    });
  }

  private failAll(error: unknown): void {
    for (const [id, request] of this.pending) { clearTimeout(request.timer); request.reject(error instanceof Error ? error : new Error(String(error))); this.pending.delete(id); }
  }
}
