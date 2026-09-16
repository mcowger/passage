import { Hono, type Context } from "hono";
import { z } from "zod";
import { agentCapabilitiesSchema, agentStatusSchema, type AgentSummary } from "../../shared/domain/agents.ts";
import { opaqueDomainIdSchema } from "../../shared/domain/workspaces.ts";
import { AgentError, type AgentService, type AgentSnapshot } from "../agents/service.ts";
import { HttpInputError, readJsonBody } from "./body.ts";
import { MAX_AGENT_IMAGE_DATA_CHARACTERS, MAX_AGENT_IMAGES, MAX_AGENT_MESSAGE_BYTES, agentImageSchema } from "../../shared/protocol/agents.ts";

const MAX_AGENT_JSON_BYTES = MAX_AGENT_IMAGES * MAX_AGENT_IMAGE_DATA_CHARACTERS + MAX_AGENT_MESSAGE_BYTES + 4096;
const MAX_AGENT_SETTING_BODY_BYTES = 1024;
const MAX_AGENT_TITLE_LENGTH = 256;
const MAX_AGENT_SETTING_LENGTH = 256;

const createInput = z.object({ title: z.string().trim().min(1).max(MAX_AGENT_TITLE_LENGTH).optional() }).strict();
const messageInput = z.object({
  message: z.string().min(1).max(MAX_AGENT_MESSAGE_BYTES),
  images: z.array(agentImageSchema).max(MAX_AGENT_IMAGES).optional(),
}).strict();
const modelInput = z.object({ provider: z.string().trim().min(1).max(MAX_AGENT_SETTING_LENGTH), modelId: z.string().trim().min(1).max(MAX_AGENT_SETTING_LENGTH) }).strict();
const thinkingInput = z.object({ level: z.string().trim().min(1).max(MAX_AGENT_SETTING_LENGTH) }).strict();
const uiResponseInput = z.object({
  id: z.string().min(1).max(256),
  value: z.string().max(MAX_AGENT_MESSAGE_BYTES).optional(),
  confirmed: z.boolean().optional(),
  cancelled: z.literal(true).optional(),
}).refine(
  (data) => data.cancelled !== undefined || data.confirmed !== undefined || data.value !== undefined,
  "Either value, confirmed, or cancelled must be provided"
);
const acceptedResponseSchema = z.object({ accepted: z.literal(true) }).strict();
const okResponseSchema = z.object({ ok: z.literal(true) }).strict();

function success(value: unknown, status = 200): Response {
  return Response.json(value, { status, headers: { "Cache-Control": "no-store" } });
}

function errorResponse(error: unknown): Response {
  if (error instanceof HttpInputError) {
    return success({ error: error.code }, error.code === "body-too-large" ? 413 : 400);
  }
  if (error instanceof z.ZodError) return success({ error: "invalid-request" }, 400);
  if (error instanceof AgentError) {
    const status = error.code === "not-found" ? 404
      : error.code === "archived" || error.code === "not-running" ? 409
        : error.code === "limit" ? 429
          : 400;
    return success({ error: error.code }, status);
  }
  return success({ error: "agent-operation-failed" }, 502);
}

function id(value: string): string {
  const parsed = opaqueDomainIdSchema.safeParse(value);
  if (!parsed.success) throw new HttpInputError("invalid-id");
  return parsed.data;
}

function publicSnapshot(snapshot: AgentSnapshot): AgentSummary {
  return {
    id: snapshot.id,
    workspaceId: snapshot.workspaceId,
    title: snapshot.title,
    status: agentStatusSchema.parse(snapshot.lastKnownStatus),
    modelPreference: snapshot.modelPreference,
    thinkingPreference: snapshot.thinkingPreference,
    live: snapshot.live,
    persisted: snapshot.persisted,
    ...(snapshot.generation === undefined ? {} : { generation: snapshot.generation }),
    ...(snapshot.pendingUiRequest === undefined ? {} : { pendingUiRequest: snapshot.pendingUiRequest }),
  };
}

function integer(value: string | undefined, fallback: number, maximum: number): number {
  if (value === undefined) return fallback;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0 || parsed > maximum) throw new AgentError("invalid-input", "invalid query cursor");
  return parsed;
}

export function createAgentRoutes(service: AgentService): Hono {
  const app = new Hono();
  app.use("*", async (context, next) => { context.header("Cache-Control", "no-store"); return next(); });

  app.get("/api/workspaces/:workspaceId/agents", (context) => {
    try {
      const limit = integer(context.req.query("limit"), 100, 100);
      return success(service.list(id(context.req.param("workspaceId")), limit).map(publicSnapshot));
    } catch (error) { return errorResponse(error); }
  });
  app.post("/api/workspaces/:workspaceId/agents", async (context) => {
    try {
      const input = createInput.parse(await readJsonBody(context.req.raw, MAX_AGENT_JSON_BYTES));
      return success(publicSnapshot(await service.create(id(context.req.param("workspaceId")), input.title)), 201);
    } catch (error) { return errorResponse(error); }
  });
  app.get("/api/agents/:agentId", (context) => {
    try { return success(publicSnapshot(service.snapshot(id(context.req.param("agentId"))))); }
    catch (error) { return errorResponse(error); }
  });
  app.get("/api/agents/:agentId/capabilities", async (context) => {
    try {
      return success(agentCapabilitiesSchema.parse(await service.capabilities(id(context.req.param("agentId") ?? ""))));
    } catch (error) { return errorResponse(error); }
  });
  app.post("/api/agents/:agentId/start", async (context) => {
    try { const agentId = id(context.req.param("agentId")); await service.start(agentId); return success(publicSnapshot(service.snapshot(agentId))); }
    catch (error) { return errorResponse(error); }
  });
  app.get("/api/agents/:agentId/history", async (context) => {
    try {
      const beforeValue = context.req.query("before");
      const before = beforeValue === undefined ? undefined : integer(beforeValue, 0, Number.MAX_SAFE_INTEGER);
      const limit = integer(context.req.query("limit"), 100, 500);
      return success(await service.history(id(context.req.param("agentId")), before, limit));
    } catch (error) { return errorResponse(error); }
  });

  const messageRoute = (operation: "prompt" | "steer" | "followUp") => async (context: Context) => {
    try {
      const input = messageInput.parse(await readJsonBody(context.req.raw, MAX_AGENT_JSON_BYTES));
      const agentId = id(context.req.param("agentId") ?? "");
      await service[operation](agentId, input.message, input.images);
      return success(acceptedResponseSchema.parse({ accepted: true }), 202);
    } catch (error) { return errorResponse(error); }
  };
  app.post("/api/agents/:agentId/prompt", messageRoute("prompt"));
  app.post("/api/agents/:agentId/steer", messageRoute("steer"));
  app.post("/api/agents/:agentId/follow-up", messageRoute("followUp"));
  app.post("/api/agents/:agentId/abort", async (context) => {
    try { await service.abort(id(context.req.param("agentId"))); return success(acceptedResponseSchema.parse({ accepted: true }), 202); }
    catch (error) { return errorResponse(error); }
  });
  app.post("/api/agents/:agentId/compact", async (context) => {
    try {
      const agentId = id(context.req.param("agentId"));
      let customInstructions: string | undefined;
      try {
        const body = await readJsonBody(context.req.raw, MAX_AGENT_SETTING_BODY_BYTES);
        customInstructions = z.object({ customInstructions: z.string().trim().min(1).max(MAX_AGENT_SETTING_LENGTH).optional() }).strict().parse(body).customInstructions;
      } catch (error) {
        // Empty body means a plain compact; only reject real input errors.
        if (error instanceof HttpInputError && error.code === "invalid-json") customInstructions = undefined;
        else throw error;
      }
      await service.compact(agentId, customInstructions);
      return success(acceptedResponseSchema.parse({ accepted: true }), 202);
    }
    catch (error) { return errorResponse(error); }
  });
  app.post("/api/agents/:agentId/model", async (context) => {
    try { const input = modelInput.parse(await readJsonBody(context.req.raw, MAX_AGENT_SETTING_BODY_BYTES)); const agentId = id(context.req.param("agentId")); await service.model(agentId, input.provider, input.modelId); return success(publicSnapshot(service.snapshot(agentId))); }
    catch (error) { return errorResponse(error); }
  });
  app.post("/api/agents/:agentId/thinking", async (context) => {
    try { const input = thinkingInput.parse(await readJsonBody(context.req.raw, MAX_AGENT_SETTING_BODY_BYTES)); const agentId = id(context.req.param("agentId")); await service.thinking(agentId, input.level); return success(publicSnapshot(service.snapshot(agentId))); }
    catch (error) { return errorResponse(error); }
  });
  app.post("/api/agents/:agentId/ui-response", async (context) => {
    try {
      const input = uiResponseInput.parse(await readJsonBody(context.req.raw, MAX_AGENT_JSON_BYTES));
      const agentId = id(context.req.param("agentId") ?? "");
      await service.respondExtensionUi(agentId, input as any);
      return success(okResponseSchema.parse({ ok: true }));
    } catch (error) { return errorResponse(error); }
  });
  app.post("/api/agents/:agentId/archive", async (context) => {
    try { await service.archive(id(context.req.param("agentId"))); return success(okResponseSchema.parse({ ok: true })); }
    catch (error) { return errorResponse(error); }
  });

  return app;
}
