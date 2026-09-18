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

/** Compact footer label, e.g. "v1.4.0 · a1b2c3d" or "v1.4.0 · dev". */
export function formatBuildLabel(build: BuildInfo): string {
  return `v${build.bunVersion} · ${build.shortCommit}${build.dirty ? "*" : ""}`;
}

/** Tooltip / health-friendly detail, e.g. "a1b2c3d… (dirty) · built 2026-…". */
export function formatBuildDetail(build: BuildInfo): string {
  const dirty = build.dirty ? " (dirty)" : "";
  return `${build.commit}${dirty} · built ${build.builtAt}`;
}
