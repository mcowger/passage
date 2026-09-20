import type { AgentSummary } from "../../shared/domain/agents.ts";
import type { TerminalSummary } from "../../shared/domain/terminals.ts";
import type { WebPreview } from "../../shared/domain/previews.ts";
import type { WorkspaceScriptRuntime } from "../../shared/domain/workspace-actions.ts";
import type { ConnectionHealth } from "../socketLifecycle.ts";
import { AGENT_STATUS_LABEL, getAgentStatusKind, type AgentStatusKind } from "./agentStatus.ts";
import { WsHealthIndicator } from "./WsHealthIndicator.tsx";
import { WorkspaceScriptsButton } from "./WorkspaceScriptsButton.tsx";
import { Dialog, DialogContent, DialogTitle } from "./ui/dialog.tsx";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "./ui/dropdown-menu.tsx";
import { ArrowLeft, ChevronDown, Menu, MoreHorizontal, Plus, X } from "lucide-react";
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

function statusDotClass(kind: AgentStatusKind): string {
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
  /** Closes the currently visible agent / terminal / preview / file view.
   *  Absent when the current destination has nothing to close (Files,
   *  Changes, Overview). Without this there is no way to close anything
   *  from mobile: the desktop close affordance lives in the canvas tab
   *  strip, which mobile does not render. */
  onCloseCurrent?: () => void;
  closeLabel?: string;
  /** paseo.json services/tasks for the top-bar play-button menu.
   *  Absent (or empty) hides the button; the session sheet keeps its own
   *  Services/Tasks sections regardless. */
  scripts?: WorkspaceScriptRuntime[];
  scriptBusyName?: string | null;
  onStartScript?: (name: string) => void;
  onStopScript?: (name: string) => void;
  onRestartScript?: (name: string) => void;
  onViewScriptTerminal?: (terminalId: string) => void;
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
    onCloseCurrent,
    closeLabel,
    scripts = [],
    scriptBusyName = null,
    onStartScript,
    onStopScript,
    onRestartScript,
    onViewScriptTerminal,
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
        <WsHealthIndicator health={wsHealth} hideLabel className="mobile-context-health" />
        {(onStartScript || onStopScript) && scripts.length > 0 && (
          <WorkspaceScriptsButton
            iconOnly
            scripts={scripts}
            busyName={scriptBusyName}
            onStart={(name) => onStartScript?.(name)}
            onStop={(name) => onStopScript?.(name)}
            onRestart={(name) => onRestartScript?.(name)}
            onViewTerminal={(terminalId) => onViewScriptTerminal?.(terminalId)}
          />
        )}
        {onCloseCurrent && (
          <button
            type="button"
            className="mobile-context-icon-btn"
            onClick={onCloseCurrent}
            aria-label={closeLabel ?? "Close current view"}
            title={closeLabel ?? "Close current view"}
          >
            <X className="size-5" aria-hidden="true" />
          </button>
        )}
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
  scripts: WorkspaceScriptRuntime[];
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
  /** Close actions for the session rows. Each ends the underlying
   *  resource (agents are archived, terminals terminated, previews
   *  stopped and deleted) exactly like closing the desktop canvas tab.
   *  Absent handlers hide the row close button. */
  onCloseAgent?: (id: string) => void;
  onCloseTerminal?: (id: string) => void;
  onClosePreview?: (id: string) => void;
  /** Script controls (bottom-sheet home for the Actions list on phones).
   *  Absent handlers hide the section. View-terminal selects the backing
   *  PTY without closing the sheet's parent flow. */
  onStartScript?: (name: string) => void;
  onStopScript?: (name: string) => void;
  onRestartScript?: (name: string) => void;
  onViewScriptTerminal?: (terminalId: string) => void;
  /** Name of the script with a start/stop/restart in flight. Disables its
   *  row actions so a double-tap cannot issue a duplicate mutation. */
  scriptBusyName?: string | null;
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
    onCloseAgent,
    onCloseTerminal,
    onClosePreview,
    scripts = [],
    onStartScript,
    onStopScript,
    onRestartScript,
    onViewScriptTerminal,
    scriptBusyName = null,
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
              <div
                key={agent.id}
                role="listitem"
                className={`mobile-sheet-row${current ? " current" : ""}`}
              >
                <button
                  type="button"
                  className="mobile-sheet-select"
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
                {onCloseAgent && (
                  <button
                    type="button"
                    className="mobile-sheet-close"
                    aria-label={`Close agent ${agent.title}`}
                    title={`Close agent ${agent.title}`}
                    onClick={() => onCloseAgent(agent.id)}
                  >
                    <X className="size-5" aria-hidden="true" />
                  </button>
                )}
              </div>
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
              <div
                key={terminal.id}
                role="listitem"
                className={`mobile-sheet-row${current ? " current" : ""}`}
              >
                <button
                  type="button"
                  className="mobile-sheet-select"
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
                {onCloseTerminal && (
                  <button
                    type="button"
                    className="mobile-sheet-close"
                    aria-label={`Close terminal ${terminal.title}`}
                    title={`Close terminal ${terminal.title}`}
                    onClick={() => onCloseTerminal(terminal.id)}
                  >
                    <X className="size-5" aria-hidden="true" />
                  </button>
                )}
              </div>
            );
          })}

          {previews.length > 0 && (
            <>
              <SectionLabel>{`Previews (${previews.length})`}</SectionLabel>
              {previews.map((preview) => {
                const current = isPreviewCurrent(preview.id);
                return (
                  <div
                    key={preview.id}
                    role="listitem"
                    className={`mobile-sheet-row${current ? " current" : ""}`}
                  >
                    <button
                      type="button"
                      className="mobile-sheet-select"
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
                    {onClosePreview && (
                      <button
                        type="button"
                        className="mobile-sheet-close"
                        aria-label={`Close preview ${preview.label}`}
                        title={`Close preview ${preview.label}`}
                        onClick={() => onClosePreview(preview.id)}
                      >
                        <X className="size-5" aria-hidden="true" />
                      </button>
                    )}
                  </div>
                );
              })}
            </>
          )}

          {scripts.length > 0 && (onStartScript || onStopScript) && (() => {
            // Services are long-running (port, health, restart); tasks run
            // once and report an exit code. Separate sections keep the
            // two from reading as one flat list of identical rows.
            const services = scripts.filter((script) => script.type === "service");
            const tasks = scripts.filter((script) => script.type !== "service");
            const renderScriptRow = (script: WorkspaceScriptRuntime, kindLabel: "service" | "task") => {
              const running = script.lifecycle === "running";
              // Single-line status: the dot + action buttons already carry
              // running/stopped, so this stays short (port, not full URL).
              const status = running
                ? script.health === "healthy" && script.port !== null
                  ? `running \u00b7 :${script.port}`
                  : script.health === "healthy"
                    ? "running \u00b7 listening"
                    : script.health === "unhealthy"
                      ? "not listening"
                      : "running"
                : script.exitCode !== null
                  ? `exit ${script.exitCode}`
                  : "stopped";
              const dotKind: "idle" | "empty" | "active" =
                running && script.health === "healthy"
                  ? "idle"
                  : running && script.health === "unhealthy"
                    ? "empty"
                    : running
                      ? "active"
                      : "idle";
              const busy = scriptBusyName === script.name;
              const glyph = kindLabel === "service" ? "\u25c9" : "\u25b6";
              return (
                <div key={script.name} role="listitem" className="mobile-sheet-row mobile-script-row">
                  <span className={statusDotClass(dotKind)} aria-hidden="true" />
                  <span className="mobile-script-name" title={`${script.name} (${status})`}>
                    <span aria-hidden="true" className="mobile-script-glyph">{glyph} </span>{script.name}
                  </span>
                  <span className="mobile-script-status">{status}</span>
                  <span className="mobile-script-actions">
                    {!running ? (
                      <button
                        type="button"
                        className="mobile-sheet-action"
                        aria-label={`Run ${kindLabel} ${script.name}, ${status}`}
                        disabled={busy}
                        onClick={() => onStartScript?.(script.name)}
                      >
                        Run
                      </button>
                    ) : (
                      <>
                        {script.terminalId && onViewScriptTerminal && (
                          <button
                            type="button"
                            className="mobile-sheet-action"
                            aria-label={`View ${script.name} logs`}
                            onClick={pick(() => onViewScriptTerminal(script.terminalId as string))}
                          >
                            Logs
                          </button>
                        )}
                        {onRestartScript && (
                          <button
                            type="button"
                            className="mobile-sheet-action"
                            aria-label={`Restart ${kindLabel} ${script.name}`}
                            disabled={busy}
                            onClick={() => onRestartScript(script.name)}
                          >
                            Restart
                          </button>
                        )}
                        <button
                          type="button"
                          className="mobile-sheet-action"
                          aria-label={`Stop ${kindLabel} ${script.name}`}
                          disabled={busy}
                          onClick={() => onStopScript?.(script.name)}
                        >
                          Stop
                        </button>
                      </>
                    )}
                  </span>
                </div>
              );
            };
            return (
              <>
                {services.length > 0 && (
                  <>
                    <SectionLabel>{`Services (${services.length})`}</SectionLabel>
                    {services.map((script) => renderScriptRow(script, "service"))}
                  </>
                )}
                {tasks.length > 0 && (
                  <>
                    <SectionLabel>{`Tasks (${tasks.length})`}</SectionLabel>
                    {tasks.map((script) => renderScriptRow(script, "task"))}
                  </>
                )}
              </>
            );
          })()}

          <SectionLabel>Views</SectionLabel>          <button
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
