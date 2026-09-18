import { describe, expect, test } from "bun:test";
import { buildInfoSchema, formatBuildDetail, formatBuildLabel } from "./build-info.ts";

describe("build-info shared", () => {
  test("accepts a full build record", () => {
    const parsed = buildInfoSchema.parse({
      commit: "abc1234567890",
      shortCommit: "abc1234",
      dirty: false,
      builtAt: "2026-01-01T00:00:00.000Z",
      bunVersion: "1.4.0",
    });
    expect(parsed.shortCommit).toBe("abc1234");
  });

  test("footer label shows bun version plus short commit", () => {
    expect(
      formatBuildLabel({ commit: "abc1234", shortCommit: "abc1234", dirty: false, builtAt: "dev", bunVersion: "1.4.0" })
    ).toBe("v1.4.0 · abc1234");
  });

  test("dirty builds get a marker and full detail", () => {
    const build = { commit: "abc1234", shortCommit: "abc1234", dirty: true, builtAt: "dev", bunVersion: "1.4.0" };
    expect(formatBuildLabel(build)).toBe("v1.4.0 · abc1234*");
    expect(formatBuildDetail(build)).toContain("(dirty)");
  });
});
