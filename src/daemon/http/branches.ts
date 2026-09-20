import { Hono } from "hono";
import { z } from "zod";
import { opaqueDomainIdSchema } from "../../shared/domain/workspaces.ts";
import { projectBranchListSchema } from "../../shared/domain/git.ts";
import { BranchError, BranchService } from "../workspaces/branches.ts";
import type { WorkspaceEventHub } from "../workspaces/events.ts";
import { HttpInputError, readJsonBody } from "./body.ts";

const branchName = z.string().trim().min(1).max(1024);
const removeInput = z.object({ branch: branchName, force: z.literal(true).optional() }).strict();

const id = (value: string) => {
  const parsed = opaqueDomainIdSchema.safeParse(value);
  if (!parsed.success) throw new HttpInputError("invalid-id");
  return parsed.data;
};

const error = (e: unknown) => {
  if (e instanceof BranchError) {
    const status = e.code === "invalid-project" ? 409 : e.code === "force-required" ? 428 : e.code === "invalid-branch" ? 400 : 422;
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

const ok = (value: unknown, status = 200) => Response.json(value, { status, headers: { "Cache-Control": "no-store" } });

export const createBranchRoutes = (service: BranchService, events?: WorkspaceEventHub): Hono => {
  const app = new Hono();
  app.use("*", async (c, next) => {
    c.header("Cache-Control", "no-store");
    return next();
  });
  /** Branch review snapshot for the project modal. Read-only: emits nothing. */
  app.get("/api/projects/:projectId/branches", async (c) => {
    try {
      const branches = await service.list(id(c.req.param("projectId")));
      return ok(projectBranchListSchema.parse(branches));
    } catch (e) {
      return error(e);
    }
  });
  /** Safe branch delete (`-d`); unmerged work returns 428 `force-required`
   *  so the UI can offer the explicit second force confirm. Returns the
   *  fresh branch list inline (HTTP = snapshots) and invalidates the
   *  workspace snapshot for other windows. */
  app.post("/api/projects/:projectId/branches/delete", async (c) => {
    try {
      const projectId = id(c.req.param("projectId"));
      const input = removeInput.parse(await readJsonBody(c.req.raw));
      const branches = await service.remove(projectId, input.branch, input.force === true);
      events?.emitWorkspacesChanged({ reason: "update", projectId });
      return ok(projectBranchListSchema.parse(branches));
    } catch (e) {
      return error(e);
    }
  });
  return app;
};
