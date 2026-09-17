import { useCallback, useEffect, useRef, useState } from "react";
import { Terminal as TerminalIcon } from "lucide-react";
import type { PaneTab } from "../../shared/domain/layout.ts";
import type { TerminalSummary } from "../../shared/domain/terminals.ts";
import type { Workspace } from "../../shared/domain/workspaces.ts";
import type { WorkspaceApi } from "../api.ts";
import { TerminalPanel } from "./TerminalPanel.tsx";
import { Button } from "./ui/button.tsx";
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "./ui/empty.tsx";
import { Spinner } from "./ui/spinner.tsx";

export interface TerminalTabPaneProps {
  tab: PaneTab;
  workspace: Workspace;
  terminals: TerminalSummary[];
  terminalsLoaded: boolean;
  api: WorkspaceApi;
  onClose: () => void;
  onTerminated: () => void;
  onTerminalAttached: (oldTabId: string, created: TerminalSummary) => void;
}

export function TerminalTabPane({
  tab,
  workspace,
  terminals,
  terminalsLoaded,
  api,
  onClose,
  onTerminated,
  onTerminalAttached,
}: TerminalTabPaneProps) {
  const currentTerm = tab.targetId
    ? terminals.find((t) => t.id === tab.targetId)
    : terminals[0];

  const [launching, setLaunching] = useState(false);
  const [launchError, setLaunchError] = useState<string | null>(null);
  const autoLaunchAttemptedRef = useRef(false);

  const triggerLaunch = useCallback(async () => {
    setLaunching(true);
    setLaunchError(null);
    try {
      const cleanTitle = tab.title ? tab.title.replace(/^>_\s*/, "").trim() : undefined;
      const created = await api.createTerminal(workspace.id, cleanTitle ? { title: cleanTitle } : undefined);
      onTerminalAttached(tab.id, created);
    } catch (err) {
      setLaunchError(err instanceof Error ? err.message : "Failed to launch terminal");
    } finally {
      setLaunching(false);
    }
  }, [api, onTerminalAttached, tab.id, tab.title, workspace.id]);

  useEffect(() => {
    if (!terminalsLoaded || currentTerm || workspace.archivedAt) return;
    if (autoLaunchAttemptedRef.current) return;
    autoLaunchAttemptedRef.current = true;
    void triggerLaunch();
  }, [terminalsLoaded, currentTerm, workspace.archivedAt, triggerLaunch]);

  if (currentTerm) {
    return (
      <TerminalPanel
        key={currentTerm.id}
        terminal={currentTerm}
        api={api}
        onClose={onClose}
        onTerminated={onTerminated}
      />
    );
  }

  if (!terminalsLoaded) {
    return (
      <Empty className="border-none p-6">
        <EmptyHeader>
          <EmptyMedia variant="icon">
            <Spinner className="size-5 text-muted-foreground" />
          </EmptyMedia>
          <EmptyTitle>Connecting to terminal…</EmptyTitle>
          <EmptyDescription>Loading workspace shell sessions.</EmptyDescription>
        </EmptyHeader>
      </Empty>
    );
  }

  if (workspace.archivedAt) {
    return (
      <Empty className="border-none p-6">
        <EmptyHeader>
          <EmptyMedia variant="icon">
            <TerminalIcon className="size-5 text-muted-foreground" />
          </EmptyMedia>
          <EmptyTitle>Terminal</EmptyTitle>
          <EmptyDescription>This workspace is archived. Reopen it to launch a terminal.</EmptyDescription>
        </EmptyHeader>
        <EmptyContent>
          <Button
            size="sm"
            onClick={async () => {
              await api.reopenWorkspace(workspace.id);
              onTerminated();
            }}
          >
            Reopen Workspace
          </Button>
        </EmptyContent>
      </Empty>
    );
  }

  if (launchError) {
    return (
      <Empty className="border-none p-6">
        <EmptyHeader>
          <EmptyMedia variant="icon">
            <TerminalIcon className="size-5 text-muted-foreground" />
          </EmptyMedia>
          <EmptyTitle>Terminal unavailable</EmptyTitle>
          <EmptyDescription>{launchError}</EmptyDescription>
        </EmptyHeader>
        <EmptyContent>
          <Button size="sm" onClick={() => void triggerLaunch()}>
            Launch terminal
          </Button>
        </EmptyContent>
      </Empty>
    );
  }

  return (
    <Empty className="border-none p-6">
      <EmptyHeader>
        <EmptyMedia variant="icon">
          <Spinner className="size-5 text-muted-foreground" />
        </EmptyMedia>
        <EmptyTitle>Starting terminal…</EmptyTitle>
        <EmptyDescription>Launching a new shell session for this workspace.</EmptyDescription>
      </EmptyHeader>
    </Empty>
  );
}
