import { describe, expect, test } from "bun:test";
import {
  resolveCanonicalTool,
  computeLatestTimelineIds,
  isItemExpanded,
} from "./timeline-expansion.ts";
import { DEFAULT_TIMELINE_EXPANSION } from "../../shared/domain/settings.ts";
import type { TimelineItem, ToolActivity } from "../../shared/domain/agents.ts";

describe("resolveCanonicalTool", () => {
  test("maps read and aliases", () => {
    expect(resolveCanonicalTool("read")).toBe("read");
    expect(resolveCanonicalTool("readFile")).toBe("read");
    expect(resolveCanonicalTool("READ")).toBe("read");
  });

  test("maps write and aliases", () => {
    expect(resolveCanonicalTool("write")).toBe("write");
    expect(resolveCanonicalTool("writeFile")).toBe("write");
  });

  test("maps edit and aliases", () => {
    expect(resolveCanonicalTool("edit")).toBe("edit");
    expect(resolveCanonicalTool("editFile")).toBe("edit");
    expect(resolveCanonicalTool("multiedit")).toBe("edit");
    expect(resolveCanonicalTool("apply_patch")).toBe("edit");
  });

  test("maps bash and command", () => {
    expect(resolveCanonicalTool("bash")).toBe("bash");
    expect(resolveCanonicalTool("command")).toBe("bash");
  });

  test("maps find and glob", () => {
    expect(resolveCanonicalTool("find")).toBe("find");
    expect(resolveCanonicalTool("glob")).toBe("find");
  });

  test("maps grep", () => {
    expect(resolveCanonicalTool("grep")).toBe("grep");
  });

  test("maps ls and list aliases", () => {
    expect(resolveCanonicalTool("ls")).toBe("ls");
    expect(resolveCanonicalTool("list")).toBe("ls");
    expect(resolveCanonicalTool("list_dir")).toBe("ls");
  });

  test("maps ask_user_question and aliases to ask", () => {
    expect(resolveCanonicalTool("ask_user_question")).toBe("ask");
    expect(resolveCanonicalTool("ask_user")).toBe("ask");
    expect(resolveCanonicalTool("ask")).toBe("ask");
    expect(resolveCanonicalTool("ASK_USER_QUESTION")).toBe("ask");
  });

  test("maps unlisted and mcp tools to other", () => {
    expect(resolveCanonicalTool("mcp__github__search")).toBe("other");
    expect(resolveCanonicalTool("custom_tool")).toBe("other");
  });
});

describe("computeLatestTimelineIds", () => {
  test("identifies latest thinking and tool IDs across timeline", () => {
    const timeline: TimelineItem[] = [
      { kind: "thinking", id: "think-1", text: "First thought" },
      {
        kind: "tool",
        id: "tool-read-1",
        name: "read",
        input: { path: "a.ts" },
        status: "complete",
      },
      { kind: "thinking", id: "think-2", text: "Second thought" },
      {
        kind: "tool",
        id: "tool-read-2",
        name: "readFile",
        input: { path: "b.ts" },
        status: "complete",
      },
      {
        kind: "tool",
        id: "tool-bash-1",
        name: "bash",
        input: { command: "ls" },
        status: "complete",
      },
    ];

    const latest = computeLatestTimelineIds(timeline);
    expect(latest.latestThinkingId).toBe("think-2");
    expect(latest.latestToolIds.read).toBe("tool-read-2");
    expect(latest.latestToolIds.bash).toBe("tool-bash-1");
    expect(latest.latestToolIds.write).toBeUndefined();
  });

});

describe("isItemExpanded", () => {
  const settings = {
    ...DEFAULT_TIMELINE_EXPANSION,
    thinking: "latest" as const,
    tools: {
      ...DEFAULT_TIMELINE_EXPANSION.tools,
      read: "latest" as const,
      write: "always" as const,
      edit: "none" as const,
    },
    otherTools: "latest" as const,
  };

  const latestIds = {
    latestThinkingId: "think-2",
    latestToolIds: {
      read: "tool-read-2",
      write: "tool-write-2",
      edit: "tool-edit-2",
      other: "tool-mcp-2",
    },
  };

  test("thinking expands only for latest when set to latest", () => {
    const think1: TimelineItem = { kind: "thinking", id: "think-1", text: "Old" };
    const think2: TimelineItem = { kind: "thinking", id: "think-2", text: "New" };

    expect(isItemExpanded(think1, settings, latestIds)).toBe(false);
    expect(isItemExpanded(think2, settings, latestIds)).toBe(true);
  });

  test("thinking expands always when set to always", () => {
    const thinkAlwaysSettings = { ...settings, thinking: "always" as const };
    const think1: TimelineItem = { kind: "thinking", id: "think-1", text: "Old" };
    expect(isItemExpanded(think1, thinkAlwaysSettings, latestIds)).toBe(true);
  });

  test("tool expands always when set to always regardless of latest", () => {
    const write1: ToolActivity = {
      kind: "tool",
      id: "tool-write-1",
      name: "write",
      input: null,
      status: "complete",
    };
    expect(isItemExpanded(write1, settings, latestIds)).toBe(true);
  });

  test("tool does not expand when set to none even if latest", () => {
    const edit2: ToolActivity = {
      kind: "tool",
      id: "tool-edit-2",
      name: "edit",
      input: null,
      status: "complete",
    };
    expect(isItemExpanded(edit2, settings, latestIds)).toBe(false);
  });

  test("error tools always expand regardless of setting", () => {
    const editError: ToolActivity = {
      kind: "tool",
      id: "tool-edit-err",
      name: "edit",
      input: null,
      status: "error",
      error: "Write failed",
    };
    expect(isItemExpanded(editError, settings, latestIds)).toBe(true);
  });

  test("running tools expand during execution", () => {
    const editRunning: ToolActivity = {
      kind: "tool",
      id: "tool-edit-run",
      name: "edit",
      input: null,
      status: "running",
    };
    expect(isItemExpanded(editRunning, settings, latestIds)).toBe(true);
  });

  test("manual toggle overrides setting", () => {
    const edit2: ToolActivity = {
      kind: "tool",
      id: "tool-edit-2",
      name: "edit",
      input: null,
      status: "complete",
    };
    // Setting is 'none', but user explicitly clicked open
    expect(isItemExpanded(edit2, settings, latestIds, { "tool-edit-2": true })).toBe(true);

    const write1: ToolActivity = {
      kind: "tool",
      id: "tool-write-1",
      name: "write",
      input: null,
      status: "complete",
    };
    // Setting is 'always', but user explicitly collapsed it
    expect(isItemExpanded(write1, settings, latestIds, { "tool-write-1": false })).toBe(false);
  });

  test("a superseded 'latest' row collapses once a newer row arrives", () => {
    const read1: ToolActivity = { kind: "tool", id: "tool-read-1", name: "read", input: null, status: "complete" };
    const read2: ToolActivity = { kind: "tool", id: "tool-read-2", name: "read", input: null, status: "complete" };
    // latestIds points at tool-read-2, so the older row stays collapsed.
    expect(isItemExpanded(read1, settings, latestIds)).toBe(false);
    expect(isItemExpanded(read2, settings, latestIds)).toBe(true);
  });

  test("ask_user_question follows the ask setting, not otherTools", () => {
    const askSettings = {
      ...DEFAULT_TIMELINE_EXPANSION,
      tools: { ...DEFAULT_TIMELINE_EXPANSION.tools, ask: "none" as const },
      otherTools: "always" as const,
    };
    const askLatest: ToolActivity = { kind: "tool", id: "tool-ask-1", name: "ask_user_question", input: null, status: "complete" };
    const askIds = { latestThinkingId: undefined, latestToolIds: { ask: "tool-ask-1", other: "tool-ask-1" } };
    // Even though it is the latest ask row (and otherTools is always),
    // the ask=none setting keeps the gross input JSON collapsed.
    expect(isItemExpanded(askLatest, askSettings, askIds)).toBe(false);

    const askAlways = { ...askSettings, tools: { ...askSettings.tools, ask: "always" as const } };
    expect(isItemExpanded(askLatest, askAlways, askIds)).toBe(true);
  });
});
