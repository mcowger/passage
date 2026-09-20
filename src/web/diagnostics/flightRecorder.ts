/**
 * Lightweight always-on diagnostic flight recorder (blank-screen forensics).
 *
 * Streams compact periodic snapshots to the daemon over a dedicated
 * same-origin HTTP endpoint (`POST /api/diagnostics/events`), independent
 * of the app's agent/WebSocket lifecycle. Evidence is sent while healthy
 * (every 5s visible / 30s hidden), not only on unload, so an abrupt WebKit
 * death still leaves the preceding minutes in the daemon's SQLite.
 *
 * Overhead discipline:
 * - No continuous requestAnimationFrame; one setTimeout chain.
 * - At most one fetch in flight; a bounded pending queue (3) with
 *   oldest-dropped overflow; no aggressive retries.
 * - DOM element count sampled at ~20s cadence, not every snapshot.
 * - Transcript metrics are incremental counters updated at existing
 *   mutation points (row_upsert handlers, history loads) -- snapshots read
 *   them O(1) and never walk, serialize, or stringify histories.
 * - Payloads are numeric/boolean/enum scalars only. Never transcript text,
 *   prompts, tool output, credentials, raw error payloads, DOM HTML,
 *   screenshots, or application-state dumps.
 * - No claim of browser RAM / WebKit / GPU / CPU metrics: Safari does not
 *   expose those to page JavaScript.
 *
 * Every collection path is feature-detected and failure-proof: diagnostics
 * must never crash or alter the user-facing app.
 */

import type { DiagnosticEvent, DiagnosticKind } from "../../shared/domain/diagnostics.ts";
import { getPageInstanceId, getRootBuildIdentifier } from "../root-error.ts";

export const FLIGHT_VISIBLE_INTERVAL_MS = 5_000;
export const FLIGHT_HIDDEN_INTERVAL_MS = 30_000;
/** DOM census cadence: every Nth visible snapshot (~20s), never every tick. */
export const FLIGHT_DOM_SAMPLE_EVERY = 4;
export const FLIGHT_SEND_TIMEOUT_MS = 4_000;
export const FLIGHT_MAX_PENDING = 3;
export const FLIGHT_ENDPOINT = "/api/diagnostics/events";

export type Metrics = Record<string, number | boolean | string | null>;

type SocketChannel = "agent" | "daemon" | "terminal" | "preview";

type TranscriptStats = { rows: number; bytes: number; largest: number; foreground: boolean };

type RecorderState = {
  seq: number;
  timer: ReturnType<typeof setTimeout> | undefined;
  inFlight: boolean;
  pending: DiagnosticEvent[];
  snapshotsSinceDomSample: number;
  domCount: number | null;
  /** Timer-drift/responsiveness: expected interval vs actual (NOT CPU usage). */
  lastTickAt: number | null;
  lastExpectedMs: number;
  recentDriftMs: number;
  maxDriftMs: number;
  errorCount: number;
  errorLastAt: number | null;
  rejectionCount: number;
  rejectionLastAt: number | null;
  sockets: Record<SocketChannel, { opens: number; closes: number; reconnects: number }>;
  highlightCount: number;
  highlightCacheHits: number;
  highlightLastMs: number | null;
  highlightMaxMs: number;
  transcripts: Map<string, TranscriptStats>;
  /** Agent ids owned by the background keep-alive (never foreground). */
  backgroundIds: string[];
  build: string | null;
};

function freshState(): RecorderState {
  const sockets = {} as RecorderState["sockets"];
  for (const channel of ["agent", "daemon", "terminal", "preview"] as const) {
    sockets[channel] = { opens: 0, closes: 0, reconnects: 0 };
  }
  return {
    seq: 0,
    timer: undefined,
    inFlight: false,
    pending: [],
    snapshotsSinceDomSample: 0,
    domCount: null,
    lastTickAt: null,
    lastExpectedMs: FLIGHT_VISIBLE_INTERVAL_MS,
    recentDriftMs: 0,
    maxDriftMs: 0,
    errorCount: 0,
    errorLastAt: null,
    rejectionCount: 0,
    rejectionLastAt: null,
    sockets,
    highlightCount: 0,
    highlightCacheHits: 0,
    highlightLastMs: null,
    highlightMaxMs: 0,
    transcripts: new Map(),
    backgroundIds: [],
    build: null,
  };
}

let state: RecorderState = freshState();
let started = false;

function safe(fn: () => void): void {
  try {
    fn();
  } catch {
    // Diagnostics must never throw into app code.
  }
}

function nowMs(): number {
  try {
    return Date.now();
  } catch {
    return 0;
  }
}

/** Cheap per-row size estimate: sums string field lengths without walking
 *  nested structures or stringifying. An approximation for trend analysis,
 *  not an exact byte count. */
export function estimateTimelineRowChars(row: {
  kind: string;
  text?: unknown;
  result?: unknown;
  name?: unknown;
  error?: unknown;
  entryType?: unknown;
  input?: unknown;
  images?: unknown[];
  files?: unknown[];
}): number {
  try {
    let total = 0;
    for (const field of [row.text, row.result, row.name, row.error, row.entryType] as unknown[]) {
      if (typeof field === "string") total += field.length;
    }
    if (typeof row.input === "string") total += row.input.length;
    else if (row.input !== undefined) total += 128;
    if (Array.isArray(row.images)) total += row.images.length * 64;
    if (Array.isArray(row.files)) total += row.files.length * 64;
    return total;
  } catch {
    return 0;
  }
}

// --- Incremental counters (called at existing mutation points) ---

/** One incoming transcript/tool row arrived via row_upsert (foreground or background). */
export function noteTranscriptRow(agentId: string, estimatedChars: number): void {
  safe(() => {
    if (typeof agentId !== "string" || agentId === "") return;
    const bytes = Number.isFinite(estimatedChars) && estimatedChars > 0 ? Math.floor(estimatedChars) : 0;
    const entry = state.transcripts.get(agentId) ?? { rows: 0, bytes: 0, largest: 0, foreground: false };
    entry.rows += 1;
    entry.bytes += bytes;
    if (bytes > entry.largest) entry.largest = bytes;
    state.transcripts.set(agentId, entry);
  });
}

/**
 * A history load replaced an agent's timeline wholesale (initial load,
 * epoch change, pagination prepend counts as an add). Re-baselines the
 * incremental counters instead of letting them double-count.
 */
export function noteHistoryBaseline(agentId: string, rows: number, estimatedChars: number): void {
  safe(() => {
    if (typeof agentId !== "string" || agentId === "") return;
    const entry = state.transcripts.get(agentId) ?? { rows: 0, bytes: 0, largest: 0, foreground: false };
    entry.rows = Number.isSafeInteger(rows) && rows >= 0 ? rows : entry.rows;
    entry.bytes = Number.isFinite(estimatedChars) && estimatedChars >= 0 ? Math.floor(estimatedChars) : entry.bytes;
    state.transcripts.set(agentId, entry);
  });
}

/** A mounted foreground panel owns this agent id (unmount clears it). */
export function setForegroundAgent(agentId: string, foreground: boolean): void {
  safe(() => {
    if (typeof agentId !== "string" || agentId === "") return;
    if (!foreground) {
      const entry = state.transcripts.get(agentId);
      if (entry) entry.foreground = false;
      return;
    }
    const entry = state.transcripts.get(agentId) ?? { rows: 0, bytes: 0, largest: 0, foreground: false };
    entry.foreground = true;
    state.transcripts.set(agentId, entry);
  });
}

/**
 * Agent ids owned by the background keep-alive (updated by the store on
 * hand-off/take/prune). Row/byte totals are read from the incremental
 * counters above, so this stays O(ids) with no history walking.
 */
export function reportBackgroundAgents(ids: string[]): void {
  safe(() => {
    state.backgroundIds = Array.isArray(ids)
      ? ids.filter((id) => typeof id === "string").map((id) => id.slice(0, 128)).slice(0, 64)
      : [];
  });
}

/** Sum rows/estimated chars of one history timeline (one walk, called only
 *  at mutation points: history loads and panel mounts, never per snapshot). */
export function estimateHistoryChars(timeline: Array<{ kind: string }> | undefined): number {
  try {
    if (!Array.isArray(timeline)) return 0;
    let total = 0;
    for (const row of timeline) total += estimateTimelineRowChars(row as Parameters<typeof estimateTimelineRowChars>[0]);
    return total;
  } catch {
    return 0;
  }
}

/** Socket open/close/reconnect transition (counts only, never message bodies). */
export function noteSocketEvent(channel: SocketChannel, event: "open" | "close" | "reconnect"): void {
  safe(() => {
    const counters = state.sockets[channel];
    if (!counters) return;
    if (event === "open") counters.opens += 1;
    else if (event === "close") counters.closes += 1;
    else counters.reconnects += 1;
  });
}

/** One syntax-highlight pass completed (or hit the token cache). */
export function recordHighlight(durationMs: number, cacheHit: boolean): void {
  safe(() => {
    if (!Number.isFinite(durationMs) || durationMs < 0) return;
    state.highlightCount += 1;
    if (cacheHit) state.highlightCacheHits += 1;
    state.highlightLastMs = durationMs;
    if (durationMs > state.highlightMaxMs) state.highlightMaxMs = durationMs;
  });
}

/** Daemon build label once the snapshot resolves (same identity the sidebar shows). */
export function setFlightBuildIdentifier(build: string | null): void {
  safe(() => {
    state.build = typeof build === "string" && build !== "" ? build.slice(0, 128) : null;
  });
}

// --- Environment sampling (all feature-detected) ---

export type FlightEnv = {
  visibility: string;
  focused: boolean;
  online: boolean;
  standalone: boolean;
  viewportW: number | null;
  viewportH: number | null;
  visualW: number | null;
  visualH: number | null;
  dpr: number | null;
};

export function readEnvironment(): FlightEnv {
  const env: FlightEnv = {
    visibility: "unknown",
    focused: false,
    online: true,
    standalone: false,
    viewportW: null,
    viewportH: null,
    visualW: null,
    visualH: null,
    dpr: null,
  };
  safe(() => {
    if (typeof document !== "undefined" && typeof document.visibilityState === "string") {
      env.visibility = document.visibilityState;
    }
  });
  safe(() => {
    if (typeof document !== "undefined" && typeof document.hasFocus === "function") {
      env.focused = document.hasFocus();
    }
  });
  safe(() => {
    if (typeof navigator !== "undefined" && typeof navigator.onLine === "boolean") {
      env.online = navigator.onLine;
    }
  });
  safe(() => {
    const mq = typeof window !== "undefined" && typeof window.matchMedia === "function"
      ? window.matchMedia("(display-mode: standalone)").matches
      : false;
    const ios = typeof navigator !== "undefined" && (navigator as { standalone?: unknown }).standalone === true;
    env.standalone = mq || ios;
  });
  safe(() => {
    if (typeof window !== "undefined") {
      if (Number.isFinite(window.innerWidth)) env.viewportW = Math.floor(window.innerWidth);
      if (Number.isFinite(window.innerHeight)) env.viewportH = Math.floor(window.innerHeight);
      const vv = window.visualViewport;
      if (vv) {
        if (Number.isFinite(vv.width)) env.visualW = Math.floor(vv.width);
        if (Number.isFinite(vv.height)) env.visualH = Math.floor(vv.height);
      }
      if (Number.isFinite(window.devicePixelRatio)) env.dpr = window.devicePixelRatio;
    }
  });
  return env;
}

function sampleDomCount(): void {
  safe(() => {
    if (typeof document === "undefined" || typeof document.getElementsByTagName !== "function") return;
    state.domCount = document.getElementsByTagName("*").length;
  });
}

function navigationType(): string | null {
  try {
    if (typeof performance === "undefined" || typeof performance.getEntriesByType !== "function") return null;
    const entries = performance.getEntriesByType("navigation") as Array<{ type?: unknown }>;
    const type = entries[0]?.type;
    return typeof type === "string" ? type.slice(0, 32) : null;
  } catch {
    return null;
  }
}

// --- Event construction ---

function nextEvent(kind: DiagnosticKind, payload?: Metrics): DiagnosticEvent {
  const event: DiagnosticEvent = {
    pageInstanceId: getPageInstanceId(),
    seq: state.seq,
    clientTsMs: nowMs(),
    kind,
  };
  state.seq += 1;
  if (payload && Object.keys(payload).length > 0) event.payload = payload;
  return event;
}

function userAgent(): string | null {
  try {
    if (typeof navigator !== "undefined" && typeof navigator.userAgent === "string") {
      return navigator.userAgent.slice(0, 512);
    }
  } catch {
    // Ignore.
  }
  return null;
}

function buildPageStarted(): DiagnosticEvent {
  const env = readEnvironment();
  const nav = navigationType();
  const payload: Metrics = {
    build: state.build ?? getRootBuildIdentifier(),
    visibility: env.visibility,
    standalone: env.standalone,
    viewportW: env.viewportW,
    viewportH: env.viewportH,
    visualW: env.visualW,
    visualH: env.visualH,
    dpr: env.dpr,
  };
  const ua = userAgent();
  if (ua !== null) payload.userAgent = ua;
  if (nav !== null) payload.navigationType = nav;
  return nextEvent("page_started", payload);
}

function foregroundTotals(): { agents: number; rows: number; bytes: number; largest: number } {
  let agents = 0;
  let rows = 0;
  let bytes = 0;
  let largest = 0;
  for (const entry of state.transcripts.values()) {
    if (!entry.foreground) continue;
    agents += 1;
    rows += entry.rows;
    bytes += entry.bytes;
    if (entry.largest > largest) largest = entry.largest;
  }
  return { agents, rows, bytes, largest };
}

/** Foreground agent ids are opaque UUIDs only -- safe and non-sensitive.
 *  Bounded so the joined value stays well under the wire string limit. */
function foregroundAgentIds(limit = 6): string[] {
  const ids: string[] = [];
  for (const [id, entry] of state.transcripts) {
    if (!entry.foreground) continue;
    ids.push(id.slice(0, 128));
    if (ids.length >= limit) break;
  }
  return ids;
}

function backgroundTotals(): { agents: number; rows: number; bytes: number } {
  let rows = 0;
  let bytes = 0;
  for (const id of state.backgroundIds) {
    const entry = state.transcripts.get(id);
    if (!entry || entry.foreground) continue;
    rows += entry.rows;
    bytes += entry.bytes;
  }
  return { agents: state.backgroundIds.length, rows, bytes };
}

export function buildSnapshot(): DiagnosticEvent {
  const env = readEnvironment();
  const fg = foregroundTotals();
  const bg = backgroundTotals();
  const payload: Metrics = {
    visibility: env.visibility,
    focused: env.focused,
    standalone: env.standalone,
    online: env.online,
    viewportW: env.viewportW,
    viewportH: env.viewportH,
    visualW: env.visualW,
    visualH: env.visualH,
    dpr: env.dpr,
    driftExpectedMs: state.lastExpectedMs,
    driftRecentMs: Math.round(state.recentDriftMs * 10) / 10,
    driftMaxMs: Math.round(state.maxDriftMs * 10) / 10,
    errorCount: state.errorCount,
    rejectionCount: state.rejectionCount,
    fgAgents: fg.agents,
    fgRows: fg.rows,
    fgBytes: fg.bytes,
    fgLargestRow: fg.largest,
    bgAgents: bg.agents,
    bgRows: bg.rows,
    bgBytes: bg.bytes,
    hlCount: state.highlightCount,
    hlCacheHits: state.highlightCacheHits,
    hlLastMs: state.highlightLastMs === null ? null : Math.round(state.highlightLastMs * 10) / 10,
    hlMaxMs: Math.round(state.highlightMaxMs * 10) / 10,
  };
  if (state.domCount !== null) payload.domElements = state.domCount;
  if (state.errorLastAt !== null) payload.errorLastAt = state.errorLastAt;
  if (state.rejectionLastAt !== null) payload.rejectionLastAt = state.rejectionLastAt;
  for (const channel of ["agent", "daemon", "terminal", "preview"] as const) {
    const counters = state.sockets[channel];
    payload[`ws_${channel}_opens`] = counters.opens;
    payload[`ws_${channel}_closes`] = counters.closes;
    payload[`ws_${channel}_reconnects`] = counters.reconnects;
  }
  const ids = foregroundAgentIds();
  if (ids.length > 0) payload.fgAgentIds = ids.join(",");
  return nextEvent("snapshot", payload);
}

function buildLifecycleEvent(transition: string): DiagnosticEvent {
  return nextEvent("lifecycle", { transition: transition.slice(0, 64) });
}

// --- Transport (dedicated fetch, one in flight, bounded queue) ---

async function postBatch(events: DiagnosticEvent[]): Promise<boolean> {
  try {
    if (typeof fetch !== "function" || events.length === 0) return false;
    const controller = typeof AbortController !== "undefined" ? new AbortController() : null;
    const timer = controller ? setTimeout(() => safe(() => controller.abort()), FLIGHT_SEND_TIMEOUT_MS) : undefined;
    try {
      const response = await fetch(FLIGHT_ENDPOINT, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ events }),
        credentials: "same-origin",
        signal: controller?.signal,
      });
      return response.ok;
    } finally {
      if (timer) clearTimeout(timer);
    }
  } catch {
    return false;
  }
}

function enqueue(event: DiagnosticEvent): void {
  // At most one request in flight; retain only a very small bounded queue
  // and drop the oldest rather than growing without bound. Never retry
  // aggressively: a failed batch keeps only its newest events pending.
  if (state.inFlight) {
    state.pending.push(event);
    while (state.pending.length > FLIGHT_MAX_PENDING) state.pending.shift();
    return;
  }
  state.inFlight = true;
  const batch = [...state.pending, event].slice(-(FLIGHT_MAX_PENDING + 1));
  state.pending = [];
  void postBatch(batch).then((ok) => {
    safe(() => {
      state.inFlight = false;
      if (!ok) {
        for (const item of batch) {
          state.pending.push(item);
          while (state.pending.length > FLIGHT_MAX_PENDING) state.pending.shift();
        }
      } else if (state.pending.length > 0) {
        const next = state.pending;
        state.pending = [];
        state.inFlight = true;
        void postBatch(next).then((retryOk) => {
          safe(() => {
            state.inFlight = false;
            if (!retryOk) {
              for (const item of next) {
                state.pending.push(item);
                while (state.pending.length > FLIGHT_MAX_PENDING) state.pending.shift();
              }
            }
          });
        });
      }
    });
  });
}

/** Best-effort final snapshot on pagehide (sendBeacon, no response handling). */
function beaconSnapshot(): void {
  safe(() => {
    if (typeof navigator === "undefined" || typeof navigator.sendBeacon !== "function") return;
    const body = JSON.stringify({ events: [buildSnapshot()] });
    if (body.length > 16 * 1024) return;
    navigator.sendBeacon(FLIGHT_ENDPOINT, body);
  });
}

// --- Scheduler ---

function currentIntervalMs(): number {
  try {
    if (typeof document !== "undefined" && document.visibilityState === "hidden") return FLIGHT_HIDDEN_INTERVAL_MS;
  } catch {
    // Fall through to the visible cadence.
  }
  return FLIGHT_VISIBLE_INTERVAL_MS;
}

function tick(): void {
  safe(() => {
    state.timer = undefined;
    const at = nowMs();
    if (state.lastTickAt !== null) {
      const actual = at - state.lastTickAt;
      const drift = actual - state.lastExpectedMs;
      state.recentDriftMs = drift;
      if (drift > state.maxDriftMs) state.maxDriftMs = drift;
    }
    state.lastTickAt = at;
    state.snapshotsSinceDomSample += 1;
    if (state.snapshotsSinceDomSample >= FLIGHT_DOM_SAMPLE_EVERY || state.domCount === null) {
      state.snapshotsSinceDomSample = 0;
      sampleDomCount();
    }
    enqueue(buildSnapshot());
    const interval = currentIntervalMs();
    state.lastExpectedMs = interval;
    state.timer = setTimeout(tick, interval);
  });
}

// --- Lifecycle listeners (counts and transitions only, no payloads) ---

function onGlobalError(): void {
  safe(() => {
    state.errorCount += 1;
    state.errorLastAt = nowMs();
  });
}

function onGlobalRejection(): void {
  safe(() => {
    state.rejectionCount += 1;
    state.rejectionLastAt = nowMs();
  });
}

function lifecycleListener(transition: string): () => void {
  return () => {
    safe(() => {
      enqueue(buildLifecycleEvent(transition));
      // A visibility return resets to the fast cadence immediately instead
      // of waiting out a 30s hidden tick.
      if (transition === "visible" || transition === "pageshow") {
        if (state.timer) clearTimeout(state.timer);
        state.timer = undefined;
        state.lastExpectedMs = FLIGHT_VISIBLE_INTERVAL_MS;
        state.timer = setTimeout(tick, FLIGHT_VISIBLE_INTERVAL_MS);
      }
    });
  };
}

/**
 * Initialize once during app bootstrap. Safe under React dev hot reload
 * (install-once guard) and safe to call when DOM APIs are unavailable.
 */
export function initFlightRecorder(): void {
  safe(() => {
    if (typeof window === "undefined") return;
    const flag = "__passageFlightRecorderInstalled";
    const w = window as unknown as Record<string, unknown>;
    if (w[flag] === true) return;
    w[flag] = true;
    if (started) return;
    started = true;

    window.addEventListener("error", onGlobalError);
    window.addEventListener("unhandledrejection", onGlobalRejection);
    document.addEventListener("visibilitychange", () => {
      safe(() => {
        let transition = "visibilitychange";
        try {
          transition = document.visibilityState === "visible" ? "visible" : "hidden";
        } catch {
          // Keep the generic name.
        }
        enqueue(buildLifecycleEvent(transition));
        if (transition === "visible") {
          if (state.timer) clearTimeout(state.timer);
          state.timer = undefined;
          state.lastExpectedMs = FLIGHT_VISIBLE_INTERVAL_MS;
          state.timer = setTimeout(tick, FLIGHT_VISIBLE_INTERVAL_MS);
        }
      });
    });
    // Note: visibilitychange reports the state at install time in the
    // transition name above; subsequent changes re-read it. This keeps the
    // handler allocation-free per fire while staying correct.
    window.addEventListener("pagehide", () => {
      safe(() => {
        enqueue(buildLifecycleEvent("pagehide"));
        beaconSnapshot();
      });
    });
    window.addEventListener("pageshow", lifecycleListener("pageshow"));
    window.addEventListener("online", lifecycleListener("online"));
    window.addEventListener("offline", lifecycleListener("offline"));
    try {
      if ("onfreeze" in document) document.addEventListener("freeze", lifecycleListener("freeze"));
      if ("onresume" in document) document.addEventListener("resume", lifecycleListener("resume"));
    } catch {
      // Feature detection failed -- freeze/resume stay unreported.
    }

    enqueue(buildPageStarted());
    state.lastExpectedMs = currentIntervalMs();
    state.timer = setTimeout(tick, state.lastExpectedMs);
  });
}

/** Test hook: forget installed state so each test starts clean. */
export function resetFlightRecorderForTests(): void {
  try {
    if (state.timer) clearTimeout(state.timer);
  } catch {
    // Ignore.
  }
  state = freshState();
  started = false;
  try {
    if (typeof window !== "undefined") {
      delete (window as unknown as Record<string, unknown>).__passageFlightRecorderInstalled;
    }
  } catch {
    // Ignore.
  }
}

/** Test hook: inspect the bounded pending queue depth. */
export function flightPendingCount(): number {
  return state.pending.length;
}
