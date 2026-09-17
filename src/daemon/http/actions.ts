import { Hono } from "hono";
import { z } from "zod";
import { opaqueDomainIdSchema } from "../../shared/domain/workspaces.ts";
import { WORKSPACE_SETUP_ACTION_ID } from "../../shared/domain/workspace-actions.ts";
import { WorkspaceActionError, type WorkspaceActionsService } from "../workspaces/actions.ts";
import { HttpInputError, readJsonBody } from "./body.ts";

const runAction = z.object({ id: z.string().min(1).max(64) }).strict();
const id = (v: string) => opaqueDomainIdSchema.parse(v);

const error = (e: unknown) => {
  if (e instanceof WorkspaceActionError) {
    if (e.code === "action-running") {
      return Response.json(
        { error: e.code, message: e.message, ...(e.runId ? { runId: e.runId } : {}) },
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

export const createWorkspaceActionRoutes = (service: WorkspaceActionsService): Hono => {
  const app = new Hono();
  app.use("*", async (c, next) => { c.header("Cache-Control", "no-store"); return next(); });
  app.get("/api/workspaces/:workspaceId/actions", async (c) => {
    try {
      return ok({ actions: service.list(id(c.req.param("workspaceId"))) });
    } catch (e) {
      return error(e);
    }
  });
  app.post("/api/workspaces/:workspaceId/actions/run", async (c) => {
    try {
      const body = runAction.parse(await readJsonBody(c.req.raw));
      if (body.id !== WORKSPACE_SETUP_ACTION_ID) {
        return Response.json(
          { error: "unknown-action", message: `Unknown workspace action "${body.id}".` },
          { status: 400, headers: { "Cache-Control": "no-store" } },
        );
      }
      return ok(await service.start(id(c.req.param("workspaceId")), body.id), 202);
    } catch (e) {
      return error(e);
    }
  });
  app.get("/api/workspaces/:workspaceId/actions/runs/:runId", async (c) => {
    try {
      return ok(service.get(id(c.req.param("workspaceId")), id(c.req.param("runId"))));
    } catch (e) {
      return error(e);
    }
  });
  app.post("/api/workspaces/:workspaceId/actions/runs/:runId/cancel", async (c) => {
    try {
      return ok(service.cancel(id(c.req.param("workspaceId")), id(c.req.param("runId"))));
    } catch (e) {
      return error(e);
    }
  });
  return app;
};
