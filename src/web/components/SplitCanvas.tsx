import React, { useCallback, useRef, useState } from "react";
import type { LayoutNode, PaneTab, SplitNode, TabGroupNode, WorkspaceLayout } from "../../shared/domain/layout.ts";
import {
  addTabToGroup,
  createDefaultLayout,
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
  onCloseTab?: (tabId: string) => void;
  workspaceId: string;
}

export function SplitCanvas({
  layout,
  onLayoutChange,
  renderTabContent,
  onActivateTab,
  onCloseTab,
  workspaceId,
}: SplitCanvasProps) {
  const [contextMenu, setContextMenu] = useState<{
    x: number;
    y: number;
    tabId: string;
    groupId: string;
  } | null>(null);

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
      onCloseTab?.(tabId);
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

  const handleSplitRight = useCallback(
    (groupId: string, tab: PaneTab) => {
      const nextRoot = splitTabGroup(layout.root, groupId, "horizontal", tab, "after");
      onLayoutChange({ ...layout, root: nextRoot });
      setContextMenu(null);
    },
    [layout, onLayoutChange]
  );

  const handleSplitDown = useCallback(
    (groupId: string, tab: PaneTab) => {
      const nextRoot = splitTabGroup(layout.root, groupId, "vertical", tab, "after");
      onLayoutChange({ ...layout, root: nextRoot });
      setContextMenu(null);
    },
    [layout, onLayoutChange]
  );

  const handleResetLayout = useCallback(() => {
    onLayoutChange(createDefaultLayout(workspaceId));
    setContextMenu(null);
  }, [onLayoutChange, workspaceId]);

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
        onSplitRight={handleSplitRight}
        onSplitDown={handleSplitDown}
        onOpenContextMenu={(x, y, tabId, groupId) => setContextMenu({ x, y, tabId, groupId })}
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
          <button
            type="button"
            role="menuitem"
            onClick={() => handleCloseTab(contextMenu.tabId)}
          >
            ✕ Close Tab (Ctrl+Alt+W)
          </button>
          <div className="menu-divider" />
          <button type="button" role="menuitem" onClick={handleResetLayout}>
            ↺ Reset Canvas Layout
          </button>
        </div>
      )}
    </div>
  );
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

interface NodeRendererProps {
  node: LayoutNode;
  layout: WorkspaceLayout;
  onLayoutChange: (layout: WorkspaceLayout) => void;
  renderTabContent: (tab: PaneTab) => React.ReactNode;
  onActivateTab?: (tab: PaneTab) => void;
  onSelectTab: (groupId: string, tabId: string) => void;
  onCloseTab: (tabId: string) => void;
  onSplitRight: (groupId: string, tab: PaneTab) => void;
  onSplitDown: (groupId: string, tab: PaneTab) => void;
  onOpenContextMenu: (x: number, y: number, tabId: string, groupId: string) => void;
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
  onOpenContextMenu,
}: TabGroupRendererProps) {
  const activeTab =
    group.tabs.find((t) => t.id === group.activeTabId) ?? group.tabs[0];

  const getTabIcon = (kind: PaneTab["kind"]) => {
    switch (kind) {
      case "overview":
        return "ℹ";
      case "agent":
        return "◈";
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

  return (
    <div className="canvas-tab-group" role="region" aria-label="Pane group">
      <div className="canvas-tab-strip" role="tablist">
        <div className="canvas-tab-items">
          {group.tabs.map((tab) => {
            const isActive = tab.id === activeTab?.id;
            return (
              <div
                key={tab.id}
                role="tab"
                aria-selected={isActive}
                tabIndex={isActive ? 0 : -1}
                className={`canvas-tab ${isActive ? "active" : ""}`}
                onClick={() => onSelectTab(group.id, tab.id)}
                onContextMenu={(e) => {
                  e.preventDefault();
                  onOpenContextMenu(e.clientX, e.clientY, tab.id, group.id);
                }}
              >
                <span className="canvas-tab-icon">{getTabIcon(tab.kind)}</span>
                <span className="canvas-tab-title">{tab.title}</span>
                {group.tabs.length > 1 && (
                  <button
                    type="button"
                    className="canvas-tab-close"
                    title="Close tab"
                    aria-label={`Close ${tab.title}`}
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
          })}
        </div>

        {activeTab && (
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
      </div>
    </div>
  );
}
