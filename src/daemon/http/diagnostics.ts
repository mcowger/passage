import { Hono } from "hono";
import { diagnosticBatchSchema } from "../../shared/domain/diagnostics.ts";
import { HttpInputError, readJsonBody } from "./body.ts";
import type { DiagnosticRepository } from "../metadata/repositories.ts";
import { logger, errorFields } from "../logging.ts";

/** Hard backstop for one diagnostics POST (a batch of at most 8 compact
 *  scalar-metric events). Rejects oversized bodies before parsing. */
export const MAX_DIAGNOSTICS_BODY_BYTES = 32 * 1024;
/** Belt-and-suspenders cap on the stored JSON payload per event. The wire
 *  schema already bounds keys/values; this guards against pathological
 * -but-valid shapes reaching SQLite. */
export const MAX_DIAGNOSTICS_PAYLOAD_BYTES = 8 * 1024;

const log = logger("diagnostics");

function success(value: unknown, status = 200): Response {
  return Response.json(value, { status, headers: { "Cache-Control": "no-store" } });
}

/**
 * Dedicated flight-recorder endpoint, independent of the agent/WebSocket
 * lifecycle. Same conventions as the other daemon routes: no app auth
 * (LAN-trusted per AGENTS.md), `Cache-Control: no-store`, strict
 * request-size limits, zod-validated strict shapes.
 *
 * There is deliberately no retrieval endpoint or UI -- analysis happens
 * offline via direct SQLite inspection of `diagnostic_events`.
 *
 * Persistence is best-effort by design: a database write failure is logged
 * and acknowledged (not 5xx), so the recorder can never break normal
 * daemon behavior.
 */
export function createDiagnosticRoutes(diagnostics: DiagnosticRepository): Hono {
  const app = new Hono();
  app.use("*", async (context, next) => { context.header("Cache-Control", "no-store"); return next(); });

  app.post("/api/diagnostics/events", async (context) => {
    let body: unknown;
    try {
      body = await readJsonBody(context.req.raw, MAX_DIAGNOSTICS_BODY_BYTES);
    } catch (error) {
      if (error instanceof HttpInputError) {
        return success({ error: error.code }, error.code === "body-too-large" ? 413 : 400);
      }
      return success({ error: "invalid-request" }, 400);
    }
    const parsed = diagnosticBatchSchema.safeParse(body);
    if (!parsed.success) return success({ error: "invalid-request" }, 400);
    const receivedAtMs = Date.now();
    const rows = parsed.data.events.map((event) => {
      const payloadJson = JSON.stringify(event.payload ?? {});
      return {
        pageInstanceId: event.pageInstanceId,
        seq: event.seq,
        clientTsMs: event.clientTsMs,
        receivedAtMs,
        kind: event.kind,
        payloadJson: payloadJson.length > MAX_DIAGNOSTICS_PAYLOAD_BYTES
          ? payloadJson.slice(0, MAX_DIAGNOSTICS_PAYLOAD_BYTES)
          : payloadJson,
      };
    });
    try {
      const stored = diagnostics.insertBatch(rows);
      return success({ ok: true as const, stored });
    } catch (error) {
      // Diagnostics must never impact normal daemon behavior: log and
      // acknowledge instead of failing the request.
      log.warn("Diagnostic event persistence failed", { event: "diagnostics.persist_failed", ...errorFields(error) });
      return success({ ok: true as const, stored: 0, dropped: true });
    }
  });

  return app;
}
