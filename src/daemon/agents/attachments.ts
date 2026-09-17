import { createHash } from "node:crypto";
import { mkdir, readdir, readFile, stat, unlink, utimes, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import type { AgentFile, AgentImage } from "../../shared/protocol/agents.ts";
import type { UserFileRef, UserImageRef } from "../../shared/domain/agents.ts";

export const ATTACHMENT_HASH_PATTERN = /^[a-f0-9]{64}$/;
/** ~1GB shared across images and generic file uploads: roughly the last 500
 *  image-bearing messages at the 2MB/image maximum. */
export const DEFAULT_ATTACHMENT_CACHE_BYTES = 1024 * 1024 * 1024;

export type AttachmentKind = "image" | "file";
export type StoredAttachment = {
  bytes: Uint8Array;
  mimeType: string;
  name: string;
  kind: AttachmentKind;
};

const IMAGE_MIME_TYPES = ["image/png", "image/jpeg", "image/gif", "image/webp"] as const;

const MIME_EXTENSIONS: Record<(typeof IMAGE_MIME_TYPES)[number], string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/gif": "gif",
  "image/webp": "webp",
};

function isImageMimeType(value: unknown): value is (typeof IMAGE_MIME_TYPES)[number] {
  return typeof value === "string" && (IMAGE_MIME_TYPES as readonly string[]).includes(value);
}

export function attachmentHashFor(dataBase64: string): string {
  return createHash("sha256").update(Buffer.from(dataBase64, "base64")).digest("hex");
}

/** Strips directories and unsafe characters; always returns a safe non-empty name. */
export function sanitizeAttachmentFilename(name: string): string {
  const base = basename(name).trim();
  const cleaned = base.replace(/[^A-Za-z0-9._-]+/g, "_").replace(/^\.+/, "_").slice(0, 128);
  if (!cleaned || cleaned === "." || cleaned === "..") return "upload";
  return cleaned;
}

/** Falls back to octet-stream unless the stored MIME looks like a valid
 *  `type/subtype` token — upload MIME types are free-form client input, so
 *  they must never reach a Content-Type header unsanitized. */
export function safeAttachmentContentType(mimeType: string): string {
  return /^[\w!#$&^_.+-]+\/[\w!#$&^_.+-]+$/.test(mimeType) ? mimeType : "application/octet-stream";
}

/** Content-addressed sidecar store for user-uploaded bytes — images and
 *  generic file attachments alike.
 *
 *  Rows in the transcript journal carry only ref metadata (`UserImageRef` /
 *  `UserFileRef`); the bytes live here as flat files named by SHA-256 hex
 *  with a `<hash>.json` sidecar holding `{ kind, mimeType, name }`.
 *  Eviction is a global size cap with LRU order driven by file atime
 *  (touched on store and serve), swept opportunistically on every store.
 *
 *  Images additionally travel to the model as API blocks; files are
 *  referenced by their absolute cache path in the Pi-bound message text
 *  (same turn, never a separate message) so the agent's file tools can
 *  read them. */
export class AttachmentCache {
  private sweepChain: Promise<void> = Promise.resolve();

  constructor(
    readonly root: string,
    private readonly maxBytes: number = DEFAULT_ATTACHMENT_CACHE_BYTES,
  ) {}

  private filePath(hash: string): string {
    return join(this.root, hash);
  }

  private metaPath(hash: string): string {
    return join(this.root, `${hash}.json`);
  }

  /** Stores one validated image upload; returns the ref to journal on the row. Idempotent per content hash. */
  async storeImage(image: AgentImage): Promise<UserImageRef> {
    const bytes = Buffer.from(image.data, "base64");
    const hash = await this.storeBytes(bytes, {
      kind: "image",
      mimeType: image.mimeType,
      name: image.name ?? `image.${MIME_EXTENSIONS[image.mimeType]}`,
    });
    return { hash, mimeType: image.mimeType, name: image.name ?? `image.${MIME_EXTENSIONS[image.mimeType]}` };
  }

  /** Stores one validated file upload; returns the ref to journal on the row. Idempotent per content hash. */
  async storeFile(file: AgentFile): Promise<UserFileRef> {
    const bytes = Buffer.from(file.data, "base64");
    const name = sanitizeAttachmentFilename(file.name);
    const hash = await this.storeBytes(bytes, { kind: "file", mimeType: file.mimeType, name });
    return { hash, name, path: this.filePath(hash), size: bytes.byteLength, mimeType: file.mimeType };
  }

  /** Reads one entry for serving; touches it so serving counts as use. Returns undefined when evicted/unknown. */
  async read(hash: string): Promise<StoredAttachment | undefined> {
    if (!ATTACHMENT_HASH_PATTERN.test(hash)) return undefined;
    let meta: { kind?: unknown; mimeType?: unknown; name?: unknown };
    try {
      meta = JSON.parse(await readFile(this.metaPath(hash), "utf8")) as { kind?: unknown; mimeType?: unknown; name?: unknown };
    } catch {
      return undefined;
    }
    // Entries written before the image/file unification carry no kind;
    // back then only images existed, so infer from the MIME type.
    const kind: AttachmentKind = meta.kind === "image" || meta.kind === "file"
      ? meta.kind
      : isImageMimeType(meta.mimeType) ? "image" : "file";
    if (kind === "image" && !isImageMimeType(meta.mimeType)) return undefined;
    if (typeof meta.mimeType !== "string" || meta.mimeType.length === 0) return undefined;
    const name = typeof meta.name === "string" && meta.name.length > 0 ? meta.name : "upload";
    let bytes: Buffer;
    try {
      bytes = await readFile(this.filePath(hash));
    } catch {
      return undefined;
    }
    await utimes(this.filePath(hash), new Date(), new Date()).catch(() => undefined);
    return { bytes: new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength), mimeType: meta.mimeType, name, kind };
  }

  private async storeBytes(bytes: Buffer, meta: { kind: AttachmentKind; mimeType: string; name: string }): Promise<string> {
    const hash = createHash("sha256").update(bytes).digest("hex");
    await mkdir(this.root, { recursive: true });
    try {
      await stat(this.filePath(hash));
      await utimes(this.filePath(hash), new Date(), new Date()).catch(() => undefined);
    } catch {
      await writeFile(this.filePath(hash), bytes);
      await writeFile(this.metaPath(hash), JSON.stringify(meta));
    }
    void this.sweep().catch(() => undefined);
    return hash;
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
        if (!ATTACHMENT_HASH_PATTERN.test(entry)) continue;
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

/** Renders the inline file references appended to the Pi-bound message.
 *  Kept in one place so the service and tests share the exact format. */
export function formatFileRefsForMessage(files: UserFileRef[]): string {
  const lines = files.map(
    (file) => `- ${file.name} (${file.path}, ${file.size} bytes, ${file.mimeType})`,
  );
  return `\n\nAttached files (already saved locally — read them with your file tools):\n${lines.join("\n")}`;
}

/** Returns the Pi-bound message: original text plus inline file references.
 *  Images are NOT folded in here — they travel as model API blocks. */
export function withFileRefs(message: string, files?: UserFileRef[]): string {
  if (!files?.length) return message;
  return `${message}${formatFileRefsForMessage(files)}`;
}
