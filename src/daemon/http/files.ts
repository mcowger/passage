import { Hono } from "hono";
import { z } from "zod";
import { MAX_FILE_PATH_LENGTH, fileRevisionSchema } from "../../shared/domain/files.ts";
import { FileError, FileService } from "../workspaces/files.ts";
import { opaqueDomainIdSchema } from "../../shared/domain/workspaces.ts";
import { readJsonBody } from "./body.ts";

const path = z.string().min(1).max(MAX_FILE_PATH_LENGTH);
const writeInput = z.object({ path, content: z.string(), expected: fileRevisionSchema }).strict();
const id = (v: string) => { const p = opaqueDomainIdSchema.safeParse(v); if (!p.success) throw new Error("invalid-id"); return p.data; };
const error = (e: unknown) => Response.json({ error: e instanceof FileError ? e.code : "invalid-request" }, { status: e instanceof FileError ? (e.code === "conflict" ? 409 : e.code === "not-found" ? 404 : 400) : 400, headers: { "Cache-Control": "no-store" } });
const ok = (v: unknown, status = 200) => Response.json(v, { status, headers: { "Cache-Control": "no-store" } });

export const createFileRoutes = (files: FileService): Hono => {
  const app = new Hono(); app.use("*", async (c, next) => { c.header("Cache-Control", "no-store"); return next(); });
  app.get("/api/workspaces/:workspaceId/files", async (c) => { try { const p = path.parse(c.req.query("path") ?? "."); const cursor = c.req.query("cursor"); if (cursor !== undefined && !/^\d{1,6}$/.test(cursor)) throw new Error("invalid-cursor"); return ok(await files.list(id(c.req.param("workspaceId")), p, cursor)); } catch (e) { return error(e); } });
  app.get("/api/workspaces/:workspaceId/files/read", async (c) => { try { return ok(await files.read(id(c.req.param("workspaceId")), path.parse(c.req.query("path") ?? ""))); } catch (e) { return error(e); } });
  app.put("/api/workspaces/:workspaceId/files", async (c) => { try { const input = writeInput.parse(await readJsonBody(c.req.raw, 1_100_000)); return ok(await files.write(id(c.req.param("workspaceId")), input.path, input.content, input.expected)); } catch (e) { return error(e); } });
  return app;
};
