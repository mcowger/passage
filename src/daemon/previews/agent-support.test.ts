import { describe, expect, test } from "bun:test";
import { createAgentPreviewSupport, type AgentPreviewBackend } from "./agent-support.ts";

function backend(rows: { id: string }[] = [], candidates: { port: number; confidence: "high" | "uncertain"; source: "script" | "process" }[] = []): AgentPreviewBackend & {
  calls: { created: { label?: string; targetUrl: string }[]; opened: string[] };
  resolveOpen: () => void;
} {
  const calls = { created: [] as { label?: string; targetUrl: string }[], opened: [] as string[] };
  let releaseOpen: (() => void) | null = null;
  const openGate = new Promise<void>((resolve) => { releaseOpen = resolve; });
  return {
    calls,
    resolveOpen: () => releaseOpen?.(),
    list: () => rows,
    sessionName: (id: string) => `pp-${id}`,
    portCandidates: async () => candidates,
    create: async (_workspaceId: string, input: { label?: string; targetUrl: string }) => {
      calls.created.push(input);
      const id = `prv_${calls.created.length}`;
      rows.push({ id });
      return { id };
    },
    // Block open until released so tests can observe "row exists, open pending".
    open: async (id: string) => {
      calls.opened.push(id);
      await openGate;
      return null;
    },
  };
}

describe("agent preview support", () => {
  test("pins the session only when exactly one preview exists", () => {
    expect(createAgentPreviewSupport(backend()).sessionForWorkspace("w")).toBeNull();
    expect(createAgentPreviewSupport(backend([{ id: "a" }])).sessionForWorkspace("w")).toBe("pp-a");
    expect(createAgentPreviewSupport(backend([{ id: "a" }, { id: "b" }])).sessionForWorkspace("w")).toBeNull();
  });

  test("auto-open creates the default target and opens in the background", async () => {
    const fake = backend([], [{ port: 5173, confidence: "high", source: "process" }]);
    const support = createAgentPreviewSupport(fake);
    // ensure resolves once the row exists, without waiting for Chromium.
    await support.ensurePreviewForWorkspace("w");
    expect(fake.calls.created).toEqual([{ label: "Agent preview", targetUrl: "http://localhost:5173" }]);
    expect(fake.calls.opened).toHaveLength(1);
    expect(support.sessionForWorkspace("w")).toBe("pp-prv_1");
    fake.resolveOpen();
  });

  test("falls back to localhost:3000 with no candidates and skips existing rows", async () => {
    const fake = backend();
    const support = createAgentPreviewSupport(fake);
    await support.ensurePreviewForWorkspace("w");
    expect(fake.calls.created[0]?.targetUrl).toBe("http://localhost:3000");
    fake.resolveOpen();
    // Second call is a no-op: the row now exists.
    await support.ensurePreviewForWorkspace("w");
    expect(fake.calls.created).toHaveLength(1);
  });

  test("concurrent ensures create only once", async () => {
    const fake = backend();
    const support = createAgentPreviewSupport(fake);
    await Promise.all([
      support.ensurePreviewForWorkspace("w"),
      support.ensurePreviewForWorkspace("w"),
      support.ensurePreviewForWorkspace("w"),
    ]);
    expect(fake.calls.created).toHaveLength(1);
    fake.resolveOpen();
  });

  test("never throws when the backend fails", async () => {
    const failing: AgentPreviewBackend = {
      list: () => { throw new Error("db gone"); },
      sessionName: (id: string) => id,
      portCandidates: async () => { throw new Error("proc gone"); },
      create: async () => { throw new Error("create gone"); },
      open: async () => null,
    };
    const support = createAgentPreviewSupport(failing);
    expect(support.sessionForWorkspace("w")).toBeNull();
    await support.ensurePreviewForWorkspace("w");
  });
});
