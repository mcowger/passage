import {
  projectSchema,
  workspaceSchema,
  workspaceSnapshotSchema,
  type Project,
  type Workspace,
  type WorkspaceSnapshot,
} from "../shared/domain/workspaces.ts";
import { agentCapabilitiesSchema, agentHistoryResponseSchema, agentSummarySchema, type AgentCapabilities, type AgentHistoryResponse, type AgentSummary } from "../shared/domain/agents.ts";
import type { AgentImage } from "../shared/protocol/agents.ts";
import { z } from "zod";
import type { FileListing, FileRead, FileRevision, FileWrite } from "../shared/domain/files.ts";
import type { GitDiff, GitStatus } from "../shared/domain/git.ts";

type Fetcher = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;
const acceptedResponseSchema = z.object({ accepted: z.literal(true) }).strict();
const okResponseSchema = z.object({ ok: z.literal(true) }).strict();

export type WorkspaceApi = ReturnType<typeof createWorkspaceApi>;

export class WorkspaceApiError extends Error {
  constructor(readonly code: string, readonly status: number, message?: string) {
    super(message ?? code);
    this.name = "WorkspaceApiError";
  }
}

export function createWorkspaceApi(fetcher: Fetcher = fetch) {
  async function request(path: string, init?: RequestInit): Promise<unknown> {
    const headers = new Headers(init?.headers);
    if (init?.body !== undefined) headers.set("Content-Type", "application/json");
    const response = await fetcher(path, { ...init, headers });
    if (!response.ok) {
      let code = "request-failed";
      let message: string | undefined;
      try {
        const error = (await response.json()) as { error?: string; message?: string };
        code = error.error ?? code;
        message = error.message;
      } catch {}
      throw new WorkspaceApiError(code, response.status, message);
    }
    return response.json();
  }

  return {
    async snapshot(): Promise<WorkspaceSnapshot> {
      return workspaceSnapshotSchema.parse(await request("/api/workspaces/snapshot"));
    },
    async registerProject(input: { configuredRootPath: string; displayLabel: string }): Promise<Project> {
      return projectSchema.parse(await request("/api/projects", { method: "POST", body: JSON.stringify(input) }));
    },
    async archiveProject(id: string): Promise<void> {
      await request(`/api/projects/${encodeURIComponent(id)}/archive`, { method: "POST" });
    },
    async reopenProject(id: string): Promise<Project> {
      return projectSchema.parse(await request(`/api/projects/${encodeURIComponent(id)}/reopen`, { method: "POST" }));
    },
    async createDirectoryWorkspace(projectId: string, input: { cwd?: string; displayLabel: string }): Promise<Workspace> {
      return workspaceSchema.parse(await request(`/api/projects/${encodeURIComponent(projectId)}/workspaces`, {
        method: "POST",
        body: JSON.stringify(input),
      }));
    },
    async labelWorkspace(id: string, displayLabel: string): Promise<Workspace> {
      return workspaceSchema.parse(await request(`/api/workspaces/${encodeURIComponent(id)}`, {
        method: "PATCH",
        body: JSON.stringify({ displayLabel }),
      }));
    },
    async archiveWorkspace(id: string): Promise<void> {
      await request(`/api/workspaces/${encodeURIComponent(id)}/archive`, { method: "POST" });
    },
    async reopenWorkspace(id: string): Promise<Workspace> {
      return workspaceSchema.parse(await request(`/api/workspaces/${encodeURIComponent(id)}/reopen`, { method: "POST" }));
    },
    async configureLocation(input: { projectId?: string; displayLabel: string; configuredRootPath: string; enabled?: boolean }) {
      return await request("/api/worktree-locations", { method: "POST", body: JSON.stringify(input) });
    },
    async suggestWorktree(projectId: string, purpose: string): Promise<{ label: string; branch: string; folder: string }> {
      return await request(`/api/projects/${encodeURIComponent(projectId)}/worktrees/suggest`, { method: "POST", body: JSON.stringify({ purpose }) }) as { label: string; branch: string; folder: string };
    },
    async createWorktree(projectId: string, input: { locationId: string; ref: string; label: string; folder?: string }): Promise<Workspace> {
      return workspaceSchema.parse(await request(`/api/projects/${encodeURIComponent(projectId)}/worktrees`, { method: "POST", body: JSON.stringify(input) }));
    },
    async repairWorktree(workspaceId: string): Promise<Workspace> {
      return workspaceSchema.parse(await request(`/api/workspaces/${encodeURIComponent(workspaceId)}/worktree/repair`, { method: "POST" }));
    },
    async removeWorktree(workspaceId: string, force = false): Promise<void> {
      okResponseSchema.parse(await request(`/api/workspaces/${encodeURIComponent(workspaceId)}/worktree/remove`, { method: "POST", body: JSON.stringify(force ? { force: true } : {}) }));
    },
    async gitStatus(id: string): Promise<GitStatus> { return await request(`/api/workspaces/${encodeURIComponent(id)}/git/status`) as GitStatus; },
    async gitDiff(id: string, target: "staged" | "working-tree" = "working-tree"): Promise<GitDiff[]> { return await request(`/api/workspaces/${encodeURIComponent(id)}/git/diff?target=${target}`) as GitDiff[]; },
    async listFiles(id: string, path = ".", cursor?: string): Promise<FileListing> { const q = new URLSearchParams({ path }); if (cursor) q.set("cursor", cursor); return await request(`/api/workspaces/${encodeURIComponent(id)}/files?${q}`) as FileListing; },
    async readFile(id: string, path: string): Promise<FileRead> { return await request(`/api/workspaces/${encodeURIComponent(id)}/files/read?path=${encodeURIComponent(path)}`) as FileRead; },
    async writeFile(id: string, path: string, content: string, expected: FileRevision): Promise<FileWrite> { return await request(`/api/workspaces/${encodeURIComponent(id)}/files`, { method: "PUT", body: JSON.stringify({ path, content, expected }) }) as FileWrite; },
    async listAgents(workspaceId: string): Promise<AgentSummary[]> {
      return agentSummarySchema.array().parse(await request(`/api/workspaces/${encodeURIComponent(workspaceId)}/agents`));
    },
    async createAgent(workspaceId: string, title?: string): Promise<AgentSummary> {
      return agentSummarySchema.parse(await request(`/api/workspaces/${encodeURIComponent(workspaceId)}/agents`, { method: "POST", body: JSON.stringify(title ? { title } : {}) }));
    },
    async agent(id: string): Promise<AgentSummary> { return agentSummarySchema.parse(await request(`/api/agents/${encodeURIComponent(id)}`)); },
    async capabilities(id: string): Promise<AgentCapabilities> { return agentCapabilitiesSchema.parse(await request(`/api/agents/${encodeURIComponent(id)}/capabilities`)); },
    async history(id: string, before?: number, limit = 100): Promise<AgentHistoryResponse> {
      const query = new URLSearchParams({ limit: String(limit) });
      if (before !== undefined) query.set("before", String(before));
      return agentHistoryResponseSchema.parse(await request(`/api/agents/${encodeURIComponent(id)}/history?${query}`));
    },
    async startAgent(id: string): Promise<AgentSummary> { return agentSummarySchema.parse(await request(`/api/agents/${encodeURIComponent(id)}/start`, { method: "POST" })); },
    async prompt(id: string, message: string, images?: AgentImage[]) { acceptedResponseSchema.parse(await request(`/api/agents/${encodeURIComponent(id)}/prompt`, { method: "POST", body: JSON.stringify({ message, ...(images?.length ? { images } : {}) }) })); },
    async steer(id: string, message: string, images?: AgentImage[]) { acceptedResponseSchema.parse(await request(`/api/agents/${encodeURIComponent(id)}/steer`, { method: "POST", body: JSON.stringify({ message, ...(images?.length ? { images } : {}) }) })); },
    async followUp(id: string, message: string, images?: AgentImage[]) { acceptedResponseSchema.parse(await request(`/api/agents/${encodeURIComponent(id)}/follow-up`, { method: "POST", body: JSON.stringify({ message, ...(images?.length ? { images } : {}) }) })); },
    async abort(id: string) { okResponseSchema.parse(await request(`/api/agents/${encodeURIComponent(id)}/abort`, { method: "POST" })); },
    async setModel(id: string, provider: string, modelId: string): Promise<AgentSummary> { return agentSummarySchema.parse(await request(`/api/agents/${encodeURIComponent(id)}/model`, { method: "POST", body: JSON.stringify({ provider, modelId }) })); },
    async setThinking(id: string, level: string): Promise<AgentSummary> { return agentSummarySchema.parse(await request(`/api/agents/${encodeURIComponent(id)}/thinking`, { method: "POST", body: JSON.stringify({ level }) })); },
    async archiveAgent(id: string): Promise<void> { okResponseSchema.parse(await request(`/api/agents/${encodeURIComponent(id)}/archive`, { method: "POST" })); },
  };
}
