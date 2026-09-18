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
 *  indicator needs a second, always-visible home there too. */
export function WsHealthIndicator({ health, className }: { health?: ConnectionHealth; className?: string }) {
  const effective = health ?? "checking";
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span
          className={cn("footer-status", className)}
          role="status"
          aria-label={`WebSocket connection: ${WS_HEALTH_LABEL[effective]}`}
        >
          <span className={cn("connected-dot", effective === "offline" && "ws-offline", effective === "checking" && "ws-checking")} aria-hidden="true" />
          {WS_HEALTH_LABEL[effective]}
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
