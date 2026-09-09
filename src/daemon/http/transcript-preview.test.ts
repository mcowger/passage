import { describe, expect, test } from "bun:test";
import { agentHistorySchema } from "../../shared/domain/agents.ts";
import { createTranscriptPreviewRoutes } from "./git.ts";

const request = (path: string, init?: RequestInit) => new Request(`http://localhost${path}`, init);

describe("transcript preview endpoint", () => {
  test("returns 404 unless explicitly enabled", async () => {
    const app = createTranscriptPreviewRoutes();
    const res = await app.fetch(request("/api/dev/transcript-preview?mode=transcript"));
    expect(res.status).toBe(404);
  });

  test("returns the deterministic fixture transcript when enabled", async () => {
    process.env.PASSAGE_TRANSCRIPT_PREVIEW = "1";
    try {
      const app = createTranscriptPreviewRoutes();
      const res = await app.fetch(request("/api/dev/transcript-preview?mode=transcript"));
      expect(res.status).toBe(200);
      const json = (await res.json()) as { history: unknown };
      const history = agentHistorySchema.parse(json.history);
      expect(history.timeline.map((item) => item.kind)).toEqual(["user", "tool", "process", "assistant"]);
      const tool = history.timeline.find((item) => item.kind === "tool");
      expect(tool?.kind === "tool" ? tool.name : "").toBe("write");
      const process = history.timeline.find((item) => item.kind === "process");
      expect(process?.kind === "process" ? process.activities.map((item) => item.name) : []).toEqual(["bash", "read"]);
    } finally {
      delete process.env.PASSAGE_TRANSCRIPT_PREVIEW;
    }
  });

  test("rejects unknown preview modes", async () => {
    process.env.PASSAGE_TRANSCRIPT_PREVIEW = "1";
    try {
      const app = createTranscriptPreviewRoutes();
      const res = await app.fetch(request("/api/dev/transcript-preview?mode=other"));
      expect(res.status).toBe(400);
    } finally {
      delete process.env.PASSAGE_TRANSCRIPT_PREVIEW;
    }
  });
});
