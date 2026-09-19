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

/** Env vars stripped from every daemon child process. `PORT` is the
 *  daemon's own listen port; `PASEO_PORT` is the worktree runner's routing
 *  port for this checkout. Both are per-worktree and must never leak into
 *  shells, agents, or their descendants. */
export const STRIPPED_SUBPROCESS_ENV_VARS = ["PORT", "PASEO_PORT"] as const;

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

/** Copy of `process.env` with per-worktree routing vars removed, plus
 *  optional overrides. Pass the result as `env` to every `Bun.spawn` so
 *  children never inherit the daemon's own `PORT`/`PASEO_PORT`.
 *
 *  `extra` entries with `undefined` values delete that key (mirrors how
 *  `Bun.spawn` treats undefined); all other values override. */
export function sanitizedSubprocessEnv(
  extra?: Record<string, string | undefined>,
  base: NodeJS.ProcessEnv = process.env,
): Record<string, string | undefined> {
  const env: Record<string, string | undefined> = { ...base };
  for (const key of STRIPPED_SUBPROCESS_ENV_VARS) delete env[key];
  if (extra) {
    for (const [key, value] of Object.entries(extra)) {
      if (value === undefined) delete env[key];
      else env[key] = value;
    }
  }
  return env;
}
