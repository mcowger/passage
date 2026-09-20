import { Hono } from "hono";
import { z } from "zod";
import { opaqueDomainIdSchema, MAX_DOMAIN_LABEL_LENGTH, MAX_DOMAIN_PATH_LENGTH, PROJECT_ICON_NAMES } from "../../shared/domain/workspaces.ts";
import { workspaceLayoutSchema } from "../../shared/domain/layout.ts";
import { workspaceSettingsSchema } from "../../shared/domain/settings.ts";
import { BUILTIN_THEMES, AVAILABLE_FONTS, BUILTIN_TOOL_RENDERERS } from "../../shared/domain/customization.ts";
import { WorkspaceError, type WorkspaceService } from "../workspaces/service.ts";
import type { WorkspaceEventHub } from "../workspaces/events.ts";
import type { WorkspacesChangedReason } from "../../shared/protocol/index.ts";
import { HttpInputError, readJsonBody } from "./body.ts";

const hexColor = z.string().regex(/^#[0-9a-fA-F]{6}$/);
const projectIcon = z.enum(PROJECT_ICON_NAMES as unknown as [string, ...string[]]);
const projectInput = z.object({ configuredRootPath: z.string().min(1).max(MAX_DOMAIN_PATH_LENGTH), displayLabel: z.string().trim().min(1).max(MAX_DOMAIN_LABEL_LENGTH), iconName: projectIcon.nullish(), iconColor: hexColor.nullish(), useProjectIcon: z.boolean().optional() }).strict();
const projectUpdateInput = z.object({ displayLabel: z.string().trim().min(1).max(MAX_DOMAIN_LABEL_LENGTH).optional(), iconName: projectIcon.nullable().optional(), iconColor: hexColor.nullable().optional(), useProjectIcon: z.boolean().optional() }).strict().refine((v) => v.displayLabel !== undefined || v.iconName !== undefined || v.iconColor !== undefined || v.useProjectIcon !== undefined, { message: "Nothing to update" });
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

export const createWorkspaceRoutes = (service: WorkspaceService, hooks?: { onArchiveWorkspace?: (workspaceId: string) => Promise<void> }, events?: WorkspaceEventHub): Hono => {
  const app = new Hono();
  /** Emit a workspace-list invalidation after a committed mutation. Reads
   *  and failures emit nothing; emit helpers never throw so the HTTP
   *  mutation stays green. */
  const changed = (reason: WorkspacesChangedReason, ids?: { workspaceId?: string; projectId?: string }) => {
    events?.emitWorkspacesChanged({ reason, ...ids });
  };
  app.use("*", async (context, next) => { context.header("Cache-Control", "no-store"); return next(); });
  app.get("/api/workspaces/snapshot", async (context) => { try { await service.ensureAllDefaults(); } catch {} return success(service.snapshot()); });
  app.post("/api/projects", async (context) => { try { const input = projectInput.parse(await readJsonBody(context.req.raw)); const project = await service.registerProject(input.configuredRootPath, input.displayLabel, { iconName: input.iconName ?? null, iconColor: input.iconColor ?? null, useProjectIcon: input.useProjectIcon ?? false }); changed("create", { projectId: project.id }); return success(project, 201); } catch (error) { return errorResponse(error); } });
  app.patch("/api/projects/:projectId", async (context) => { try { const input = projectUpdateInput.parse(await readJsonBody(context.req.raw)); const project = service.updateProject(id(context, "projectId"), input); changed("update", { projectId: project.id }); return success(project); } catch (error) { return errorResponse(error); } });
  app.get("/api/projects/:projectId/icon", async (context) => {
    try {
      const icon = await service.getProjectIconData(id(context, "projectId"));
      if (!icon) return Response.json({ error: "icon-not-found", message: "No recognizable icon file found in this project" }, { status: 404, headers: { "Cache-Control": "no-store" } });
      // SVG is served as active content from the app origin: a directly
      // opened icon URL must not execute embedded scripts, so sandbox it.
      // <img> embedding is unaffected by the sandbox or nosniff.
      return new Response(Buffer.from(icon.data, "base64"), { status: 200, headers: { "Content-Type": icon.mimeType, "Cache-Control": "private, max-age=60", "Content-Security-Policy": "sandbox; default-src 'none'", "X-Content-Type-Options": "nosniff" } });
    } catch (error) { return errorResponse(error); }
  });
  app.post("/api/projects/:projectId/archive", (context) => { try { const projectId = id(context, "projectId"); service.archiveProject(projectId); changed("archive", { projectId }); return success({ ok: true }); } catch (error) { return errorResponse(error); } });
  app.post("/api/projects/:projectId/reopen", (context) => { try { const project = service.reopenProject(id(context, "projectId")); changed("reopen", { projectId: project.id }); return success(project); } catch (error) { return errorResponse(error); } });
  app.post("/api/projects/:projectId/workspaces", async (context) => { try { const projectId = id(context, "projectId"); const input = workspaceInput.parse(await readJsonBody(context.req.raw)); const workspace = await service.createDirectoryWorkspace(projectId, input); changed("create", { workspaceId: workspace.id, projectId }); return success(workspace, 201); } catch (error) { return errorResponse(error); } });
  app.patch("/api/workspaces/:workspaceId", async (context) => { try { const input = labelInput.parse(await readJsonBody(context.req.raw)); const workspace = service.labelWorkspace(id(context, "workspaceId"), input.displayLabel); changed("update", { workspaceId: workspace.id, projectId: workspace.projectId }); return success(workspace); } catch (error) { return errorResponse(error); } });
  app.post("/api/workspaces/:workspaceId/archive", async (context) => { try { const workspaceId = id(context, "workspaceId"); await hooks?.onArchiveWorkspace?.(workspaceId); service.archiveWorkspace(workspaceId); changed("archive", { workspaceId }); return success({ ok: true }); } catch (error) { return errorResponse(error); } });
  app.post("/api/workspaces/:workspaceId/reopen", (context) => { try { const workspace = service.reopenWorkspace(id(context, "workspaceId")); changed("reopen", { workspaceId: workspace.id, projectId: workspace.projectId }); return success(workspace); } catch (error) { return errorResponse(error); } });
  app.post("/api/worktree-locations", async (context) => { try { const input = locationInput.parse(await readJsonBody(context.req.raw)); const location = await service.configureLocation(input); changed("create", { projectId: location.projectId ?? undefined }); return success(location, 201); } catch (error) { return errorResponse(error); } });
  app.get("/api/worktree-locations", (context) => { try { return success(service.listAllLocations()); } catch (error) { return errorResponse(error); } });
  app.patch("/api/worktree-locations/:locationId", async (context) => { try { const input = locationEnabledInput.parse(await readJsonBody(context.req.raw)); const location = await service.setLocationEnabled(id(context, "locationId"), input.enabled); changed("update", { projectId: location.projectId ?? undefined }); return success(location); } catch (error) { return errorResponse(error); } });

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
  app.get("/api/customization/font-options", () => success(AVAILABLE_FONTS));
  app.get("/api/customization/tool-renderers", () => success(BUILTIN_TOOL_RENDERERS));

  return app;
};
