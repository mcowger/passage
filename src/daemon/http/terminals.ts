import { Hono } from "hono";
import { z } from "zod";
import { opaqueDomainIdSchema } from "../../shared/domain/workspaces.ts";
import { createTerminalInputSchema } from "../../shared/domain/terminals.ts";
import type { TerminalManager } from "../terminals/manager.ts";
import { readJsonBody } from "./body.ts";

const id = (val: string) => opaqueDomainIdSchema.parse(val);
const ok = (v: unknown, status = 200) => Response.json(v, { status, headers: { "Cache-Control": "no-store" } });
const error = (msg: string, status = 400) => Response.json({ error: msg }, { status, headers: { "Cache-Control": "no-store" } });

export const createTerminalRoutes = (terminals: TerminalManager): Hono => {
  const app = new Hono();
  app.use("*", async (c, next) => {
    c.header("Cache-Control", "no-store");
    return next();
  });

  app.get("/api/workspaces/:workspaceId/terminals", (c) => {
    try {
      const workspaceId = id(c.req.param("workspaceId"));
      return ok(terminals.list(workspaceId));
    } catch (e) {
      return error("invalid-workspace-id");
    }
  });

  app.post("/api/workspaces/:workspaceId/terminals", async (c) => {
    try {
      const workspaceId = id(c.req.param("workspaceId"));
      let body: unknown = {};
      try {
        body = await readJsonBody(c.req.raw);
      } catch {}
      const input = createTerminalInputSchema.parse(body);
      const summary = await terminals.create(workspaceId, input);
      return ok(summary, 201);
    } catch (e) {
      return error(e instanceof Error ? e.message : "invalid-request");
    }
  });

  app.get("/api/terminals/:terminalId", (c) => {
    try {
      const terminalId = id(c.req.param("terminalId"));
      const summary = terminals.get(terminalId);
      if (!summary) return error("not-found", 404);
      return ok(summary);
    } catch {
      return error("invalid-terminal-id");
    }
  });

  app.delete("/api/terminals/:terminalId", (c) => {
    try {
      const terminalId = id(c.req.param("terminalId"));
      const killed = terminals.terminate(terminalId);
      if (!killed) return error("not-found", 404);
      return ok({ ok: true });
    } catch {
      return error("invalid-terminal-id");
    }
  });

  return app;
};
