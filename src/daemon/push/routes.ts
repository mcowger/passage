import { Hono } from "hono";
import { z } from "zod";
import { pushSubscriptionSchema } from "../../shared/domain/push.ts";
import type { PushService } from "./service.ts";
import { HttpInputError, readJsonBody } from "../http/body.ts";

const MAX_PUSH_BODY_BYTES = 8192;

function success(value: unknown, status = 200): Response {
  return Response.json(value, { status, headers: { "Cache-Control": "no-store" } });
}

const testInput = z.object({
  title: z.string().trim().min(1).max(128).optional(),
  body: z.string().trim().min(1).max(512).optional(),
}).strict();

export function createPushRoutes(push: PushService): Hono {
  const app = new Hono();
  app.use("*", async (context, next) => { context.header("Cache-Control", "no-store"); return next(); });

  app.get("/api/push/vapid-public-key", (context) => {
    const publicKey = push.vapidPublicKey();
    if (!publicKey) return success({ configured: false }, 503);
    return success({ configured: true, publicKey });
  });

  app.get("/api/push/subscriptions", (context) => {
    return success({ configured: push.isConfigured, count: push.subscriptionCount() });
  });

  app.post("/api/push/subscriptions", async (context) => {
    try {
      if (!push.isConfigured) return success({ error: "push-not-configured", message: "Daemon has no VAPID keys (set VAPID_PUBLIC_KEY/PRIVATE_KEY/SUBJECT)." }, 503);
      const body = pushSubscriptionSchema.parse(await readJsonBody(context.req.raw, MAX_PUSH_BODY_BYTES));
      push.subscribe({ ...body, userAgent: context.req.header("user-agent")?.slice(0, 512) });
      return success({ ok: true as const }, 201);
    } catch (error) {
      if (error instanceof HttpInputError) return success({ error: error.code }, error.code === "body-too-large" ? 413 : 400);
      if (error instanceof z.ZodError) return success({ error: "invalid-request" }, 400);
      return success({ error: "push-subscribe-failed" }, 500);
    }
  });

  app.delete("/api/push/subscriptions", async (context) => {
    try {
      const body = z.object({ endpoint: z.string().url().max(2048) }).strict().parse(await readJsonBody(context.req.raw, MAX_PUSH_BODY_BYTES));
      push.unsubscribe(body.endpoint);
      return success({ ok: true as const });
    } catch (error) {
      if (error instanceof HttpInputError) return success({ error: error.code }, error.code === "body-too-large" ? 413 : 400);
      if (error instanceof z.ZodError) return success({ error: "invalid-request" }, 400);
      return success({ error: "push-unsubscribe-failed" }, 500);
    }
  });

  app.post("/api/push/test", async (context) => {
    try {
      if (!push.isConfigured) return success({ error: "push-not-configured" }, 503);
      let title = "Passage test notification";
      let body = "Push is working — you can close the PWA and still get these.";
      try {
        const parsed = testInput.parse(await readJsonBody(context.req.raw, MAX_PUSH_BODY_BYTES));
        if (parsed.title) title = parsed.title;
        if (parsed.body) body = parsed.body;
      } catch {
        // Empty body means default test copy.
      }
      const result = await push.sendToAll({ title, body, tag: "passage-test", url: "/?source=push-test" });
      return success({ ok: true as const, ...result });
    } catch {
      return success({ error: "push-test-failed" }, 500);
    }
  });

  return app;
}
