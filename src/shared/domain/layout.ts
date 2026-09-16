import { z } from "zod";

export type PaneTabKind =
  | "overview"
  | "agent"
  | "terminal"
  | "editor"
  | "diff"
  | "explorer"
  | "changes";

export const paneTabSchema = z.object({
  id: z.string().min(1).max(256),
  kind: z.enum(["overview", "agent", "terminal", "editor", "diff", "explorer", "changes"]),
  title: z.string().min(1).max(256),
  targetId: z.string().max(1024).optional(),
  pinned: z.boolean().optional(),
});
export type PaneTab = z.infer<typeof paneTabSchema>;

export type TabGroupNode = {
  type: "tabs";
  id: string;
  tabs: PaneTab[];
  activeTabId: string;
};

export type SplitNode = {
  type: "split";
  id: string;
  direction: "horizontal" | "vertical";
  sizes: number[];
  children: LayoutNode[];
};

export type LayoutNode = TabGroupNode | SplitNode;

export const tabGroupNodeSchema = z.object({
  type: z.literal("tabs"),
  id: z.string().min(1).max(128),
  tabs: z.array(paneTabSchema).min(1).max(50),
  activeTabId: z.string().min(1).max(256),
});

export const splitNodeSchema: z.ZodType<SplitNode> = z.lazy(() =>
  z.object({
    type: z.literal("split"),
    id: z.string().min(1).max(128),
    direction: z.enum(["horizontal", "vertical"]),
    sizes: z.array(z.number().min(0.01).max(0.99)).min(2).max(10),
    children: z.array(layoutNodeSchema).min(2).max(10),
  })
);

export const layoutNodeSchema: z.ZodType<LayoutNode> = z.lazy(() =>
  z.union([tabGroupNodeSchema, splitNodeSchema])
);

export const CURRENT_LAYOUT_SCHEMA_VERSION = 1;

export const workspaceLayoutSchema = z.object({
  version: z.number().int().min(1).max(100),
  root: layoutNodeSchema,
});
export type WorkspaceLayout = z.infer<typeof workspaceLayoutSchema>;

function shortId(): string {
  try {
    const c = (globalThis as unknown as { crypto?: Crypto }).crypto;
    if (c && typeof c.randomUUID === "function") {
      return c.randomUUID().slice(0, 8);
    }
    if (c && typeof c.getRandomValues === "function") {
      const bytes = new Uint8Array(8);
      c.getRandomValues(bytes);
      return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("").slice(0, 8);
    }
  } catch {}
  return `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`.slice(0, 8);
}

function newNodeId(prefix: "group" | "split"): string {
  return `${prefix}-${shortId()}`;
}

export function createDefaultLayout(workspaceId: string, initialTab?: PaneTab): WorkspaceLayout {
  const defaultTab: PaneTab = initialTab ?? {
    id: `overview-${workspaceId}`,
    kind: "overview",
    title: "Overview",
  };
  return {
    version: CURRENT_LAYOUT_SCHEMA_VERSION,
    root: {
      type: "tabs",
      id: newNodeId("group"),
      tabs: [defaultTab],
      activeTabId: defaultTab.id,
    },
  };
}

export function findTab(
  node: LayoutNode,
  tabId: string
): { node: TabGroupNode; tab: PaneTab; index: number } | null {
  if (node.type === "tabs") {
    const index = node.tabs.findIndex((t) => t.id === tabId);
    if (index !== -1) {
      return { node, tab: node.tabs[index], index };
    }
    return null;
  }
  for (const child of node.children) {
    const found = findTab(child, tabId);
    if (found) return found;
  }
  return null;
}

export function countAgentTabs(node: LayoutNode, agentIds?: ReadonlySet<string>): number {
  const seen = new Set<string>();
  const visit = (current: LayoutNode) => {
    if (current.type === "tabs") {
      for (const tab of current.tabs) {
        if (tab.kind !== "agent" || tab.targetId === undefined) continue;
        if (agentIds && !agentIds.has(tab.targetId)) continue;
        seen.add(tab.targetId);
      }
      return;
    }
    current.children.forEach(visit);
  };
  visit(node);
  return seen.size;
}

export function findNode(node: LayoutNode, nodeId: string): LayoutNode | null {
  if (node.id === nodeId) return node;
  if (node.type === "split") {
    for (const child of node.children) {
      const found = findNode(child, nodeId);
      if (found) return found;
    }
  }
  return null;
}

export function normalizeTree(node: LayoutNode): LayoutNode | null {
  if (node.type === "tabs") {
    if (node.tabs.length === 0) return null;
    const activeTab = node.tabs.some((t) => t.id === node.activeTabId)
      ? node.activeTabId
      : node.tabs[0].id;
    return { ...node, activeTabId: activeTab };
  }

  const normalizedChildren: LayoutNode[] = [];
  const normalizedSizes: number[] = [];

  for (let i = 0; i < node.children.length; i++) {
    const norm = normalizeTree(node.children[i]);
    if (norm) {
      normalizedChildren.push(norm);
      normalizedSizes.push(node.sizes[i] ?? 1 / node.children.length);
    }
  }

  if (normalizedChildren.length === 0) return null;
  if (normalizedChildren.length === 1) return normalizedChildren[0];

  // Re-normalize sizes to sum to 1.0
  const total = normalizedSizes.reduce((sum, s) => sum + s, 0);
  const rebalancedSizes = normalizedSizes.map((s) => s / total);

  return {
    ...node,
    sizes: rebalancedSizes,
    children: normalizedChildren,
  };
}

export function addTabToGroup(
  root: LayoutNode,
  targetGroupId: string,
  tab: PaneTab
): LayoutNode {
  // If tab already exists anywhere in the tree, activate it instead of duplicating
  const existing = findTab(root, tab.id);
  if (existing) {
    return setActiveTabInTree(root, existing.node.id, tab.id);
  }

  function update(node: LayoutNode): LayoutNode {
    if (node.type === "tabs") {
      if (node.id === targetGroupId) {
        return {
          ...node,
          tabs: [...node.tabs, tab],
          activeTabId: tab.id,
        };
      }
      return node;
    }
    return {
      ...node,
      children: node.children.map(update),
    };
  }

  const updated = update(root);
  // If targetGroupId wasn't found (e.g. invalid), append to first tab group
  if (findTab(updated, tab.id) === null) {
    const firstGroup = getFirstTabGroup(root);
    if (firstGroup) {
      return addTabToGroup(root, firstGroup.id, tab);
    }
  }
  return updated;
}

export function getFirstTabGroup(node: LayoutNode): TabGroupNode | null {
  if (node.type === "tabs") return node;
  for (const child of node.children) {
    const group = getFirstTabGroup(child);
    if (group) return group;
  }
  return null;
}

export function setActiveTabInTree(
  root: LayoutNode,
  groupId: string,
  tabId: string
): LayoutNode {
  function update(node: LayoutNode): LayoutNode {
    if (node.type === "tabs") {
      if (node.id === groupId) {
        return { ...node, activeTabId: tabId };
      }
      return node;
    }
    return {
      ...node,
      children: node.children.map(update),
    };
  }
  return update(root);
}

export function removeTabFromTree(root: LayoutNode, tabId: string): LayoutNode | null {
  function update(node: LayoutNode): LayoutNode | null {
    if (node.type === "tabs") {
      const index = node.tabs.findIndex((t) => t.id === tabId);
      if (index === -1) return node;
      const remainingTabs = node.tabs.filter((t) => t.id !== tabId);
      if (remainingTabs.length === 0) return null;
      let nextActiveId = node.activeTabId;
      if (node.activeTabId === tabId) {
        nextActiveId = remainingTabs[Math.min(index, remainingTabs.length - 1)].id;
      }
      return {
        ...node,
        tabs: remainingTabs,
        activeTabId: nextActiveId,
      };
    }
    const nextChildren: LayoutNode[] = [];
    const nextSizes: number[] = [];
    for (let i = 0; i < node.children.length; i++) {
      const c = update(node.children[i]);
      if (c) {
        nextChildren.push(c);
        nextSizes.push(node.sizes[i] ?? 1 / node.children.length);
      }
    }
    if (nextChildren.length === 0) return null;
    if (nextChildren.length === 1) return nextChildren[0];
    const total = nextSizes.reduce((sum, s) => sum + s, 0);
    return {
      ...node,
      sizes: nextSizes.map((s) => s / total),
      children: nextChildren,
    };
  }

  const result = update(root);
  return result ? normalizeTree(result) : null;
}

export function splitTabGroup(
  root: LayoutNode,
  targetGroupId: string,
  direction: "horizontal" | "vertical",
  newTab: PaneTab,
  position: "before" | "after" = "after"
): LayoutNode {
  // First remove newTab from anywhere it might already exist
  let currentRoot = root;
  const existing = findTab(currentRoot, newTab.id);
  if (existing) {
    const cleaned = removeTabFromTree(currentRoot, newTab.id);
    if (cleaned) currentRoot = cleaned;
  }

  const newGroup: TabGroupNode = {
    type: "tabs",
    id: newNodeId("group"),
    tabs: [newTab],
    activeTabId: newTab.id,
  };

  function update(node: LayoutNode): LayoutNode {
    if (node.type === "tabs") {
      if (node.id === targetGroupId) {
        const children = position === "before" ? [newGroup, node] : [node, newGroup];
        const newSplit: SplitNode = {
          type: "split",
          id: newNodeId("split"),
          direction,
          sizes: [0.5, 0.5],
          children,
        };
        return newSplit;
      }
      return node;
    }
    return {
      ...node,
      children: node.children.map(update),
    };
  }

  return normalizeTree(update(currentRoot)) ?? currentRoot;
}

export function moveTab(
  root: LayoutNode,
  tabId: string,
  targetGroupId: string,
  insertIndex?: number
): LayoutNode {
  const found = findTab(root, tabId);
  if (!found) return root;

  const movedTab = found.tab;

  // Remove tab from current location
  const removed = removeTabFromTree(root, tabId);
  if (!removed) {
    // It was the only tab; replace root with new tab group
    return {
      type: "tabs",
      id: targetGroupId,
      tabs: [movedTab],
      activeTabId: movedTab.id,
    };
  }

  function update(node: LayoutNode): LayoutNode {
    if (node.type === "tabs") {
      if (node.id === targetGroupId) {
        const tabs = [...node.tabs];
        const index = insertIndex !== undefined ? Math.min(insertIndex, tabs.length) : tabs.length;
        tabs.splice(index, 0, movedTab);
        return {
          ...node,
          tabs,
          activeTabId: movedTab.id,
        };
      }
      return node;
    }
    return {
      ...node,
      children: node.children.map(update),
    };
  }

  return update(removed);
}

export function resizeSplitNode(
  root: LayoutNode,
  splitNodeId: string,
  newSizes: number[]
): LayoutNode {
  function update(node: LayoutNode): LayoutNode {
    if (node.type === "tabs") return node;
    if (node.id === splitNodeId) {
      const total = newSizes.reduce((a, b) => a + b, 0);
      const normalized = newSizes.map((s) => s / total);
      return { ...node, sizes: normalized };
    }
    return {
      ...node,
      children: node.children.map(update),
    };
  }
  return update(root);
}

export function replaceOverviewTabs(node: LayoutNode): LayoutNode {
  if (node.type === "tabs") {
    const nextTabs = node.tabs.map((tab) =>
      (tab.kind === "overview" || (tab.kind === "agent" && !tab.targetId))
        ? { ...tab, kind: "overview" as const, title: "Overview" }
        : tab
    );
    return { ...node, tabs: nextTabs };
  }
  return {
    ...node,
    children: node.children.map(replaceOverviewTabs),
  };
}

export function migrateLayout(raw: unknown, version: number): WorkspaceLayout {
  if (version === 1 && typeof raw === "object" && raw !== null && "root" in raw) {
    const parsed = workspaceLayoutSchema.safeParse(raw);
    if (parsed.success) {
      return {
        ...parsed.data,
        root: replaceOverviewTabs(parsed.data.root),
      };
    }
  }
  // Fallback for empty or unknown layout
  return createDefaultLayout("default");
}
