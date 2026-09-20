import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { MetadataRepositories, MetadataStore } from "../metadata/index.ts";
import { WorkspaceService } from "../workspaces/service.ts";
import { WorkspaceEventHub } from "../workspaces/events.ts";
import { WebPreviewManager, parseProcNetTcp, type AgentBrowserRunner } from "../previews/manager.ts";
import { createPreviewRoutes } from "./previews.ts";
import { normalizePreviewUrl } from "../../shared/domain/previews.ts";
import {
  MAX_PREVIEW_FRAME_BYTES,
  previewDownstreamMessageSchema,
  previewUpstreamMessageSchema,
} from "../../shared/protocol/previews.ts";
import { isAllowedPreviewRequest } from "../previews/relay.ts";
import { TerminalManager } from "../terminals/manager.ts";
import { WorkspaceScriptsService } from "../workspaces/scripts.ts";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((r) => rm(r, { recursive: true, force: true })));
});

function fakeRunner(handlers?: Partial<AgentBrowserRunner>): AgentBrowserRunner {
  return {
    version: async () => "v0.38.1",
    run: async (args: string[]) => {
      if (args.includes("stream") && args.includes("status")) {
        return { stdout: JSON.stringify({ success: true, data: { port: 41234 } }), stderr: "", exitCode: 0 };
      }
      if (args.includes("stream") && args.includes("enable")) {
        return { stdout: "", stderr: "Streaming is already enabled for this session", exitCode: 1 };
      }
      return { stdout: JSON.stringify({ success: true }), stderr: "", exitCode: 0 };
    },
    ...handlers,
  };
}

async function fixture(runner?: AgentBrowserRunner) {
  const root = await mkdtemp(join(tmpdir(), "passage-preview-"));
  roots.push(root);
  const store = new MetadataStore(":memory:");
  const repos = new MetadataRepositories(store.db);
  const workspaces = new WorkspaceService(repos);
  const project = await workspaces.registerProject(root, "Test Repo");
  const workspace = await workspaces.createDirectoryWorkspace(project.id, { displayLabel: "Test WS" });
  const manager = new WebPreviewManager(repos, workspaces, runner ?? fakeRunner());
  const events = new WorkspaceEventHub();
  const app = createPreviewRoutes(manager, events);
  return { root, store, repos, workspaces, project, workspace, manager, app };
}

const request = (path: string, init?: RequestInit) => new Request(`http://localhost${path}`, init);

describe("preview URL validation", () => {
  test("accepts loopback URLs with explicit ports", () => {
    expect(normalizePreviewUrl("http://localhost:5173")).toBe("http://localhost:5173/");
    expect(normalizePreviewUrl("5173")).toBe("http://localhost:5173/");
    expect(normalizePreviewUrl("http://127.0.0.1:3000/app")).toBe("http://127.0.0.1:3000/app");
    expect(normalizePreviewUrl("http://[::1]:8080/")).toBe("http://[::1]:8080/");
  });

  test("rejects remote hosts, missing ports, and credentials", () => {
    expect(() => normalizePreviewUrl("https://example.com:443/")).toThrow();
    expect(() => normalizePreviewUrl("http://localhost/app")).toThrow();
    expect(() => normalizePreviewUrl("http://user:pass@localhost:3000/")).toThrow();
    expect(() => normalizePreviewUrl("not a url")).toThrow();
  });
});

describe("previews HTTP API", () => {
  test("navigating a stopped preview starts the session and discovers its stream", async () => {
    const calls: string[] = [];
    const f = await fixture(fakeRunner({
      run: async (args) => {
        calls.push(args.join(" "));
        if (args.includes("stream") && args.includes("status")) {
          return { stdout: JSON.stringify({ success: true, data: { port: 45678 } }), stderr: "", exitCode: 0 };
        }
        return { stdout: JSON.stringify({ success: true }), stderr: "", exitCode: 0 };
      },
    }));
    const createRes = await f.app.fetch(request(`/api/workspaces/${f.workspace.id}/previews`, {
      method: "POST",
      body: JSON.stringify({ targetUrl: "http://localhost:3000/" }),
    }));
    const created = await createRes.json() as { id: string };
    expect(f.manager.streamPortFor(created.id)).toBeNull();

    // Without an explicit Start, entering a URL must launch the session and
    // leave the preview genuinely streamable rather than "ready" with no port.
    const navRes = await f.app.fetch(request(`/api/previews/${created.id}/navigate`, {
      method: "POST",
      body: JSON.stringify({ url: "http://127.0.0.1:5173/app" }),
    }));
    expect(navRes.status).toBe(200);
    const navigated = await navRes.json() as { status: string; currentUrl: string | null };
    expect(navigated.status).toBe("ready");
    expect(navigated.currentUrl).toBe("http://127.0.0.1:5173/app");
    expect(f.manager.streamPortFor(created.id)).toBe(45678);
    expect(calls.some((line) => line.includes("open --json http://127.0.0.1:5173/app"))).toBe(true);
    expect(calls.some((line) => line.includes("set viewport"))).toBe(true);
    f.store.close();
  });

  test("rediscover repairs a ready preview whose stream port was lost", async () => {
    const f = await fixture();
    const createRes = await f.app.fetch(request(`/api/workspaces/${f.workspace.id}/previews`, {
      method: "POST",
      body: JSON.stringify({ targetUrl: "http://localhost:3000/" }),
    }));
    const created = await createRes.json() as { id: string };
    await f.app.fetch(request(`/api/previews/${created.id}/open`, { method: "POST" }));
    expect(f.manager.streamPortFor(created.id)).toBe(41234);

    // Simulate an in-memory port loss (for example a daemon restart) while the
    // agent-browser session, and therefore the stream, is still alive. The
    // record stays "ready", so the old early-return skipped recovery entirely.
    const record = (f.manager as unknown as {
      recordFor(id: string): { runtime: { streamPort: number | null } } | null;
    }).recordFor(created.id);
    expect(record).not.toBeNull();
    record!.runtime.streamPort = null;

    expect(await f.manager.rediscover(created.id)).toBe(true);
    expect(f.manager.streamPortFor(created.id)).toBe(41234);
    expect(f.manager.previewStatus(created.id)).toBe("ready");
    f.store.close();
  });

  test("creates, opens, navigates, and stops a preview", async () => {
    const f = await fixture();
    const createRes = await f.app.fetch(request(`/api/workspaces/${f.workspace.id}/previews`, {
      method: "POST",
      body: JSON.stringify({ targetUrl: "5173" }),
    }));
    expect(createRes.status).toBe(201);
    const created = await createRes.json() as { id: string; targetUrl: string; status: string };
    expect(created.targetUrl).toBe("http://localhost:5173/");

    const openRes = await f.app.fetch(request(`/api/previews/${created.id}/open`, { method: "POST" }));
    expect(openRes.status).toBe(200);
    const opened = await openRes.json() as { status: string; currentUrl: string | null };
    expect(opened.status).toBe("ready");

    const navRes = await f.app.fetch(request(`/api/previews/${created.id}/navigate`, {
      method: "POST",
      body: JSON.stringify({ url: "http://127.0.0.1:3000/" }),
    }));
    expect(navRes.status).toBe(200);

    // Remote navigation is rejected.
    const badNav = await f.app.fetch(request(`/api/previews/${created.id}/navigate`, {
      method: "POST",
      body: JSON.stringify({ url: "https://example.com/" }),
    }));
    expect(badNav.status).toBe(400);

    const stopRes = await f.app.fetch(request(`/api/previews/${created.id}/stop`, { method: "POST" }));
    expect(stopRes.status).toBe(200);
    const stopped = await stopRes.json() as { status: string };
    expect(stopped.status).toBe("stopped");
    f.store.close();
  });

  test("open failure surfaces an error snapshot instead of throwing", async () => {
    const f = await fixture(fakeRunner({
      run: async () => ({ stdout: "", stderr: "browser exploded", exitCode: 1 }),
    }));
    const createRes = await f.app.fetch(request(`/api/workspaces/${f.workspace.id}/previews`, {
      method: "POST",
      body: JSON.stringify({ targetUrl: "http://localhost:3000/" }),
    }));
    const created = await createRes.json() as { id: string };
    const openRes = await f.app.fetch(request(`/api/previews/${created.id}/open`, { method: "POST" }));
    expect(openRes.status).toBe(502);
    const opened = await openRes.json() as { status: string };
    expect(opened.status).toBe("error");
    f.store.close();
  });

  test("input lease is only granted while ready", async () => {
    const f = await fixture();
    const createRes = await f.app.fetch(request(`/api/workspaces/${f.workspace.id}/previews`, {
      method: "POST",
      body: JSON.stringify({ targetUrl: "http://localhost:3000/" }),
    }));
    const created = await createRes.json() as { id: string };
    const early = await f.app.fetch(request(`/api/previews/${created.id}/lease`, {
      method: "POST",
      body: JSON.stringify({ clientId: "phone" }),
    }));
    expect(early.status).toBe(409);
    await f.app.fetch(request(`/api/previews/${created.id}/open`, { method: "POST" }));
    const taken = await f.app.fetch(request(`/api/previews/${created.id}/lease`, {
      method: "POST",
      body: JSON.stringify({ clientId: "phone" }),
    }));
    expect(taken.status).toBe(200);
    f.store.close();
  });
});

describe("proc-net parsing", () => {
  test("extracts loopback listeners with correct inodes", () => {
    const text = [
      "  sl  local_address rem_address   st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode",
      "   0: 0100007F:138D 00000000:0000 0A 00000000:00000000 00:00000000 00000000  1000        0 11111 1 0000000000000000 100 0 0 10 0",
      "   1: 00000000:22C5 00000000:0000 0A 00000000:00000000 00:00000000 00000000  1000        0 22222 1 0000000000000000 100 0 0 10 0",
      "   2: 0A00A8C0:1F90 00000000:0000 0A 00000000:00000000 00:00000000 00000000  1000        0 33333 1 0000000000000000 100 0 0 10 0",
      "   3: 0100007F:1F91 0100007F:1F91 01 00000000:00000000 00:00000000 00000000  1000        0 44444 1 0000000000000000 100 0 0 10 0",
    ].join("\n");
    // 0x138D = 5005 (loopback), 0x22C5 = 8901 (any-address, loopback-reachable).
    // 10.168.0.192 is not loopback; established connections (01) are ignored.
    expect(parseProcNetTcp(text, false)).toEqual([
      { port: 5005, inode: "11111" },
      { port: 8901, inode: "22222" },
    ]);
  });
});

describe("preview stream protocol", () => {
  test("upstream allowlist accepts frames and drops unknown types", () => {
    expect(previewUpstreamMessageSchema.safeParse({ type: "frame", seq: 1, data: "x", metadata: { deviceWidth: 1280, deviceHeight: 720 } }).success).toBe(true);
    expect(previewUpstreamMessageSchema.safeParse({ type: "status", connected: true }).success).toBe(true);
    expect(previewUpstreamMessageSchema.safeParse({ type: "tabs", tabs: [] }).success).toBe(true);
    expect(previewUpstreamMessageSchema.safeParse({ type: "url", url: "http://localhost:3000/" }).success).toBe(true);
    expect(previewUpstreamMessageSchema.safeParse({ type: "eval", js: "alert(1)" }).success).toBe(false);
    expect(previewUpstreamMessageSchema.safeParse({ type: "frame", seq: 1, data: "x".repeat(MAX_PREVIEW_FRAME_BYTES + 1), width: 800, height: 600 }).success).toBe(false);
  });

  test("downstream input is bounded and typed", () => {
    expect(previewDownstreamMessageSchema.safeParse({ type: "ack", seq: 3 }).success).toBe(true);
    expect(previewDownstreamMessageSchema.safeParse({ type: "config", pacing: "ack", maxFps: 15 }).success).toBe(true);
    expect(previewDownstreamMessageSchema.safeParse({ type: "input_mouse", eventType: "mousePressed", x: 10, y: 20, button: "left", clickCount: 1 }).success).toBe(true);
    expect(previewDownstreamMessageSchema.safeParse({ type: "input_mouse", eventType: "mousePressed", x: -5, y: 20 }).success).toBe(false);
    expect(previewDownstreamMessageSchema.safeParse({ type: "input_keyboard", eventType: "keyDown", key: "a", text: "a" }).success).toBe(true);
    expect(previewDownstreamMessageSchema.safeParse({ type: "raw", cdp: {} }).success).toBe(false);
  });
});

describe("preview origin policy", () => {  test("same-origin and loopback pass, cross-origin fails", () => {
    const same = new Request("http://localhost:3333/api/previews/x/ws", { headers: { Host: "localhost:3333", Origin: "http://localhost:3333" } });
    expect(isAllowedPreviewRequest(same)).toBe(true);
    const none = new Request("http://localhost:3333/api/previews/x/ws", { headers: { Host: "localhost:3333" } });
    expect(isAllowedPreviewRequest(none)).toBe(true);
    const evil = new Request("http://localhost:3333/api/previews/x/ws", { headers: { Host: "localhost:3333", Origin: "https://evil.example" } });
    expect(isAllowedPreviewRequest(evil)).toBe(false);
  });
});

describe("preview candidates from workspace scripts", () => {
  async function scriptFixture(paseoJson: unknown) {
    const root = await mkdtemp(join(tmpdir(), "passage-preview-scripts-"));
    roots.push(root);
    const store = new MetadataStore(":memory:");
    const repos = new MetadataRepositories(store.db);
    const workspaces = new WorkspaceService(repos);
    const project = await workspaces.registerProject(root, "Test Repo");
    const dir = join(root, "ws");
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, "paseo.json"), JSON.stringify(paseoJson));
    const workspace = await workspaces.createDirectoryWorkspace(project.id, {
      cwd: dir,
      displayLabel: "Scripts",
    });
    const terminals = new TerminalManager(workspaces);
    const scripts = new WorkspaceScriptsService(repos, terminals);
    const manager = new WebPreviewManager(repos, workspaces, fakeRunner(), scripts);
    return { root, store, workspace, terminals, scripts, manager };
  }

  test("running services lead as high-confidence script candidates", async () => {
    const f = await scriptFixture({
      scripts: { dev: { type: "service", command: "sleep 30", port: 48791 } },
    });
    await f.scripts.start(f.workspace.id, "dev");
    try {
      const candidates = await f.manager.portCandidates(f.workspace.id);
      const dev = candidates.find((c) => c.port === 48791);
      expect(dev).toMatchObject({ confidence: "high", source: "script" });
      expect(candidates[0]).toMatchObject({ port: 48791, source: "script" });
    } finally {
      f.scripts.stopForWorkspace(f.workspace.id);
      f.store.close();
    }
  });

  test("stopped services with explicit ports appear as uncertain script candidates", async () => {
    const f = await scriptFixture({
      scripts: { web: { type: "service", command: "sleep 30", port: 48792 } },
    });
    try {
      const candidates = await f.manager.portCandidates(f.workspace.id);
      expect(candidates.find((c) => c.port === 48792)).toMatchObject({
        confidence: "uncertain",
        source: "script",
      });
    } finally {
      f.store.close();
    }
  });

  test("services without a known port are skipped", async () => {
    const f = await scriptFixture({
      scripts: { api: { type: "service", command: "sleep 30" } },
    });
    try {
      const candidates = await f.manager.portCandidates(f.workspace.id);
      expect(candidates.filter((c) => c.source === "script")).toEqual([]);
    } finally {
      f.store.close();
    }
  });
});
