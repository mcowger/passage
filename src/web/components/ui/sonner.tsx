import * as React from "react"
import {
  CircleCheckIcon,
  InfoIcon,
  Loader2Icon,
  OctagonXIcon,
  TriangleAlertIcon,
} from "lucide-react"
import { Toaster as Sonner, type ToasterProps } from "sonner"

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

const Toaster = ({ ...props }: ToasterProps) => {
  const theme = useAppTheme()

  return (
    <Sonner
      theme={theme}
      position="top-center"
      className="toaster group"
      gap={8}
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
