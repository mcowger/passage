import { PROTOCOL_VERSION, acknowledgementSchema, commandEnvelopeSchema } from "../shared/protocol/index.ts";

/** Shared by every `/ws` client helper (agent/workspace/daemon): request-ID
 *  generation, the app-level ping/ack heartbeat, and foreground-resume
 *  detection. iOS Safari suspends backgrounded WebSockets without firing
 *  `close` -- the socket keeps reporting `OPEN` while dead
 *  (docs/IOSWEBSOCKETS.md; WebKit #247943, #228296). Browser JS cannot see
 *  protocol-level ping/pong, so liveness is proven only by a round trip on
 *  a fresh, versioned `daemon/ping` command matched by request id -- a
 *  stale ack from a superseded probe must never satisfy a newer one. */

export function generateRequestId(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  if (typeof crypto !== "undefined" && typeof crypto.getRandomValues === "function") {
    const bytes = new Uint8Array(16);
    crypto.getRandomValues(bytes);
    bytes[6] = (bytes[6] & 0x0f) | 0x40;
    bytes[8] = (bytes[8] & 0x3f) | 0x80;
    const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
  }
  return "req_" + Date.now().toString(36) + "_" + Math.random().toString(36).slice(2, 10);
}

export function webSocketUrl(path = "/ws"): string {
  return `${location.protocol === "https:" ? "wss" : "ws"}://${location.host}${path}`;
}

/** `daemon/ping` is accepted on any `/ws` socket regardless of its
 *  subscribed channel (`handleCommand` checks it before channel routing in
 *  `src/daemon/index.ts`), so every client helper can share this builder. */
export function pingEnvelope(requestId: string) {
  return commandEnvelopeSchema.parse({
    version: PROTOCOL_VERSION,
    requestId,
    channel: "daemon",
    type: "ping",
    payload: {},
  });
}

export type ConnectionHealth = "online" | "checking" | "offline";

/** Foreground ping cadence. Single-user, LAN-trusted (AGENTS.md); pings are
 *  cheap. `docs/WS.md`'s "no speculative heartbeat" caution is conditioned
 *  on absence of evidence of a real problem -- iOS silently suspending
 *  backgrounded sockets without a `close` event (docs/IOSWEBSOCKETS.md) is
 *  observed evidence, not speculation, so that condition is satisfied. */
export const PING_INTERVAL_MS = 1000;
/** Ambient miss deadline: ~4 missed pings before declaring the connection
 *  dead. Tolerant of ordinary jitter; still detects a zombie socket well
 *  under a minute. */
export const PING_DEAD_AFTER_MS = 4000;
/** Faster deadline used only for the resume-triggered probe -- the user is
 *  actively looking at the screen, so this trades a little jitter
 *  tolerance for snappier recovery. */
export const RESUME_PROBE_DEAD_AFTER_MS = 2000;

export type Heartbeat = {
  /** Feed every parsed inbound message; recognizes the ack for the
   *  currently pending probe (a stale ack for a superseded probe is
   *  ignored) and reports it as proof of life. Not gated by any
   *  subject-reconciliation flag -- control frames must be handled even
   *  mid-reconcile. */
  handleMessage: (value: unknown) => void;
  /** Begin the ping loop; sends the first probe immediately. */
  start: () => void;
  /** Stop the loop and forget any pending probe. Does not itself report a
   *  health change -- the caller decides what "stopped" means for its
   *  transport (usually "offline"). */
  stop: () => void;
  /** Send one probe outside the regular cadence and reset it, with an
   *  optional shorter deadline (foreground return). */
  probeNow: (timeoutMs?: number) => void;
};

export function createHeartbeat(options: {
  sendPing: (requestId: string) => void;
  onAlive: () => void;
  onDead: () => void;
  intervalMs?: number;
  timeoutMs?: number;
}): Heartbeat {
  // Exactly one outstanding probe at a time: the next cadence probe is
  // scheduled only after the current one is acked, never on an independent
  // fixed-interval loop. An independent loop would let the normal cadence
  // silently supersede a `probeNow()` deadline before it could fire.
  let pendingId: string | undefined;
  let nextProbeTimer: ReturnType<typeof setTimeout> | undefined;
  let deadlineTimer: ReturnType<typeof setTimeout> | undefined;
  let running = false;

  const clearNextProbeTimer = () => { if (nextProbeTimer) clearTimeout(nextProbeTimer); nextProbeTimer = undefined; };
  const clearDeadline = () => { if (deadlineTimer) clearTimeout(deadlineTimer); deadlineTimer = undefined; };

  function sendProbe(timeoutMs: number) {
    if (!running) return;
    clearNextProbeTimer();
    const id = generateRequestId();
    pendingId = id;
    clearDeadline();
    deadlineTimer = setTimeout(() => {
      if (pendingId !== id) return;
      pendingId = undefined;
      options.onDead();
    }, timeoutMs);
    options.sendPing(id);
  }

  return {
    handleMessage(value) {
      if (!pendingId) return;
      const parsed = acknowledgementSchema.safeParse(value);
      if (!parsed.success || parsed.data.requestId !== pendingId) return;
      pendingId = undefined;
      clearDeadline();
      options.onAlive();
      clearNextProbeTimer();
      nextProbeTimer = setTimeout(() => sendProbe(options.timeoutMs ?? PING_DEAD_AFTER_MS), options.intervalMs ?? PING_INTERVAL_MS);
    },
    start() {
      if (running) return;
      running = true;
      sendProbe(options.timeoutMs ?? PING_DEAD_AFTER_MS);
    },
    stop() {
      running = false;
      pendingId = undefined;
      clearNextProbeTimer();
      clearDeadline();
    },
    probeNow(timeoutMs) {
      if (!running) return;
      // Supersede whatever's outstanding (a still-pending cadence probe, or
      // a scheduled future one) -- a stale ack for it must not satisfy this
      // fresh probe.
      clearNextProbeTimer();
      pendingId = undefined;
      sendProbe(timeoutMs ?? options.timeoutMs ?? PING_DEAD_AFTER_MS);
    },
  };
}

/** Coalesce `visibilitychange` (visible), `pageshow` (covers bfcache
 *  restore, which does not always fire `visibilitychange`), and `online`
 *  into a single `onResume()` call per burst -- iOS commonly fires several
 *  of these together on one foreground return. `onResume` itself must
 *  still check current visibility/online state before acting: `pageshow`
 *  can fire while hidden, and `online` can fire without the tab being
 *  foregrounded. */
export function watchForegroundResume(onResume: () => void): () => void {
  let scheduled = false;
  const trigger = () => {
    if (scheduled) return;
    scheduled = true;
    queueMicrotask(() => {
      scheduled = false;
      onResume();
    });
  };
  const onVisibilityChange = () => { if (document.visibilityState === "visible") trigger(); };
  const onPageShow = () => trigger();
  const onOnline = () => trigger();
  document.addEventListener("visibilitychange", onVisibilityChange);
  window.addEventListener("pageshow", onPageShow);
  window.addEventListener("online", onOnline);
  return () => {
    document.removeEventListener("visibilitychange", onVisibilityChange);
    window.removeEventListener("pageshow", onPageShow);
    window.removeEventListener("online", onOnline);
  };
}
