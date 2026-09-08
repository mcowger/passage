export const DEFAULT_JSONL_MAX_RECORD_BYTES = 1024 * 1024;

export class LfJsonlParser<T = unknown> {
  private buffer = "";
  private readonly decoder = new TextDecoder();

  constructor(
    private readonly onRecord: (record: T) => void,
    private readonly maxRecordBytes = DEFAULT_JSONL_MAX_RECORD_BYTES,
    private readonly onMalformed?: (line: string, error: unknown) => void,
  ) {
    if (!Number.isSafeInteger(maxRecordBytes) || maxRecordBytes < 1) {
      throw new Error("JSONL record limit must be a positive safe integer");
    }
  }

  push(chunk: string | Uint8Array): void {
    this.buffer += typeof chunk === "string" ? chunk : this.decoder.decode(chunk, { stream: true });
    let newline;
    while ((newline = this.buffer.indexOf("\n")) !== -1) {
      const line = this.buffer.slice(0, newline).replace(/\r$/, "");
      this.buffer = this.buffer.slice(newline + 1);
      if (new TextEncoder().encode(line).byteLength > this.maxRecordBytes) {
        throw new Error("JSONL record exceeds byte limit");
      }
      if (line.trim()) {
        try {
          this.onRecord(JSON.parse(line) as T);
        } catch (error) {
          if (this.onMalformed) {
            this.onMalformed(line, error);
          } else {
            throw error;
          }
        }
      }
    }
    if (new TextEncoder().encode(this.buffer).byteLength > this.maxRecordBytes) {
      throw new Error("JSONL record exceeds byte limit");
    }
  }

  finish(): void {
    this.buffer += this.decoder.decode();
    const remaining = this.buffer.replace(/\r$/, "");
    if (remaining.trim()) {
      if (this.onMalformed) {
        this.onMalformed(remaining, new Error("incomplete JSONL record"));
        this.buffer = "";
      } else {
        throw new Error("incomplete JSONL record");
      }
    }
  }
}
