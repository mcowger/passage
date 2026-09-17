import { describe, expect, test } from "bun:test";
import {
  addTabToGroup,
  countAgentTabs,
  countTabsOfKind,
  createDefaultLayout,
  findFirstDeadTerminalTab,
  findNode,
  findTab,
  getTabGroupIdsInOrder,
  migrateLayout,
  moveTab,
  normalizeTree,
  removeTabFromTree,
  resizeSplitNode,
  splitTabGroup,
  updateTabInTree,
  workspaceLayoutSchema,
  type PaneTab,
  type WorkspaceLayout,
} from "./layout.ts";

describe("split-tree layout domain operations", () => {
  test("creates valid default layout with overview tab", () => {
    const layout = createDefaultLayout("ws_1");
    expect(layout.version).toBe(1);
    expect(layout.root.type).toBe("tabs");
    if (layout.root.type === "tabs") {
      expect(layout.root.tabs).toHaveLength(1);
      expect(layout.root.tabs[0].kind).toBe("overview");
      expect(layout.root.activeTabId).toBe("overview-ws_1");
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
      expect(findTab(splitRoot, "overview-ws_1")).not.toBeNull();
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
      expect(collapsedRoot.tabs[0].id).toBe("overview-ws_1");
    }
  });

  test("moves a tab between groups", () => {    const layout = createDefaultLayout("ws_1");
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

  test("counts only distinct agent tabs targeting known agents", () => {
    const layout = createDefaultLayout("ws_1");
    const agentOne: PaneTab = { id: "agent-a", kind: "agent", title: "Agent A", targetId: "a" };
    const agentTwo: PaneTab = { id: "agent-b", kind: "agent", title: "Agent B", targetId: "b" };
    const orphan: PaneTab = { id: "agent-orphan", kind: "agent", title: "Agent C", targetId: "c" };
    const legacy: PaneTab = { id: "agent-legacy", kind: "agent", title: "Agent" };

    let root = addTabToGroup(layout.root, layout.root.id, agentOne);
    root = addTabToGroup(root, layout.root.id, agentTwo);
    root = addTabToGroup(root, layout.root.id, orphan);
    root = addTabToGroup(root, layout.root.id, legacy);

    expect(countAgentTabs(root)).toBe(3);
    expect(countAgentTabs(root, new Set(["a", "b"]))).toBe(2);
    expect(countAgentTabs(createDefaultLayout("ws_1").root, new Set(["a"]))).toBe(0);
  });

  test("counts distinct preview tabs targeting known previews", () => {
    const layout = createDefaultLayout("ws_1");
    const previewOne: PaneTab = { id: "preview-1", kind: "preview", title: "Preview 1", targetId: "p1" };
    const previewTwo: PaneTab = { id: "preview-2", kind: "preview", title: "Preview 2", targetId: "p2" };

    let root = addTabToGroup(layout.root, layout.root.id, previewOne);
    root = addTabToGroup(root, layout.root.id, previewTwo);

    expect(countTabsOfKind(root, "preview", new Set(["p1", "p2"]))).toBe(2);
    // A durable preview row with no open tab must not contribute to the count.
    expect(countTabsOfKind(root, "preview", new Set(["p1"]))).toBe(1);
    expect(countTabsOfKind(root, "preview", new Set())).toBe(0);
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

  test("updateTabInTree replaces tab in place and updates activeTabId if matched", () => {
    const layout = createDefaultLayout("ws_1");
    const terminalTab: PaneTab = { id: "term-old", kind: "terminal", title: "Terminal 1", targetId: "trm_old" };
    const rootWithTerm = addTabToGroup(layout.root, layout.root.id, terminalTab);

    const updatedTab: PaneTab = { id: "term-new", kind: "terminal", title: "Terminal 1", targetId: "trm_new" };
    const nextRoot = updateTabInTree(rootWithTerm, "term-old", updatedTab);

    expect(findTab(nextRoot, "term-old")).toBeNull();
    const foundNew = findTab(nextRoot, "term-new");
    expect(foundNew).not.toBeNull();
    expect(foundNew?.tab.targetId).toBe("trm_new");
    if (nextRoot.type === "tabs") {
      expect(nextRoot.activeTabId).toBe("term-new");
    }
  });

  test("findFirstDeadTerminalTab locates unbacked terminal tabs", () => {
    const layout = createDefaultLayout("ws_1");
    const deadTerm: PaneTab = { id: "term-dead", kind: "terminal", title: "Terminal 1", targetId: "trm_dead" };
    const liveTerm: PaneTab = { id: "term-live", kind: "terminal", title: "Terminal 2", targetId: "trm_live" };

    let root = addTabToGroup(layout.root, layout.root.id, deadTerm);
    root = addTabToGroup(root, layout.root.id, liveTerm);

    const liveSet = new Set(["trm_live"]);
    const foundDead = findFirstDeadTerminalTab(root, liveSet);
    expect(foundDead).not.toBeNull();
    expect(foundDead?.id).toBe("term-dead");

    const allLiveSet = new Set(["trm_dead", "trm_live"]);
    expect(findFirstDeadTerminalTab(root, allLiveSet)).toBeNull();
  });

  test("splitting a single-tab group with its own tab is a no-op", () => {
    const layout = createDefaultLayout("ws_1");
    const groupId = layout.root.id;
    const ownTab: PaneTab = { id: "overview-ws_1", kind: "overview", title: "Overview" };
    const nextRoot = splitTabGroup(layout.root, groupId, "horizontal", ownTab, "after");
    // No duplicate created, no tab lost.
    expect(nextRoot).toEqual(layout.root);
    expect(workspaceLayoutSchema.safeParse({ version: 1, root: nextRoot }).success).toBe(true);
  });

  test("splitting a multi-tab group with its own tab extracts it without duplicating", () => {
    const layout = createDefaultLayout("ws_1");
    const editorTab: PaneTab = { id: "editor-1", kind: "editor", title: "index.ts" };
    const rootWithTwo = addTabToGroup(layout.root, layout.root.id, editorTab);
    const splitRoot = splitTabGroup(rootWithTwo, layout.root.id, "horizontal", editorTab, "after");

    expect(splitRoot.type).toBe("split");
    // Tab exists exactly once.
    let occurrences = 0;
    const visit = (node: typeof splitRoot) => {
      if (node.type === "tabs") {
        for (const t of node.tabs) if (t.id === "editor-1") occurrences++;
        return;
      }
      node.children.forEach(visit);
    };
    visit(splitRoot);
    expect(occurrences).toBe(1);
    expect(findTab(splitRoot, "overview-ws_1")).not.toBeNull();
    expect(workspaceLayoutSchema.safeParse({ version: 1, root: splitRoot }).success).toBe(true);
  });

  test("moveTab reorders within a group and appends across groups", () => {
    const layout = createDefaultLayout("ws_1");
    const a: PaneTab = { id: "a", kind: "editor", title: "a" };
    const b: PaneTab = { id: "b", kind: "editor", title: "b" };
    const c: PaneTab = { id: "term-1", kind: "terminal", title: "Terminal 1" };
    let root = addTabToGroup(layout.root, layout.root.id, a);
    root = addTabToGroup(root, layout.root.id, b);
    // Reorder b to front (post-removal index 0 among remaining).
    root = moveTab(root, "b", layout.root.id, 0);
    if (root.type !== "tabs") throw new Error("expected single tab group");
    expect(root.tabs.map((t) => t.id)).toEqual(["b", "overview-ws_1", "a"]);
    expect(root.activeTabId).toBe("b");

    // Move across groups via split then move.
    const splitRoot = splitTabGroup(root, layout.root.id, "horizontal", c, "after");
    const targetGroup = findTab(splitRoot, "term-1")!.node.id;
    const movedRoot = moveTab(splitRoot, "a", targetGroup, 0);
    const found = findTab(movedRoot, "a");
    expect(found?.node.id).toBe(targetGroup);
    expect(found?.node.tabs[0].id).toBe("a");
  });

  test("getTabGroupIdsInOrder lists groups depth-first", () => {
    const layout = createDefaultLayout("ws_1");
    expect(getTabGroupIdsInOrder(layout.root)).toEqual([layout.root.id]);
    const c: PaneTab = { id: "term-1", kind: "terminal", title: "Terminal 1" };
    const splitRoot = splitTabGroup(layout.root, layout.root.id, "horizontal", c, "after");
    const order = getTabGroupIdsInOrder(splitRoot);
    expect(order).toHaveLength(2);
    expect(order[0]).toBe(layout.root.id);
  });
});
