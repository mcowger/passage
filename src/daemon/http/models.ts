import { Hono } from "hono";
import { z } from "zod";
import { agentCapabilitiesSchema } from "../../shared/domain/agents.ts";
import { queryAvailableModels, type ModelCatalogProbeOptions } from "../models/catalog.ts";

const modelsResponseSchema = z.object({ models: agentCapabilitiesSchema.shape.models }).strict();

const ok = (value: unknown, status = 200) => Response.json(value, { status, headers: { "Cache-Control": "no-store" } });

/** Global pi model catalog probed from `pi --mode rpc`. Unlike the per-agent
 * capabilities endpoint, this needs no running agent, so unauthenticated
 * surfaces like Settings can offer a model picker. */
export const createModelRoutes = (probeOptions?: ModelCatalogProbeOptions): Hono => {
  const app = new Hono();
  app.use("*", async (c, next) => { c.header("Cache-Control", "no-store"); return next(); });
  app.get("/api/models", async (c) => {
    try {
      const models = await queryAvailableModels(probeOptions);
      return ok(modelsResponseSchema.parse({ models }));
    } catch (e) {
      return Response.json(
        { error: "models-unavailable", message: e instanceof Error ? e.message : "Unable to list pi models" },
        { status: 502, headers: { "Cache-Control": "no-store" } },
      );
    }
  });
  return app;
};
