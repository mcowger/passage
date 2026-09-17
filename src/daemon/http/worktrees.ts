import { Hono } from "hono";
import { z } from "zod";
import { opaqueDomainIdSchema, MAX_DOMAIN_LABEL_LENGTH, MAX_DOMAIN_PATH_LENGTH } from "../../shared/domain/workspaces.ts";
import { WorktreeError, WorktreeService } from "../workspaces/worktrees.ts";
import { HttpInputError, readJsonBody } from "./body.ts";
import { GitError } from "../workspaces/git.ts";
const create = z.object({ locationId: opaqueDomainIdSchema, ref: z.string().min(1).max(MAX_DOMAIN_PATH_LENGTH), label: z.string().trim().min(1).max(MAX_DOMAIN_LABEL_LENGTH), folder: z.string().max(MAX_DOMAIN_LABEL_LENGTH).optional(), createBranch: z.boolean().optional(), baseRef: z.string().min(1).max(MAX_DOMAIN_PATH_LENGTH).optional() }).strict();
const suggest = z.object({ purpose: z.string().max(2000), model: z.string().trim().max(256).optional() }).strict();
const remove = z.object({ force: z.literal(true).optional() }).strict();
const importWorktree = z.object({ path: z.string().min(1).max(MAX_DOMAIN_PATH_LENGTH), label: z.string().trim().max(MAX_DOMAIN_LABEL_LENGTH).optional() }).strict();
const id = (v: string) => opaqueDomainIdSchema.parse(v);
const error = (e: unknown) => {
  if (e instanceof WorktreeError) {
    const status = e.code === "not-found" ? 404 : e.code === "force-required" ? 428 : 409;
    return Response.json({ error: e.code, message: e.message }, { status, headers: { "Cache-Control": "no-store" } });
  }
  if (e instanceof HttpInputError) {
    return Response.json({ error: e.code }, { status: e.code === "body-too-large" ? 413 : 400, headers: { "Cache-Control": "no-store" } });
  }
  if (e instanceof GitError) {
    return Response.json({ error: "git-failed", message: e.message }, { status: 422, headers: { "Cache-Control": "no-store" } });
  }
  if (e instanceof z.ZodError) {
    return Response.json({ error: "invalid-request" }, { status: 400, headers: { "Cache-Control": "no-store" } });
  }
  return Response.json({ error: "request-failed", message: e instanceof Error ? e.message : "Request failed" }, { status: 500, headers: { "Cache-Control": "no-store" } });
};
const ok = (v: unknown, status = 200) => Response.json(v, { status, headers: { "Cache-Control": "no-store" } });
export const createWorktreeRoutes = (service: WorktreeService, hooks?: { onRemoveWorkspace?: (workspaceId: string) => Promise<void> }): Hono => { const app = new Hono(); app.use("*", async (c, next) => { c.header("Cache-Control", "no-store"); return next(); });
  app.get("/api/projects/:projectId/worktrees/discover", async (c) => { try { return ok(await service.discover(id(c.req.param("projectId")))); } catch (e) { return error(e); } });
  app.post("/api/projects/:projectId/worktrees/import", async (c) => { try { const x = importWorktree.parse(await readJsonBody(c.req.raw)); return ok(await service.importWorktree(id(c.req.param("projectId")), x), 201); } catch (e) { return error(e); } });
  app.post("/api/projects/:projectId/worktrees/suggest", async (c) => { try { const x = suggest.parse(await readJsonBody(c.req.raw)); return ok(await service.suggest(id(c.req.param("projectId")), x.purpose, x.model)); } catch (e) { return error(e); } });
  app.post("/api/projects/:projectId/worktrees", async (c) => { try { const x = create.parse(await readJsonBody(c.req.raw)); return ok(await service.create(id(c.req.param("projectId")), x.locationId, x.ref, x.label, x.folder, { createBranch: x.createBranch, baseRef: x.baseRef }), 201); } catch (e) { return error(e); } });
  app.post("/api/workspaces/:workspaceId/worktree/repair", async (c) => { try { return ok(await service.reconcile(id(c.req.param("workspaceId")))); } catch (e) { return error(e); } });
  app.post("/api/workspaces/:workspaceId/worktree/remove", async (c) => { try { const x = remove.parse(await readJsonBody(c.req.raw)); const workspaceId = id(c.req.param("workspaceId")); await hooks?.onRemoveWorkspace?.(workspaceId); await service.remove(workspaceId, x.force === true); return ok({ ok: true }); } catch (e) { return error(e); } }); return app; };
