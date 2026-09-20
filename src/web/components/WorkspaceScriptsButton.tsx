import { useCallback } from "react";
import { Copy, ExternalLink, Globe, Play, RotateCw, Square, SquareTerminal } from "lucide-react";
import type { WorkspaceScriptRuntime } from "../../shared/domain/workspace-actions.ts";
import { Button } from "./ui/button.tsx";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "./ui/dropdown-menu.tsx";

export type WorkspaceScriptsButtonProps = {
  scripts: WorkspaceScriptRuntime[];
  busyName: string | null;
  onStart: (name: string) => void;
  onStop: (name: string) => void;
  onRestart: (name: string) => void;
  onViewTerminal: (terminalId: string) => void;
  /** Compact play-glyph trigger (no "Scripts" text) for the mobile
   *  context bar, where title space wins over labels. */
  iconOnly?: boolean;
  className?: string;
};

/** Header Actions button for `paseo.json` scripts/services. Hidden when the
 *  workspace declares no scripts. Each row exposes run/stop/restart plus
 *  view-terminal (running), open-URL and copy-URL (services with a port).
 *  Rows use 44px touch targets so the same menu works as a bottom-sheet
 *  equivalent on phones. */
export function WorkspaceScriptsButton(props: WorkspaceScriptsButtonProps) {
  const { scripts, busyName, onStart, onStop, onRestart, onViewTerminal, iconOnly = false, className } = props;
  if (scripts.length === 0) return null;
  const running = scripts.filter((s) => s.lifecycle === "running").length;

  const copyUrl = useCallback((url: string) => {
    try {
      void navigator.clipboard?.writeText(url);
    } catch {}
  }, []);
  const openUrl = useCallback((url: string) => {
    try {
      window.open(url, "_blank", "noopener");
    } catch {}
  }, []);

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        {iconOnly ? (
          <button
            type="button"
            className={`mobile-context-icon-btn mobile-scripts-btn${className ? ` ${className}` : ""}`}
            aria-label={`Workspace scripts, ${running} of ${scripts.length} running`}
            title="Workspace scripts"
          >
            <Play className="size-5" aria-hidden="true" />
            {running > 0 && (
              <span className="mobile-scripts-badge" aria-hidden="true">{running}</span>
            )}
          </button>
        ) : (
        <Button
          size="sm"
          variant="secondary"
          aria-label={`Workspace scripts, ${running} of ${scripts.length} running`}
          title="Workspace scripts"
        >
          <Play className="h-3.5 w-3.5" aria-hidden="true" />
          Scripts
          {running > 0 && <span className="tab-badge">{running}</span>}
        </Button>
        )}
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-80 max-w-[90vw]">
        <DropdownMenuLabel>Workspace scripts</DropdownMenuLabel>
        <DropdownMenuSeparator />
        {scripts.map((script) => {
          const isRunning = script.lifecycle === "running";
          const busy = busyName === script.name;
          const Icon = script.type === "service" ? Globe : SquareTerminal;
          const healthDot =
            isRunning && script.health ? (
              <span
                className={`status-dot dot-sm ${script.health === "healthy" ? "idle" : "empty"}`}
                aria-hidden="true"
                title={script.health === "healthy" ? "Port is accepting connections" : "Port is not accepting connections"}
              />
            ) : null;
          const statusText = isRunning
            ? script.health === "healthy"
              ? "running · listening"
              : script.health === "unhealthy"
                ? "running · not listening"
                : "running"
            : script.exitCode !== null
              ? `exit ${script.exitCode}`
              : "stopped";
          return (
            <div key={script.name} className="flex flex-col px-2 py-1.5" aria-label={`Script ${script.name}`}>
              <div className="flex min-h-11 items-center gap-2">
                <Icon className="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
                <span className="min-w-0 flex-1 truncate text-xs font-medium text-foreground" title={script.name}>
                  {script.name}
                </span>
                <span className="flex shrink-0 items-center gap-1 text-[11px] text-muted-foreground">
                  {healthDot}{statusText}
                </span>
                {!isRunning ? (
                  <Button
                    size="xs"
                    variant="secondary"
                    disabled={busy}
                    onClick={() => onStart(script.name)}
                    aria-label={`Run ${script.name}`}
                  >
                    <Play className="size-3" aria-hidden="true" /> Run
                  </Button>
                ) : (
                  <Button
                    size="xs"
                    variant="secondary"
                    disabled={busy}
                    onClick={() => onStop(script.name)}
                    aria-label={`Stop ${script.name}`}
                  >
                    <Square className="size-3" aria-hidden="true" /> Stop
                  </Button>
                )}
              </div>
              {script.url && (
                <div className="flex min-h-11 items-center gap-1 pl-6">
                  <span className="min-w-0 flex-1 truncate font-mono text-[11px] text-muted-foreground" title={script.url}>
                    {script.url}
                  </span>
                  <button
                    type="button"
                    className="rounded p-2 hover:bg-surface-hover"
                    aria-label={`Open ${script.name} in browser`}
                    title="Open in browser"
                    onClick={() => script.url && openUrl(script.url)}
                  >
                    <ExternalLink className="size-3.5" aria-hidden="true" />
                  </button>
                  <button
                    type="button"
                    className="rounded p-2 hover:bg-surface-hover"
                    aria-label={`Copy ${script.name} URL`}
                    title="Copy URL"
                    onClick={() => script.url && copyUrl(script.url)}
                  >
                    <Copy className="size-3.5" aria-hidden="true" />
                  </button>
                </div>
              )}
              {isRunning && (
                <div className="flex items-center gap-1 pl-6">
                  <Button
                    size="xs"
                    variant="secondary"
                    disabled={busy}
                    onClick={() => onRestart(script.name)}
                    aria-label={`Restart ${script.name}`}
                  >
                    <RotateCw className="size-3" aria-hidden="true" /> Restart
                  </Button>
                  {script.terminalId && (
                    <Button
                      size="xs"
                      variant="ghost"
                      onClick={() => script.terminalId && onViewTerminal(script.terminalId)}
                      aria-label={`View ${script.name} terminal`}
                    >
                      <SquareTerminal className="size-3" aria-hidden="true" /> Logs
                    </Button>
                  )}
                </div>
              )}
            </div>
          );
        })}
        <DropdownMenuSeparator />
        <DropdownMenuItem onSelect={() => undefined} className="text-[11px] text-muted-foreground">
          Scripts come from paseo.json and run in workspace terminals.
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
