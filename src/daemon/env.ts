/** Daemon port resolution + subprocess env sanitization.
 *
 * The daemon is launched with a per-worktree port (`PORT=...` or `--port
 * ...`). That value must never leak into child processes: terminals run
 * user shells, Pi agents run user tool calls, and setup actions / previews
 * / model probes all execute subprocesses whose descendants (e.g. a Vite
 * dev server honoring `PORT`) would otherwise bind the wrong port or
 * cross-talk between checkouts. Every `Bun.spawn` in the daemon must use
 * `sanitizedSubprocessEnv()` instead of spreading `process.env` directly.
 */

export const DEFAULT_PORT = 3333;

/** Every `PASSAGE_*` variable the daemon (or its scripts/tests) reads from
 *  the environment. A dev shell descending from a staging-owned process
 *  once inherited `PASSAGE_DB_PATH` and friends, so a worktree daemon
 *  silently opened staging's production sqlite and migrated it. Two rules
 *  prevent a repeat:
 *  1. Daemon children never inherit `PASSAGE_*` (see `sanitizedSubprocessEnv`).
 *  2. Dev entrypoints set worktree-local values explicitly (`scripts/dev-env.ts`).
 *
 *  Keep this list in sync with live reads of `process.env.PASSAGE_*`; the
 *  sanitizer additionally strips any unknown `PASSAGE_*` prefix match, so a
 *  newly added var is safe even if this list lags behind. */
export const PASSAGE_ENV_VARS = [
  // Daemon state: which sqlite / sessions / pidfile this process owns.
  "PASSAGE_DB_PATH",
  "PASSAGE_SESSIONS_ROOT",
  "PASSAGE_PID_FILE",
  // Daemon tuning.
  "PASSAGE_SHUTDOWN_TIMEOUT_MINUTES",
  "PASSAGE_MAX_ACTIVE_AGENTS",
  "PASSAGE_AUTO_CONTINUE_WINDOW_MINUTES",
  // Tool locations.
  "PASSAGE_PI_PATH",
  "PASSAGE_AGENT_BROWSER_BIN",
  // Build identity (baked into binaries via scripts/build.ts `define`;
  // the process.env fallback only matters for source runs).
  "PASSAGE_BUILD_COMMIT",
  "PASSAGE_BUILD_TIME",
  "PASSAGE_BUILD_DIRTY",
  // Feature/test gates.
  "PASSAGE_TRANSCRIPT_PREVIEW",
  "PASSAGE_PI_LIVE",
  "PASSAGE_PI_USE_REAL",
  "PASSAGE_PTY_LIVE",
  // Deploy knobs (scripts/deploy.ts).
  "PASSAGE_DEPLOY_UNIT",
  "PASSAGE_DEPLOY_DELAY_S",
  "PASSAGE_DEPLOY_NO_RESTART",
] as const;

/** Env vars stripped from every daemon child process. `PORT` is the
 *  daemon's own listen port; `PASEO_PORT` is the worktree runner's routing
 *  port for this checkout. Both are per-worktree and must never leak into
 *  shells, agents, or their descendants. */
export const STRIPPED_SUBPROCESS_ENV_VARS = ["PORT", "PASEO_PORT"] as const;

/** True for daemon-owned config: anything starting with `PASSAGE_`. */
export function isPassageEnvVar(key: string): boolean {
  return key.startsWith("PASSAGE_");
}

/** Parse `--port 3333` / `--port=3333` out of an argv array (e.g.
 *  `Bun.argv.slice(1)`). Returns undefined when absent. Throws on an
 *  invalid value so the daemon fails fast instead of binding 0/NaN. */
export function parsePortArg(argv: readonly string[]): number | undefined {
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--port") {
      const raw = argv[i + 1];
      if (raw === undefined) throw new Error("--port requires a value (1-65535)");
      return parsePortValue(raw, "--port");
    }
    if (arg.startsWith("--port=")) {
      return parsePortValue(arg.slice("--port=".length), "--port");
    }
  }
  return undefined;
}

function parsePortValue(raw: string, source: string): number {
  const port = Number(raw.trim());
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`Invalid ${source} value ${JSON.stringify(raw)}: expected a port 1-65535`);
  }
  return port;
}

function parseEnvPort(raw: string | undefined): number | undefined {
  if (raw === undefined || raw.trim() === "") return undefined;
  return parsePortValue(raw, "PORT");
}

/** Resolve the daemon's listen port. Precedence: `--port` flag, then
 *  `PORT` env, then {@link DEFAULT_PORT}. Throws on an invalid value. */
export function resolveDaemonPort(
  env: Record<string, string | undefined> = process.env,
  argv: readonly string[] = [],
): number {
  const flag = parsePortArg(argv);
  if (flag !== undefined) return flag;
  return parseEnvPort(env.PORT) ?? DEFAULT_PORT;
}

/** Copy of `process.env` with daemon routing vars and ALL `PASSAGE_*` vars
 *  removed, plus optional overrides. Pass the result as `env` to every
 *  `Bun.spawn` so children never inherit this checkout's database path,
 *  sessions root, pidfile, tuning, tool paths, or build/test gates --
 *  Pi tool calls, user shells, setup commands, previews, and model probes
 *  all start from a clean slate.
 *
 *  `extra` entries with `undefined` values delete that key (mirrors how
 *  `Bun.spawn` treats undefined); all other values override, so a caller
 *  that deliberately needs one var back (e.g. `PI_CODING_AGENT_DIR`) can
 *  re-add exactly that key. */
export function sanitizedSubprocessEnv(
  extra?: Record<string, string | undefined>,
  base: NodeJS.ProcessEnv = process.env,
): Record<string, string | undefined> {
  const env: Record<string, string | undefined> = { ...base };
  for (const key of Object.keys(env)) {
    if (isPassageEnvVar(key)) delete env[key];
  }
  for (const key of STRIPPED_SUBPROCESS_ENV_VARS) delete env[key];
  if (extra) {
    for (const [key, value] of Object.entries(extra)) {
      if (value === undefined) delete env[key];
      else env[key] = value;
    }
  }
  return env;
}
