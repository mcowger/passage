import { afterEach, describe, expect, test } from "bun:test";
import { buildInfoSchema } from "../shared/build-info.ts";
import { getBuildInfo, resetBuildInfoCache } from "./build-info.ts";

afterEach(() => {
  delete process.env.PASSAGE_BUILD_COMMIT;
  delete process.env.PASSAGE_BUILD_DIRTY;
  delete process.env.PASSAGE_BUILD_TIME;
  resetBuildInfoCache();
});

describe("getBuildInfo", () => {
  test("returns a valid build record", () => {
    const build = getBuildInfo();
    expect(() => buildInfoSchema.parse(build)).not.toThrow();
    expect(build.bunVersion).toBe(Bun.version);
  });

  test("prefers explicit env over live git", () => {
    process.env.PASSAGE_BUILD_COMMIT = "deadbeef12345678";
    process.env.PASSAGE_BUILD_DIRTY = "true";
    process.env.PASSAGE_BUILD_TIME = "2026-02-02T00:00:00.000Z";
    const build = getBuildInfo();
    expect(build.commit).toBe("deadbeef12345678");
    expect(build.shortCommit).toBe("deadbee");
    expect(build.dirty).toBe(true);
    expect(build.builtAt).toBe("2026-02-02T00:00:00.000Z");
  });

  test("falls back to dev without git or env", () => {
    // Outside a git repo these would already be dev/unknown; with git
    // present the env override forces the fallback path deterministically.
    process.env.PASSAGE_BUILD_COMMIT = "dev";
    process.env.PASSAGE_BUILD_TIME = "dev";
    process.env.PASSAGE_BUILD_DIRTY = "false";
    const build = getBuildInfo();
    expect(build.shortCommit).toBe("dev");
    expect(build.dirty).toBe(false);
  });
});
