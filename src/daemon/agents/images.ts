import { createHash } from "node:crypto";
import { mkdir, readdir, readFile, stat, unlink, utimes, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { AgentImage } from "../../shared/protocol/agents.ts";
import type { UserImageRef } from "../../shared/domain/agents.ts";

export const IMAGE_HASH_PATTERN = /^[a-f0-9]{64}$/;
/** ~1GB: roughly the last 500 image-bearing messages at the 2MB/image maximum. */
export const DEFAULT_IMAGE_CACHE_BYTES = 1024 * 1024 * 1024;

const MIME_EXTENSIONS: Record<AgentImage["mimeType"], string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/gif": "gif",
  "image/webp": "webp",
};

export function imageHashFor(dataBase64: string): string {
  return createHash("sha256").update(Buffer.from(dataBase64, "base64")).digest("hex");
}

/** Content-addressed sidecar store for user-uploaded image bytes.
 *
 *  Rows in the transcript journal carry only `UserImageRef` metadata; the
 *  bytes live here as flat files named by SHA-256 hex. Eviction is a global
 *  size cap with LRU order driven by file atime (touched on store and serve),
 *  swept opportunistically on every store. */
export class ImageCache {
  private sweepChain: Promise<void> = Promise.resolve();

  constructor(
    readonly root: string,
    private readonly maxBytes: number = DEFAULT_IMAGE_CACHE_BYTES,
  ) {}

  private filePath(hash: string): string {
    return join(this.root, hash);
  }

  private metaPath(hash: string): string {
    return join(this.root, `${hash}.json`);
  }

  /** Stores one validated upload; returns the ref to journal on the row. Idempotent per content hash. */
  async store(image: AgentImage): Promise<UserImageRef> {
    const bytes = Buffer.from(image.data, "base64");
    const hash = createHash("sha256").update(bytes).digest("hex");
    await mkdir(this.root, { recursive: true });
    try {
      await stat(this.filePath(hash));
      await utimes(this.filePath(hash), new Date(), new Date()).catch(() => undefined);
    } catch {
      const extension = MIME_EXTENSIONS[image.mimeType];
      await writeFile(this.filePath(hash), bytes);
      await writeFile(this.metaPath(hash), JSON.stringify({ mimeType: image.mimeType, extension }));
    }
    void this.sweep().catch(() => undefined);
    return { hash, mimeType: image.mimeType, name: image.name ?? `image.${MIME_EXTENSIONS[image.mimeType]}` };
  }

  /** Reads bytes for serving; touches the entry so serving counts as use. Returns undefined when evicted/unknown. */
  async read(hash: string): Promise<{ bytes: Uint8Array; mimeType: AgentImage["mimeType"] } | undefined> {
    if (!IMAGE_HASH_PATTERN.test(hash)) return undefined;
    let meta: { mimeType?: unknown };
    try {
      meta = JSON.parse(await readFile(this.metaPath(hash), "utf8")) as { mimeType?: unknown };
    } catch {
      return undefined;
    }
    if (meta.mimeType !== "image/png" && meta.mimeType !== "image/jpeg" && meta.mimeType !== "image/gif" && meta.mimeType !== "image/webp") {
      return undefined;
    }
    let bytes: Buffer;
    try {
      bytes = await readFile(this.filePath(hash));
    } catch {
      return undefined;
    }
    await utimes(this.filePath(hash), new Date(), new Date()).catch(() => undefined);
    return { bytes: new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength), mimeType: meta.mimeType };
  }

  /** Deletes least-recently-used entries until the directory fits the cap. Sweeps serialize per instance. */
  sweep(): Promise<void> {
    const run = this.sweepChain.then(() => this.sweepNow());
    this.sweepChain = run.catch(() => undefined);
    return run;
  }

  private async sweepNow(): Promise<void> {
      let entries: string[];
      try {
        entries = await readdir(this.root);
      } catch {
        return;
      }
      const files: Array<{ hash: string; size: number; atimeMs: number }> = [];
      let total = 0;
      for (const entry of entries) {
        if (!IMAGE_HASH_PATTERN.test(entry)) continue;
        try {
          const info = await stat(this.filePath(entry));
          if (!info.isFile()) continue;
          total += info.size;
          files.push({ hash: entry, size: info.size, atimeMs: info.atimeMs });
        } catch {
          continue;
        }
      }
      if (total <= this.maxBytes) return;
      files.sort((a, b) => a.atimeMs - b.atimeMs);
      for (const file of files) {
        if (total <= this.maxBytes) break;
        try {
          await unlink(this.filePath(file.hash));
          await unlink(this.metaPath(file.hash)).catch(() => undefined);
          total -= file.size;
        } catch {
          continue;
        }
      }
    }
}
