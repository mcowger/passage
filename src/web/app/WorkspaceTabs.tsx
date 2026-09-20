import type { ReactNode } from "react";
import type { AgentHistory, AgentSummary } from "../../shared/domain/agents.ts";
import type { TerminalSummary } from "../../shared/domain/terminals.ts";
import type { WebPreview } from "../../shared/domain/previews.ts";
import type { PaneTab } from "../../shared/domain/layout.ts";
import type { Workspace, Project } from "../../shared/domain/workspaces.ts";
import type { WorkspaceLayout } from "../../shared/domain/layout.ts";
import type { WorkspaceSettings } from "../../shared/domain/settings.ts";
import type { WorkspaceApi } from "../api.ts";
import type { FormKind } from "./appHelpers.tsx";
import type { TabKind } from "./appHelpers.tsx";
import { AGENT_STATUS_LABEL, getAgentStatusKind } from "../components/agentStatus.ts";
import { NonGitPane } from "./appHelpers.tsx";
import { resolveFontFamilies } from "../../shared/domain/customization.ts";
import type { FontOption } from "../../shared/domain/customization.ts";
import { updateTabInTree } from "../../shared/domain/layout.ts";
import { AgentSessionPanel } from "../components/AgentSessionPanel.tsx";
import { WorkspaceOverview } from "../components/WorkspaceOverview.tsx";
import { TerminalTabPane } from "../components/TerminalTabPane.tsx";
import { ExplorerPanel } from "../components/ExplorerPanel.tsx";
import { ChangesPanel } from "../components/ChangesPanel.tsx";
import { EditorPanel } from "../components/EditorPanel.tsx";
import { DiffPanel } from "../components/DiffPanel.tsx";
import { PreviewPanel } from "../components/PreviewPanel.tsx";
import { Button } from "../components/ui/button.tsx";
import { Alert, AlertDescription } from "../components/ui/alert.tsx";
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "../components/ui/empty.tsx";
import { FileCode, Globe } from "lucide-react";

export type WorkspaceTabContentProps = {
  tab: PaneTab;
  workspace: Workspace | undefined;
  project: Project | undefined;
  agents: AgentSummary[];
  terminals: TerminalSummary[];
  terminalsLoaded: boolean;
  previews: WebPreview[];
  settings: WorkspaceSettings;
  fontOptions: FontOption[];
  api: WorkspaceApi;
  layout: WorkspaceLayout | undefined;
  agentError: string;
  autoAgentPending: boolean;
  isGitWorkspace: boolean;
  selectedAgentId: string | undefined;
  selectedTerminalId: string | undefined;
  selectedPreviewId: string | undefined;
  openEditorPath: string | undefined;
  openDiffPath: string | undefined;
  dirtyEditors: Record<string, string>;
  previewHistory: AgentHistory | null;
  openPaneTab: (tab: PaneTab) => void;
  openEditorFile: (path: string) => void;
  openDiffFile: (path: string) => void;
  handleExplorerRenamed: (oldPath: string, newPath: string) => void;
  handleExplorerDeleted: (path: string) => void;
  handleEditorDirtyChange: (tabId: string, path: string, isDirty: boolean, save: () => Promise<boolean>) => void;
  closeTabNow: (tabId: string) => void;
  handleWorkspaceRemoved: () => void | Promise<void>;
  handleLayoutChange: (layout: WorkspaceLayout) => void;
  handleSelectAgent: (id: string) => void;
  handleTerminalAttached: (oldTabId: string, created: TerminalSummary) => void;
  loadTerminals: (workspaceId: string, selectFirst?: boolean) => Promise<void>;
  refreshWorkspaces: () => Promise<boolean>;
  createAgent: () => Promise<void>;
  createTerminal: (options?: { forceNew?: boolean }) => Promise<void>;
  createPreview: () => Promise<void>;
  reopenAgent: (agentId: string) => Promise<AgentSummary>;
  setAgents: React.Dispatch<React.SetStateAction<AgentSummary[]>>;
  setAgentError: React.Dispatch<React.SetStateAction<string>>;
  setActiveTab: React.Dispatch<React.SetStateAction<TabKind>>;
  setForm: React.Dispatch<React.SetStateAction<FormKind | undefined>>;
  setFormError: React.Dispatch<React.SetStateAction<string>>;
  setPendingDirtyClose: React.Dispatch<React.SetStateAction<{ tabId: string; path: string } | null>>;
  setPreviews: React.Dispatch<React.SetStateAction<WebPreview[]>>;
  captureMobileReturn: () => void;
};

/** Renders one canvas tab for SplitCanvas and single-pane mobile mode. */
export function WorkspaceTabContent(props: WorkspaceTabContentProps): ReactNode {
  const {
    tab,
    workspace,
    project,
    agents,
    terminals,
    terminalsLoaded,
    previews,
    settings,
    fontOptions,
    api,
    layout,
    agentError,
    autoAgentPending,
    isGitWorkspace,
    selectedAgentId,
    selectedTerminalId,
    selectedPreviewId,
    openEditorPath,
    openDiffPath,
    dirtyEditors,
    previewHistory,
    openPaneTab,
    openEditorFile,
    openDiffFile,
    handleExplorerRenamed,
    handleExplorerDeleted,
    handleEditorDirtyChange,
    closeTabNow,
    handleWorkspaceRemoved,
    handleLayoutChange,
    handleSelectAgent,
    handleTerminalAttached,
    loadTerminals,
    refreshWorkspaces,
    createAgent,
    createTerminal,
    createPreview,
    reopenAgent,
    setAgents,
    setAgentError,
    setActiveTab,
    setForm,
    setFormError,
    setPendingDirtyClose,
    setPreviews,
    captureMobileReturn,
  } = props;
    if (!workspace || !project) {
      return (
        <div className="empty flex flex-1 flex-col items-center justify-center p-8 text-center max-w-md mx-auto">
          <span className="empty-icon text-3xl mb-2" aria-hidden="true">⌂</span>
          <h1 className="text-lg font-semibold text-foreground mb-1">Select a workspace</h1>
          <p className="text-xs text-muted-foreground mb-4">Choose a workspace from navigation or register a project to begin.</p>
          <Button size="xs" onClick={() => { setFormError(""); setForm("project"); }}>+ Add Project</Button>
        </div>
      );
    }

    switch (tab.kind) {
      case "overview":
      case "agent": {
        const agentId = tab.targetId;
        const currentAgent = agentId ? agents.find((a) => a.id === agentId) : undefined;
        const previewEnabled = typeof window !== "undefined"
          && new URLSearchParams(window.location.search).get("transcriptPreview") === "1";
        return currentAgent ? (
          <AgentSessionPanel
            key={currentAgent.id}
            agent={currentAgent}
            api={api}
            settings={settings}
            workspaceRoot={workspace.cwd}
            onAgentChanged={(updatedAgent) => {
              const previous = agents.find((agent) => agent.id === updatedAgent.id);
              setAgents((current) => current.map((agent) => agent.id === updatedAgent.id ? updatedAgent : agent));
              // Auto-titles (and any later rename) arrive over the agent
              // socket; keep the open pane tab label in sync so it stops
              // reading "Agent" too. Guarded to the title change so
              // ordinary status traffic never rewrites the layout.
              if (previous && previous.title !== updatedAgent.title && layout) {
                const tabId = `agent-${updatedAgent.id}`;
                handleLayoutChange({
                  ...layout,
                  root: updateTabInTree(layout.root, tabId, { id: tabId, kind: "agent", title: updatedAgent.title, targetId: updatedAgent.id }),
                });
              }
            }}
            previewHistory={previewEnabled ? previewHistory ?? undefined : undefined}
            onWorkspaceDeleted={handleWorkspaceRemoved}
          />
        ) : tab.kind === "overview" ? (
          <WorkspaceOverview
            workspace={workspace}
            project={project}
            agents={agents}
            terminals={terminals}
            previews={previews}
            isGitWorkspace={isGitWorkspace}
            agentError={agentError}
            autoStartingAgent={autoAgentPending}
            onNewAgent={() => void createAgent()}
            onOpenAgent={handleSelectAgent}
            onListArchivedAgents={() => (workspace ? api.listArchivedAgents(workspace.id) : Promise.resolve([]))}
            onReopenAgent={reopenAgent}
            onNewTerminal={() => void createTerminal()}
            onOpenFiles={() => {
              captureMobileReturn();
              setActiveTab("explorer");
              openPaneTab({ id: `explorer-${workspace.id}`, kind: "explorer", title: "Files" });
            }}
            onOpenChanges={() => {
              captureMobileReturn();
              setActiveTab("changes");
              openPaneTab({ id: `changes-${workspace.id}`, kind: "changes", title: "Changes" });
            }}
            onNewPreview={() => void createPreview()}
          />
        ) : (
          <div className="empty flex flex-col items-center justify-center p-8 text-center max-w-md mx-auto">
            <span className="empty-icon text-3xl mb-2 text-primary" aria-hidden="true">◈</span>
            <h1 className="text-lg font-semibold text-foreground mb-1">Pi Agent</h1>
            <p className="text-xs text-muted-foreground mb-4">
              Autonomous coding agent attached to this workspace.
            </p>
            {agentError && (
              <Alert variant="destructive" className="mb-4 w-full text-left">
                <AlertDescription className="text-xs">{agentError}</AlertDescription>
              </Alert>
            )}
            {workspace.archivedAt ? (
              <div className="flex flex-col items-center gap-2">
                <span className="text-xs text-amber-600 bg-amber-500/10 px-2 py-1 rounded">
                  This workspace is archived.
                </span>
                <Button
                  size="xs"
                  onClick={async () => {
                    setAgentError("");
                    await api.reopenWorkspace(workspace.id);
                    await refreshWorkspaces();
                  }}
                >
                  Reopen Workspace
                </Button>
              </div>
            ) : (
              <Button size="xs" onClick={() => void createAgent()}>
                + Start Agent Session
              </Button>
            )}
          </div>
        );
      }

      case "terminal": {
        const terminalFamilies = resolveFontFamilies(fontOptions, settings.fonts);
        return (
          <TerminalTabPane
            key={tab.id}
            tab={tab}
            workspace={workspace}
            terminals={terminals}
            terminalsLoaded={terminalsLoaded}
            api={api}
            terminalFontFamily={terminalFamilies.xterm}
            terminalFontSize={settings.terminalFontSize}
            onClose={() => {
              closeTabNow(tab.id);
              setActiveTab("overview");
            }}
            onTerminated={() => {
              void loadTerminals(workspace.id);
            }}
            onTerminalAttached={handleTerminalAttached}
          />
        );
      }

      case "explorer":
        return (
          <ExplorerPanel
            workspaceId={workspace.id}
            api={api}
            selectedFile={openEditorPath}
            onOpenFile={openEditorFile}
            workspaceCwd={workspace.cwd}
            onRenamed={handleExplorerRenamed}
            onDeleted={handleExplorerDeleted}
          />
        );

      case "changes": {
        if (!isGitWorkspace) return <NonGitPane title="Changes" />;
        const selectedAgent = agents.find((a) => a.id === selectedAgentId) ?? agents[0];
        const settled = !selectedAgent || (selectedAgent.status !== "running" && selectedAgent.status !== "stopping" && selectedAgent.status !== "initializing");
        return (
          <ChangesPanel
            workspaceId={workspace.id}
            api={api}
            onOpenFile={openEditorFile}
            onOpenDiff={openDiffFile}
            onWorkspaceDeleted={handleWorkspaceRemoved}
            agentSettled={settled}
            agentStatusLabel={selectedAgent ? AGENT_STATUS_LABEL[getAgentStatusKind(selectedAgent)] : undefined}
            suggestModel={settings.suggestModel}
            suggestThinkingLevel={settings.suggestThinkingLevel}
            commitPrompt={settings.commitPrompt}
            selectedAgentId={selectedAgent?.id}
          />
        );
      }

      case "editor": {
        const filePath = tab.targetId ?? openEditorPath;
        const openFileDiff = isGitWorkspace ? openDiffFile : undefined;
        return filePath ? (
          <EditorPanel
            workspaceId={workspace.id}
            filePath={filePath}
            api={api}
            tabId={`editor-${filePath}`}
            onDirtyChange={handleEditorDirtyChange}
            onClose={() => {
              const tid = `editor-${filePath}`;
              const dirtyPath = dirtyEditors[tid];
              if (dirtyPath !== undefined) {
                setPendingDirtyClose({ tabId: tid, path: dirtyPath });
                return;
              }
              closeTabNow(tid);
              setActiveTab("explorer");
            }}
            onOpenDiff={openFileDiff}
          />
        ) : (
          <Empty className="border-none p-6">
            <EmptyHeader>
              <EmptyMedia variant="icon">
                <FileCode className="size-5 text-muted-foreground" />
              </EmptyMedia>
              <EmptyTitle>No file selected</EmptyTitle>
              <EmptyDescription>Choose a file from the explorer to view or edit.</EmptyDescription>
            </EmptyHeader>
          </Empty>
        );
      }

      case "diff": {
        if (!isGitWorkspace) return <NonGitPane title="Diff" />;
        const diffPath = tab.targetId ?? openDiffPath;
        return (
          <DiffPanel
            workspaceId={workspace.id}
            initialPath={diffPath}
            api={api}
            onOpenFile={openEditorFile}
            onClose={() => {
              closeTabNow(`diff-${diffPath}`);
              setActiveTab("changes");
            }}
          />
        );
      }

      case "preview": {
        const previewId = tab.targetId ?? selectedPreviewId;
        const currentPreview = previews.find((p) => p.id === previewId) ?? previews[0];
        return currentPreview ? (
          <PreviewPanel
            key={currentPreview.id}
            preview={currentPreview}
            api={api}
            onPreviewChanged={(updated) => {
              setPreviews((current) => current.map((p) => (p.id === updated.id ? updated : p)));
            }}
            onClose={() => {
              // Closing the pane stops and removes the preview.
              closeTabNow(`preview-${currentPreview.id}`);
              setActiveTab("overview");
            }}
          />
        ) : (
          <Empty className="border-none p-6">
            <EmptyHeader>
              <EmptyMedia variant="icon">
                <Globe className="size-5 text-muted-foreground" />
              </EmptyMedia>
              <EmptyTitle>No web preview</EmptyTitle>
              <EmptyDescription>Start a live web preview for this workspace.</EmptyDescription>
            </EmptyHeader>
            <EmptyContent>
              <Button size="sm" onClick={() => void createPreview()}>
                Start web preview
              </Button>
            </EmptyContent>
          </Empty>
        );
      }

      default:
        return (
          <Empty className="border-none p-6">
            <EmptyHeader>
              <EmptyTitle>Unknown view</EmptyTitle>
            </EmptyHeader>
          </Empty>
        );
    }
}

