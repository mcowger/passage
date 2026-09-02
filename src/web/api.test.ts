import { describe, expect, test } from "bun:test";
import { createWorkspaceApi } from "./api.ts";

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
    return Response.json(agent);
  });
  expect(await api.agent("agent-1")).toEqual(agent);
  expect(await api.capabilities("agent-1")).toMatchObject({ thinkingLevels: ["low"] });
  await api.followUp("agent-1", "Review this");
  expect(calls.at(-1)?.url).toContain("/api/agents/agent-1/follow-up");
  expect(await calls.at(-1)?.json()).toEqual({ message: "Review this" });
});

test("client rejects malformed successful command responses", async () => {
  const api = createWorkspaceApi(async () => Response.json({ accepted: false }));
  await expect(api.prompt("agent-1", "Hello")).rejects.toThrow();
});
