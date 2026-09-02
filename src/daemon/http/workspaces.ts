import { Hono } from "hono";
import { z } from "zod";
import { opaqueDomainIdSchema, MAX_DOMAIN_LABEL_LENGTH, MAX_DOMAIN_PATH_LENGTH } from "../../shared/domain/workspaces.ts";
import { WorkspaceError, type WorkspaceService } from "../workspaces/service.ts";
import { HttpInputError, readJsonBody } from "./body.ts";

const projectInput = z.object({ configuredRootPath: z.string().min(1).max(MAX_DOMAIN_PATH_LENGTH), displayLabel: z.string().trim().min(1).max(MAX_DOMAIN_LABEL_LENGTH) }).strict();
const workspaceInput = z.object({ cwd: z.string().min(1).max(MAX_DOMAIN_PATH_LENGTH).optional(), displayLabel: z.string().trim().min(1).max(MAX_DOMAIN_LABEL_LENGTH) }).strict();
const locationInput = z.object({ projectId: opaqueDomainIdSchema.optional(), displayLabel: z.string().trim().min(1).max(MAX_DOMAIN_LABEL_LENGTH), configuredRootPath: z.string().min(1).max(MAX_DOMAIN_PATH_LENGTH), enabled: z.boolean().optional() }).strict();
const labelInput = z.object({ displayLabel: z.string().trim().min(1).max(MAX_DOMAIN_LABEL_LENGTH) }).strict();

type RouteContext = { req: { raw: Request; param: (name: string) => string } };

const errorResponse = (error: unknown): Response => {
  if (error instanceof WorkspaceError) {
    const status = error.code === "not-found" ? 404 : error.code === "archived" ? 409 : 400;
    return Response.json({ error: error.code, message: error.message }, { status, headers: { "Cache-Control": "no-store" } });
  }
  if (error instanceof HttpInputError) {
    return Response.json({ error: error.code }, { status: error.code === "body-too-large" ? 413 : 400, headers: { "Cache-Control": "no-store" } });
  }
  return Response.json({ error: "invalid-request" }, { status: 400, headers: { "Cache-Control": "no-store" } });
};

function id(context: RouteContext, name: string): string {
  const parsed = opaqueDomainIdSchema.safeParse(context.req.param(name));
  if (!parsed.success) throw new HttpInputError("invalid-id");
  return parsed.data;
}

const success = (value: unknown, status = 200) => Response.json(value, { status, headers: { "Cache-Control": "no-store" } });

export const createWorkspaceRoutes = (service: WorkspaceService): Hono => {
  const app = new Hono();
  app.use("*", async (context, next) => { context.header("Cache-Control", "no-store"); return next(); });
  app.get("/api/workspaces/snapshot", (context) => success(service.snapshot()));
  app.post("/api/projects", async (context) => { try { const input = projectInput.parse(await readJsonBody(context.req.raw)); return success(await service.registerProject(input.configuredRootPath, input.displayLabel), 201); } catch (error) { return errorResponse(error); } });
  app.post("/api/projects/:projectId/archive", (context) => { try { service.archiveProject(id(context, "projectId")); return success({ ok: true }); } catch (error) { return errorResponse(error); } });
  app.post("/api/projects/:projectId/reopen", (context) => { try { return success(service.reopenProject(id(context, "projectId"))); } catch (error) { return errorResponse(error); } });
  app.post("/api/projects/:projectId/workspaces", async (context) => { try { const input = workspaceInput.parse(await readJsonBody(context.req.raw)); return success(await service.createDirectoryWorkspace(id(context, "projectId"), input), 201); } catch (error) { return errorResponse(error); } });
  app.patch("/api/workspaces/:workspaceId", async (context) => { try { const input = labelInput.parse(await readJsonBody(context.req.raw)); return success(service.labelWorkspace(id(context, "workspaceId"), input.displayLabel)); } catch (error) { return errorResponse(error); } });
  app.post("/api/workspaces/:workspaceId/archive", (context) => { try { service.archiveWorkspace(id(context, "workspaceId")); return success({ ok: true }); } catch (error) { return errorResponse(error); } });
  app.post("/api/workspaces/:workspaceId/reopen", (context) => { try { return success(service.reopenWorkspace(id(context, "workspaceId"))); } catch (error) { return errorResponse(error); } });
  app.post("/api/worktree-locations", async (context) => { try { const input = locationInput.parse(await readJsonBody(context.req.raw)); return success(await service.configureLocation(input), 201); } catch (error) { return errorResponse(error); } });
  return app;
};
