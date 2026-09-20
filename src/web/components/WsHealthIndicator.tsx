import { cn } from "../lib/utils.ts";
import type { ConnectionHealth } from "../socketLifecycle.ts";
import { Tooltip, TooltipContent, TooltipTrigger } from "./ui/tooltip.tsx";

export const WS_HEALTH_LABEL: Record<ConnectionHealth, string> = {
  online: "Connected",
  checking: "Reconnecting\u2026",
  offline: "Disconnected",
};

/** Real `/ws` heartbeat status (docs/IOSWEBSOCKETS.md), never an assumed
 *  "Connected". Shared by the desktop sidebar footer and the mobile nav
 *  bar -- the sidebar is a drawer on mobile (hidden by default), so the
 *  indicator needs a second, always-visible home there too.
 *
 *  `hideLabel` renders the dot alone (no "Connected" text) for the
 *  compact mobile bars, where the label steals title space. The accessible
 *  name and tooltip keep carrying the full status. */
export function WsHealthIndicator({ health, className, hideLabel = false }: { health?: ConnectionHealth; className?: string; hideLabel?: boolean }) {
  const effective = health ?? "checking";
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span
          className={cn("footer-status", hideLabel && "dot-only", className)}
          role="status"
          aria-label={`WebSocket connection: ${WS_HEALTH_LABEL[effective]}`}
        >
          <span className={cn("connected-dot", effective === "offline" && "ws-offline", effective === "checking" && "ws-checking")} aria-hidden="true" />
          {!hideLabel && WS_HEALTH_LABEL[effective]}
        </span>
      </TooltipTrigger>
      <TooltipContent side="top">
        {effective === "online"
          ? "Live connection to the daemon is healthy."
          : "Not currently connected to the daemon. Passage keeps retrying automatically."}
      </TooltipContent>
    </Tooltip>
  );
}
