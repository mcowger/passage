import { describe, expect, test } from "bun:test";
import { encodeBinaryFrame, decodeBinaryFrame } from "../shared/protocol/terminals.ts";

describe("terminal binary framing", () => {
  test("encodes and decodes sequenced binary frames cleanly", () => {
    const originalPayload = new TextEncoder().encode("ls -la /tmp\r\n");
    const frame = {
      subjectId: "trm_test_123",
      sequence: 42,
      payload: originalPayload,
    };

    const encoded = encodeBinaryFrame(frame);
    expect(encoded.byteLength).toBeGreaterThan(originalPayload.byteLength);

    const decoded = decodeBinaryFrame(encoded);
    expect(decoded.subjectId).toBe("trm_test_123");
    expect(decoded.sequence).toBe(42);
    expect(new TextDecoder().decode(decoded.payload)).toBe("ls -la /tmp\r\n");
  });

  test("rejects truncated or invalid binary frames", () => {
    expect(() => decodeBinaryFrame(new Uint8Array([0, 1]))).toThrow();
  });
});
