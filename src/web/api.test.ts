import { describe, expect, test } from "bun:test";
import { createWorkspaceApi, WorkspaceApiError } from "./api.ts";

const snapshot = { projects: [], workspaces: [], locations: [] };
test("client requests and validates snapshots", async () => {
  const calls: Request[] = [];
  const api = createWorkspaceApi(async (input, init) => { calls.push(new Request(new URL(input.toString(), "http://localhost"), init)); return Response.json(snapshot); });
  expect(await api.snapshot()).toEqual(snapshot);
  expect(calls[0].url).toContain("/api/workspaces/snapshot");
});
test("client reports API errors", async () => {
  const api = createWorkspaceApi(async () => Response.json({ error: "invalid-root", message: "Directory does not exist or is inaccessible" }, { status: 400 }));
  expect(api.snapshot()).rejects.toThrow("Directory does not exist or is inaccessible");
});
test("client serializes mutations", async () => {
  let request: Request | undefined;
  const api = createWorkspaceApi(async (input, init) => {
    request = new Request(new URL(input.toString(), "http://localhost"), init);
    return Response.json({
      id: "project-1",
      configuredRootPath: "/repo",
      canonicalRootPath: "/repo",
      displayLabel: "Repo",
      archivedAt: null,
    });
  });
  await api.registerProject({ configuredRootPath: "/repo", displayLabel: "Repo" });
  expect(request?.method).toBe("POST");
  expect(await request?.json()).toEqual({ configuredRootPath: "/repo", displayLabel: "Repo" });
});

test("client validates typed agent responses and serializes commands", async () => {
  const calls: Request[] = [];
  const agent = {
    id: "agent-1", workspaceId: "workspace-1", title: "Agent", status: "idle" as const,
    modelPreference: null, thinkingPreference: null, live: true, persisted: false,
  };
  const api = createWorkspaceApi(async (input, init) => {
    calls.push(new Request(new URL(input.toString(), "http://localhost"), init));
    if (String(input).endsWith("/capabilities")) {
      return Response.json({ models: [{ provider: "test", id: "model", name: "Model", api: "test", input: ["text"], authenticated: true, supportedThinkingLevels: ["low"] }], thinkingLevels: ["low"] });
    }
    if (String(input).endsWith("/follow-up")) return Response.json({ accepted: true });
    if (String(input).endsWith("/ui-response")) return Response.json({ ok: true });
    return Response.json(agent);
  });
  expect(await api.agent("agent-1")).toEqual(agent);
  expect(await api.capabilities("agent-1")).toMatchObject({ thinkingLevels: ["low"] });
  await api.followUp("agent-1", "Review this");
  expect(calls.at(-1)?.url).toContain("/api/agents/agent-1/follow-up");
  expect(await calls.at(-1)?.json()).toEqual({ message: "Review this" });
  await api.respondUi("agent-1", { id: "req-1", value: "Answer" });
  expect(calls.at(-1)?.url).toContain("/api/agents/agent-1/ui-response");
  expect(await calls.at(-1)?.json()).toEqual({ id: "req-1", value: "Answer" });
});

test("client searches workspace files and compacts agents", async () => {
  const calls: string[] = [];
  const api = createWorkspaceApi(async (input, init) => {
    calls.push(String(input));
    if (String(input).includes("/files/search")) {
      return Response.json({ query: "rea", entries: [{ path: "README.md", kind: "file" }], truncated: false });
    }
    return Response.json({ accepted: true });
  });
  const result = await api.searchFiles("workspace-1", "rea");
  expect(result.entries).toEqual([{ path: "README.md", kind: "file" }]);
  expect(calls[0]).toContain("/api/workspaces/workspace-1/files/search?q=rea");
  await api.compact("agent-1");
  expect(calls[1]).toContain("/api/agents/agent-1/compact");
});

test("client rejects malformed successful command responses", async () => {
  const api = createWorkspaceApi(async () => Response.json({ accepted: false }));
  await expect(api.prompt("agent-1", "Hello")).rejects.toThrow();
});

test("client lists pi models for settings", async () => {
  const api = createWorkspaceApi(async (input) => {
    expect(String(input)).toBe("/api/models");
    return Response.json({ models: [{ provider: "test", id: "model", name: "Model", api: "test", input: ["text"], authenticated: true, supportedThinkingLevels: ["low"] }] });
  });
  const models = await api.listModels();
  expect(models).toHaveLength(1);
  expect(models[0]).toMatchObject({ provider: "test", id: "model" });
});

test("client requests worktree operations and suggestions", async () => {
  const calls: Request[] = [];
  const api = createWorkspaceApi(async (input, init) => {
    calls.push(new Request(new URL(input.toString(), "http://localhost"), init));
    if (String(input).includes("/worktrees/suggest")) {
      return Response.json({ label: "Test Label", branch: "feature/test", folder: "test-folder" });
    }
    if (String(input).includes("/worktree/remove")) {
      return Response.json({ ok: true });
    }
    return Response.json({
      workspace: {
      id: "wsp_123",
      projectId: "prj_123",
      kind: "worktree",
      cwd: "/worktrees/test",
      checkoutRoot: "/worktrees/test",
      mainRepositoryRoot: "/repo",
      branchRef: "feature/test",
      displayLabel: "Test Worktree",
      locationId: "loc_123",
      ownershipState: "owned",
      markerId: "m_1",
      markerPath: "/worktrees/test/.passage-worktree.json",
      repairDetail: null,
      archivedAt: null,
      },
      setup: null,
    });
  });

  const suggestion = await api.suggestWorktree("prj_123", "Test purpose");
  expect(suggestion.label).toBe("Test Label");
  expect(suggestion.branch).toBe("feature/test");

  const created = await api.createWorktree("prj_123", { locationId: "loc_123", ref: "feature/test", label: "Test Worktree" });
  expect(created.workspace.id).toBe("wsp_123");
  expect(created.workspace.kind).toBe("worktree");

  await api.removeWorktree("wsp_123", true);
  expect(calls.at(-1)?.url).toContain("/api/workspaces/wsp_123/worktree/remove");
});

test("client aborts a hung read instead of waiting forever", async () => {
  // A mobile suspend or dropped QUIC stream can leave a fetch pending forever;
  // the client must abort it and surface a retryable timeout, not spin.
  const api = createWorkspaceApi(
    (_input, init) => new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => reject(new Error("aborted")));
    }),
    { requestTimeoutMs: 20, mutationTimeoutMs: 20 },
  );
  await expect(api.snapshot()).rejects.toBeInstanceOf(WorkspaceApiError);
  await expect(api.snapshot()).rejects.toMatchObject({ code: "timeout" });
});

test("client disables the timeout once a response resolves", async () => {
  const api = createWorkspaceApi(
    async () => Response.json(snapshot),
    { requestTimeoutMs: 25 },
  );
  expect(await api.snapshot()).toEqual(snapshot);
});

test("client starts, reads, and cancels workspace action runs", async () => {
  const run = {
    id: "arun_1",
    workspaceId: "wsp_123",
    actionId: "setup",
    status: "running",
    commands: ["./init.sh"],
    results: [],
    currentCommand: "./init.sh",
    error: null,
    startedAt: new Date().toISOString(),
    finishedAt: null,
  };
  const calls: string[] = [];
  const api = createWorkspaceApi(async (input, init) => {
    calls.push(`${init?.method ?? "GET"} ${String(input)}`);
    if (String(input).includes("/actions")) {
      return Response.json(String(input).endsWith("/actions") ? { actions: [] } : run, { status: String(input).endsWith("/run") ? 202 : 200 });
    }
    throw new Error(`unexpected request ${String(input)}`);
  });
  expect(await api.listWorkspaceActions("wsp_123")).toEqual({ actions: [] });
  expect((await api.runWorkspaceAction("wsp_123", "setup")).id).toBe("arun_1");
  expect((await api.getWorkspaceActionRun("wsp_123", "arun_1")).status).toBe("running");
  expect((await api.cancelWorkspaceActionRun("wsp_123", "arun_1")).workspaceId).toBe("wsp_123");
  expect(calls).toEqual([
    "GET /api/workspaces/wsp_123/actions",
    "POST /api/workspaces/wsp_123/actions/run",
    "GET /api/workspaces/wsp_123/actions/runs/arun_1",
    "POST /api/workspaces/wsp_123/actions/runs/arun_1/cancel",
  ]);
});
