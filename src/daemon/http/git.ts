import { Hono } from "hono";
import { basename, dirname, isAbsolute, join, relative, sep } from "node:path";
import { z } from "zod";
import { opaqueDomainIdSchema } from "../../shared/domain/workspaces.ts";
import { MAX_FILE_PATH_LENGTH } from "../../shared/domain/files.ts";
import type { GitStatusChangedReason } from "../../shared/protocol/index.ts";
import { GitError, GitService } from "../workspaces/git.ts";
import { CommitGenerator, fallbackCommitMessage, formatConversationMessages, serializeDiffsForPrompt } from "../workspaces/commit-generator.ts";
import type { WorkspaceEventHub } from "../workspaces/events.ts";
import { WorkspaceService } from "../workspaces/service.ts";
import { readJsonBody } from "./body.ts";
import { fixtureTranscriptHistory } from "../agents/history/fixture.ts";

const target = z.enum(["staged", "working-tree"]);
const repoPath = z.string().min(1).max(MAX_FILE_PATH_LENGTH);
const pathsInput = z.object({ paths: z.array(repoPath).min(1).max(100) }).strict();
const pathInput = z.object({ path: repoPath }).strict();
const commitInput = z.object({ message: z.string().trim().min(1).max(1000) }).strict();
const commitAutoInput = z.object({
  model: z.string().trim().max(256).optional(),
  thinkingLevel: z.string().trim().max(256).optional(),
  commitPrompt: z.string().max(8000).optional(),
  agentId: z.string().min(1).max(128).optional(),
}).strict();

/** Best-effort conversation excerpts for the commit prompt (plain text only).
 *  The daemon wires this to `AgentService.getCommitConversation`; tests and
 *  other hosts may supply their own. Never throws from the caller's
 *  perspective -- failures resolve to empty excerpts. */
export type CommitConversationProvider = (
  workspaceId: string,
  agentId?: string,
) => Promise<{ userMessages: string[]; finalAssistantMessages: string[] }>;

const gitMessage = (e: GitError): string | undefined => {
  const detail = (e.stderr || e.message || "").split("\n")[0].trim().replace(/^fatal:\s*/i, "");
  return detail ? detail.slice(0, 500) : undefined;
};
const error = (e: unknown) => {
  if (e instanceof GitError) {
    const message = gitMessage(e);
    return Response.json({ error: "git-failed", ...(message ? { message } : {}) }, { status: 422, headers: { "Cache-Control": "no-store" } });
  }
  return Response.json({ error: "invalid-request" }, { status: 400, headers: { "Cache-Control": "no-store" } });
};
const id = (value: string) => { const parsed = opaqueDomainIdSchema.safeParse(value); if (!parsed.success) throw new Error("invalid-id"); return parsed.data; };
const ok = (value: unknown) => Response.json(value, { headers: { "Cache-Control": "no-store" } });

/** Resolve a repo-relative browser path to a repo-relative Git path, anchored
 *  inside the workspace root. `resolvePath` requires existence, so paths that
 *  are missing on disk (e.g. staged deletions) fall back to anchoring the
 *  nearest existing ancestor and re-appending the remainder; the final
 *  lexical check keeps `..` escapes (including via `basename("..")`) out.
 *  Whole missing subtrees must use stage-all. */
const resolveRepoPath = async (workspaces: WorkspaceService, workspaceId: string, requested: string): Promise<{ cwd: string; rel: string }> => {
  const parsed = repoPath.safeParse(requested);
  if (!parsed.success || isAbsolute(requested)) throw new Error("invalid-path");
  const cwd = await workspaces.resolvePath(workspaceId, ".");
  let abs: string;
  try {
    abs = await workspaces.resolvePath(workspaceId, requested);
  } catch {
    const parent = dirname(requested);
    const base = basename(requested);
    const parentAbs = await workspaces.resolvePath(workspaceId, parent === "" ? "." : parent);
    abs = join(parentAbs, base);
  }
  const rel = relative(cwd, abs);
  if (rel === "" || rel === ".." || rel.startsWith(`..${sep}`)) throw new Error("invalid-path");
  return { cwd, rel };
};

export const createGitRoutes = (workspaces: WorkspaceService, git: GitService, events?: WorkspaceEventHub, commitGenerator?: Pick<CommitGenerator, "suggestCommit">, getConversation?: CommitConversationProvider): Hono => {
  const commits = commitGenerator ?? new CommitGenerator();
  const app = new Hono();
  app.use("*", async (c, next) => { c.header("Cache-Control", "no-store"); return next(); });
  const changed = (workspaceId: string, reason: GitStatusChangedReason) => {
    events?.emitGitStatus({ workspaceId, reason });
  };
  /** Run a mutation, return the fresh status snapshot inline, then broadcast
   *  an invalidation so other clients refetch. Reads and failures emit nothing. */
  const mutate = async (workspaceId: string, reason: GitStatusChangedReason, run: (cwd: string) => Promise<void>) => {
    const cwd = await workspaces.resolvePath(workspaceId, ".");
    await run(cwd);
    const status = await git.status(cwd);
    changed(workspaceId, reason);
    return ok(status);
  };
  app.get("/api/workspaces/:workspaceId/git/status", async (c) => { try { const cwd = await workspaces.resolvePath(id(c.req.param("workspaceId")), "."); return ok(await git.status(cwd)); } catch (e) { return error(e); } });
  app.get("/api/workspaces/:workspaceId/git/diff", async (c) => { try { const value = target.safeParse(c.req.query("target") ?? "working-tree"); if (!value.success) throw new Error("invalid-target"); const cwd = await workspaces.resolvePath(id(c.req.param("workspaceId")), "."); return ok(await git.diff(cwd, value.data)); } catch (e) { return error(e); } });
  app.post("/api/workspaces/:workspaceId/git/stage", async (c) => {
    try {
      const input = pathsInput.parse(await readJsonBody(c.req.raw));
      const workspaceId = id(c.req.param("workspaceId"));
      const cwd = await workspaces.resolvePath(workspaceId, ".");
      const rels: string[] = [];
      for (const p of input.paths) rels.push((await resolveRepoPath(workspaces, workspaceId, p)).rel);
      await git.stage(cwd, rels);
      const status = await git.status(cwd);
      changed(workspaceId, "stage");
      return ok(status);
    } catch (e) { return error(e); }
  });
  app.post("/api/workspaces/:workspaceId/git/unstage", async (c) => {
    try {
      const input = pathsInput.parse(await readJsonBody(c.req.raw));
      const workspaceId = id(c.req.param("workspaceId"));
      const cwd = await workspaces.resolvePath(workspaceId, ".");
      const rels: string[] = [];
      for (const p of input.paths) rels.push((await resolveRepoPath(workspaces, workspaceId, p)).rel);
      await git.unstage(cwd, rels);
      const status = await git.status(cwd);
      changed(workspaceId, "unstage");
      return ok(status);
    } catch (e) { return error(e); }
  });
  app.post("/api/workspaces/:workspaceId/git/stage-all", async (c) => {
    try {
      const workspaceId = id(c.req.param("workspaceId"));
      return await mutate(workspaceId, "stage-all", (cwd) => git.stageAll(cwd));
    } catch (e) { return error(e); }
  });
  app.post("/api/workspaces/:workspaceId/git/unstage-all", async (c) => {
    try {
      const workspaceId = id(c.req.param("workspaceId"));
      return await mutate(workspaceId, "unstage-all", (cwd) => git.unstageAll(cwd));
    } catch (e) { return error(e); }
  });
  app.post("/api/workspaces/:workspaceId/git/discard", async (c) => {
    try {
      const input = pathInput.parse(await readJsonBody(c.req.raw));
      const workspaceId = id(c.req.param("workspaceId"));
      const { cwd, rel } = await resolveRepoPath(workspaces, workspaceId, input.path);
      await git.discard(cwd, rel);
      const status = await git.status(cwd);
      changed(workspaceId, "discard");
      return ok(status);
    } catch (e) { return error(e); }
  });
  app.post("/api/workspaces/:workspaceId/git/commit", async (c) => {
    try {
      const input = commitInput.parse(await readJsonBody(c.req.raw));
      const workspaceId = id(c.req.param("workspaceId"));
      const cwd = await workspaces.resolvePath(workspaceId, ".");
      const head = await git.commit(cwd, input.message);
      const status = await git.status(cwd);
      changed(workspaceId, "commit");
      return ok({ head, status });
    } catch (e) { return error(e); }
  });
  app.post("/api/workspaces/:workspaceId/git/commit-auto", async (c) => {
    try {
      const input = commitAutoInput.parse(await readJsonBody(c.req.raw));
      const workspaceId = id(c.req.param("workspaceId"));
      const cwd = await workspaces.resolvePath(workspaceId, ".");
      const before = await git.status(cwd);
      if (before.files.length === 0) throw new GitError("Nothing to commit: working tree is clean");
      if (before.conflicted) throw new GitError("Resolve merge conflicts before committing");
      // Snapshot the overall change (staged + working tree) before
      // stage-all rewrites the index, so the message covers everything.
      const [stagedDiffs, workingDiffs] = await Promise.all([git.diff(cwd, "staged"), git.diff(cwd, "working-tree")]);
      const combined = [serializeDiffsForPrompt(stagedDiffs), serializeDiffsForPrompt(workingDiffs)].filter(Boolean).join("\n");
      await git.stageAll(cwd);
      let storedModel = "";
      let storedThinking = "";
      let storedPrompt = "";
      try {
        const settings = workspaces.getSettings(workspaceId);
        storedModel = settings.suggestModel ?? "";
        storedThinking = settings.suggestThinkingLevel ?? "";
        storedPrompt = settings.commitPrompt ?? "";
      } catch {
        // Stored settings are best-effort; explicit body fields still apply.
      }
      const files = before.files.map((f) => ({ path: f.oldPath ? `${f.oldPath} -> ${f.path}` : f.path, kind: f.kind }));
      // Conversation context for {{user_messages}} /
      // {{final_assistant_messages}}: plain-text excerpts only, best-effort.
      let conversation = { userMessages: "(none)", finalAssistantMessages: "(none)" };
      try {
        const raw = await getConversation?.(workspaceId, input.agentId);
        if (raw) {
          conversation = {
            userMessages: formatConversationMessages(raw.userMessages ?? []),
            finalAssistantMessages: formatConversationMessages(raw.finalAssistantMessages ?? []),
          };
        }
      } catch {
        // Conversation context is advisory; the diff still generates a message.
      }
      const message = (await commits.suggestCommit(
        files,
        combined,
        cwd,
        input.model ?? storedModel,
        input.thinkingLevel ?? storedThinking,
        input.commitPrompt ?? storedPrompt,
        conversation,
      )) ?? fallbackCommitMessage(files);
      const head = await git.commit(cwd, message);
      const status = await git.status(cwd);
      changed(workspaceId, "commit");
      return ok({ head, message, status });
    } catch (e) { return error(e); }
  });
  app.post("/api/workspaces/:workspaceId/git/pull", async (c) => {
    try {
      const workspaceId = id(c.req.param("workspaceId"));
      return await mutate(workspaceId, "pull", (cwd) => git.pull(cwd));
    } catch (e) { return error(e); }
  });
  app.post("/api/workspaces/:workspaceId/git/fetch", async (c) => {
    try {
      const workspaceId = id(c.req.param("workspaceId"));
      return await mutate(workspaceId, "fetch", (cwd) => git.fetch(cwd));
    } catch (e) { return error(e); }
  });
  app.post("/api/workspaces/:workspaceId/git/merge", async (c) => {
    try {
      const workspaceId = id(c.req.param("workspaceId"));
      return await mutate(workspaceId, "merge", (cwd) => git.mergeIntoMain(cwd));
    } catch (e) { return error(e); }
  });
  app.post("/api/workspaces/:workspaceId/git/rebase", async (c) => {
    try {
      const workspaceId = id(c.req.param("workspaceId"));
      return await mutate(workspaceId, "rebase", (cwd) => git.rebase(cwd));
    } catch (e) { return error(e); }
  });
  app.post("/api/workspaces/:workspaceId/git/push", async (c) => {
    try {
      const workspaceId = id(c.req.param("workspaceId"));
      return await mutate(workspaceId, "push", (cwd) => git.push(cwd));
    } catch (e) { return error(e); }
  });
  return app;
}

const transcriptPreview = z.object({ mode: z.literal("transcript") });

/**
 * Offline transcript preview used to verify agent timeline rendering
 * (tool rows, process groups, inline diffs, settlement scroll) without
 * contacting a model provider. Disabled unless the daemon explicitly opts
 * in with PASSAGE_TRANSCRIPT_PREVIEW=1; never wired to live agent state.
 */
export const createTranscriptPreviewRoutes = (): Hono => {
  const app = new Hono();
  app.use("*", async (c, next) => { c.header("Cache-Control", "no-store"); return next(); });
  app.get("/api/dev/transcript-preview", (c) => {
    if (process.env.PASSAGE_TRANSCRIPT_PREVIEW !== "1") {
      return Response.json({ error: "not-found" }, { status: 404, headers: { "Cache-Control": "no-store" } });
    }
    const value = transcriptPreview.safeParse({ mode: c.req.query("mode") ?? "transcript" });
    if (!value.success) {
      return Response.json({ error: "invalid-request" }, { status: 400, headers: { "Cache-Control": "no-store" } });
    }
    return Response.json({ history: fixtureTranscriptHistory() }, { headers: { "Cache-Control": "no-store" } });
  });
  return app;
};
