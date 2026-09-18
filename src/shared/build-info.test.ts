import { describe, expect, test } from "bun:test";
import { buildInfoSchema, formatBuildDate, formatBuildDetail, formatBuildLabel } from "./build-info.ts";

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

  test("footer label shows build date plus short commit", () => {
    expect(
      formatBuildLabel({ commit: "abc1234", shortCommit: "abc1234", dirty: false, builtAt: "dev", bunVersion: "1.4.0" })
    ).toBe("dev · abc1234");
  });

  test("footer label formats an ISO build time like 7:34 PM Sep 18", () => {
    const builtAt = "2026-09-18T19:34:00.000Z";
    expect(
      formatBuildLabel({ commit: "abc1234", shortCommit: "abc1234", dirty: false, builtAt, bunVersion: "1.4.0" })
    ).toBe(`${formatBuildDate(builtAt)} · abc1234`);
    expect(formatBuildDate(builtAt)).toMatch(/^\d{1,2}:\d{2} (AM|PM) [A-Z][a-z]{2} \d{1,2}$/);
    expect(formatBuildDate("dev")).toBe("dev");
  });

  test("dirty builds get a marker and full detail", () => {
    const build = { commit: "abc1234", shortCommit: "abc1234", dirty: true, builtAt: "dev", bunVersion: "1.4.0" };
    expect(formatBuildLabel(build)).toBe("dev · abc1234*");
    expect(formatBuildDetail(build)).toContain("(dirty)");
  });
});
