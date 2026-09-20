import { describe, expect, test } from "bun:test";
import { pickPreviewTargetUrl } from "./previewTarget.ts";

describe("pickPreviewTargetUrl", () => {
  test("prefers the first high-confidence candidate", () => {
    expect(
      pickPreviewTargetUrl([
        { port: 4000, confidence: "uncertain", source: "script" },
        { port: 5000, confidence: "high" },
      ]),
    ).toBe("http://localhost:5000");
  });

  test("falls back to a declared-but-stopped script port", () => {
    expect(
      pickPreviewTargetUrl([
        { port: 4000, confidence: "uncertain", source: "script" },
        { port: 5000, confidence: "uncertain", source: "process" },
      ]),
    ).toBe("http://localhost:4000");
  });

  test("ignores process listeners without a script port", () => {
    expect(pickPreviewTargetUrl([{ port: 5000, confidence: "uncertain", source: "process" }])).toBe(
      "http://localhost:3000",
    );
  });

  test("falls back to localhost:3000 without candidates", () => {
    expect(pickPreviewTargetUrl([])).toBe("http://localhost:3000");
  });
});
