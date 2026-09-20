import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import {
  buildDevEnv,
  DEV_DATA_ENV_VARS,
  DEV_SCRUBBED_ENV_VARS,
  resolveDevDataEnv,
} from "./dev-env.ts";

describe("dev-env", () => {
  test("resolveDevDataEnv points at the worktree .data dir", () => {
    const data = resolveDevDataEnv("/wt/mine");
    expect(data.PASSAGE_DB_PATH).toBe(join("/wt/mine", ".data", "passage.sqlite"));
    expect(data.PASSAGE_SESSIONS_ROOT).toBe(join("/wt/mine", ".data", "sessions"));
    expect(data.PASSAGE_PID_FILE).toBe(join("/wt/mine", ".data", "dev.pid"));
    expect(Object.keys(data).sort()).toEqual([...DEV_DATA_ENV_VARS].sort());
  });

  test("buildDevEnv scrubs staging leaks and sets explicit worktree paths", () => {
    const env = buildDevEnv(
      {
        PASSAGE_DB_PATH: "/home/user/.config/passage.sqlite",
        PASSAGE_SESSIONS_ROOT: "/home/user/.config/sessions",
        PASSAGE_PID_FILE: "/tmp/staging.pid",
        PASSAGE_SHUTDOWN_TIMEOUT_MINUTES: "5",
        PASSAGE_MAX_ACTIVE_AGENTS: "1",
        PASSAGE_PI_PATH: "/custom/pi",
        PORT: "9999",
        PASEO_PORT: "3456",
        PASEO_WORKTREE_PATH: "/wt/mine",
        KEEP: "yes",
      } as NodeJS.ProcessEnv,
      "/wt/mine",
    );
    const data = resolveDevDataEnv("/wt/mine");
    expect(env.PASSAGE_DB_PATH).toBe(data.PASSAGE_DB_PATH);
    expect(env.PASSAGE_SESSIONS_ROOT).toBe(data.PASSAGE_SESSIONS_ROOT);
    expect(env.PASSAGE_PID_FILE).toBe(data.PASSAGE_PID_FILE);
    for (const key of DEV_SCRUBBED_ENV_VARS) expect(env).not.toHaveProperty(key);
    expect(env).not.toHaveProperty("PASSAGE_PI_PATH");
    expect(env).not.toHaveProperty("PORT");
    // Runner routing and unrelated vars pass through.
    expect(env.PASEO_PORT).toBe("3456");
    expect(env.PASEO_WORKTREE_PATH).toBe("/wt/mine");
    expect(env.KEEP).toBe("yes");
  });

  test("buildDevEnv leaves no PASSAGE_* behind except the explicit worktree paths", () => {
    const env = buildDevEnv({ PASSAGE_FUTURE_VAR: "oops" } as NodeJS.ProcessEnv, "/wt/mine");
    for (const key of Object.keys(env)) {
      if (key.startsWith("PASSAGE_")) {
        expect([...DEV_DATA_ENV_VARS]).toContain(key);
      }
    }
  });
});
