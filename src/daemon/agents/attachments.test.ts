import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm, utimes } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  AttachmentCache,
  attachmentHashFor,
  safeAttachmentContentType,
  sanitizeAttachmentFilename,
  withFileRefs,
} from "./attachments.ts";
import type { AgentFile, AgentImage } from "../../shared/protocol/agents.ts";

const roots: string[] = [];
async function root(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "passage-attachment-cache-"));
  roots.push(dir);
  return dir;
}
afterEach(async () => {
  for (const dir of roots.splice(0)) await rm(dir, { recursive: true, force: true });
});

function image(name: string, bytes: string, mimeType: AgentImage["mimeType"] = "image/png"): AgentImage {
  return { type: "image", name, data: Buffer.from(bytes).toString("base64"), mimeType };
}

function file(name: string, bytes: string, mimeType = "text/plain"): AgentFile {
  return { type: "file", name, data: Buffer.from(bytes).toString("base64"), mimeType };
}

describe("AttachmentCache images", () => {
  test("stores and serves bytes with metadata", async () => {
    const cache = new AttachmentCache(await root());
    const ref = await cache.storeImage(image("shot.png", "fake-png-bytes"));
    expect(ref.hash).toBe(attachmentHashFor(Buffer.from("fake-png-bytes").toString("base64")));
    expect(ref).toMatchObject({ mimeType: "image/png", name: "shot.png" });

    const served = await cache.read(ref.hash);
    expect(served).toMatchObject({ mimeType: "image/png", kind: "image", name: "shot.png" });
    expect(Buffer.from(served!.bytes).toString()).toBe("fake-png-bytes");
  });

  test("defaults the filename when the upload has no name", async () => {
    const cache = new AttachmentCache(await root());
    const ref = await cache.storeImage({ type: "image", data: Buffer.from("x").toString("base64"), mimeType: "image/jpeg" });
    expect(ref.name).toBe("image.jpg");
  });

  test("storing identical bytes twice is idempotent", async () => {
    const cache = new AttachmentCache(await root());
    const first = await cache.storeImage(image("a.png", "same-bytes"));
    const second = await cache.storeImage(image("b.png", "same-bytes"));
    expect(second.hash).toBe(first.hash);
    await cache.sweep();
    expect((await cache.read(first.hash))?.mimeType).toBe("image/png");
  });

  test("rejects malformed hashes without touching disk", async () => {
    const cache = new AttachmentCache(await root());
    expect(await cache.read("not-a-hash")).toBeUndefined();
    expect(await cache.read("../escape")).toBeUndefined();
    expect(await cache.read("0".repeat(64))).toBeUndefined();
  });

  test("sweep evicts least-recently-used entries over the cap", async () => {
    const dir = await root();
    const pad = (seed: string, size: number) => seed + "x".repeat(size - seed.length);
    const cache = new AttachmentCache(dir, 2 * 1024);
    const oldest = await cache.storeImage(image("old.png", pad("old", 700)));
    // Pin recency immediately after each store: stores queue a background
    // sweep, so pinning must preserve write order no matter when that sweep
    // (or the explicit one below) observes the directory.
    const now = Date.now();
    await utimes(join(dir, oldest.hash), new Date(now - 3000), new Date(now - 3000));
    const middle = await cache.storeImage(image("mid.png", pad("mid", 700)));
    await utimes(join(dir, middle.hash), new Date(now - 2000), new Date(now - 2000));
    const newest = await cache.storeImage(image("new.png", pad("new", 700)));
    await utimes(join(dir, newest.hash), new Date(now - 1000), new Date(now - 1000));
    await cache.sweep();

    expect(await cache.read(oldest.hash)).toBeUndefined();
    expect(await cache.read(middle.hash)).toBeDefined();
    expect(await cache.read(newest.hash)).toBeDefined();
  });
});

describe("AttachmentCache files", () => {
  test("stores file bytes under the content hash and refs the absolute path", async () => {
    const dir = await root();
    const cache = new AttachmentCache(dir);
    const ref = await cache.storeFile(file("report.txt", "hello"));
    expect(ref.hash).toBe(attachmentHashFor(Buffer.from("hello").toString("base64")));
    expect(ref).toMatchObject({ name: "report.txt", size: 5, mimeType: "text/plain" });
    expect(ref.path).toBe(join(dir, ref.hash));

    const served = await cache.read(ref.hash);
    expect(served).toMatchObject({ kind: "file", name: "report.txt", mimeType: "text/plain" });
    expect(Buffer.from(served!.bytes).toString()).toBe("hello");
  });

  test("identical file bytes share one entry and the LRU cap covers both kinds", async () => {
    const dir = await root();
    const pad = (seed: string, size: number) => seed + "x".repeat(size - seed.length);
    const cache = new AttachmentCache(dir, 2 * 1024);
    const first = await cache.storeFile(file("a.txt", pad("f", 700)));
    const second = await cache.storeFile(file("b.txt", pad("f", 700)));
    expect(second.hash).toBe(first.hash);
    // Image and file entries compete for the same budget.
    const img = await cache.storeImage(image("big.png", pad("img", 1500)));
    expect(await cache.read(img.hash)).toBeDefined();
    await cache.sweep();
    expect(await cache.read(first.hash)).toBeUndefined();
  });

  test("reads legacy kind-less entries by inferring the kind from the MIME type", async () => {
    const cache = new AttachmentCache(await root());
    const ref = await cache.storeImage(image("shot.png", "legacy-bytes"));
    const { kind, ...meta } = JSON.parse(
      await Bun.file(join(cache.root, `${ref.hash}.json`)).text(),
    ) as Record<string, unknown>;
    expect(kind).toBe("image");
    await Bun.write(join(cache.root, `${ref.hash}.json`), JSON.stringify(meta));
    expect(await cache.read(ref.hash)).toMatchObject({ kind: "image", mimeType: "image/png" });
  });
});

describe("sanitizeAttachmentFilename", () => {
  test("strips directories and unsafe characters", () => {
    expect(sanitizeAttachmentFilename("../../etc/passwd")).toBe("passwd");
    expect(sanitizeAttachmentFilename("/abs/path/report final.pdf")).toBe("report_final.pdf");
    expect(sanitizeAttachmentFilename("...")).toBe("_");
  });
});

describe("safeAttachmentContentType", () => {
  test("passes through valid type/subtype tokens and rejects the rest", () => {
    expect(safeAttachmentContentType("text/csv")).toBe("text/csv");
    expect(safeAttachmentContentType("application/octet-stream")).toBe("application/octet-stream");
    expect(safeAttachmentContentType("no-slash")).toBe("application/octet-stream");
    expect(safeAttachmentContentType("text/html\nX-Injected: 1")).toBe("application/octet-stream");
  });
});

describe("withFileRefs", () => {
  test("leaves the message untouched without files", () => {
    expect(withFileRefs("hi")).toBe("hi");
    expect(withFileRefs("hi", [])).toBe("hi");
  });

  test("folds file path references into the same message", () => {
    const out = withFileRefs("Look", [
      { hash: "a".repeat(64), name: "a.csv", path: "/sessions/agt/uploads/a.csv", size: 10, mimeType: "text/csv" },
    ]);
    expect(out.startsWith("Look\n\n")).toBe(true);
    expect(out).toContain("a.csv");
    expect(out).toContain("/sessions/agt/uploads/a.csv");
    // One message, not two — no separate user turn for the attachments.
    expect(out.split("\n\nAttached files").length).toBe(2);
  });
});
