import { useEffect, useMemo, useState } from "react";
import type { WorkspaceSnapshot } from "../../shared/domain/workspaces.ts";
import type { AgentSummary } from "../../shared/domain/agents.ts";
import type { TerminalSummary } from "../../shared/domain/terminals.ts";
import {
  CommandDialog,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem as CommandRow,
  CommandList,
  CommandSeparator,
  CommandShortcut,
} from "./ui/command.tsx";

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
  onDiscoverWorktrees?: () => void;
}

const CATEGORY_ORDER: CommandItem["category"][] = ["Views", "Actions", "Navigation", "Theme"];

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
  onDiscoverWorktrees,
}: CommandPaletteProps) {
  const [query, setQuery] = useState("");

  useEffect(() => {
    if (open) setQuery("");
  }, [open ]);

  // `selectedWorkspaceId` is accepted for API compatibility; cmdk filtering
  // does not need it, but keep it referenced so intent stays explicit.
  void selectedWorkspaceId;

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
      ...(onDiscoverWorktrees ? [{
        id: "action-discover-worktrees",
        category: "Actions" as const,
        title: "Discover & Import Git Worktrees",
        subtitle: "Scan repository for existing worktrees and register as workspaces",
        icon: "📂",
        run: onDiscoverWorktrees,
      }] : []),
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

  const grouped = useMemo(() => {
    return CATEGORY_ORDER.map((category) => ({
      category,
      rows: items.filter((item) => item.category === category),
    })).filter((group) => group.rows.length > 0);
  }, [items]);

  const runItem = (item: CommandItem) => {
    item.run();
    onClose();
  };

  return (
    <CommandDialog
      open={open}
      onOpenChange={(isOpen) => { if (!isOpen) onClose(); }}
      title="Command Palette"
      description="Type a command, search views, agents, workspaces..."
    >
      <CommandInput
        placeholder="Type a command, search views, agents, workspaces... (Esc to close)"
        value={query}
        onValueChange={setQuery}
      />
      <CommandList>
        <CommandEmpty>No matching commands or destinations</CommandEmpty>
        {grouped.map((group, groupIndex) => (
          <div key={group.category}>
            {groupIndex > 0 && <CommandSeparator />}
            <CommandGroup heading={group.category}>
              {group.rows.map((item) => (
                <CommandRow
                  key={item.id}
                  value={`${item.title} ${item.subtitle ?? ""} ${item.category}`}
                  onSelect={() => runItem(item)}
                >
                  <span className="palette-item-icon" aria-hidden="true">{item.icon}</span>
                  <div className="palette-item-text">
                    <span className="palette-item-title">{item.title}</span>
                    {item.subtitle && <span className="palette-item-subtitle">{item.subtitle}</span>}
                  </div>
                  {item.shortcut && <CommandShortcut>{item.shortcut}</CommandShortcut>}
                </CommandRow>
              ))}
            </CommandGroup>
          </div>
        ))}
      </CommandList>
    </CommandDialog>
  );
}
