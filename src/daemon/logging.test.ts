import { describe, expect, test } from "bun:test";
import { createRedactedSinkForTesting } from "./logging.ts";

describe("daemon logging", () => {
  test("redacts sensitive fields and JWTs", () => {
    const output: unknown[][] = [];
    const sink = createRedactedSinkForTesting();
    const consoleSink = sink as unknown as { (record: unknown): void };
    const original = console.log;
    console.log = (...args: unknown[]) => output.push(args);
    try {
      consoleSink({
        category: ["passage", "test"],
        level: "info",
        timestamp: Date.now(),
        rawMessage: "test",
        message: ["test"],
        properties: {
          event: "test.redaction",
          authorization: "Bearer secret",
          prompt: "do not record this",
          token: "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjMifQ.signature",
        },
      });
    } finally {
      console.log = original;
    }
    const serialized = JSON.stringify(output);
    expect(serialized).not.toContain("Bearer secret");
    expect(serialized).not.toContain("do not record this");
    expect(serialized).not.toContain("eyJhbGciOiJIUzI1NiJ9");
  });
});
