import type { BuildInfo } from "../shared/build-info.ts";

/** Values injected by scripts/build.ts via Bun.build `define`. In dev they
 *  are undefined and we fall back to runtime env / live git / "dev". */
declare const PASSAGE_BUILD_COMMIT: string | undefined;
declare const PASSAGE_BUILD_TIME: string | undefined;
declare const PASSAGE_BUILD_DIRTY: string | undefined;

function injected(name: "PASSAGE_BUILD_COMMIT" | "PASSAGE_BUILD_TIME" | "PASSAGE_BUILD_DIRTY"): string | undefined {
  try {
    if (name === "PASSAGE_BUILD_COMMIT" && typeof PASSAGE_BUILD_COMMIT === "string") return PASSAGE_BUILD_COMMIT;
    if (name === "PASSAGE_BUILD_TIME" && typeof PASSAGE_BUILD_TIME === "string") return PASSAGE_BUILD_TIME;
    if (name === "PASSAGE_BUILD_DIRTY" && typeof PASSAGE_BUILD_DIRTY === "string") return PASSAGE_BUILD_DIRTY;
  } catch {
    // ReferenceError in dev where the define was never applied.
  }
  return undefined;
}

function liveGitCommit(): string | undefined {
  try {
    const result = Bun.spawnSync(["git", "rev-parse", "HEAD"], { stdout: "pipe", stderr: "ignore" });
    if (result.exitCode !== 0) return undefined;
    const commit = new TextDecoder().decode(result.stdout).trim();
    return /^[0-9a-f]{4,40}$/i.test(commit) ? commit : undefined;
  } catch {
    return undefined;
  }
}

function liveGitDirty(): boolean {
  try {
    const result = Bun.spawnSync(["git", "status", "--porcelain"], { stdout: "pipe", stderr: "ignore" });
    if (result.exitCode !== 0) return false;
    return new TextDecoder().decode(result.stdout).trim().length > 0;
  } catch {
    return false;
  }
}

let cached: BuildInfo | undefined;

/** Resolve the binary's build identity. Never throws. */
export function getBuildInfo(): BuildInfo {
  if (cached) return cached;
  const rawCommit =
    injected("PASSAGE_BUILD_COMMIT") ??
    process.env.PASSAGE_BUILD_COMMIT ??
    liveGitCommit() ??
    "dev";
  const commit = rawCommit.trim() === "" ? "dev" : rawCommit.trim();
  const shortCommit =
    commit === "dev" || commit === "unknown" ? commit : commit.length <= 7 ? commit : commit.slice(0, 7);
  const dirtyRaw = injected("PASSAGE_BUILD_DIRTY") ?? process.env.PASSAGE_BUILD_DIRTY;
  const dirty = dirtyRaw !== undefined ? dirtyRaw === "true" || dirtyRaw === "1" : liveGitDirty();
  const builtAt = injected("PASSAGE_BUILD_TIME") ?? process.env.PASSAGE_BUILD_TIME ?? "dev";
  cached = { commit, shortCommit, dirty, builtAt, bunVersion: Bun.version };
  return cached;
}

/** Test hook: drop the memoized value so env changes take effect. */
export function resetBuildInfoCache(): void {
  cached = undefined;
}
