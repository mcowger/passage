import { Hono } from "hono";
import { z } from "zod";
import { opaqueDomainIdSchema } from "../../shared/domain/workspaces.ts";
import { GitError, GitService } from "../workspaces/git.ts";
import { WorkspaceService } from "../workspaces/service.ts";
import { fixtureTranscriptHistory } from "../agents/history/fixture.ts";

const target = z.enum(["staged", "working-tree"]);
const error = (e: unknown) => Response.json({ error: e instanceof GitError ? "git-failed" : "invalid-request" }, { status: e instanceof GitError ? 422 : 400, headers: { "Cache-Control": "no-store" } });
const id = (value: string) => { const parsed = opaqueDomainIdSchema.safeParse(value); if (!parsed.success) throw new Error("invalid-id"); return parsed.data; };
const ok = (value: unknown) => Response.json(value, { headers: { "Cache-Control": "no-store" } });

export const createGitRoutes = (workspaces: WorkspaceService, git: GitService): Hono => {
  const app = new Hono();
  app.use("*", async (c, next) => { c.header("Cache-Control", "no-store"); return next(); });
  app.get("/api/workspaces/:workspaceId/git/status", async (c) => { try { const cwd = await workspaces.resolvePath(id(c.req.param("workspaceId")), "."); return ok(await git.status(cwd)); } catch (e) { return error(e); } });
  app.get("/api/workspaces/:workspaceId/git/diff", async (c) => { try { const value = target.safeParse(c.req.query("target") ?? "working-tree"); if (!value.success) throw new Error("invalid-target"); const cwd = await workspaces.resolvePath(id(c.req.param("workspaceId")), "."); return ok(await git.diff(cwd, value.data)); } catch (e) { return error(e); } });
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
