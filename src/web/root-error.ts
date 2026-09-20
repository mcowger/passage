/**
 * Top-level React failure containment and diagnostics.
 *
 * Scope: this module (with `RootErrorBoundary`) catches render/lifecycle
 * failures *inside* the React tree, and records out-of-React failures
 * (window error / unhandledrejection) for diagnostics. It explicitly does
 * NOT cover:
 * - module-loading or bootstrap failures before React mounts (a blank page
 *   with no "Passage encountered an error" fallback means the boundary
 *   never mounted — check the console / service worker / bundle serving);
 * - termination of the browser/WebKit content process itself.
 *
 * No backend endpoint or telemetry dependency: diagnostics are logged to
 * the console and kept as a bounded recent history in sessionStorage so
 * they survive a reload in the same session. Never store transcript
 * content, credentials, or application-state dumps here — only error
 * metadata (message, stacks, timestamp, page-instance id, build label,
 * user agent, standalone/PWA status).
 *
 * Every export is defensive: logging and storage must never throw.
 */

import type { ErrorInfo } from "react";

export type RootErrorSource = "react-boundary" | "root-callback" | "global-error" | "global-rejection";

export interface RootErrorDiagnostics {
  message: string;
  jsStack?: string;
  componentStack?: string;
  timestamp: string;
  pageInstanceId: string;
  build: string;
  userAgent: string;
  /** "standalone" (installed PWA / iOS standalone) or "browser". */
  display: string;
  source: RootErrorSource;
}

const HISTORY_KEY = "passage.root-error-history.v1";
const HISTORY_LIMIT = 10;

let pageInstanceId: string | undefined;
let buildIdentifier: string | undefined;
let lastRecordSignature: string | undefined;

/** Stable-for-this-page-load id that ties diagnostics to one document instance. */
export function getPageInstanceId(): string {
  try {
    if (!pageInstanceId) {
      const cryptoId =
        typeof crypto !== "undefined" && typeof crypto.randomUUID === "function"
          ? crypto.randomUUID()
          : undefined;
      pageInstanceId = cryptoId ?? `page-${Date.now().toString(36)}-${Math.floor(Math.random() * 0xffffffff).toString(36)}`;
    }
    return pageInstanceId;
  } catch {
    return "unknown-page";
  }
}

/** Build label supplied once the daemon snapshot resolves (useDaemon). */
export function setRootBuildIdentifier(id: string | undefined): void {
  try {
    buildIdentifier = typeof id === "string" && id.trim() !== "" ? id : undefined;
  } catch {
    // Never throw from diagnostics plumbing.
  }
}

export function getRootBuildIdentifier(): string {
  try {
    return buildIdentifier ?? "unknown";
  } catch {
    return "unknown";
  }
}

function resolveDisplayMode(): string {
  try {
    const standaloneQuery =
      typeof window !== "undefined" && typeof window.matchMedia === "function"
        ? window.matchMedia("(display-mode: standalone)").matches
        : false;
    const iosStandalone =
      typeof navigator !== "undefined" &&
      (navigator as { standalone?: unknown }).standalone === true;
    return standaloneQuery || iosStandalone ? "standalone" : "browser";
  } catch {
    return "unknown";
  }
}

function resolveUserAgent(): string {
  try {
    return typeof navigator !== "undefined" && typeof navigator.userAgent === "string"
      ? navigator.userAgent
      : "unknown";
  } catch {
    return "unknown";
  }
}

function normalizeThrown(value: unknown): { message: string; jsStack?: string } {
  try {
    if (value instanceof Error) {
      return {
        message: value.message !== "" ? value.message : String(value),
        jsStack: typeof value.stack === "string" ? value.stack : undefined,
      };
    }
    if (typeof value === "string") return { message: value };
    try {
      const text = JSON.stringify(value);
      return { message: typeof text === "string" ? text : String(value) };
    } catch {
      return { message: String(value) };
    }
  } catch {
    return { message: "unknown error" };
  }
}

export function buildRootErrorDiagnostics(input: {
  error: unknown;
  componentStack?: string | null;
  source: RootErrorSource;
}): RootErrorDiagnostics {
  try {
    const { message, jsStack } = normalizeThrown(input.error);
    const componentStack =
      typeof input.componentStack === "string" && input.componentStack.trim() !== ""
        ? input.componentStack
        : undefined;
    let timestamp = "unknown";
    try {
      timestamp = new Date().toISOString();
    } catch {
      // Keep "unknown".
    }
    return {
      message,
      jsStack,
      componentStack,
      timestamp,
      pageInstanceId: getPageInstanceId(),
      build: getRootBuildIdentifier(),
      userAgent: resolveUserAgent(),
      display: resolveDisplayMode(),
      source: input.source,
    };
  } catch {
    return {
      message: "unknown error",
      timestamp: "unknown",
      pageInstanceId: "unknown-page",
      build: "unknown",
      userAgent: "unknown",
      display: "unknown",
      source: input.source,
    };
  }
}

export function formatRootErrorDiagnosticsText(d: RootErrorDiagnostics): string {
  try {
    const lines = [
      "Passage diagnostics",
      `message: ${d.message}`,
      `source: ${d.source}`,
      `timestamp: ${d.timestamp}`,
      `pageInstanceId: ${d.pageInstanceId}`,
      `build: ${d.build}`,
      `userAgent: ${d.userAgent}`,
      `display: ${d.display}`,
      `jsStack: ${d.jsStack ?? "n/a"}`,
      `componentStack: ${d.componentStack ?? "n/a"}`,
    ];
    return lines.join("\n");
  } catch {
    return "Passage diagnostics (unavailable)";
  }
}

function signatureOf(d: RootErrorDiagnostics): string {
  return `${d.message}\n${d.jsStack ?? ""}\n${d.componentStack ?? ""}`;
}

function readRecentRootErrors(): RootErrorDiagnostics[] {
  try {
    if (typeof sessionStorage === "undefined") return [];
    const raw = sessionStorage.getItem(HISTORY_KEY);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (entry): entry is RootErrorDiagnostics =>
        typeof entry === "object" && entry !== null && typeof (entry as { message?: unknown }).message === "string",
    );
  } catch {
    return [];
  }
}

function appendRootErrorHistory(d: RootErrorDiagnostics): void {
  try {
    if (typeof sessionStorage === "undefined") return;
    const history = readRecentRootErrors();
    history.push(d);
    sessionStorage.setItem(HISTORY_KEY, JSON.stringify(history.slice(-HISTORY_LIMIT)));
  } catch {
    // Storage denied / full / unavailable — diagnostics are best-effort.
  }
}

/**
 * Shared reporting helper for the boundary, createRoot callbacks, and
 * global listeners. Logs + records, deduplicated so the same failure
 * (e.g. seen by both componentDidCatch and onCaughtError) is only stored
 * once. Never throws.
 */
export function recordRootError(d: RootErrorDiagnostics): void {
  try {
    const signature = signatureOf(d);
    if (signature === lastRecordSignature) return;
    lastRecordSignature = signature;
    try {
      console.error("[passage] root error:", d.message, d);
    } catch {
      // Console unavailable — storage below still applies.
    }
    appendRootErrorHistory(d);
  } catch {
    // Reporting must never throw.
  }
}

/** Test hook: forget the dedupe signature so repeated reports are stored. */
export function resetRootErrorDedupeForTests(): void {
  lastRecordSignature = undefined;
}

function reportFromCallback(
  source: RootErrorSource,
  error: unknown,
  errorInfo?: Pick<ErrorInfo, "componentStack">,
): void {
  try {
    recordRootError(
      buildRootErrorDiagnostics({
        error,
        componentStack: errorInfo?.componentStack,
        source,
      }),
    );
  } catch {
    // Never throw out of React's error callbacks.
  }
}

/**
 * Shared createRoot error callbacks. onCaughtError fires for failures the
 * boundary catches (dedupe keeps the single history entry); onUncaughtError
 * / onRecoverableError only record diagnostics — they never touch React
 * state, so an uncaught failure can't itself break the fallback.
 */
export function createRootErrorCallbacks(): {
  onCaughtError: (error: unknown, errorInfo: ErrorInfo) => void;
  onUncaughtError: (error: unknown, errorInfo: ErrorInfo) => void;
  onRecoverableError: (error: unknown, errorInfo: ErrorInfo) => void;
} {
  return {
    onCaughtError: (error, errorInfo) => reportFromCallback("root-callback", error, errorInfo),
    onUncaughtError: (error, errorInfo) => reportFromCallback("root-callback", error, errorInfo),
    onRecoverableError: (error, errorInfo) => reportFromCallback("root-callback", error, errorInfo),
  };
}

/**
 * Capture failures outside React (script errors, unhandled rejections) as
 * diagnostics. Deliberately does NOT replace the application UI: a healthy
 * tree stays up, and default browser logging is preserved (no
 * preventDefault). Safe to call repeatedly — installs once, so dev hot
 * reload re-runs don't stack listeners.
 */
export function installGlobalRootErrorListeners(): void {
  try {
    if (typeof window === "undefined") return;
    const flag = "__passageRootErrorListenersInstalled";
    const w = window as unknown as Record<string, unknown>;
    if (w[flag] === true) return;
    w[flag] = true;
    window.addEventListener("error", (event) => {
      try {
        const thrown =
          event instanceof ErrorEvent && event.error !== undefined && event.error !== null
            ? (event.error as unknown)
            : event.message;
        recordRootError(buildRootErrorDiagnostics({ error: thrown, source: "global-error" }));
      } catch {
        // Never throw from a global handler.
      }
    });
    window.addEventListener("unhandledrejection", (event) => {
      try {
        recordRootError(
          buildRootErrorDiagnostics({ error: (event as PromiseRejectionEvent).reason, source: "global-rejection" }),
        );
      } catch {
        // Never throw from a global handler.
      }
    });
  } catch {
    // Listener installation itself must never throw.
  }
}
