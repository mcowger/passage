import { describe, expect, test } from "bun:test";
import {
  DEFAULT_PORT,
  isPassageEnvVar,
  PASSAGE_ENV_VARS,
  parsePortArg,
  resolveDaemonPort,
  sanitizedSubprocessEnv,
} from "./env.ts";

describe("daemon env", () => {
  test("parsePortArg handles --port forms", () => {
    expect(parsePortArg([])).toBeUndefined();
    expect(parsePortArg(["--port", "3456"])).toBe(3456);
    expect(parsePortArg(["--port=3456"])).toBe(3456);
    expect(parsePortArg(["bun", "src/daemon/index.ts", "--port", "3456"])).toBe(3456);
    expect(() => parsePortArg(["--port"])).toThrow();
    expect(() => parsePortArg(["--port", "nope"])).toThrow();
    expect(() => parsePortArg(["--port=0"])).toThrow();
    expect(() => parsePortArg(["--port=99999"])).toThrow();
  });

  test("resolveDaemonPort prefers --port over PORT over default", () => {
    expect(resolveDaemonPort({}, [])).toBe(DEFAULT_PORT);
    expect(resolveDaemonPort({ PORT: "3456" }, [])).toBe(3456);
    // A stale PORT inherited from another checkout's shell must lose to --port.
    expect(resolveDaemonPort({ PORT: "3333" }, ["--port", "3456"])).toBe(3456);
    expect(resolveDaemonPort({ PORT: "" }, [])).toBe(DEFAULT_PORT);
    expect(() => resolveDaemonPort({ PORT: "nope" }, [])).toThrow();
  });

  test("sanitizedSubprocessEnv strips daemon routing ports", () => {
    const env = sanitizedSubprocessEnv(
      { TERM: "xterm-256color" },
      { PORT: "3456", PASEO_PORT: "3456", KEEP: "yes" } as NodeJS.ProcessEnv,
    );
    expect(env).not.toHaveProperty("PORT");
    expect(env).not.toHaveProperty("PASEO_PORT");
    expect(env.KEEP).toBe("yes");
    expect(env.TERM).toBe("xterm-256color");
  });

  test("PASSAGE_ENV_VARS lists every daemon-owned var with no duplicates", () => {
    const required = [
      "PASSAGE_DB_PATH",
      "PASSAGE_SESSIONS_ROOT",
      "PASSAGE_PID_FILE",
      "PASSAGE_SHUTDOWN_TIMEOUT_MINUTES",
      "PASSAGE_MAX_ACTIVE_AGENTS",
      "PASSAGE_PI_PATH",
      "PASSAGE_AGENT_BROWSER_BIN",
      "PASSAGE_BUILD_COMMIT",
      "PASSAGE_BUILD_TIME",
      "PASSAGE_BUILD_DIRTY",
      "PASSAGE_TRANSCRIPT_PREVIEW",
      "PASSAGE_PI_LIVE",
      "PASSAGE_PI_USE_REAL",
      "PASSAGE_PTY_LIVE",
      "PASSAGE_DEPLOY_UNIT",
      "PASSAGE_DEPLOY_DELAY_S",
      "PASSAGE_DEPLOY_NO_RESTART",
    ];
    const listed: readonly string[] = PASSAGE_ENV_VARS;
    for (const key of required) expect(listed).toContain(key);
    expect(new Set(PASSAGE_ENV_VARS).size).toBe(PASSAGE_ENV_VARS.length);
    expect(isPassageEnvVar("PASSAGE_DB_PATH")).toBe(true);
    expect(isPassageEnvVar("PORT")).toBe(false);
  });

  test("sanitizedSubprocessEnv strips every PASSAGE_* var, including unknown ones", () => {
    const base = {
      PASSAGE_DB_PATH: "/home/user/.config/passage.sqlite",
      PASSAGE_SESSIONS_ROOT: "/home/user/.config/sessions",
      PASSAGE_PID_FILE: "/tmp/staging.pid",
      PASSAGE_SHUTDOWN_TIMEOUT_MINUTES: "5",
      PASSAGE_MAX_ACTIVE_AGENTS: "1",
      PASSAGE_PI_PATH: "/custom/pi",
      PASSAGE_FUTURE_VAR: "oops",
      PORT: "3456",
      PASEO_PORT: "3456",
      KEEP: "yes",
    } as NodeJS.ProcessEnv;
    const env = sanitizedSubprocessEnv(undefined, base);
    for (const key of Object.keys(env)) {
      expect(key.startsWith("PASSAGE_")).toBe(false);
    }
    expect(env).not.toHaveProperty("PORT");
    expect(env).not.toHaveProperty("PASEO_PORT");
    expect(env.KEEP).toBe("yes");
  });

  test("sanitizedSubprocessEnv lets callers re-add exactly one key", () => {
    const env = sanitizedSubprocessEnv(
      { PI_CODING_AGENT_DIR: "/tmp/agents" },
      { PASSAGE_DB_PATH: "/staging.sqlite" } as NodeJS.ProcessEnv,
    );
    expect(env).not.toHaveProperty("PASSAGE_DB_PATH");
    expect(env.PI_CODING_AGENT_DIR).toBe("/tmp/agents");
  });

  test("sanitizedSubprocessEnv extra undefined deletes keys", () => {
    const env = sanitizedSubprocessEnv(
      { BASH_ENV: undefined },
      { BASH_ENV: "/x", KEEP: "yes" } as NodeJS.ProcessEnv,
    );
    expect(env).not.toHaveProperty("BASH_ENV");
    expect(env.KEEP).toBe("yes");
  });
});
