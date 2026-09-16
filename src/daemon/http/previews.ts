import { Hono } from "hono";
import { z } from "zod";
import { opaqueDomainIdSchema } from "../../shared/domain/workspaces.ts";
import {
  createPreviewInputSchema,
  normalizePreviewUrl,
  previewViewportSchema,
  updatePreviewInputSchema,
  webPreviewSchema,
} from "../../shared/domain/previews.ts";
import type { WebPreviewManager } from "../previews/manager.ts";
import type { WorkspaceEventHub } from "../workspaces/events.ts";
import { HttpInputError, readJsonBody } from "./body.ts";

const ok = (value: unknown, status = 200) => Response.json(value, { status, headers: { "Cache-Control": "no-store" } });
const error = (message: string, status = 400) => Response.json({ error: message }, { status, headers: { "Cache-Control": "no-store" } });

const navigateInput = z.object({ url: z.string().min(1).max(2048) }).strict();
const viewportInput = previewViewportSchema.partial().strict();

function previewId(value: string): string {
  const parsed = opaqueDomainIdSchema.safeParse(value);
  if (!parsed.success) throw new HttpInputError("invalid-id");
  return parsed.data;
}

export const createPreviewRoutes = (previews: WebPreviewManager, _workspaceEvents: WorkspaceEventHub): Hono => {
  const app = new Hono();
  app.use("*", async (c, next) => {
    c.header("Cache-Control", "no-store");
    return next();
  });

  app.get("/api/workspaces/:workspaceId/previews", (c) => {
    try {
      return ok(previews.list(previewId(c.req.param("workspaceId"))));
    } catch (e) {
      return error(e instanceof Error ? e.message : "invalid-request");
    }
  });

  app.post("/api/workspaces/:workspaceId/previews", async (c) => {
    try {
      const workspaceId = previewId(c.req.param("workspaceId"));
      const input = createPreviewInputSchema.parse(await readJsonBody(c.req.raw));
      const created = await previews.create(workspaceId, input);
      return ok(webPreviewSchema.parse(created), 201);
    } catch (e) {
      return error(e instanceof Error ? e.message : "invalid-request", 400);
    }
  });

  app.get("/api/workspaces/:workspaceId/previews/candidates", async (c) => {
    try {
      const workspaceId = previewId(c.req.param("workspaceId"));
      return ok(await previews.portCandidates(workspaceId, [Number(process.env.PORT ?? 3333)]));
    } catch (e) {
      return error(e instanceof Error ? e.message : "invalid-request");
    }
  });

  app.get("/api/previews/:previewId", (c) => {
    try {
      const found = previews.get(previewId(c.req.param("previewId")));
      if (!found) return error("not-found", 404);
      return ok(found);
    } catch {
      return error("invalid-id");
    }
  });

  app.patch("/api/previews/:previewId", async (c) => {
    try {
      const input = updatePreviewInputSchema.parse(await readJsonBody(c.req.raw));
      const updated = await previews.update(previewId(c.req.param("previewId")), input);
      if (!updated) return error("not-found", 404);
      return ok(updated);
    } catch (e) {
      return error(e instanceof Error ? e.message : "invalid-request");
    }
  });

  app.post("/api/previews/:previewId/open", async (c) => {
    try {
      const opened = await previews.open(previewId(c.req.param("previewId")));
      if (!opened) return error("not-found", 404);
      if (opened.status === "error") return ok(opened, 502);
      return ok(opened);
    } catch (e) {
      return error(e instanceof Error ? e.message : "invalid-request");
    }
  });

  app.post("/api/previews/:previewId/stop", async (c) => {
    try {
      const stopped = await previews.stop(previewId(c.req.param("previewId")));
      if (!stopped) return error("not-found", 404);
      return ok(stopped);
    } catch (e) {
      return error(e instanceof Error ? e.message : "invalid-request");
    }
  });

  app.delete("/api/previews/:previewId", async (c) => {
    try {
      const removed = await previews.remove(previewId(c.req.param("previewId")));
      if (!removed) return error("not-found", 404);
      return ok({ ok: true });
    } catch {
      return error("invalid-id");
    }
  });

  app.post("/api/previews/:previewId/navigate", async (c) => {
    try {
      const input = navigateInput.parse(await readJsonBody(c.req.raw));
      normalizePreviewUrl(input.url);
      const updated = await previews.navigate(previewId(c.req.param("previewId")), input.url);
      if (!updated) return error("not-found", 404);
      return ok(updated);
    } catch (e) {
      return error(e instanceof Error ? e.message : "invalid-request");
    }
  });

  for (const action of ["back", "forward", "reload"] as const) {
    app.post(`/api/previews/:previewId/${action}`, async (c) => {
      try {
        const id = previewId(c.req.param("previewId"));
        const updated = action === "back" ? await previews.back(id) : action === "forward" ? await previews.forward(id) : await previews.reload(id);
        if (!updated) return error("not-found", 404);
        return ok(updated);
      } catch (e) {
        return error(e instanceof Error ? e.message : "invalid-request");
      }
    });
  }

  app.post("/api/previews/:previewId/viewport", async (c) => {
    try {
      const input = viewportInput.parse(await readJsonBody(c.req.raw));
      const updated = await previews.update(previewId(c.req.param("previewId")), { viewport: input });
      if (!updated) return error("not-found", 404);
      return ok(updated);
    } catch (e) {
      return error(e instanceof Error ? e.message : "invalid-request");
    }
  });

  app.post("/api/previews/:previewId/lease", async (c) => {
    try {
      const id = previewId(c.req.param("previewId"));
      const body = await readJsonBody(c.req.raw).catch(() => ({}));
      const clientId = z.object({ clientId: z.string().min(1).max(256) }).strict().parse(body).clientId;
      const taken = previews.takeLease(id, clientId);
      if (!taken) return error("preview-not-running", 409);
      const found = previews.get(id, clientId);
      return ok(found);
    } catch (e) {
      return error(e instanceof Error ? e.message : "invalid-request");
    }
  });

  return app;
};
