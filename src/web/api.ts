//Comment
import {
  projectSchema,
  workspaceSchema,
  workspaceSnapshotSchema,
  locationSchema,
  type Project,
  type Workspace,
  type WorkspaceSnapshot,
  type WorktreeLocation,
} from "../shared/domain/workspaces.ts";
import { agentCapabilitiesSchema, agentHistoryResponseSchema, agentHistorySchema, agentSummarySchema, type AgentCapabilities, type AgentHistory, type AgentHistoryResponse, type AgentSummary } from "../shared/domain/agents.ts";
import { terminalSummarySchema, type CreateTerminalInput, type TerminalSummary } from "../shared/domain/terminals.ts";
import { workspaceLayoutSchema, type WorkspaceLayout } from "../shared/domain/layout.ts";
import { workspaceSettingsSchema, type WorkspaceSettings } from "../shared/domain/settings.ts";
import { themePackSchema, fontPackSchema, toolRendererPackSchema, type ThemePack, type FontPack, type ToolRendererPack } from "../shared/domain/customization.ts";
import type { AgentImage } from "../shared/protocol/agents.ts";
import { z } from "zod";
import { filesSearchResponseSchema } from "../shared/protocol/workspace.ts";
import type { FileListing, FileRead, FileRevision, FileWrite } from "../shared/domain/files.ts";
import type { GitDiff, GitStatus } from "../shared/domain/git.ts";
import { webPreviewSchema, type WebPreview } from "../shared/domain/previews.ts";

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

const FRIENDLY_API_ERRORS: Record<string, string> = {
  "invalid-request": "Some fields are missing or invalid. Check the form and try again.",
  "invalid-root": "Directory does not exist or is inaccessible.",
  "outside-root": "That path is outside the registered workspace root.",
  "not-found": "The requested item was not found. It may have been removed.",
  "archived": "This item is archived. Reopen it before making changes.",
  "invalid-location": "That worktree location is not valid. Choose another location.",
  "invalid-path": "That path is not valid. Check it and try again.",
  "invalid-id": "Invalid identifier. Refresh and try again.",
  "invalid-cursor": "The listing expired. Refresh and try again.",
  "body-too-large": "The request was too large.",
  "request-failed": "Request failed. Check your connection and try again.",
  "conflict": "That conflicts with the current state. Refresh and try again.",
  "force-required": "That would discard uncommitted changes. Confirm a force delete to proceed.",
  "git-failed": "The git operation failed. Check the repository state and try again.",
  "preview-not-running": "The preview is not running. Start it and try again.",
};

/** Convert API/validation failures into human-readable UI messages. Raw
 *  kebab-case codes (e.g. `invalid-request`) are never shown to users; server
 *  messages that are already sentences pass through untouched. */
export function friendlyApiError(cause: unknown, fallback: string): string {
  if (cause instanceof WorkspaceApiError) {
    const looksRaw = !cause.message || cause.message === cause.code || /^[a-z0-9]+(-[a-z0-9]+)*$/.test(cause.message);
    if (!looksRaw) return cause.message;
    return FRIENDLY_API_ERRORS[cause.code] ?? fallback;
  }
  return cause instanceof Error && cause.message ? cause.message : fallback;
}

export type DiscoveredWorktree = {
  path: string;
  branchRef: string | null;
  head: string;
  isMain: boolean;
  isRegistered: boolean;
  workspaceId: string | null;
  archived: boolean;
};

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
    async listLocations(): Promise<WorktreeLocation[]> {
      return locationSchema.array().parse(await request("/api/worktree-locations"));
    },
    async setLocationEnabled(locationId: string, enabled: boolean): Promise<WorktreeLocation> {
      return locationSchema.parse(await request(`/api/worktree-locations/${encodeURIComponent(locationId)}`, { method: "PATCH", body: JSON.stringify({ enabled }) }));
    },
    async suggestWorktree(projectId: string, purpose: string): Promise<{ label: string; branch: string; folder: string }> {
      return await request(`/api/projects/${encodeURIComponent(projectId)}/worktrees/suggest`, { method: "POST", body: JSON.stringify({ purpose }) }) as { label: string; branch: string; folder: string };
    },
    async createWorktree(projectId: string, input: { locationId: string; ref: string; label: string; folder?: string; createBranch?: boolean; baseRef?: string }): Promise<Workspace> {
      return workspaceSchema.parse(await request(`/api/projects/${encodeURIComponent(projectId)}/worktrees`, { method: "POST", body: JSON.stringify(input) }));
    },
    async discoverWorktrees(projectId: string): Promise<DiscoveredWorktree[]> {
      return (await request(`/api/projects/${encodeURIComponent(projectId)}/worktrees/discover`)) as DiscoveredWorktree[];
    },
    async importWorktree(projectId: string, input: { path: string; label?: string }): Promise<Workspace> {
      return workspaceSchema.parse(
        await request(`/api/projects/${encodeURIComponent(projectId)}/worktrees/import`, {
          method: "POST",
          body: JSON.stringify(input),
        })
      );
    },
    async repairWorktree(workspaceId: string): Promise<Workspace> {
      return workspaceSchema.parse(await request(`/api/workspaces/${encodeURIComponent(workspaceId)}/worktree/repair`, { method: "POST" }));
    },
    async removeWorktree(workspaceId: string, force = false): Promise<void> {
      okResponseSchema.parse(await request(`/api/workspaces/${encodeURIComponent(workspaceId)}/worktree/remove`, { method: "POST", body: JSON.stringify(force ? { force: true } : {}) }));
    },
    async gitStatus(id: string): Promise<GitStatus> { return await request(`/api/workspaces/${encodeURIComponent(id)}/git/status`) as GitStatus; },
    async gitDiff(id: string, target: "staged" | "working-tree" = "working-tree"): Promise<GitDiff[]> { return await request(`/api/workspaces/${encodeURIComponent(id)}/git/diff?target=${target}`) as GitDiff[]; },
    async gitStage(id: string, paths: string[]): Promise<GitStatus> { return await request(`/api/workspaces/${encodeURIComponent(id)}/git/stage`, { method: "POST", body: JSON.stringify({ paths }) }) as GitStatus; },
    async gitUnstage(id: string, paths: string[]): Promise<GitStatus> { return await request(`/api/workspaces/${encodeURIComponent(id)}/git/unstage`, { method: "POST", body: JSON.stringify({ paths }) }) as GitStatus; },
    async gitStageAll(id: string): Promise<GitStatus> { return await request(`/api/workspaces/${encodeURIComponent(id)}/git/stage-all`, { method: "POST", body: JSON.stringify({}) }) as GitStatus; },
    async gitUnstageAll(id: string): Promise<GitStatus> { return await request(`/api/workspaces/${encodeURIComponent(id)}/git/unstage-all`, { method: "POST", body: JSON.stringify({}) }) as GitStatus; },
    async gitDiscard(id: string, path: string): Promise<GitStatus> { return await request(`/api/workspaces/${encodeURIComponent(id)}/git/discard`, { method: "POST", body: JSON.stringify({ path }) }) as GitStatus; },
    async gitCommit(id: string, message: string): Promise<{ head: string; status: GitStatus }> { return await request(`/api/workspaces/${encodeURIComponent(id)}/git/commit`, { method: "POST", body: JSON.stringify({ message }) }) as { head: string; status: GitStatus }; },
    async gitPull(id: string): Promise<GitStatus> { return await request(`/api/workspaces/${encodeURIComponent(id)}/git/pull`, { method: "POST", body: JSON.stringify({}) }) as GitStatus; },
    async gitFetch(id: string): Promise<GitStatus> { return await request(`/api/workspaces/${encodeURIComponent(id)}/git/fetch`, { method: "POST", body: JSON.stringify({}) }) as GitStatus; },
    async listFiles(id: string, path = ".", cursor?: string): Promise<FileListing> { const q = new URLSearchParams({ path }); if (cursor) q.set("cursor", cursor); return await request(`/api/workspaces/${encodeURIComponent(id)}/files?${q}`) as FileListing; },
    async readFile(id: string, path: string): Promise<FileRead> { return await request(`/api/workspaces/${encodeURIComponent(id)}/files/read?path=${encodeURIComponent(path)}`) as FileRead; },
    async writeFile(id: string, path: string, content: string, expected: FileRevision): Promise<FileWrite> { return await request(`/api/workspaces/${encodeURIComponent(id)}/files`, { method: "PUT", body: JSON.stringify({ path, content, expected }) }) as FileWrite; },
    async createPath(id: string, path: string, kind: "file" | "directory"): Promise<{ name: string; kind: string; path: string }> { return await request(`/api/workspaces/${encodeURIComponent(id)}/files/create`, { method: "POST", body: JSON.stringify({ path, kind }) }) as { name: string; kind: string; path: string }; },
    async renamePath(id: string, path: string, newPath: string): Promise<{ path: string }> { return await request(`/api/workspaces/${encodeURIComponent(id)}/files/rename`, { method: "POST", body: JSON.stringify({ path, newPath }) }) as { path: string }; },
    async duplicatePath(id: string, path: string): Promise<{ path: string }> { return await request(`/api/workspaces/${encodeURIComponent(id)}/files/duplicate`, { method: "POST", body: JSON.stringify({ path }) }) as { path: string }; },
    async deletePath(id: string, path: string): Promise<{ path: string }> { return await request(`/api/workspaces/${encodeURIComponent(id)}/files?path=${encodeURIComponent(path)}`, { method: "DELETE" }) as { path: string }; },
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
    async abort(id: string) { acceptedResponseSchema.parse(await request(`/api/agents/${encodeURIComponent(id)}/abort`, { method: "POST" })); },
    async compact(id: string, customInstructions?: string) { acceptedResponseSchema.parse(await request(`/api/agents/${encodeURIComponent(id)}/compact`, { method: "POST", body: JSON.stringify(customInstructions ? { customInstructions } : {}) })); },
    async searchFiles(workspaceId: string, q: string, limit = 20) {
      const query = new URLSearchParams({ q, limit: String(Math.min(Math.max(limit, 1), 50)) });
      return filesSearchResponseSchema.parse(await request(`/api/workspaces/${encodeURIComponent(workspaceId)}/files/search?${query}`));
    },
    async respondUi(id: string, response: { id: string; value?: string; confirmed?: boolean; cancelled?: true }) {
      okResponseSchema.parse(await request(`/api/agents/${encodeURIComponent(id)}/ui-response`, {
        method: "POST",
        body: JSON.stringify(response),
      }));
    },
    async setModel(id: string, provider: string, modelId: string): Promise<AgentSummary> { return agentSummarySchema.parse(await request(`/api/agents/${encodeURIComponent(id)}/model`, { method: "POST", body: JSON.stringify({ provider, modelId }) })); },
    async setThinking(id: string, level: string): Promise<AgentSummary> { return agentSummarySchema.parse(await request(`/api/agents/${encodeURIComponent(id)}/thinking`, { method: "POST", body: JSON.stringify({ level }) })); },
    async archiveAgent(id: string): Promise<void> { okResponseSchema.parse(await request(`/api/agents/${encodeURIComponent(id)}/archive`, { method: "POST" })); },
    async listTerminals(workspaceId: string): Promise<TerminalSummary[]> {
      return terminalSummarySchema.array().parse(await request(`/api/workspaces/${encodeURIComponent(workspaceId)}/terminals`));
    },
    async createTerminal(workspaceId: string, input?: CreateTerminalInput): Promise<TerminalSummary> {
      return terminalSummarySchema.parse(await request(`/api/workspaces/${encodeURIComponent(workspaceId)}/terminals`, {
        method: "POST",
        body: JSON.stringify(input ?? {}),
      }));
    },
    async getTerminal(terminalId: string): Promise<TerminalSummary> {
      return terminalSummarySchema.parse(await request(`/api/terminals/${encodeURIComponent(terminalId)}`));
    },
    async getLayout(workspaceId: string): Promise<WorkspaceLayout> {
      return workspaceLayoutSchema.parse(await request(`/api/workspaces/${encodeURIComponent(workspaceId)}/layout`));
    },
    async saveLayout(workspaceId: string, layout: WorkspaceLayout): Promise<WorkspaceLayout> {
      return workspaceLayoutSchema.parse(await request(`/api/workspaces/${encodeURIComponent(workspaceId)}/layout`, {
        method: "PUT",
        body: JSON.stringify(layout),
      }));
    },
    async getSettings(workspaceId: string): Promise<WorkspaceSettings> {
      return workspaceSettingsSchema.parse(await request(`/api/workspaces/${encodeURIComponent(workspaceId)}/settings`));
    },
    async saveSettings(workspaceId: string, settings: WorkspaceSettings): Promise<WorkspaceSettings> {
      return workspaceSettingsSchema.parse(await request(`/api/workspaces/${encodeURIComponent(workspaceId)}/settings`, {
        method: "PUT",
        body: JSON.stringify(settings),
      }));
    },
    async getThemes(): Promise<ThemePack[]> {
      return themePackSchema.array().parse(await request("/api/customization/themes"));
    },
    async getFonts(): Promise<FontPack[]> {
      return fontPackSchema.array().parse(await request("/api/customization/fonts"));
    },
    async getToolRenderers(): Promise<ToolRendererPack> {
      return toolRendererPackSchema.parse(await request("/api/customization/tool-renderers"));
    },
    async deleteTerminal(terminalId: string): Promise<void> {
      okResponseSchema.parse(await request(`/api/terminals/${encodeURIComponent(terminalId)}`, { method: "DELETE" }));
    },
    async listPreviews(workspaceId: string): Promise<WebPreview[]> {
      return webPreviewSchema.array().parse(await request(`/api/workspaces/${encodeURIComponent(workspaceId)}/previews`));
    },
    async createPreview(workspaceId: string, input: { label?: string; targetUrl: string }): Promise<WebPreview> {
      return webPreviewSchema.parse(await request(`/api/workspaces/${encodeURIComponent(workspaceId)}/previews`, {
        method: "POST",
        body: JSON.stringify(input),
      }));
    },
    async previewCandidates(workspaceId: string): Promise<{ port: number; confidence: string; processName: string | null; pid: number | null }[]> {
      return (await request(`/api/workspaces/${encodeURIComponent(workspaceId)}/previews/candidates`)) as { port: number; confidence: string; processName: string | null; pid: number | null }[];
    },
    async getPreview(previewId: string): Promise<WebPreview> {
      return webPreviewSchema.parse(await request(`/api/previews/${encodeURIComponent(previewId)}`));
    },
    async openPreview(previewId: string): Promise<WebPreview> {
      return webPreviewSchema.parse(await request(`/api/previews/${encodeURIComponent(previewId)}/open`, { method: "POST" }));
    },
    async stopPreview(previewId: string): Promise<WebPreview> {
      return webPreviewSchema.parse(await request(`/api/previews/${encodeURIComponent(previewId)}/stop`, { method: "POST" }));
    },
    async deletePreview(previewId: string): Promise<void> {
      okResponseSchema.parse(await request(`/api/previews/${encodeURIComponent(previewId)}`, { method: "DELETE" }));
    },
    async navigatePreview(previewId: string, url: string): Promise<WebPreview> {
      return webPreviewSchema.parse(await request(`/api/previews/${encodeURIComponent(previewId)}/navigate`, {
        method: "POST",
        body: JSON.stringify({ url }),
      }));
    },
    async previewBack(previewId: string): Promise<WebPreview> {
      return webPreviewSchema.parse(await request(`/api/previews/${encodeURIComponent(previewId)}/back`, { method: "POST" }));
    },
    async previewForward(previewId: string): Promise<WebPreview> {
      return webPreviewSchema.parse(await request(`/api/previews/${encodeURIComponent(previewId)}/forward`, { method: "POST" }));
    },
    async previewReload(previewId: string): Promise<WebPreview> {
      return webPreviewSchema.parse(await request(`/api/previews/${encodeURIComponent(previewId)}/reload`, { method: "POST" }));
    },
    async setPreviewViewport(previewId: string, viewport: { width?: number; height?: number }): Promise<WebPreview> {
      return webPreviewSchema.parse(await request(`/api/previews/${encodeURIComponent(previewId)}/viewport`, {
        method: "POST",
        body: JSON.stringify(viewport),
      }));
    },
    async takePreviewLease(previewId: string, clientId: string): Promise<WebPreview> {
      return webPreviewSchema.parse(await request(`/api/previews/${encodeURIComponent(previewId)}/lease`, {
        method: "POST",
        body: JSON.stringify({ clientId }),
      }));
    },
    async transcriptPreview(): Promise<AgentHistory> {
      const json = (await request("/api/dev/transcript-preview?mode=transcript")) as { history: unknown };
      return agentHistorySchema.parse(json.history);
    },
  };
}
