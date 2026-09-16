const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);

function hostOf(value: string | null): string | null {
  if (!value) return null;
  try {
    return new URL(value.includes("://") ? value : `http://${value}`).hostname.toLowerCase();
  } catch {
    return null;
  }
}

/** Baseline preview-socket origin check: non-browser clients (no Origin) pass;
 *  browser clients must be same-origin or loopback. */
export function isAllowedPreviewRequest(request: Request): boolean {
  const origin = request.headers.get("origin");
  if (!origin) return true;
  const originHost = hostOf(origin);
  const host = hostOf(request.headers.get("host"));
  if (!originHost || !host) return false;
  if (originHost === host) return true;
  return LOOPBACK_HOSTS.has(originHost) && LOOPBACK_HOSTS.has(host);
}
