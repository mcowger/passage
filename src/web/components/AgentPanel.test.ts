import { describe, expect, test } from "bun:test";
import { formatDuration } from "./AgentPanel.tsx";

describe("formatDuration", () => {
  test("formats sub-minute durations in seconds with one decimal", () => {
    expect(formatDuration(0)).toBe("0.0s");
    expect(formatDuration(4.24)).toBe("4.2s");
    expect(formatDuration(15.89)).toBe("15.9s");
    expect(formatDuration(59.9)).toBe("59.9s");
  });

  test("formats multi-minute durations in minutes and seconds", () => {
    expect(formatDuration(60)).toBe("1m 00s");
    expect(formatDuration(65)).toBe("1m 05s");
    expect(formatDuration(125)).toBe("2m 05s");
    expect(formatDuration(365)).toBe("6m 05s");
  });
});
