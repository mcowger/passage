import { describe, expect, test } from "bun:test";
import { PROTOCOL_VERSION } from "../shared/index.ts";

describe("daemon scaffold", () => {
  test("exports the current protocol version", () => {
    expect(PROTOCOL_VERSION).toBe(1);
  });
});
