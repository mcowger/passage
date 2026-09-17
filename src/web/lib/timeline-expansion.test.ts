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

  test("includes tool activities inside process items", () => {
    const timeline: TimelineItem[] = [
      {
        kind: "process",
        id: "proc-1",
        activities: [
          {
            kind: "tool",
            id: "proc-read-1",
            name: "read",
            input: null,
            status: "complete",
            significant: false,
          },
          {
            kind: "tool",
            id: "proc-ls-1",
            name: "ls",
            input: null,
            status: "complete",
            significant: false,
          },
        ],
      },
    ];

    const latest = computeLatestTimelineIds(timeline);
    expect(latest.latestToolIds.read).toBe("proc-read-1");
    expect(latest.latestToolIds.ls).toBe("proc-ls-1");
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
});
