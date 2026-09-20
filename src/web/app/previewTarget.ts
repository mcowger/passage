/** Port candidates for preview defaults, mirroring the daemon's
 *  `PortCandidate` shape (`source` marks `paseo.json` service ports). */
export type PreviewPortCandidate = {
  port: number;
  confidence: string;
  source?: string;
};

const FALLBACK_PORT = 3000;

const previewUrl = (port: number): string => `http://localhost:${port}`;

/** Pick a new preview session's default target URL:
 *  1. the first high-confidence candidate (a running script service port
 *     or a related loopback listener),
 *  2. else the first declared-but-stopped script service port,
 *  3. else the `localhost:3000` convention fallback. */
export function pickPreviewTargetUrl(candidates: readonly PreviewPortCandidate[]): string {
  const high = candidates.find((c) => c.confidence === "high");
  if (high) return previewUrl(high.port);
  const script = candidates.find((c) => c.source === "script");
  if (script) return previewUrl(script.port);
  return previewUrl(FALLBACK_PORT);
}
