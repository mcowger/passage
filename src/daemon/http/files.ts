import { Hono } from "hono";
import { z } from "zod";
import { MAX_FILE_PATH_LENGTH, fileRevisionSchema } from "../../shared/domain/files.ts";
import type { FilesChangedReason } from "../../shared/protocol/index.ts";
import { FileError, FileService } from "../workspaces/files.ts";
import type { WorkspaceEventHub } from "../workspaces/events.ts";
import { filesSearchQuerySchema, filesSearchResponseSchema } from "../../shared/protocol/workspace.ts";
import { opaqueDomainIdSchema } from "../../shared/domain/workspaces.ts";
import { readJsonBody } from "./body.ts";

const path = z.string().min(1).max(MAX_FILE_PATH_LENGTH);
const writeInput = z.object({ path, content: z.string(), expected: fileRevisionSchema }).strict();
const createInput = z.object({ path, kind: z.enum(["file", "directory"]) }).strict();
const renameInput = z.object({ path, newPath: path }).strict();
const duplicateInput = z.object({ path }).strict();
const id = (v: string) => { const p = opaqueDomainIdSchema.safeParse(v); if (!p.success) throw new Error("invalid-id"); return p.data; };
const error = (e: unknown) => Response.json({ error: e instanceof FileError ? e.code : "invalid-request" }, { status: e instanceof FileError ? (e.code === "conflict" ? 409 : e.code === "not-found" ? 404 : 400) : 400, headers: { "Cache-Control": "no-store" } });
const ok = (v: unknown, status = 200) => Response.json(v, { status, headers: { "Cache-Control": "no-store" } });

export const createFileRoutes = (files: FileService, events?: WorkspaceEventHub): Hono => {
  const app = new Hono(); app.use("*", async (c, next) => { c.header("Cache-Control", "no-store"); return next(); });
  const changed = (workspaceId: string, reason: FilesChangedReason, path?: string, previousPath?: string) => {
    events?.emit({ workspaceId, reason, ...(path !== undefined ? { path } : {}), ...(previousPath !== undefined ? { previousPath } : {}) });
  };
  app.get("/api/workspaces/:workspaceId/files", async (c) => { try { const p = path.parse(c.req.query("path") ?? "."); const cursor = c.req.query("cursor"); if (cursor !== undefined && !/^\d{1,6}$/.test(cursor)) throw new Error("invalid-cursor"); return ok(await files.list(id(c.req.param("workspaceId")), p, cursor)); } catch (e) { return error(e); } });
  // Bounded composer autocomplete search. Read-only: emits no WS events.
  app.get("/api/workspaces/:workspaceId/files/search", async (c) => {
    try {
      const query = filesSearchQuerySchema.parse({ q: c.req.query("q") ?? "", limit: c.req.query("limit") ?? "20" });
      const workspaceId = id(c.req.param("workspaceId"));
      const { entries, truncated } = await files.search(workspaceId, query.q, query.limit);
      return ok(filesSearchResponseSchema.parse({ query: query.q, entries, truncated }));
    } catch (e) { return error(e); }
  });
  app.get("/api/workspaces/:workspaceId/files/read", async (c) => { try { return ok(await files.read(id(c.req.param("workspaceId")), path.parse(c.req.query("path") ?? ""))); } catch (e) { return error(e); } });
  app.put("/api/workspaces/:workspaceId/files", async (c) => { try { const input = writeInput.parse(await readJsonBody(c.req.raw, 1_100_000)); const workspaceId = id(c.req.param("workspaceId")); const result = await files.write(workspaceId, input.path, input.content, input.expected); changed(workspaceId, "write", input.path); return ok(result); } catch (e) { return error(e); } });
  app.post("/api/workspaces/:workspaceId/files/create", async (c) => { try { const input = createInput.parse(await readJsonBody(c.req.raw)); const workspaceId = id(c.req.param("workspaceId")); const result = await files.create(workspaceId, input.path, input.kind); changed(workspaceId, "create", input.path); return ok(result, 201); } catch (e) { return error(e); } });
  app.post("/api/workspaces/:workspaceId/files/rename", async (c) => { try { const input = renameInput.parse(await readJsonBody(c.req.raw)); const workspaceId = id(c.req.param("workspaceId")); const result = await files.rename(workspaceId, input.path, input.newPath); changed(workspaceId, "rename", input.newPath, input.path); return ok(result); } catch (e) { return error(e); } });
  app.post("/api/workspaces/:workspaceId/files/duplicate", async (c) => { try { const input = duplicateInput.parse(await readJsonBody(c.req.raw)); const workspaceId = id(c.req.param("workspaceId")); const result = await files.duplicate(workspaceId, input.path); changed(workspaceId, "duplicate", result.path, input.path); return ok(result, 201); } catch (e) { return error(e); } });
  app.delete("/api/workspaces/:workspaceId/files", async (c) => { try { const target = path.parse(c.req.query("path") ?? ""); const workspaceId = id(c.req.param("workspaceId")); const result = await files.remove(workspaceId, target); changed(workspaceId, "delete", target); return ok(result); } catch (e) { return error(e); } });
  return app;
};
