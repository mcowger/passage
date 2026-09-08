import React, { useEffect, useMemo, useRef, useState } from "react";
import type { WorkspaceSnapshot } from "../../shared/domain/workspaces.ts";
import type { AgentSummary } from "../../shared/domain/agents.ts";
import type { TerminalSummary } from "../../shared/domain/terminals.ts";

export interface CommandItem {
  id: string;
  category: "Navigation" | "Actions" | "Views" | "Theme";
  title: string;
  subtitle?: string;
  icon: string;
  shortcut?: string;
  run: () => void;
}

export interface CommandPaletteProps {
  open: boolean;
  onClose: () => void;
  snapshot: WorkspaceSnapshot;
  selectedWorkspaceId?: string;
  agents: AgentSummary[];
  terminals: TerminalSummary[];
  onSelectWorkspace: (id: string) => void;
  onSelectAgent: (id: string) => void;
  onSelectTerminal: (id: string) => void;
  onOpenView: (view: "agent" | "terminal" | "explorer" | "changes" | "diff") => void;
  onCreateAgent: () => void;
  onCreateTerminal: () => void;
  onResetLayout: () => void;
  onOpenSettings: () => void;
}

export function CommandPalette({
  open,
  onClose,
  snapshot,
  selectedWorkspaceId,
  agents,
  terminals,
  onSelectWorkspace,
  onSelectAgent,
  onSelectTerminal,
  onOpenView,
  onCreateAgent,
  onCreateTerminal,
  onResetLayout,
  onOpenSettings,
}: CommandPaletteProps) {
  const [query, setQuery] = useState("");
  const [selectedIndex, setSelectedIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (open) {
      setQuery("");
      setSelectedIndex(0);
      setTimeout(() => inputRef.current?.focus(), 20);
    }
  }, [open]);

  const items = useMemo<CommandItem[]>(() => {
    const list: CommandItem[] = [
      {
        id: "view-agent",
        category: "Views",
        title: "Agent Session",
        icon: "◈",
        shortcut: "Alt+1",
        run: () => onOpenView("agent"),
      },
      {
        id: "view-explorer",
        category: "Views",
        title: "File Explorer",
        icon: "📁",
        shortcut: "Alt+2",
        run: () => onOpenView("explorer"),
      },
      {
        id: "view-changes",
        category: "Views",
        title: "Git Changes",
        icon: "±",
        shortcut: "Alt+3",
        run: () => onOpenView("changes"),
      },
      {
        id: "view-diff",
        category: "Views",
        title: "Diff Viewer",
        icon: "🔍",
        shortcut: "Alt+4",
        run: () => onOpenView("diff"),
      },
      {
        id: "action-new-agent",
        category: "Actions",
        title: "New Agent",
        subtitle: "Start an agent conversation in current workspace",
        icon: "◈",
        run: onCreateAgent,
      },
      {
        id: "action-new-terminal",
        category: "Actions",
        title: "New Terminal",
        subtitle: "Open a persistent PTY shell in current workspace",
        icon: ">_",
        run: onCreateTerminal,
      },
      {
        id: "action-reset-layout",
        category: "Actions",
        title: "Reset Canvas Layout",
        subtitle: "Restore default single-pane layout",
        icon: "↺",
        run: onResetLayout,
      },
      {
        id: "action-open-settings",
        category: "Actions",
        title: "Settings & Customization",
        subtitle: "Change theme, fonts, activity detail, and notifications",
        icon: "⚙",
        run: onOpenSettings,
      },
    ];

    // Add agents for active workspace
    for (const agent of agents) {
      list.push({
        id: `agent-${agent.id}`,
        category: "Navigation",
        title: agent.title,
        subtitle: `Agent · ${agent.status}`,
        icon: "◈",
        run: () => onSelectAgent(agent.id),
      });
    }

    // Add terminals for active workspace
    for (const term of terminals) {
      list.push({
        id: `terminal-${term.id}`,
        category: "Navigation",
        title: term.title,
        subtitle: `Terminal · ${term.status}`,
        icon: ">_",
        run: () => onSelectTerminal(term.id),
      });
    }

    // Add workspaces
    for (const ws of snapshot.workspaces) {
      if (!ws.archivedAt) {
        list.push({
          id: `ws-${ws.id}`,
          category: "Navigation",
          title: ws.displayLabel,
          subtitle: `${ws.kind} · ${ws.branchRef ?? ws.cwd}`,
          icon: "⌂",
          run: () => onSelectWorkspace(ws.id),
        });
      }
    }

    return list;
  }, [
    snapshot.workspaces,
    agents,
    terminals,
    onOpenView,
    onCreateAgent,
    onCreateTerminal,
    onResetLayout,
    onOpenSettings,
    onSelectAgent,
    onSelectTerminal,
    onSelectWorkspace,
  ]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return items;
    return items.filter(
      (item) =>
        item.title.toLowerCase().includes(q) ||
        item.subtitle?.toLowerCase().includes(q) ||
        item.category.toLowerCase().includes(q)
    );
  }, [items, query]);

  useEffect(() => {
    setSelectedIndex(0);
  }, [query]);

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setSelectedIndex((idx) => (idx + 1) % Math.max(1, filtered.length));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setSelectedIndex((idx) => (idx - 1 + filtered.length) % Math.max(1, filtered.length));
    } else if (e.key === "Enter") {
      e.preventDefault();
      if (filtered[selectedIndex]) {
        filtered[selectedIndex].run();
        onClose();
      }
    } else if (e.key === "Escape") {
      e.preventDefault();
      onClose();
    }
  };

  if (!open) return null;

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div
        className="command-palette-modal"
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-label="Command Palette"
      >
        <div className="palette-search-box">
          <span className="palette-search-icon" aria-hidden="true">🔍</span>
          <input
            ref={inputRef}
            type="text"
            className="palette-input"
            placeholder="Type a command, search views, agents, workspaces... (Esc to close)"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={handleKeyDown}
          />
        </div>

        <div className="palette-results" role="listbox">
          {filtered.length === 0 ? (
            <div className="palette-empty">No matching commands or destinations</div>
          ) : (
            filtered.map((item, idx) => {
              const isSelected = idx === selectedIndex;
              return (
                <div
                  key={item.id}
                  role="option"
                  aria-selected={isSelected}
                  className={`palette-item ${isSelected ? "selected" : ""}`}
                  onClick={() => {
                    item.run();
                    onClose();
                  }}
                  onMouseEnter={() => setSelectedIndex(idx)}
                >
                  <span className="palette-item-icon">{item.icon}</span>
                  <div className="palette-item-text">
                    <span className="palette-item-title">{item.title}</span>
                    {item.subtitle && <span className="palette-item-subtitle">{item.subtitle}</span>}
                  </div>
                  <span className="palette-item-category">{item.category}</span>
                  {item.shortcut && <kbd className="palette-item-kbd">{item.shortcut}</kbd>}
                </div>
              );
            })
          )}
        </div>
      </div>
    </div>
  );
}
