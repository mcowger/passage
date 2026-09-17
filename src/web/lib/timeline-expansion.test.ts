import { describe, expect, test } from "bun:test";
import {
  resolveCanonicalTool,
  computeLatestTimelineIds,
  collectExpandedIds,
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
        significant: false,
      },
      { kind: "thinking", id: "think-2", text: "Second thought" },
      {
        kind: "tool",
        id: "tool-read-2",
        name: "readFile",
        input: { path: "b.ts" },
        status: "complete",
        significant: false,
      },
      {
        kind: "tool",
        id: "tool-bash-1",
        name: "bash",
        input: { command: "ls" },
        status: "complete",
        significant: true,
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
      significant: true,
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
      significant: true,
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
      significant: true,
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
      significant: true,
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
      significant: true,
    };
    // Setting is 'none', but user explicitly clicked open
    expect(isItemExpanded(edit2, settings, latestIds, { "tool-edit-2": true })).toBe(true);

    const write1: ToolActivity = {
      kind: "tool",
      id: "tool-write-1",
      name: "write",
      input: null,
      status: "complete",
      significant: true,
    };
    // Setting is 'always', but user explicitly collapsed it
    expect(isItemExpanded(write1, settings, latestIds, { "tool-write-1": false })).toBe(false);
  });

  test("concise mode collapses items unless manually toggled or error", () => {
    const write1: ToolActivity = {
      kind: "tool",
      id: "tool-write-1",
      name: "write",
      input: null,
      status: "complete",
      significant: true,
    };
    expect(isItemExpanded(write1, settings, latestIds, {}, true)).toBe(false);

    // Error still expands in concise mode
    const writeErr: ToolActivity = {
      kind: "tool",
      id: "tool-write-err",
      name: "write",
      input: null,
      status: "error",
      significant: true,
    };
    expect(isItemExpanded(writeErr, settings, latestIds, {}, true)).toBe(true);
  });

  test("stickyExpandedIds keeps a row expanded once it is no longer 'latest'", () => {
    const edit1: ToolActivity = { kind: "tool", id: "tool-edit-1", name: "edit", input: null, status: "complete", significant: true };
    // Not latest (latestIds points at tool-edit-2), so it would normally collapse.
    expect(isItemExpanded(edit1, settings, latestIds)).toBe(false);
    expect(isItemExpanded(edit1, settings, latestIds, {}, false, new Set(["tool-edit-1"]))).toBe(true);
  });
});

describe("collectExpandedIds", () => {
  test("never removes a previously expanded id when a newer 'latest' row supersedes it", () => {
    const settings = {
      ...DEFAULT_TIMELINE_EXPANSION,
      tools: { ...DEFAULT_TIMELINE_EXPANSION.tools, edit: "latest" as const },
    };
    const edit1: ToolActivity = { kind: "tool", id: "e1", name: "edit", input: null, status: "complete", significant: true };
    const edit2: ToolActivity = { kind: "tool", id: "e2", name: "edit", input: null, status: "running", significant: true };

    // First render: only e1 exists and is latest, so it renders expanded and becomes sticky.
    const afterFirst = collectExpandedIds([edit1], settings, computeLatestTimelineIds([edit1]), {}, false, new Set());
    expect(afterFirst.has("e1")).toBe(true);

    // Second render: e2 starts running (now latest); e1 must stay expanded even
    // though 'latest' mode would otherwise collapse it -- this is what keeps a
    // finished tool from shrinking above the viewport while a new one streams in.
    const afterSecond = collectExpandedIds([edit1, edit2], settings, computeLatestTimelineIds([edit1, edit2]), {}, false, afterFirst);
    expect(afterSecond.has("e1")).toBe(true);
    expect(afterSecond.has("e2")).toBe(true);
  });

  test("returns the same set instance when nothing new became expanded", () => {
    const settings = DEFAULT_TIMELINE_EXPANSION;
    const read1: ToolActivity = { kind: "tool", id: "r1", name: "read", input: null, status: "complete", significant: false };
    const previous = collectExpandedIds([read1], settings, computeLatestTimelineIds([read1]), {}, false, new Set());
    const again = collectExpandedIds([read1], settings, computeLatestTimelineIds([read1]), {}, false, previous);
    expect(again).toBe(previous);
  });
});
