import { describe, expect, test } from "bun:test";
import { diagnosticBatchSchema, diagnosticEventSchema } from "./diagnostics.ts";

const base = {
  pageInstanceId: "page-abc",
  seq: 0,
  clientTsMs: 1_700_000_000_000,
  kind: "snapshot" as const,
};

describe("diagnosticEventSchema", () => {
  test("accepts a minimal snapshot event", () => {
    expect(diagnosticEventSchema.safeParse(base).success).toBe(true);
  });

  test("accepts scalar metrics payloads", () => {
    const parsed = diagnosticEventSchema.safeParse({
      ...base,
      payload: { visible: 1, online: true, display: "standalone", dropped: null, driftMs: 12.5 },
    });
    expect(parsed.success).toBe(true);
  });

  test("rejects unknown kinds and extra top-level keys", () => {
    expect(diagnosticEventSchema.safeParse({ ...base, kind: "cpu_usage" }).success).toBe(false);
    expect(diagnosticEventSchema.safeParse({ ...base, transcriptText: "hello" }).success).toBe(false);
  });

  test("rejects negative seq, non-positive timestamps, and oversized values", () => {
    expect(diagnosticEventSchema.safeParse({ ...base, seq: -1 }).success).toBe(false);
    expect(diagnosticEventSchema.safeParse({ ...base, clientTsMs: 0 }).success).toBe(false);
    expect(diagnosticEventSchema.safeParse({ ...base, payload: { x: "y".repeat(257) } }).success).toBe(false);
  });
});

describe("diagnosticBatchSchema", () => {
  test("requires 1-8 events", () => {
    expect(diagnosticBatchSchema.safeParse({ events: [base] }).success).toBe(true);
    expect(diagnosticBatchSchema.safeParse({ events: [] }).success).toBe(false);
    expect(diagnosticBatchSchema.safeParse({ events: Array.from({ length: 9 }, () => base) }).success).toBe(false);
  });
});
