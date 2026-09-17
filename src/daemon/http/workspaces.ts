import { Hono } from "hono";
import { z } from "zod";
import { opaqueDomainIdSchema, MAX_DOMAIN_LABEL_LENGTH, MAX_DOMAIN_PATH_LENGTH } from "../../shared/domain/workspaces.ts";
import { workspaceLayoutSchema } from "../../shared/domain/layout.ts";
import { workspaceSettingsSchema } from "../../shared/domain/settings.ts";
import { BUILTIN_THEMES, BUILTIN_FONTS, BUILTIN_TOOL_RENDERERS } from "../../shared/domain/customization.ts";
import { WorkspaceError, type WorkspaceService } from "../workspaces/service.ts";
import { HttpInputError, readJsonBody } from "./body.ts";

const projectInput = z.object({ configuredRootPath: z.string().min(1).max(MAX_DOMAIN_PATH_LENGTH), displayLabel: z.string().trim().min(1).max(MAX_DOMAIN_LABEL_LENGTH) }).strict();
const workspaceInput = z.object({ cwd: z.string().min(1).max(MAX_DOMAIN_PATH_LENGTH).optional(), displayLabel: z.string().trim().min(1).max(MAX_DOMAIN_LABEL_LENGTH) }).strict();
const locationInput = z.object({ projectId: opaqueDomainIdSchema.optional(), displayLabel: z.string().trim().min(1).max(MAX_DOMAIN_LABEL_LENGTH), configuredRootPath: z.string().min(1).max(MAX_DOMAIN_PATH_LENGTH), enabled: z.boolean().optional() }).strict();
const locationEnabledInput = z.object({ enabled: z.boolean() }).strict();
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

export const createWorkspaceRoutes = (service: WorkspaceService, hooks?: { onArchiveWorkspace?: (workspaceId: string) => Promise<void> }): Hono => {
  const app = new Hono();
  app.use("*", async (context, next) => { context.header("Cache-Control", "no-store"); return next(); });
  app.get("/api/workspaces/snapshot", async (context) => { try { await service.ensureAllDefaults(); } catch {} return success(service.snapshot()); });
  app.post("/api/projects", async (context) => { try { const input = projectInput.parse(await readJsonBody(context.req.raw)); return success(await service.registerProject(input.configuredRootPath, input.displayLabel), 201); } catch (error) { return errorResponse(error); } });
  app.post("/api/projects/:projectId/archive", (context) => { try { service.archiveProject(id(context, "projectId")); return success({ ok: true }); } catch (error) { return errorResponse(error); } });
  app.post("/api/projects/:projectId/reopen", (context) => { try { return success(service.reopenProject(id(context, "projectId"))); } catch (error) { return errorResponse(error); } });
  app.post("/api/projects/:projectId/workspaces", async (context) => { try { const input = workspaceInput.parse(await readJsonBody(context.req.raw)); return success(await service.createDirectoryWorkspace(id(context, "projectId"), input), 201); } catch (error) { return errorResponse(error); } });
  app.patch("/api/workspaces/:workspaceId", async (context) => { try { const input = labelInput.parse(await readJsonBody(context.req.raw)); return success(service.labelWorkspace(id(context, "workspaceId"), input.displayLabel)); } catch (error) { return errorResponse(error); } });
  app.post("/api/workspaces/:workspaceId/archive", async (context) => { try { const workspaceId = id(context, "workspaceId"); await hooks?.onArchiveWorkspace?.(workspaceId); service.archiveWorkspace(workspaceId); return success({ ok: true }); } catch (error) { return errorResponse(error); } });
  app.post("/api/workspaces/:workspaceId/reopen", (context) => { try { return success(service.reopenWorkspace(id(context, "workspaceId"))); } catch (error) { return errorResponse(error); } });
  app.post("/api/worktree-locations", async (context) => { try { const input = locationInput.parse(await readJsonBody(context.req.raw)); return success(await service.configureLocation(input), 201); } catch (error) { return errorResponse(error); } });
  app.get("/api/worktree-locations", (context) => { try { return success(service.listAllLocations()); } catch (error) { return errorResponse(error); } });
  app.patch("/api/worktree-locations/:locationId", async (context) => { try { const input = locationEnabledInput.parse(await readJsonBody(context.req.raw)); return success(await service.setLocationEnabled(id(context, "locationId"), input.enabled)); } catch (error) { return errorResponse(error); } });

  app.get("/api/workspaces/:workspaceId/layout", (context) => {
    try {
      return success(service.getLayout(id(context, "workspaceId")));
    } catch (error) {
      return errorResponse(error);
    }
  });
  app.put("/api/workspaces/:workspaceId/layout", async (context) => {
    try {
      const input = workspaceLayoutSchema.parse(await readJsonBody(context.req.raw));
      return success(service.saveLayout(id(context, "workspaceId"), input));
    } catch (error) {
      return errorResponse(error);
    }
  });

  app.get("/api/workspaces/:workspaceId/settings", (context) => {
    try {
      return success(service.getSettings(id(context, "workspaceId")));
    } catch (error) {
      return errorResponse(error);
    }
  });
  app.put("/api/workspaces/:workspaceId/settings", async (context) => {
    try {
      const input = workspaceSettingsSchema.parse(await readJsonBody(context.req.raw));
      return success(service.saveSettings(id(context, "workspaceId"), input));
    } catch (error) {
      return errorResponse(error);
    }
  });

  app.get("/api/customization/themes", () => success(BUILTIN_THEMES));
  app.get("/api/customization/fonts", () => success(BUILTIN_FONTS));
  app.get("/api/customization/tool-renderers", () => success(BUILTIN_TOOL_RENDERERS));

  return app;
};
