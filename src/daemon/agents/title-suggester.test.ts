import { expect, test, describe, it, afterEach } from "bun:test";
import { AgentTitleSuggester, buildTitlePrompt, fallbackAgentTitle, sanitizeAgentTitle } from "./title-suggester.ts";
import {
  LOCAL_QWEN_MODEL_VALUE,
  LocalQwenService,
  disposeSharedLocalQwen,
  setSharedLocalQwenForTesting,
} from "../llm/local-qwen.ts";

describe("sanitizeAgentTitle", () => {
  test("passes through a clean 3-4 word title", () => {
    expect(sanitizeAgentTitle("Fix login retry bug")).toBe("Fix login retry bug");
  });
  test("strips quotes, markdown, and trailing periods", () => {
    expect(sanitizeAgentTitle('"Fix login retry bug."')).toBe("Fix login retry bug");
    expect(sanitizeAgentTitle("**Fix login retry bug**")).toBe("Fix login retry bug");
    expect(sanitizeAgentTitle("- Fix login retry bug")).toBe("Fix login retry bug");
    expect(sanitizeAgentTitle("Title: Fix login retry bug")).toBe("Fix login retry bug");
  });
  test("collapses newlines and truncates long output on a word boundary", () => {
    const long = "Fix the login retry bug in the payment flow\nwith extra detail that goes on forever";
    const title = sanitizeAgentTitle(long)!;
    expect(title.length).toBeLessThanOrEqual(60);
    expect(title).toStartWith("Fix the login retry bug");
  });
  test("rejects empty output and the placeholder itself", () => {
    expect(sanitizeAgentTitle("")).toBeNull();
    expect(sanitizeAgentTitle("   ")).toBeNull();
    expect(sanitizeAgentTitle("Agent")).toBeNull();
    expect(sanitizeAgentTitle('"Agent"')).toBeNull();
  });
});

describe("fallbackAgentTitle", () => {
  test("uses the first words of the first message", () => {
    expect(fallbackAgentTitle(["help me refactor the websocket client", "second"])).toBe("help me refactor the");
  });
  test("returns null with no usable input", () => {
    expect(fallbackAgentTitle([])).toBeNull();
    expect(fallbackAgentTitle(["   "])).toBeNull();
  });
});

describe("buildTitlePrompt", () => {
  test("asks for a 3-4 word title over the first messages", () => {
    const prompt = buildTitlePrompt(["first message", "second message", "third is ignored"]);
    expect(prompt).toContain("3-4 words");
    expect(prompt).toContain("first message");
    expect(prompt).toContain("second message");
    expect(prompt).not.toContain("third is ignored");
  });

  test("renders a custom template with {{messages}}", () => {
    const prompt = buildTitlePrompt(["first message"], "Custom: {{messages}}!");
    expect(prompt).toBe("Custom: Message 1: \"first message\"!");
  });
});

function installFakeLocal(output: string): LocalQwenService {
  const service = new LocalQwenService("/models/qwen.gguf", async () => ({
    chat: async () => output,
    dispose: async () => undefined,
  }));
  return service;
}

describe("AgentTitleSuggester local routing", () => {
  afterEach(async () => {
    await disposeSharedLocalQwen();
    setSharedLocalQwenForTesting(undefined);
  });

  it("routes Qwen (Local) through the shared local service with the same signature", async () => {
    const service = installFakeLocal("Fix login retry loop");
    await service.init();
    setSharedLocalQwenForTesting(service);
    const suggester = new AgentTitleSuggester();
    // Same (messages, cwd, model, thinkingLevel, promptTemplate) signature.
    const title = await suggester.suggestTitle(
      ["The login retry loop hammers the API when offline"],
      "/tmp",
      LOCAL_QWEN_MODEL_VALUE,
      "high",
      "",
    );
    expect(title).toBe("Fix login retry loop");
  });

  it("sanitizes local output and falls back when unusable", async () => {
    const service = installFakeLocal("Agent");
    await service.init();
    setSharedLocalQwenForTesting(service);
    const suggester = new AgentTitleSuggester();
    const messages = ["The login retry loop hammers the API when offline"];
    const title = await suggester.suggestTitle(messages, "/tmp", LOCAL_QWEN_MODEL_VALUE);
    expect(title).toBe(fallbackAgentTitle(messages));
    expect(sanitizeAgentTitle("Agent")).toBeNull();
  });

  it("falls back deterministically when local is selected but not initialized", async () => {
    const suggester = new AgentTitleSuggester();
    const messages = ["The login retry loop hammers the API when offline"];
    const title = await suggester.suggestTitle(messages, "/tmp", LOCAL_QWEN_MODEL_VALUE);
    expect(title).toBe(fallbackAgentTitle(messages));
  });
});
