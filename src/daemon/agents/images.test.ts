import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm, utimes } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ImageCache, imageHashFor } from "./images.ts";
import type { AgentImage } from "../../shared/protocol/agents.ts";

const roots: string[] = [];
async function root(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "passage-image-cache-"));
  roots.push(dir);
  return dir;
}
afterEach(async () => {
  for (const dir of roots.splice(0)) await rm(dir, { recursive: true, force: true });
});

function upload(name: string, bytes: string, mimeType: AgentImage["mimeType"] = "image/png"): AgentImage {
  return { type: "image", name, data: Buffer.from(bytes).toString("base64"), mimeType };
}

describe("ImageCache", () => {
  test("stores and serves bytes with metadata", async () => {
    const cache = new ImageCache(await root());
    const ref = await cache.store(upload("shot.png", "fake-png-bytes"));
    expect(ref.hash).toBe(imageHashFor(Buffer.from("fake-png-bytes").toString("base64")));
    expect(ref).toMatchObject({ mimeType: "image/png", name: "shot.png" });

    const served = await cache.read(ref.hash);
    expect(served?.mimeType).toBe("image/png");
    expect(Buffer.from(served!.bytes).toString()).toBe("fake-png-bytes");
  });

  test("defaults the filename when the upload has no name", async () => {
    const cache = new ImageCache(await root());
    const ref = await cache.store({ type: "image", data: Buffer.from("x").toString("base64"), mimeType: "image/jpeg" });
    expect(ref.name).toBe("image.jpg");
  });

  test("storing identical bytes twice is idempotent", async () => {
    const cache = new ImageCache(await root());
    const first = await cache.store(upload("a.png", "same-bytes"));
    const second = await cache.store(upload("b.png", "same-bytes"));
    expect(second.hash).toBe(first.hash);
    await cache.sweep();
    expect((await cache.read(first.hash))?.mimeType).toBe("image/png");
  });

  test("rejects malformed hashes without touching disk", async () => {
    const cache = new ImageCache(await root());
    expect(await cache.read("not-a-hash")).toBeUndefined();
    expect(await cache.read("../escape")).toBeUndefined();
    expect(await cache.read("0".repeat(64))).toBeUndefined();
  });

  test("sweep evicts least-recently-used entries over the cap", async () => {
    const dir = await root();
    const pad = (seed: string, size: number) => seed + "x".repeat(size - seed.length);
    const cache = new ImageCache(dir, 2 * 1024);
    const oldest = await cache.store(upload("old.png", pad("old", 700)));
    const middle = await cache.store(upload("mid.png", pad("mid", 700)));
    const newest = await cache.store(upload("new.png", pad("new", 700)));
    // Pin an unambiguous recency order regardless of filesystem timestamp granularity.
    const now = Date.now();
    await utimes(join(dir, oldest.hash), new Date(now - 3000), new Date(now - 3000));
    await utimes(join(dir, middle.hash), new Date(now - 2000), new Date(now - 2000));
    await utimes(join(dir, newest.hash), new Date(now - 1000), new Date(now - 1000));
    await cache.sweep();

    expect(await cache.read(oldest.hash)).toBeUndefined();
    expect(await cache.read(middle.hash)).toBeDefined();
    expect(await cache.read(newest.hash)).toBeDefined();
  });
});
