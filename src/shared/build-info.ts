import { z } from "zod";

/** Build identity baked into the binary at build time (see scripts/build.ts).
 *  In dev (`bun run dev`) the commit resolves live via git when available
 *  and falls back to "dev". Never throws; unknown fields stay "unknown". */
export const buildInfoSchema = z.object({
  commit: z.string(),
  shortCommit: z.string(),
  dirty: z.boolean(),
  builtAt: z.string(),
  bunVersion: z.string(),
});

export type BuildInfo = z.infer<typeof buildInfoSchema>;

const BUILD_MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** Human-friendly build time, e.g. "7:34 PM Sep 18". Falls back to the raw
 *  value when it isn't a parseable date ("dev", "unknown"). */
export function formatBuildDate(builtAt: string): string {
  const date = new Date(builtAt);
  if (Number.isNaN(date.getTime())) return builtAt;
  const minutes = String(date.getMinutes()).padStart(2, "0");
  const ampm = date.getHours() >= 12 ? "PM" : "AM";
  const hours12 = date.getHours() % 12 === 0 ? 12 : date.getHours() % 12;
  return `${hours12}:${minutes} ${ampm} ${BUILD_MONTHS[date.getMonth()]} ${date.getDate()}`;
}

/** Compact footer label, e.g. "7:34 PM Sep 18 · a1b2c3d" or "dev · dev". */
export function formatBuildLabel(build: BuildInfo): string {
  return `${formatBuildDate(build.builtAt)} · ${build.shortCommit}${build.dirty ? "*" : ""}`;
}

/** Tooltip / health-friendly detail, e.g. "a1b2c3d… (dirty) · built 2026-…". */
export function formatBuildDetail(build: BuildInfo): string {
  const dirty = build.dirty ? " (dirty)" : "";
  return `${build.commit}${dirty} · built ${build.builtAt}`;
}
