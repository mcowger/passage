#!/usr/bin/env bun
/** Worktree-local dev environment for the Passage daemon.
 *
 * A dev shell can descend from a staging-owned process and inherit
 * production `PASSAGE_*` paths (`PASSAGE_DB_PATH=/home/.../.config/
 * passage.sqlite`, ...). A worktree daemon that honors those silently
 * opens -- and migrates -- staging's production sqlite. So the dev server
 * never trusts inherited state: `buildDevEnv()` strips every `PASSAGE_*`
 * var (plus the generic `PORT`, which `scripts/dev-port.ts` deliberately
 * ignores anyway) and then explicitly sets this worktree's own `.data`
 * paths. `PASEO_*` routing vars pass through untouched -- the worktree
 * runner sets those per checkout and `dev-port.ts` needs `PASEO_PORT` /
 * `PASEO_WORKTREE_PATH` for port resolution.
 *
 * `bun run dev` (scripts/run-dev.ts) applies this before spawning the
 * daemon; `bun run dev:stop` scrubs the same staging-leak vars (see
 * package.json) so stop tooling resolves this worktree's own pidfile.
 */

import { join } from "node:path";
import { worktreeRoot } from "./dev-port.ts";

/** Daemon state vars the dev server owns explicitly: always set to this
 *  worktree's `.data` dir, never inherited. */
export const DEV_DATA_ENV_VARS = [
  "PASSAGE_DB_PATH",
  "PASSAGE_SESSIONS_ROOT",
  "PASSAGE_PID_FILE",
] as const;

/** Daemon tuning vars that must never leak in from another checkout:
 *  always unset for dev so daemon defaults apply. */
export const DEV_SCRUBBED_ENV_VARS = [
  "PASSAGE_SHUTDOWN_TIMEOUT_MINUTES",
  "PASSAGE_MAX_ACTIVE_AGENTS",
] as const;

/** Explicit worktree-local data paths for a dev daemon in `root`. */
export function resolveDevDataEnv(root: string): Record<string, string> {
  const dataRoot = join(root, ".data");
  return {
    PASSAGE_DB_PATH: join(dataRoot, "passage.sqlite"),
    PASSAGE_SESSIONS_ROOT: join(dataRoot, "sessions"),
    PASSAGE_PID_FILE: join(dataRoot, "dev.pid"),
  };
}

/** Scrubbed + explicitly-set environment for spawning the dev daemon in
 *  `root` (defaults to this checkout). Drops every inherited `PASSAGE_*`
 *  var and `PORT`, keeps `PASEO_*` and everything else, then sets the
 *  worktree-local data paths from {@link resolveDevDataEnv}. */
export function buildDevEnv(
  base: NodeJS.ProcessEnv = process.env,
  root: string = worktreeRoot(),
): Record<string, string | undefined> {
  const env: Record<string, string | undefined> = { ...base };
  for (const key of Object.keys(env)) {
    if (key.startsWith("PASSAGE_")) delete env[key];
  }
  delete env.PORT;
  for (const [key, value] of Object.entries(resolveDevDataEnv(root))) {
    env[key] = value;
  }
  return env;
}
