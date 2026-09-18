import type { AgentSummary } from "../../shared/domain/agents.ts";
import type { TerminalSummary } from "../../shared/domain/terminals.ts";
import type { WebPreview } from "../../shared/domain/previews.ts";
import type { ConnectionHealth } from "../socketLifecycle.ts";
import { AGENT_STATUS_LABEL, getAgentStatusKind } from "./agentStatus.ts";
import { WsHealthIndicator } from "./WsHealthIndicator.tsx";
import { Dialog, DialogContent, DialogTitle } from "./ui/dialog.tsx";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "./ui/dropdown-menu.tsx";
import { ArrowLeft, ChevronDown, Menu, MoreHorizontal, Plus } from "lucide-react";

export type MobileDestinationKind =
  | "overview"
  | "agent"
  | "terminal"
  | "explorer"
  | "changes"
  | "editor"
  | "diff"
  | "preview";

export interface MobileDestination {
  kind: MobileDestinationKind;
  targetId?: string;
}

export interface MobileReturn extends MobileDestination {
  label: string;
}

const DEST_GLYPH: Record<MobileDestinationKind, string> = {
  overview: "⌂",
  agent: "◈",
  terminal: ">_",
  explorer: "📁",
  changes: "±",
  editor: "📄",
  diff: "±",
  preview: "◉",
};

export function mobileDestGlyph(kind: MobileDestinationKind): string {
  return DEST_GLYPH[kind];
}

function statusDotClass(kind: "idle" | "active" | "attention"): string {
  return `status-dot shrink-0 ${kind}`;
}

interface MobileContextBarProps {
  workspaceLabel: string;
  destKind: MobileDestinationKind;
  destTitle: string;
  destMeta?: string;
  returnLabel: string | null;
  wsHealth?: ConnectionHealth;
  onOpenDrawer: () => void;
  onOpenSwitcher: () => void;
  onBack: () => void;
  onNewAgent: () => void;
  onNewTerminal: () => void;
  onNewPreview: () => void;
  onOpenCommands: () => void;
  onOpenSettings: () => void;
  onOpenWorkspaceDetails: () => void;
}

export function MobileContextBar(props: MobileContextBarProps) {
  const {
    workspaceLabel,
    destKind,
    destTitle,
    destMeta,
    returnLabel,
    wsHealth,
    onOpenDrawer,
    onOpenSwitcher,
    onBack,
    onNewAgent,
    onNewTerminal,
    onNewPreview,
    onOpenCommands,
    onOpenSettings,
    onOpenWorkspaceDetails,
  } = props;
  return (
    <div className="mobile-context-wrap">
      <nav className="mobile-context-bar" aria-label="Workspace">
        <button
          type="button"
          className="mobile-context-icon-btn"
          onClick={onOpenDrawer}
          aria-label="Open navigation"
        >
          <Menu className="size-5" aria-hidden="true" />
        </button>
        <button
          type="button"
          className="mobile-context-title"
          onClick={onOpenSwitcher}
          aria-label={`Current view: ${destTitle}. Open session switcher.`}
          title={`${workspaceLabel} — ${destTitle}`}
        >
          <span className="mobile-context-workspace">{workspaceLabel}</span>
          <span className="mobile-context-dest">
            <span aria-hidden="true">{mobileDestGlyph(destKind)}</span>
            <span className="mobile-context-dest-text">{destTitle}</span>
            {destMeta && <span className="mobile-context-dest-meta">· {destMeta}</span>}
            <ChevronDown className="size-3.5 shrink-0 opacity-60" aria-hidden="true" />
          </span>
        </button>
        <WsHealthIndicator health={wsHealth} className="mobile-context-health" />
        <DropdownMenu>
          <DropdownMenuTrigger
            className="mobile-context-icon-btn"
            aria-label="Workspace actions"
          >
            <MoreHorizontal className="size-5" aria-hidden="true" />
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="min-w-56">
            <DropdownMenuItem onSelect={onNewAgent}>+ New agent session</DropdownMenuItem>
            <DropdownMenuItem onSelect={onNewTerminal}>+ New terminal</DropdownMenuItem>
            <DropdownMenuItem onSelect={onNewPreview}>+ New web preview</DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem onSelect={onOpenCommands}>🔍 Command palette</DropdownMenuItem>
            <DropdownMenuItem onSelect={onOpenSettings}>⚙ Settings</DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem onSelect={onOpenWorkspaceDetails}>
              Workspace details
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </nav>
      {returnLabel && (
        <button
          type="button"
          className="mobile-back-bar"
          onClick={onBack}
          aria-label={`Back to ${returnLabel}`}
        >
          <ArrowLeft className="size-4 shrink-0" aria-hidden="true" />
          <span className="mobile-back-text">Back to {returnLabel}</span>
        </button>
      )}
    </div>
  );
}

interface MobileSessionSheetProps {
  open: boolean;
  onClose: () => void;
  agents: AgentSummary[];
  terminals: TerminalSummary[];
  previews: WebPreview[];
  showChanges: boolean;
  currentKind: MobileDestinationKind;
  currentTargetId?: string;
  selectedAgentId?: string;
  selectedTerminalId?: string;
  selectedPreviewId?: string;
  onSelectAgent: (id: string) => void;
  onSelectTerminal: (id: string) => void;
  onSelectPreview: (id: string) => void;
  onOpenFiles: () => void;
  onOpenChanges: () => void;
  onNewAgent: () => void;
  onNewTerminal: () => void;
}

function SectionLabel({ children }: { children: string }) {
  return <div className="mobile-sheet-section">{children}</div>;
}

export function MobileSessionSheet(props: MobileSessionSheetProps) {
  const {
    open,
    onClose,
    agents,
    terminals,
    previews,
    showChanges,
    currentKind,
    currentTargetId,
    selectedAgentId,
    selectedTerminalId,
    selectedPreviewId,
    onSelectAgent,
    onSelectTerminal,
    onSelectPreview,
    onOpenFiles,
    onOpenChanges,
    onNewAgent,
    onNewTerminal,
  } = props;

  const pick = (fn: () => void) => () => {
    fn();
    onClose();
  };

  const isAgentCurrent = (id: string) =>
    currentKind === "agent" && (currentTargetId ?? selectedAgentId) === id;
  const isTerminalCurrent = (id: string) =>
    currentKind === "terminal" && (currentTargetId ?? selectedTerminalId) === id;
  const isPreviewCurrent = (id: string) =>
    currentKind === "preview" && (currentTargetId ?? selectedPreviewId) === id;

  return (
    <Dialog open={open} onOpenChange={(isOpen) => { if (!isOpen) onClose(); }}>
      <DialogContent
        showCloseButton={false}
        aria-describedby={undefined}
        className="mobile-sheet-content top-auto right-0 bottom-0 left-0 max-h-[80dvh] w-full max-w-none translate-x-0 translate-y-0 gap-0 rounded-t-xl rounded-b-none p-0"
      >
        <DialogTitle className="sr-only">Sessions and views</DialogTitle>
        <div className="mobile-sheet-list" role="list">
          <SectionLabel>{`Agents (${agents.length})`}</SectionLabel>
          {agents.length === 0 && (
            <div className="mobile-sheet-empty">No agent sessions yet.</div>
          )}
          {agents.map((agent) => {
            const kind = getAgentStatusKind(agent);
            const current = isAgentCurrent(agent.id);
            return (
              <button
                key={agent.id}
                type="button"
                role="listitem"
                className={`mobile-sheet-row${current ? " current" : ""}`}
                aria-current={current || undefined}
                aria-label={`Go to agent ${agent.title}, ${AGENT_STATUS_LABEL[kind]}`}
                onClick={pick(() => onSelectAgent(agent.id))}
              >
                <span className={statusDotClass(kind)} aria-hidden="true" />
                <span className="mobile-sheet-row-main">
                  <span className="mobile-sheet-row-title">◈ {agent.title}</span>
                  <span className="mobile-sheet-row-meta">
                    {AGENT_STATUS_LABEL[kind]}
                    {agent.modelPreference ? ` · ${agent.modelPreference}` : ""}
                  </span>
                </span>
                {current && <span className="mobile-sheet-check" aria-hidden="true">✓</span>}
              </button>
            );
          })}

          <SectionLabel>{`Terminals (${terminals.length})`}</SectionLabel>
          {terminals.length === 0 && (
            <div className="mobile-sheet-empty">No terminals yet.</div>
          )}
          {terminals.map((terminal) => {
            const current = isTerminalCurrent(terminal.id);
            const meta = terminal.status === "running"
              ? "running"
              : `exited${terminal.exitCode != null ? ` (${terminal.exitCode})` : ""}`;
            return (
              <button
                key={terminal.id}
                type="button"
                role="listitem"
                className={`mobile-sheet-row${current ? " current" : ""}`}
                aria-current={current || undefined}
                aria-label={`Go to terminal ${terminal.title}, ${meta}`}
                onClick={pick(() => onSelectTerminal(terminal.id))}
              >
                <span className={statusDotClass(terminal.status === "running" ? "active" : "idle")} aria-hidden="true" />
                <span className="mobile-sheet-row-main">
                  <span className="mobile-sheet-row-title">&gt;_ {terminal.title}</span>
                  <span className="mobile-sheet-row-meta">{meta}</span>
                </span>
                {current && <span className="mobile-sheet-check" aria-hidden="true">✓</span>}
              </button>
            );
          })}

          {previews.length > 0 && (
            <>
              <SectionLabel>{`Previews (${previews.length})`}</SectionLabel>
              {previews.map((preview) => {
                const current = isPreviewCurrent(preview.id);
                return (
                  <button
                    key={preview.id}
                    type="button"
                    role="listitem"
                    className={`mobile-sheet-row${current ? " current" : ""}`}
                    aria-current={current || undefined}
                    aria-label={`Go to preview ${preview.label}, ${preview.status}`}
                    onClick={pick(() => onSelectPreview(preview.id))}
                  >
                    <span className={statusDotClass(preview.status === "ready" ? "active" : "idle")} aria-hidden="true" />
                    <span className="mobile-sheet-row-main">
                      <span className="mobile-sheet-row-title">◉ {preview.label}</span>
                      <span className="mobile-sheet-row-meta">{preview.status}</span>
                    </span>
                    {current && <span className="mobile-sheet-check" aria-hidden="true">✓</span>}
                  </button>
                );
              })}
            </>
          )}

          <SectionLabel>Views</SectionLabel>
          <button
            type="button"
            className={`mobile-sheet-row${currentKind === "explorer" ? " current" : ""}`}
            aria-current={currentKind === "explorer" || undefined}
            onClick={pick(onOpenFiles)}
          >
            <span className="mobile-sheet-row-main">
              <span className="mobile-sheet-row-title">📁 Files</span>
            </span>
          </button>
          {showChanges && (
            <button
              type="button"
              className={`mobile-sheet-row${currentKind === "changes" ? " current" : ""}`}
              aria-current={currentKind === "changes" || undefined}
              onClick={pick(onOpenChanges)}
            >
              <span className="mobile-sheet-row-main">
                <span className="mobile-sheet-row-title">± Changes</span>
              </span>
            </button>
          )}

          <SectionLabel>New</SectionLabel>
          <button type="button" className="mobile-sheet-row" onClick={pick(onNewAgent)}>
            <Plus className="size-4 shrink-0" aria-hidden="true" />
            <span className="mobile-sheet-row-main">
              <span className="mobile-sheet-row-title">New agent session</span>
            </span>
          </button>
          <button type="button" className="mobile-sheet-row" onClick={pick(onNewTerminal)}>
            <Plus className="size-4 shrink-0" aria-hidden="true" />
            <span className="mobile-sheet-row-main">
              <span className="mobile-sheet-row-title">New terminal</span>
            </span>
          </button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
