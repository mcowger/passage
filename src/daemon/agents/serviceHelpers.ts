import type { TimelineItem } from "../../shared/domain/agents.ts";

/** Matches Pi's "session too small" compact refusal. */
export const COMPACTION_TOO_SHORT_PATTERN = /nothing to compact/i;
/** Matches Pi's "already compacted" compact refusal. */
export const COMPACTION_ALREADY_DONE_PATTERN = /already compacted/i;
/** Upper bound on the tool payload text scanned for a `git commit` invocation. */
export const MAX_GIT_SCAN_BYTES = 8192;
/** Matches a `git commit` invocation inside a shell command (allowing global
 *  flags such as `git -C <dir> commit`). Command separators are excluded so
 *  `echo git foo; commit` does not match. A miss only delays the refresh
 *  until run settlement; a false positive only costs one quiet refetch. */
export const GIT_COMMIT_PATTERN = /\bgit(?:\.exe)?\b[^|;&\n]*\bcommit\b/;

export function collectTitleSources(timeline: TimelineItem[]): string[] {
  const firstUserIndex = timeline.findIndex(
    (row) => row.kind === "user" && row.text.trim() !== "",
  );
  if (firstUserIndex === -1) return [];
  const firstUserText = (timeline[firstUserIndex] as { text: string }).text.trim();
  const sources = [firstUserText];
  for (let index = firstUserIndex + 1; index < timeline.length; index += 1) {
    const row = timeline[index];
    if (row.kind === "user") break;
    if (row.kind !== "thinking" && row.kind !== "assistant") continue;
    const text = (row as { text: string }).text.trim();
    if (text) sources.push(text);
  }
  return sources;
}
export function compactRefusalReason(cause: unknown): "session-too-short" | "already-compacted" | undefined {
  const message = cause instanceof Error ? cause.message : String(cause);
  if (COMPACTION_ALREADY_DONE_PATTERN.test(message)) return "already-compacted";
  if (COMPACTION_TOO_SHORT_PATTERN.test(message)) return "session-too-short";
  return undefined;
}
export function isGitCommitToolEvent(type: string, payload: Record<string, unknown>): boolean {
  if (type !== "tool_execution_end" || payload.isError) return false;
  const candidates = [payload.args, payload.input, payload.result, payload.partialResult];
  let haystack = "";
  for (const candidate of candidates) {
    if (candidate === undefined) continue;
    haystack += (typeof candidate === "string" ? candidate : JSON.stringify(candidate) ?? "") + "\n";
    if (haystack.length >= MAX_GIT_SCAN_BYTES) break;
  }
  if (haystack.length > MAX_GIT_SCAN_BYTES) haystack = haystack.slice(0, MAX_GIT_SCAN_BYTES);
  return GIT_COMMIT_PATTERN.test(haystack);
}
