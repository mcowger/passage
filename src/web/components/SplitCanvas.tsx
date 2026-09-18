import React, { useCallback, useRef, useState } from "react";
import type { LayoutNode, PaneTab, SplitNode, TabGroupNode, WorkspaceLayout } from "../../shared/domain/layout.ts";
import type { AgentSummary } from "../../shared/domain/agents.ts";
import { AGENT_STATUS_LABEL, getAgentStatusKind } from "./agentStatus.ts";
import {
  createDefaultLayout,
  getTabGroupIdsInOrder,
  moveTab,
  removeTabFromTree,
  resizeSplitNode,
  setActiveTabInTree,
  splitTabGroup,
} from "../../shared/domain/layout.ts";

export interface SplitCanvasProps {
  layout: WorkspaceLayout;
  onLayoutChange: (layout: WorkspaceLayout) => void;
  renderTabContent: (tab: PaneTab) => React.ReactNode;
  onActivateTab?: (tab: PaneTab) => void;
  onCloseTab?: (tabId: string) => boolean | void;
  workspaceId: string;
  agents?: AgentSummary[];
}

const DRAG_MIME = "application/x-passage-tab";

interface DragInfo {
  tabId: string;
  sourceGroupId: string;
}

type PaneDropEdge = "left" | "right" | "top" | "bottom" | "center";

function readDragPayload(e: React.DragEvent): DragInfo | null {
  try {
    if (!e.dataTransfer.types.includes(DRAG_MIME)) return null;
    const raw = e.dataTransfer.getData(DRAG_MIME);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as DragInfo;
    if (typeof parsed.tabId === "string" && typeof parsed.sourceGroupId === "string") {
      return parsed;
    }
    return null;
  } catch {
    return null;
  }
}

function hasDragPayload(e: React.DragEvent): boolean {
  try {
    return e.dataTransfer.types.includes(DRAG_MIME);
  } catch {
    return false;
  }
}

export function SplitCanvas({
  layout,
  onLayoutChange,
  renderTabContent,
  onActivateTab,
  onCloseTab,
  workspaceId,
  agents,
}: SplitCanvasProps) {
  const [contextMenu, setContextMenu] = useState<{
    x: number;
    y: number;
    tabId: string;
    groupId: string;
  } | null>(null);
  const [dragInfo, setDragInfo] = useState<DragInfo | null>(null);
  const [stripDrop, setStripDrop] = useState<{ groupId: string; index: number } | null>(null);
  const [paneDrop, setPaneDrop] = useState<{ groupId: string; edge: PaneDropEdge } | null>(null);

  const clearDragState = useCallback(() => {
    setDragInfo(null);
    setStripDrop(null);
    setPaneDrop(null);
  }, []);

  const handleSelectTab = useCallback(
    (groupId: string, tabId: string) => {
      const nextRoot = setActiveTabInTree(layout.root, groupId, tabId);
      onLayoutChange({ ...layout, root: nextRoot });
      const selectedTab = findTabInNode(layout.root, tabId);
      if (selectedTab) onActivateTab?.(selectedTab);
    },
    [layout, onActivateTab, onLayoutChange]
  );

  const handleCloseTab = useCallback(
    (tabId: string) => {
      const vetoed = onCloseTab?.(tabId);
      if (vetoed === false) {
        setContextMenu(null);
        return;
      }
      const nextRoot = removeTabFromTree(layout.root, tabId);
      if (nextRoot) {
        onLayoutChange({ ...layout, root: nextRoot });
      } else {
        onLayoutChange(createDefaultLayout(workspaceId));
      }
      setContextMenu(null);
    },
    [layout, onCloseTab, onLayoutChange, workspaceId]
  );

  const moveTabToGroup = useCallback(
    (tabId: string, targetGroupId: string, insertIndex?: number) => {
      const nextRoot = moveTab(layout.root, tabId, targetGroupId, insertIndex);
      onLayoutChange({ ...layout, root: nextRoot });
      const movedTab = findTabInNode(nextRoot, tabId);
      if (movedTab) onActivateTab?.(movedTab);
    },
    [layout, onActivateTab, onLayoutChange]
  );

  const splitGroupWithTab = useCallback(
    (groupId: string, tab: PaneTab, direction: "horizontal" | "vertical", position: "before" | "after") => {
      const nextRoot = splitTabGroup(layout.root, groupId, direction, tab, position);
      onLayoutChange({ ...layout, root: nextRoot });
      const movedTab = findTabInNode(nextRoot, tab.id);
      if (movedTab) onActivateTab?.(movedTab);
    },
    [layout, onActivateTab, onLayoutChange]
  );

  const handleSplitRight = useCallback(
    (groupId: string, tab: PaneTab) => {
      splitGroupWithTab(groupId, tab, "horizontal", "after");
      setContextMenu(null);
    },
    [splitGroupWithTab]
  );

  const handleSplitDown = useCallback(
    (groupId: string, tab: PaneTab) => {
      splitGroupWithTab(groupId, tab, "vertical", "after");
      setContextMenu(null);
    },
    [splitGroupWithTab]
  );

  const handleMoveToNeighbor = useCallback(
    (tabId: string, groupId: string, direction: 1 | -1) => {
      const order = getTabGroupIdsInOrder(layout.root);
      if (order.length < 2) return;
      const currentIndex = order.indexOf(groupId);
      if (currentIndex === -1) return;
      const targetGroupId = order[(currentIndex + direction + order.length) % order.length];
      moveTabToGroup(tabId, targetGroupId);
      setContextMenu(null);
    },
    [layout, moveTabToGroup]
  );

  const handleTabDragStart = useCallback((info: DragInfo, e: React.DragEvent) => {
    setDragInfo(info);
    setStripDrop(null);
    setPaneDrop(null);
    try {
      e.dataTransfer.setData(DRAG_MIME, JSON.stringify(info));
      e.dataTransfer.effectAllowed = "move";
    } catch {}
  }, []);

  const handleStripDrop = useCallback(
    (groupId: string, index: number) => {
      const info = dragInfoRef.current;
      if (!info) return;
      moveTabToGroupRef.current(info.tabId, groupId, index);
      clearDragState();
    },
    [clearDragState]
  );

  const handlePaneDrop = useCallback(
    (groupId: string, edge: PaneDropEdge) => {
      const info = dragInfoRef.current;
      if (!info) return;
      const tab = findTabInNode(layoutRef.current.root, info.tabId);
      if (!tab) {
        clearDragState();
        return;
      }
      if (edge === "center") {
        moveTabToGroupRef.current(info.tabId, groupId);
      } else if (edge === "left" || edge === "right") {
        splitGroupWithTabRef.current(groupId, tab, "horizontal", edge === "left" ? "before" : "after");
      } else {
        splitGroupWithTabRef.current(groupId, tab, "vertical", edge === "top" ? "before" : "after");
      }
      clearDragState();
    },
    [clearDragState]
  );

  // Refs mirror the latest callbacks/root so drag handlers registered on
  // child elements always act on fresh layout state.
  const layoutRef = useRef(layout);
  layoutRef.current = layout;
  const dragInfoRef = useRef(dragInfo);
  dragInfoRef.current = dragInfo;
  const moveTabToGroupRef = useRef(moveTabToGroup);
  moveTabToGroupRef.current = moveTabToGroup;
  const splitGroupWithTabRef = useRef(splitGroupWithTab);
  splitGroupWithTabRef.current = splitGroupWithTab;

  const handleResetLayout = useCallback(() => {
    onLayoutChange(createDefaultLayout(workspaceId));
    setContextMenu(null);
  }, [onLayoutChange, workspaceId]);

  const canCloseTab = countTabs(layout.root) > 1;
  const groupCount = getTabGroupIdsInOrder(layout.root).length;

  return (
    <div
      className="split-canvas-container"
      onClick={() => {
        if (contextMenu) setContextMenu(null);
      }}
    >
      <NodeRenderer
        node={layout.root}
        layout={layout}
        onLayoutChange={onLayoutChange}
        renderTabContent={renderTabContent}
        onActivateTab={onActivateTab}
        onSelectTab={handleSelectTab}
        onCloseTab={handleCloseTab}
        canCloseTab={canCloseTab}
        onSplitRight={handleSplitRight}
        onSplitDown={handleSplitDown}
        onMoveToNeighbor={handleMoveToNeighbor}
        showMoveAcrossPanes={groupCount > 1}
        onOpenContextMenu={(x, y, tabId, groupId) => setContextMenu({ x, y, tabId, groupId })}
        agents={agents}
        dragInfo={dragInfo}
        stripDrop={stripDrop}
        paneDrop={paneDrop}
        onTabDragStart={handleTabDragStart}
        onDragEnd={clearDragState}
        onStripDrop={handleStripDrop}
        onPaneDrop={handlePaneDrop}
        onStripDropTargetChange={setStripDrop}
        onPaneDropTargetChange={setPaneDrop}
      />

      {contextMenu && (
        <div
          className="canvas-context-menu"
          style={{ top: contextMenu.y, left: contextMenu.x }}
          role="menu"
        >
          <button
            type="button"
            role="menuitem"
            onClick={() => {
              const tab = findTabInNode(layout.root, contextMenu.tabId);
              if (tab) handleSplitRight(contextMenu.groupId, tab);
            }}
          >
            ◫ Split Right (Ctrl+Alt+R)
          </button>
          <button
            type="button"
            role="menuitem"
            onClick={() => {
              const tab = findTabInNode(layout.root, contextMenu.tabId);
              if (tab) handleSplitDown(contextMenu.groupId, tab);
            }}
          >
            ⬒ Split Down (Ctrl+Alt+D)
          </button>
          {groupCount > 1 && (
            <>
              <button
                type="button"
                role="menuitem"
                onClick={() => handleMoveToNeighbor(contextMenu.tabId, contextMenu.groupId, -1)}
              >
                ← Move to Previous Pane (Ctrl+Alt+←)
              </button>
              <button
                type="button"
                role="menuitem"
                onClick={() => handleMoveToNeighbor(contextMenu.tabId, contextMenu.groupId, 1)}
              >
                → Move to Next Pane (Ctrl+Alt+→)
              </button>
            </>
          )}
          {canCloseTab && (
            <button
              type="button"
              role="menuitem"
              onClick={() => handleCloseTab(contextMenu.tabId)}
            >
              ✕ Close Tab (Ctrl+Alt+W)
            </button>
          )}
          <div className="menu-divider" />
          <button type="button" role="menuitem" onClick={handleResetLayout}>
            ↺ Reset Canvas Layout
          </button>
        </div>
      )}
    </div>
  );
}

function countTabs(node: LayoutNode): number {
  if (node.type === "tabs") return node.tabs.length;
  return node.children.reduce((sum, child) => sum + countTabs(child), 0);
}

function findTabInNode(node: LayoutNode, tabId: string): PaneTab | null {
  if (node.type === "tabs") {
    return node.tabs.find((t) => t.id === tabId) ?? null;
  }
  for (const child of node.children) {
    const found = findTabInNode(child, tabId);
    if (found) return found;
  }
  return null;
}

function findGroupInNode(node: LayoutNode, groupId: string): TabGroupNode | null {
  if (node.type === "tabs") return node.id === groupId ? node : null;
  for (const child of node.children) {
    const found = findGroupInNode(child, groupId);
    if (found) return found;
  }
  return null;
}

interface NodeRendererProps {
  node: LayoutNode;
  layout: WorkspaceLayout;
  onLayoutChange: (layout: WorkspaceLayout) => void;
  renderTabContent: (tab: PaneTab) => React.ReactNode;
  onActivateTab?: (tab: PaneTab) => void;
  onSelectTab: (groupId: string, tabId: string) => void;
  onCloseTab: (tabId: string) => void;
  canCloseTab: boolean;
  onSplitRight: (groupId: string, tab: PaneTab) => void;
  onSplitDown: (groupId: string, tab: PaneTab) => void;
  onMoveToNeighbor: (tabId: string, groupId: string, direction: 1 | -1) => void;
  showMoveAcrossPanes: boolean;
  onOpenContextMenu: (x: number, y: number, tabId: string, groupId: string) => void;
  agents?: AgentSummary[];
  dragInfo: DragInfo | null;
  stripDrop: { groupId: string; index: number } | null;
  paneDrop: { groupId: string; edge: PaneDropEdge } | null;
  onTabDragStart: (info: DragInfo, e: React.DragEvent) => void;
  onDragEnd: () => void;
  onStripDrop: (groupId: string, index: number) => void;
  onPaneDrop: (groupId: string, edge: PaneDropEdge) => void;
  onStripDropTargetChange: (target: { groupId: string; index: number } | null) => void;
  onPaneDropTargetChange: (target: { groupId: string; edge: PaneDropEdge } | null) => void;
}

function NodeRenderer(props: NodeRendererProps) {
  const { node } = props;

  if (node.type === "tabs") {
    return <TabGroupRenderer {...props} group={node} />;
  }

  return <SplitNodeRenderer {...props} split={node} />;
}

interface SplitNodeRendererProps extends NodeRendererProps {
  split: SplitNode;
}

function SplitNodeRenderer({ split, layout, onLayoutChange, ...rest }: SplitNodeRendererProps) {
  const containerRef = useRef<HTMLDivElement>(null);

  const handleDividerMouseDown = (dividerIndex: number, e: React.MouseEvent) => {
    e.preventDefault();
    const isHorizontal = split.direction === "horizontal";
    const startPos = isHorizontal ? e.clientX : e.clientY;
    const initialSizes = [...split.sizes];
    const container = containerRef.current;
    if (!container) return;

    const rect = container.getBoundingClientRect();
    const totalPx = isHorizontal ? rect.width : rect.height;

    const handleMouseMove = (moveEvent: MouseEvent) => {
      const currentPos = isHorizontal ? moveEvent.clientX : moveEvent.clientY;
      const deltaPx = currentPos - startPos;
      const deltaPercent = deltaPx / totalPx;

      const newSizes = [...initialSizes];
      const minRatio = 0.1;

      // Adjust the two adjacent panes
      const leftNew = initialSizes[dividerIndex] + deltaPercent;
      const rightNew = initialSizes[dividerIndex + 1] - deltaPercent;

      if (leftNew >= minRatio && rightNew >= minRatio) {
        newSizes[dividerIndex] = leftNew;
        newSizes[dividerIndex + 1] = rightNew;
        const nextRoot = resizeSplitNode(layout.root, split.id, newSizes);
        onLayoutChange({ ...layout, root: nextRoot });
      }
    };

    const handleMouseUp = () => {
      window.removeEventListener("mousemove", handleMouseMove);
      window.removeEventListener("mouseup", handleMouseUp);
    };

    window.addEventListener("mousemove", handleMouseMove);
    window.addEventListener("mouseup", handleMouseUp);
  };

  return (
    <div
      ref={containerRef}
      className={`split-node ${split.direction}`}
      style={{
        display: "flex",
        flexDirection: split.direction === "horizontal" ? "row" : "column",
        width: "100%",
        height: "100%",
        minWidth: 0,
        minHeight: 0,
      }}
    >
      {split.children.map((child, i) => {
        const sizeRatio = split.sizes[i] ?? 1 / split.children.length;
        const isLast = i === split.children.length - 1;

        return (
          <React.Fragment key={child.id}>
            <div
              className="split-child"
              style={{
                flex: sizeRatio,
                minWidth: 0,
                minHeight: 0,
                display: "flex",
                overflow: "hidden",
                position: "relative",
              }}
            >
              <NodeRenderer
                {...rest}
                node={child}
                layout={layout}
                onLayoutChange={onLayoutChange}
              />
            </div>
            {!isLast && (
              <div
                className={`split-divider ${split.direction}`}
                role="separator"
                aria-orientation={split.direction}
                onMouseDown={(e) => handleDividerMouseDown(i, e)}
              />
            )}
          </React.Fragment>
        );
      })}
    </div>
  );
}

interface TabGroupRendererProps extends NodeRendererProps {
  group: TabGroupNode;
}

function TabGroupRenderer({
  group,
  renderTabContent,
  onSelectTab,
  onCloseTab,
  onSplitRight,
  onSplitDown,
  onMoveToNeighbor,
  showMoveAcrossPanes,
  onOpenContextMenu,
  canCloseTab,
  agents,
  dragInfo,
  stripDrop,
  paneDrop,
  onTabDragStart,
  onDragEnd,
  onStripDrop,
  onPaneDrop,
  onStripDropTargetChange,
  onPaneDropTargetChange,
}: TabGroupRendererProps) {
  const stripRef = useRef<HTMLDivElement>(null);
  const activeTab =
    group.tabs.find((t) => t.id === group.activeTabId) ?? group.tabs[0];
  const agentsById = new Map((agents ?? []).map((agent) => [agent.id, agent]));
  const isDragging = dragInfo !== null;
  const isStripTarget = stripDrop?.groupId === group.id;
  // A lone tab dropped on its own pane edges would be a no-op (it cannot
  // split with itself), so those edge zones render as non-accepting.
  const canSplitFromHere =
    !dragInfo || dragInfo.sourceGroupId !== group.id || group.tabs.length > 1;

  const getTabIcon = (kind: PaneTab["kind"]) => {
    switch (kind) {
      case "overview":
        return "ℹ";
      case "terminal":
        return ">_";
      case "editor":
        return "📄";
      case "diff":
        return "±";
      case "explorer":
        return "📁";
      case "changes":
        return "±";
      default:
        return "•";
    }
  };

  const renderTabLeading = (tab: PaneTab) => {
    if (tab.kind === "agent" && tab.targetId) {
      const agent = agentsById.get(tab.targetId);
      const kind = agent ? getAgentStatusKind(agent) : "empty";
      const label = agent ? AGENT_STATUS_LABEL[kind] : AGENT_STATUS_LABEL.empty;
      return (
        <span
          className={`canvas-tab-dot ${kind}`}
          role="img"
          aria-label={label}
          title={label}
        />
      );
    }
    return <span className="canvas-tab-icon">{getTabIcon(tab.kind)}</span>;
  };

  const computeStripIndex = (clientX: number): number => {
    const container = stripRef.current;
    if (!container) return group.tabs.filter((t) => t.id !== dragInfo?.tabId).length;
    const elements = Array.from(
      container.querySelectorAll<HTMLElement>("[data-tab-id]")
    );
    let index = 0;
    for (const el of elements) {
      if (el.dataset.tabId === dragInfo?.tabId) continue;
      const rect = el.getBoundingClientRect();
      if (clientX > rect.left + rect.width / 2) index++;
      else break;
    }
    return index;
  };

  const handleStripDragOver = (e: React.DragEvent) => {
    if (!hasDragPayload(e) && !dragInfo) return;
    e.preventDefault();
    e.stopPropagation();
    try {
      e.dataTransfer.dropEffect = "move";
    } catch {}
    const index = computeStripIndex(e.clientX);
    if (stripDrop?.groupId !== group.id || stripDrop?.index !== index) {
      onStripDropTargetChange({ groupId: group.id, index });
    }
    if (paneDrop?.groupId === group.id) {
      onPaneDropTargetChange(null);
    }
  };

  const handleStripDragLeave = (e: React.DragEvent) => {
    if (e.currentTarget.contains(e.relatedTarget as Node | null)) return;
    if (stripDrop?.groupId === group.id) onStripDropTargetChange(null);
  };

  const handleStripDrop = (e: React.DragEvent) => {
    const payload = readDragPayload(e) ?? dragInfo;
    if (!payload) return;
    e.preventDefault();
    e.stopPropagation();
    onStripDrop(group.id, computeStripIndex(e.clientX));
  };

  const handleZoneDragOver = (edge: PaneDropEdge) => (e: React.DragEvent) => {
    if (!hasDragPayload(e) && !dragInfo) return;
    if (edge !== "center" && !canSplitFromHere) return;
    e.preventDefault();
    e.stopPropagation();
    try {
      e.dataTransfer.dropEffect = "move";
    } catch {}
    if (paneDrop?.groupId !== group.id || paneDrop?.edge !== edge) {
      onPaneDropTargetChange({ groupId: group.id, edge });
    }
    if (stripDrop?.groupId === group.id) {
      onStripDropTargetChange(null);
    }
  };

  const handleZoneDrop = (edge: PaneDropEdge) => (e: React.DragEvent) => {
    const payload = readDragPayload(e) ?? dragInfo;
    if (!payload) return;
    if (edge !== "center" && !canSplitFromHere) return;
    e.preventDefault();
    e.stopPropagation();
    onPaneDrop(group.id, edge);
  };

  const handleTabKeyDown = (tab: PaneTab, index: number) => (e: React.KeyboardEvent) => {
    if (e.ctrlKey && e.altKey && (e.key === "r" || e.key === "R")) {
      e.preventDefault();
      onSplitRight(group.id, tab);
    } else if (e.ctrlKey && e.altKey && (e.key === "d" || e.key === "D")) {
      e.preventDefault();
      onSplitDown(group.id, tab);
    } else if (e.ctrlKey && e.altKey && (e.key === "w" || e.key === "W")) {
      e.preventDefault();
      if (canCloseTab) onCloseTab(tab.id);
    } else if (e.ctrlKey && e.altKey && e.key === "ArrowLeft") {
      e.preventDefault();
      onMoveToNeighbor(tab.id, group.id, -1);
    } else if (e.ctrlKey && e.altKey && e.key === "ArrowRight") {
      e.preventDefault();
      onMoveToNeighbor(tab.id, group.id, 1);
    } else if (!e.ctrlKey && !e.altKey && !e.metaKey && e.key === "ArrowLeft" && index > 0) {
      e.preventDefault();
      onSelectTab(group.id, group.tabs[index - 1].id);
      focusTab(group.id, index - 1);
    } else if (
      !e.ctrlKey &&
      !e.altKey &&
      !e.metaKey &&
      e.key === "ArrowRight" &&
      index < group.tabs.length - 1
    ) {
      e.preventDefault();
      onSelectTab(group.id, group.tabs[index + 1].id);
      focusTab(group.id, index + 1);
    }
  };

  const focusTab = (groupId: string, index: number) => {
    requestAnimationFrame(() => {
      const el = document.querySelector<HTMLElement>(
        `[data-tab-group="${groupId}"][data-tab-index="${index}"]`
      );
      el?.focus();
    });
  };

  // While a strip is the drop target, render the dragged tab as removed and
  // show the insertion indicator at the pending index.
  const visibleTabs =
    isDragging && isStripTarget && dragInfo
      ? group.tabs.filter((t) => t.id !== dragInfo.tabId)
      : group.tabs;
  const dropIndex = isStripTarget && stripDrop ? Math.min(stripDrop.index, visibleTabs.length) : -1;

  const renderTab = (tab: PaneTab, index: number) => {
    const isActive = tab.id === activeTab?.id;
    const isDragged = dragInfo?.tabId === tab.id;
    return (
      <div
        key={tab.id}
        role="tab"
        aria-selected={isActive}
        tabIndex={isActive ? 0 : -1}
        data-tab-id={tab.id}
        data-tab-group={group.id}
        data-tab-index={index}
        draggable
        className={`canvas-tab ${isActive ? "active" : ""} ${isDragged ? "dragging" : ""}`}
        onClick={() => onSelectTab(group.id, tab.id)}
        onKeyDown={handleTabKeyDown(tab, index)}
        onContextMenu={(e) => {
          e.preventDefault();
          onOpenContextMenu(e.clientX, e.clientY, tab.id, group.id);
        }}
        onDragStart={(e) => onTabDragStart({ tabId: tab.id, sourceGroupId: group.id }, e)}
        onDragEnd={onDragEnd}
        title={`${tab.title} — drag to move, Ctrl+Alt+←/→ across panes`}
      >
        {renderTabLeading(tab)}
        <span className="canvas-tab-title">{tab.title}</span>
        {canCloseTab && (
          <button
            type="button"
            className="canvas-tab-close"
            title="Close tab"
            aria-label={`Close ${tab.title}`}
            draggable={false}
            onClick={(e) => {
              e.stopPropagation();
              onCloseTab(tab.id);
            }}
          >
            ×
          </button>
        )}
      </div>
    );
  };

  const renderZone = (edge: PaneDropEdge, label: string, hint: string) => {
    const isActive = paneDrop?.groupId === group.id && paneDrop?.edge === edge;
    const disabled = edge !== "center" && !canSplitFromHere;
    return (
      <div
        className={`pane-drop-zone zone-${edge}${isActive ? " active" : ""}${disabled ? " disabled" : ""}`}
        data-drop-edge={edge}
        aria-hidden={!isDragging}
        title={disabled ? undefined : hint}
        onDragOver={handleZoneDragOver(edge)}
        onDrop={handleZoneDrop(edge)}
      >
        <span className="pane-drop-label">{label}</span>
      </div>
    );
  };

  return (
    <div className="canvas-tab-group" role="region" aria-label="Pane group">
      <div
        className={`canvas-tab-strip${isStripTarget ? " drop-target" : ""}`}
        role="tablist"
        ref={stripRef}
        onDragOver={handleStripDragOver}
        onDragLeave={handleStripDragLeave}
        onDrop={handleStripDrop}
      >
        <div className="canvas-tab-items">
          {visibleTabs.map((tab, i) => {
            const originalIndex = group.tabs.findIndex((t) => t.id === tab.id);
            return (
              <React.Fragment key={tab.id}>
                {i === dropIndex && <div className="tab-drop-indicator" aria-hidden="true" />}
                {renderTab(tab, originalIndex)}
              </React.Fragment>
            );
          })}
          {dropIndex === visibleTabs.length && (
            <div className="tab-drop-indicator" aria-hidden="true" />
          )}
        </div>

        {activeTab && !isDragging && (
          <div className="canvas-tab-actions">
            <button
              type="button"
              className="canvas-action-btn"
              title="Split Right (Ctrl+Alt+R)"
              aria-label="Split Right"
              onClick={() => onSplitRight(group.id, activeTab)}
            >
              ◫
            </button>
            <button
              type="button"
              className="canvas-action-btn"
              title="Split Down (Ctrl+Alt+D)"
              aria-label="Split Down"
              onClick={() => onSplitDown(group.id, activeTab)}
            >
              ⬒
            </button>
          </div>
        )}
      </div>

      <div className="canvas-pane-body" role="tabpanel">
        {activeTab ? (
          renderTabContent(activeTab)
        ) : (
          <div className="empty-pane-placeholder">No active view</div>
        )}
        {isDragging && (
          <div className={`pane-drop-overlay${paneDrop?.groupId === group.id ? " has-target" : ""}`}>
            {renderZone("top", "▲", "Drop to split above")}
            {renderZone("left", "◀", "Drop to split left")}
            {renderZone("center", "＋", "Drop to move tab here")}
            {renderZone("right", "▶", "Drop to split right")}
            {renderZone("bottom", "▼", "Drop to split below")}
          </div>
        )}
      </div>
    </div>
  );
}
