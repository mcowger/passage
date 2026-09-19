import webpush from "web-push";
import type { MetadataRepositories } from "../metadata/repositories.ts";
import type { PushPayload } from "../../shared/domain/push.ts";
import { logger } from "../logging.ts";

export type VapidConfig = {
  publicKey: string;
  privateKey: string;
  subject: string;
};

const log = logger("push");

/** Env-provided VAPID keys (per product decision). Empty when unconfigured. */
export function vapidConfigFromEnv(env: NodeJS.ProcessEnv = process.env): VapidConfig | undefined {
  const publicKey = env.VAPID_PUBLIC_KEY?.trim() ?? "";
  const privateKey = env.VAPID_PRIVATE_KEY?.trim() ?? "";
  const subject = env.VAPID_SUBJECT?.trim() ?? "";
  if (!publicKey || !privateKey || !subject) return undefined;
  return { publicKey, privateKey, subject };
}

export class PushService {
  private configured = false;

  constructor(
    private readonly repositories: MetadataRepositories,
    vapid?: VapidConfig,
  ) {
    const config = vapid ?? vapidConfigFromEnv();
    if (config) {
      try {
        webpush.setVapidDetails(config.subject, config.publicKey, config.privateKey);
        this.configured = true;
      } catch (error) {
        log.warn("Invalid VAPID configuration, push disabled", { event: "push.invalid_vapid" });
      }
    }
  }

  get isConfigured(): boolean {
    return this.configured;
  }

  vapidPublicKey(): string | undefined {
    return this.configured ? vapidConfigFromEnv()?.publicKey : undefined;
  }

  subscribe(input: { endpoint: string; keys: { p256dh: string; auth: string }; label?: string; userAgent?: string }): void {
    this.repositories.pushSubscriptions.save({
      endpoint: input.endpoint,
      keys: input.keys,
      label: input.label ?? null,
      userAgent: input.userAgent ?? null,
      createdAt: new Date().toISOString(),
    });
  }

  unsubscribe(endpoint: string): void {
    this.repositories.pushSubscriptions.delete(endpoint);
  }

  subscriptionCount(): number {
    try {
      return this.repositories.pushSubscriptions.count();
    } catch {
      return 0;
    }
  }

  /** Fan out to every stored subscription; prune 404/410 endpoints. */
  async sendToAll(payload: PushPayload): Promise<{ sent: number; pruned: number; failed: number }> {
    let sent = 0;
    let pruned = 0;
    let failed = 0;
    if (!this.configured) return { sent, pruned, failed };
    let rows: Array<{ endpoint: string; keysJson: string }>;
    try {
      rows = this.repositories.pushSubscriptions.list();
    } catch {
      return { sent, pruned, failed };
    }
    const body = JSON.stringify(payload);
    await Promise.all(rows.map(async (row) => {
      let keys: { p256dh: string; auth: string };
      try {
        keys = JSON.parse(row.keysJson) as { p256dh: string; auth: string };
      } catch {
        failed += 1;
        return;
      }
      try {
        await webpush.sendNotification({ endpoint: row.endpoint, keys } as never, body);
        sent += 1;
      } catch (error) {
        const statusCode = (error as { statusCode?: number })?.statusCode;
        if (statusCode === 404 || statusCode === 410) {
          try {
            this.repositories.pushSubscriptions.delete(row.endpoint);
          } catch {}
          pruned += 1;
        } else {
          failed += 1;
          log.warn("Push send failed", { event: "push.send_failed", statusCode });
        }
      }
    }));
    return { sent, pruned, failed };
  }
}
