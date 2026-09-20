import { describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MetadataStore } from "../metadata/index.ts";
import { DiagnosticRepository } from "../metadata/repositories.ts";
import { createDiagnosticRoutes } from "./diagnostics.ts";

const request = (path: string, init?: RequestInit) => new Request(`http://localhost${path}`, init);

async function openStore() {
  const directory = await mkdtemp(join(tmpdir(), "passage-diagnostics-"));
  const store = new MetadataStore(join(directory, "metadata.sqlite"));
  return { directory, store };
}

const event = (overrides: Record<string, unknown> = {}) => ({
  pageInstanceId: "page-1",
  seq: 0,
  clientTsMs: 1_700_000_000_000,
  kind: "snapshot",
  ...overrides,
});

describe("diagnostics HTTP API", () => {
  test("stores a valid batch and reports the count", async () => {
    const { directory, store } = await openStore();
    try {
      const app = createDiagnosticRoutes(new DiagnosticRepository(store.db));
      const res = await app.fetch(request("/api/diagnostics/events", {
        method: "POST",
        body: JSON.stringify({ events: [event(), event({ seq: 1, kind: "lifecycle", payload: { transition: "visible" } })] }),
      }));
      expect(res.status).toBe(200);
      expect(await res.json()).toMatchObject({ ok: true, stored: 2 });
      expect(res.headers.get("Cache-Control")).toBe("no-store");
    } finally {
      store.close();
      await rm(directory, { recursive: true, force: true });
    }
  });

  test("rejects invalid shapes and oversized bodies", async () => {
    const { directory, store } = await openStore();
    try {
      const app = createDiagnosticRoutes(new DiagnosticRepository(store.db));
      const bad = await app.fetch(request("/api/diagnostics/events", {
        method: "POST",
        body: JSON.stringify({ events: [{ ...event(), transcriptText: "secret" }] }),
      }));
      expect(bad.status).toBe(400);
      const big = await app.fetch(request("/api/diagnostics/events", {
        method: "POST",
        body: JSON.stringify({ events: [event()] }).padEnd(40 * 1024, " "),
      }));
      expect(big.status).toBe(413);
    } finally {
      store.close();
      await rm(directory, { recursive: true, force: true });
    }
  });

  test("duplicate (page, seq) deliveries are idempotent", async () => {
    const { directory, store } = await openStore();
    try {
      const app = createDiagnosticRoutes(new DiagnosticRepository(store.db));
      const post = () => app.fetch(request("/api/diagnostics/events", {
        method: "POST",
        body: JSON.stringify({ events: [event()] }),
      }));
      expect(((await (await post()).json()) as { stored: number }).stored).toBe(1);
      expect(((await (await post()).json()) as { stored: number }).stored).toBe(0);
    } finally {
      store.close();
      await rm(directory, { recursive: true, force: true });
    }
  });

  test("retention prunes beyond the row bound", async () => {
    const { directory, store } = await openStore();
    try {
      const repo = new DiagnosticRepository(store.db);
      const at = Date.now();
      repo.insertBatch(
        Array.from({ length: 5 }, (_, i) => ({
          pageInstanceId: `page-${i}`,
          seq: 0,
          clientTsMs: at,
          receivedAtMs: at,
          kind: "snapshot",
          payloadJson: "{}",
        })),
        { maxRows: 3 },
      );
      expect(repo.count()).toBe(3);
    } finally {
      store.close();
      await rm(directory, { recursive: true, force: true });
    }
  });

  test("database write failures are acknowledged, never 5xx", async () => {
    const { directory, store } = await openStore();
    const repo = new DiagnosticRepository(store.db);
    store.close();
    const app = createDiagnosticRoutes(repo);
    const res = await app.fetch(request("/api/diagnostics/events", {
      method: "POST",
      body: JSON.stringify({ events: [event()] }),
    }));
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, dropped: true });
    await rm(directory, { recursive: true, force: true });
  });
});
