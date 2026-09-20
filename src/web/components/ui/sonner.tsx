import * as React from "react"
import {
  CircleCheckIcon,
  InfoIcon,
  Loader2Icon,
  OctagonXIcon,
  TriangleAlertIcon,
} from "lucide-react"
import { Toaster as Sonner, toast, type ToasterProps } from "sonner"

// The app manages its own light/dark theme packs via `data-theme-mode` and the
// `dark` class on <html> (see applyThemeTokens in main.tsx). There is no
// next-themes provider, so `useTheme()` always fell back to "system", which
// sonner resolves from the OS color scheme. When the OS scheme disagreed with
// the app theme, sonner styled toast internals (e.g. a light-gray description
// in its dark mode) for a card painted with the app's light tokens — washing
// the text out. Follow the app theme instead.
function useAppTheme(): "light" | "dark" {
  const readTheme = () => {
    const root = document.documentElement
    return root.dataset.themeMode === "dark" || root.classList.contains("dark")
      ? ("dark" as const)
      : ("light" as const)
  }
  const [theme, setTheme] = React.useState(readTheme)
  React.useEffect(() => {
    const root = document.documentElement
    const update = () => setTheme(readTheme())
    const observer = new MutationObserver(update)
    observer.observe(root, {
      attributes: true,
      attributeFilter: ["class", "data-theme-mode"],
    })
    return () => observer.disconnect()
  }, [])
  return theme
}

// Commit messages can be very long (subject + body). Toasts only get a
// one-line summary so the card stays small and never covers the prompt.
const COMMIT_TOAST_SUMMARY_MAX = 160;

export function summarizeCommitMessage(message: string): string | undefined {
  const firstLine = message.split("\n")[0]?.trim() ?? "";
  if (!firstLine) return undefined;
  return firstLine.length > COMMIT_TOAST_SUMMARY_MAX
    ? `${firstLine.slice(0, COMMIT_TOAST_SUMMARY_MAX - 1).trimEnd()}…`
    : firstLine;
}

// Long enough to actually read the summary; the close button + swipe/
// hover-pause let the user hold it on screen as long as needed.
export const COMMIT_TOAST_DURATION_MS = 15000;

// Tap-to-expand toast description: collapsed it shows the one-line summary
// (so the card stays small); tapping "Show more" reveals the full commit
// message in a height-capped scroll region, so even expanded it can't
// swallow the screen. Tapping "Show less" collapses it back.
// While expanded the toast holds until explicitly closed (close button /
// swipe); collapsing restores the auto-dismiss timer.
export function CommitToastDescription({
  message,
  toastId,
  title,
  initialExpanded = false,
}: {
  message: string;
  toastId?: string;
  title?: string;
  initialExpanded?: boolean;
}) {
  const [expanded, setExpanded] = React.useState(initialExpanded);
  const full = message.trim();
  const summary = summarizeCommitMessage(message) ?? full;
  if (full.length <= summary.length) return <>{summary}</>;
  return (
    <span>
      {expanded ? (
        <span className="mt-0.5 block max-h-64 overflow-y-auto whitespace-pre-wrap">{full}</span>
      ) : (
        <span>{summary} </span>
      )}
      <button
        type="button"
        className="font-medium underline underline-offset-2"
        onClick={(event) => {
          event.stopPropagation();
          const next = !expanded;
          setExpanded(next);
          if (toastId !== undefined && title !== undefined) {
            toast.success(title, {
              id: toastId,
              description: (
                <CommitToastDescription message={message} toastId={toastId} title={title} initialExpanded={next} />
              ),
              duration: next ? Infinity : COMMIT_TOAST_DURATION_MS,
              dismissible: true,
            });
          }
        }}
      >
        {expanded ? "Show less" : "Show more"}
      </button>
    </span>
  );
}

export function commitToastDescription(message: string): React.ReactNode | undefined {
  return message.trim() ? <CommitToastDescription message={message} /> : undefined;
}

let commitToastSeq = 0;

// Commit/ship-it success toast with a tap-to-expand description. The toast
// gets a stable id so expanding can switch it to hold-until-closed.
export function commitToast(title: string, message: string): void {
  const id = `commit-toast-${++commitToastSeq}`;
  toast.success(title, {
    id,
    description: message.trim() ? (
      <CommitToastDescription message={message} toastId={id} title={title} />
    ) : undefined,
    duration: COMMIT_TOAST_DURATION_MS,
    dismissible: true,
  });
}

const Toaster = ({ ...props }: ToasterProps) => {
  const theme = useAppTheme()

  return (
    <Sonner
      theme={theme}
      position="top-center"
      className="toaster group"
      gap={8}
      closeButton
      expand
      // PWA edge-to-edge (black-translucent): top-center toasts paint under
      // the status bar / Dynamic Island frost without this. Offset (not
      // layout padding) moves only the toast layer, so the safe-area
      // geometry is untouched. On phones the toast sits below the mobile
      // context bar (hamburger row ~62px tall) with wide side margins so
      // it renders as a small centered pill that never covers the nav;
      // desktop keeps its current distance with a slightly narrower card.
      offset={{ top: "16px" }}
      mobileOffset={{
        top: "calc(env(safe-area-inset-top, 0px) + 72px)",
        left: "48px",
        right: "48px",
      }}
      toastOptions={{
        style: { padding: "10px 12px" },
      }}
      icons={{
        success: <CircleCheckIcon className="size-4" />,
        info: <InfoIcon className="size-4" />,
        warning: <TriangleAlertIcon className="size-4" />,
        error: <OctagonXIcon className="size-4" />,
        loading: <Loader2Icon className="size-4 animate-spin" />,
      }}
      style={
        {
          "--normal-bg": "var(--popover)",
          "--normal-text": "var(--popover-foreground)",
          "--normal-border": "var(--border)",
          "--border-radius": "var(--radius)",
          "--width": "320px",
        } as React.CSSProperties
      }
      {...props}
    />
  )
}

export { Toaster }
