import { Component, type ErrorInfo, type ReactNode } from "react";
import {
  buildRootErrorDiagnostics,
  formatRootErrorDiagnosticsText,
  recordRootError,
  type RootErrorDiagnostics,
} from "../root-error.ts";
import { copyTextToClipboard } from "../lib/clipboard.ts";

interface RootErrorBoundaryState {
  failure: RootErrorDiagnostics | null;
  copied: boolean;
  copyFailed: boolean;
}

// Plain inline styles only: the fallback must render without application
// providers, the app stylesheet, or any UI library — the failure may have
// come from those very layers.
const PAGE_STYLE: React.CSSProperties = {
  minHeight: "100vh",
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  padding: "24px",
  background: "#f6f5f2",
  color: "#1a1c1e",
  fontFamily: "system-ui, -apple-system, sans-serif",
};

const CARD_STYLE: React.CSSProperties = {
  maxWidth: "560px",
  width: "100%",
  background: "#ffffff",
  border: "1px solid #d8d5cd",
  borderRadius: "12px",
  padding: "24px",
  boxShadow: "0 2px 12px rgba(0,0,0,0.08)",
};

const TITLE_STYLE: React.CSSProperties = {
  margin: "0 0 8px",
  fontSize: "20px",
  lineHeight: "1.3",
};

const BODY_STYLE: React.CSSProperties = {
  margin: "0 0 8px",
  fontSize: "14px",
  lineHeight: "1.5",
};

const NOTE_STYLE: React.CSSProperties = {
  margin: "0 0 16px",
  fontSize: "12px",
  lineHeight: "1.5",
  color: "#6b6f76",
};

const BUTTON_ROW_STYLE: React.CSSProperties = {
  display: "flex",
  gap: "8px",
  flexWrap: "wrap",
  alignItems: "center",
  marginBottom: "16px",
};

const PRIMARY_BUTTON_STYLE: React.CSSProperties = {
  appearance: "none",
  border: "1px solid #1a1c1e",
  borderRadius: "8px",
  background: "#1a1c1e",
  color: "#ffffff",
  fontSize: "14px",
  fontWeight: 600,
  padding: "8px 16px",
  cursor: "pointer",
};

const SECONDARY_BUTTON_STYLE: React.CSSProperties = {
  appearance: "none",
  border: "1px solid #a8a49a",
  borderRadius: "8px",
  background: "#ffffff",
  color: "#1a1c1e",
  fontSize: "13px",
  padding: "6px 12px",
  cursor: "pointer",
};

const DETAILS_STYLE: React.CSSProperties = {
  fontSize: "13px",
  borderTop: "1px solid #e4e1d9",
  paddingTop: "12px",
};

const PRE_STYLE: React.CSSProperties = {
  whiteSpace: "pre-wrap",
  wordBreak: "break-word",
  background: "#f0efeb",
  border: "1px solid #e4e1d9",
  borderRadius: "8px",
  padding: "12px",
  fontSize: "12px",
  lineHeight: "1.5",
  maxHeight: "240px",
  overflow: "auto",
  margin: "8px 0",
  fontFamily: "ui-monospace, monospace",
};

const STATUS_STYLE: React.CSSProperties = {
  fontSize: "12px",
  color: "#6b6f76",
};

/**
 * Top-level containment: wraps the entire application tree (providers and
 * Toaster included) so a render/lifecycle failure degrades to an explicit
 * fallback instead of a blank PWA. Never reloads or retries on its own —
 * the user explicitly reloads via the button.
 */
export class RootErrorBoundary extends Component<{ children: ReactNode }, RootErrorBoundaryState> {
  state: RootErrorBoundaryState = { failure: null, copied: false, copyFailed: false };

  static getDerivedStateFromError(error: unknown): Partial<RootErrorBoundaryState> {
    try {
      return {
        failure: buildRootErrorDiagnostics({ error, source: "react-boundary" }),
        copied: false,
        copyFailed: false,
      };
    } catch {
      return { failure: null };
    }
  }

  componentDidCatch(error: unknown, info: ErrorInfo): void {
    try {
      const failure = buildRootErrorDiagnostics({
        error,
        componentStack: info.componentStack,
        source: "react-boundary",
      });
      recordRootError(failure);
      this.setState({ failure });
    } catch {
      // The fallback from getDerivedStateFromError still stands.
    }
  }

  private handleCopy = (): void => {
    const { failure } = this.state;
    if (!failure) return;
    const text = formatRootErrorDiagnosticsText(failure);
    void (async () => {
      try {
        const ok = await copyTextToClipboard(text);
        this.setState(ok ? { copied: true, copyFailed: false } : { copied: false, copyFailed: true });
      } catch {
        this.setState({ copied: false, copyFailed: true });
      }
    })();
  };

  render(): ReactNode {
    const { failure, copied, copyFailed } = this.state;
    if (!failure) return this.props.children;
    return (
      <div style={PAGE_STYLE}>
        <div style={CARD_STYLE} role="alert">
          <h1 style={TITLE_STYLE}>Passage encountered an error</h1>
          <p style={BODY_STYLE}>
            The app hit a problem while rendering. Your daemon-side work (agents, terminals) is unaffected — this is
            only the display. Reload to try again; nothing reloads automatically.
          </p>
          <p style={NOTE_STYLE}>
            This screen only covers failures after the app started. A blank page with no message means the app never
            loaded (bundle, service worker, or browser process) — check the browser console instead.
          </p>
          <div style={BUTTON_ROW_STYLE}>
            <button type="button" style={PRIMARY_BUTTON_STYLE} onClick={() => window.location.reload()}>
              Reload app
            </button>
          </div>
          <details style={DETAILS_STYLE}>
            <summary>Diagnostics</summary>
            <pre style={PRE_STYLE}>{formatRootErrorDiagnosticsText(failure)}</pre>
            <div style={BUTTON_ROW_STYLE}>
              <button type="button" style={SECONDARY_BUTTON_STYLE} onClick={this.handleCopy}>
                Copy diagnostics
              </button>
              {copied && <span style={STATUS_STYLE}>Copied to clipboard.</span>}
              {copyFailed && <span style={STATUS_STYLE}>Copy failed — select the text above manually.</span>}
            </div>
          </details>
        </div>
      </div>
    );
  }
}
