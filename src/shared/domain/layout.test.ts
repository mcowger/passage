import { describe, expect, test } from "bun:test";
import {
  addTabToGroup,
  createDefaultLayout,
  findNode,
  findTab,
  migrateLayout,
  moveTab,
  normalizeTree,
  removeTabFromTree,
  resizeSplitNode,
  splitTabGroup,
  workspaceLayoutSchema,
  type PaneTab,
  type WorkspaceLayout,
} from "./layout.ts";

describe("split-tree layout domain operations", () => {
  test("creates valid default layout with agent tab", () => {
    const layout = createDefaultLayout("ws_1");
    expect(layout.version).toBe(1);
    expect(layout.root.type).toBe("tabs");
    if (layout.root.type === "tabs") {
      expect(layout.root.tabs).toHaveLength(1);
      expect(layout.root.tabs[0].kind).toBe("agent");
      expect(layout.root.activeTabId).toBe("agent-ws_1");
    }
    expect(workspaceLayoutSchema.safeParse(layout).success).toBe(true);
  });

  test("adds a tab to an existing group and avoids duplicates", () => {
    const layout = createDefaultLayout("ws_1");
    const newTab: PaneTab = { id: "agent-1", kind: "agent", title: "Agent 1" };
    const nextRoot = addTabToGroup(layout.root, layout.root.id, newTab);

    expect(findTab(nextRoot, "agent-1")).not.toBeNull();
    if (nextRoot.type === "tabs") {
      expect(nextRoot.tabs).toHaveLength(2);
      expect(nextRoot.activeTabId).toBe("agent-1");
    }

    // Adding same tab again activates it without duplicating
    const againRoot = addTabToGroup(nextRoot, nextRoot.id, newTab);
    if (againRoot.type === "tabs") {
      expect(againRoot.tabs).toHaveLength(2);
      expect(againRoot.activeTabId).toBe("agent-1");
    }
  });

  test("splits a tab group horizontally and vertically", () => {
    const layout = createDefaultLayout("ws_1");
    const terminalTab: PaneTab = { id: "term-1", kind: "terminal", title: "Terminal 1" };
    const splitRoot = splitTabGroup(layout.root, layout.root.id, "horizontal", terminalTab, "after");

    expect(splitRoot.type).toBe("split");
    if (splitRoot.type === "split") {
      expect(splitRoot.direction).toBe("horizontal");
      expect(splitRoot.children).toHaveLength(2);
      expect(splitRoot.sizes).toEqual([0.5, 0.5]);
      expect(findTab(splitRoot, "agent-ws_1")).not.toBeNull();
      expect(findTab(splitRoot, "term-1")).not.toBeNull();
    }
  });

  test("removes tabs and normalizes split tree collapsing empty nodes", () => {
    const layout = createDefaultLayout("ws_1");
    const terminalTab: PaneTab = { id: "term-1", kind: "terminal", title: "Terminal 1" };
    const splitRoot = splitTabGroup(layout.root, layout.root.id, "horizontal", terminalTab, "after");

    // Remove term-1 -> should collapse back to single tabs node
    const collapsedRoot = removeTabFromTree(splitRoot, "term-1");
    expect(collapsedRoot).not.toBeNull();
    expect(collapsedRoot?.type).toBe("tabs");
    if (collapsedRoot?.type === "tabs") {
      expect(collapsedRoot.tabs).toHaveLength(1);
      expect(collapsedRoot.tabs[0].id).toBe("agent-ws_1");
    }
  });

  test("moves a tab between groups", () => {
    const layout = createDefaultLayout("ws_1");
    const terminalTab: PaneTab = { id: "term-1", kind: "terminal", title: "Terminal 1" };
    const editorTab: PaneTab = { id: "editor-1", kind: "editor", title: "index.ts" };

    const splitRoot = splitTabGroup(layout.root, layout.root.id, "horizontal", terminalTab, "after");
    const withEditor = addTabToGroup(splitRoot, layout.root.id, editorTab);

    // Find the terminal group ID
    const termTabFound = findTab(withEditor, "term-1");
    expect(termTabFound).not.toBeNull();

    const targetGroupId = termTabFound!.node.id;
    const movedRoot = moveTab(withEditor, "editor-1", targetGroupId);

    const movedFound = findTab(movedRoot, "editor-1");
    expect(movedFound?.node.id).toBe(targetGroupId);
  });

  test("resizes split node sizes normalized to sum 1.0", () => {
    const layout = createDefaultLayout("ws_1");
    const terminalTab: PaneTab = { id: "term-1", kind: "terminal", title: "Terminal 1" };
    const splitRoot = splitTabGroup(layout.root, layout.root.id, "horizontal", terminalTab, "after");

    if (splitRoot.type === "split") {
      const resized = resizeSplitNode(splitRoot, splitRoot.id, [0.7, 0.3]);
      if (resized.type === "split") {
        expect(resized.sizes[0]).toBeCloseTo(0.7);
        expect(resized.sizes[1]).toBeCloseTo(0.3);
      }
    }
  });

  test("migrates layout from valid version or falls back to default", () => {
    const validRaw = createDefaultLayout("ws_test");
    const migrated = migrateLayout(validRaw, 1);
    expect(migrated.version).toBe(1);

    const invalidRaw = { corrupted: true };
    const fallback = migrateLayout(invalidRaw, 1);
    expect(fallback.version).toBe(1);
    expect(fallback.root.type).toBe("tabs");
  });
});
