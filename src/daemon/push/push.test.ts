import { describe, expect, test } from "bun:test";
import { shouldNotify } from "./notifier.ts";
import { vapidConfigFromEnv } from "./service.ts";
import { pushSubscriptionSchema } from "../../shared/domain/push.ts";

describe("push notifier triggers", () => {
  test("notifies on needs-attention and error", () => {
    expect(shouldNotify({ agentId: "a", type: "attention", status: "needs-attention" })).toBe("attention");
    expect(shouldNotify({ agentId: "a", type: "attention", status: "error" })).toBe("attention");
  });
  test("notifies on settled idle as done", () => {
    expect(shouldNotify({ agentId: "a", type: "settled", status: "idle" })).toBe("done");
  });
  test("stays quiet for running and plain status idle", () => {
    expect(shouldNotify({ agentId: "a", type: "status", status: "running" })).toBeUndefined();
    expect(shouldNotify({ agentId: "a", type: "status", status: "idle" })).toBeUndefined();
  });
});

describe("vapid config", () => {
  test("undefined when env is incomplete", () => {
    expect(vapidConfigFromEnv({} as NodeJS.ProcessEnv)).toBeUndefined();
    expect(vapidConfigFromEnv({ VAPID_PUBLIC_KEY: "x" } as NodeJS.ProcessEnv)).toBeUndefined();
  });
  test("returns keys when complete", () => {
    const config = vapidConfigFromEnv({
      VAPID_PUBLIC_KEY: "BPUB",
      VAPID_PRIVATE_KEY: "PRIV",
      VAPID_SUBJECT: "mailto:a@b.c",
    } as NodeJS.ProcessEnv);
    expect(config?.publicKey).toBe("BPUB");
  });
});

describe("push subscription schema", () => {
  test("rejects invalid endpoint and missing keys", () => {
    expect(pushSubscriptionSchema.safeParse({ endpoint: "not-a-url", keys: { p256dh: "x", auth: "y" } }).success).toBe(false);
    expect(pushSubscriptionSchema.safeParse({ endpoint: "https://web.push.apple.com/x", keys: { p256dh: "", auth: "y" } }).success).toBe(false);
  });
  test("accepts a valid subscription", () => {
    expect(pushSubscriptionSchema.safeParse({
      endpoint: "https://web.push.apple.com/abc",
      keys: { p256dh: "dh-key", auth: "auth-key" },
    }).success).toBe(true);
  });
});
