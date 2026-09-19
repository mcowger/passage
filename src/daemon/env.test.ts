import { describe, expect, test } from "bun:test";
import {
  DEFAULT_PORT,
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

  test("sanitizedSubprocessEnv extra undefined deletes keys", () => {
    const env = sanitizedSubprocessEnv(
      { BASH_ENV: undefined },
      { BASH_ENV: "/x", KEEP: "yes" } as NodeJS.ProcessEnv,
    );
    expect(env).not.toHaveProperty("BASH_ENV");
    expect(env.KEEP).toBe("yes");
  });
});
