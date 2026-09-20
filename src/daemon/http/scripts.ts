import { Hono } from "hono";
import { z } from "zod";
import { opaqueDomainIdSchema } from "../../shared/domain/workspaces.ts";
import {
  workspaceScriptListSchema,
  workspaceScriptRuntimeSchema,
} from "../../shared/domain/workspace-actions.ts";
import { WorkspaceScriptError, type WorkspaceScriptsService } from "../workspaces/scripts.ts";
import { HttpInputError } from "./body.ts";

const id = (v: string) => opaqueDomainIdSchema.parse(v);
const scriptName = z.string().min(1).max(128);

const error = (e: unknown) => {
  if (e instanceof WorkspaceScriptError) {
    if (e.code === "script-running") {
      return Response.json(
        { error: e.code, message: e.message, ...(e.terminalId ? { terminalId: e.terminalId } : {}) },
        { status: 409, headers: { "Cache-Control": "no-store" } },
      );
    }
    const status = e.code === "not-found" ? 404 : e.code === "archived" ? 409 : 400;
    return Response.json({ error: e.code, message: e.message }, { status, headers: { "Cache-Control": "no-store" } });
  }
  if (e instanceof HttpInputError) {
    return Response.json({ error: e.code }, { status: e.code === "body-too-large" ? 413 : 400, headers: { "Cache-Control": "no-store" } });
  }
  if (e instanceof z.ZodError) {
    return Response.json({ error: "invalid-request" }, { status: 400, headers: { "Cache-Control": "no-store" } });
  }
  return Response.json({ error: "request-failed", message: e instanceof Error ? e.message : "Request failed" }, { status: 500, headers: { "Cache-Control": "no-store" } });
};
const ok = (v: unknown, status = 200) => Response.json(v, { status, headers: { "Cache-Control": "no-store" } });

export const createWorkspaceScriptRoutes = (service: WorkspaceScriptsService): Hono => {
  const app = new Hono();
  app.use("*", async (c, next) => { c.header("Cache-Control", "no-store"); return next(); });
  app.get("/api/workspaces/:workspaceId/scripts", async (c) => {
    try {
      const scripts = await service.list(id(c.req.param("workspaceId")));
      return ok(workspaceScriptListSchema.parse({ scripts }));
    } catch (e) {
      return error(e);
    }
  });
  app.post("/api/workspaces/:workspaceId/scripts/:scriptName/start", async (c) => {
    try {
      const runtime = await service.start(
        id(c.req.param("workspaceId")),
        scriptName.parse(c.req.param("scriptName")),
      );
      return ok(workspaceScriptRuntimeSchema.parse(runtime), 202);
    } catch (e) {
      return error(e);
    }
  });
  app.post("/api/workspaces/:workspaceId/scripts/:scriptName/stop", async (c) => {
    try {
      const runtime = await service.stop(
        id(c.req.param("workspaceId")),
        scriptName.parse(c.req.param("scriptName")),
      );
      return ok(workspaceScriptRuntimeSchema.parse(runtime));
    } catch (e) {
      return error(e);
    }
  });
  app.post("/api/workspaces/:workspaceId/scripts/:scriptName/restart", async (c) => {
    try {
      const runtime = await service.restart(
        id(c.req.param("workspaceId")),
        scriptName.parse(c.req.param("scriptName")),
      );
      return ok(workspaceScriptRuntimeSchema.parse(runtime), 202);
    } catch (e) {
      return error(e);
    }
  });
  return app;
};
