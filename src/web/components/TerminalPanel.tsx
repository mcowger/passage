import { useCallback, useEffect, useRef, useState } from "react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { Unicode11Addon } from "@xterm/addon-unicode11";
import "@xterm/xterm/css/xterm.css";
import type { TerminalSummary } from "../../shared/domain/terminals.ts";
import { connectTerminalSocket, type TerminalSocket } from "../terminalSocket.ts";

type TerminalProps = {
  terminal: TerminalSummary;
  onClose: () => void;
  fontFamily?: string;
  fontSize?: number;
};

const DEFAULT_TERMINAL_FONT_FAMILY = "ui-monospace, SFMono-Regular, Menlo, monospace";
const DEFAULT_TERMINAL_FONT_SIZE = 13;

export function TerminalPanel({ terminal, onClose, fontFamily, fontSize }: TerminalProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const termRef = useRef<Terminal | null>(null);
  const fitAddonRef = useRef<FitAddon | null>(null);
  const socketRef = useRef<TerminalSocket | null>(null);
  const animationFrameRef = useRef<number | null>(null);

  const [connected, setConnected] = useState(false);
  const [hasSizeLease, setHasSizeLease] = useState(terminal.hasSizeLease);
  const [dimensions, setDimensions] = useState({ cols: terminal.columns, rows: terminal.rows });
  const [status, setStatus] = useState<"running" | "exited">(terminal.status);
  const [exitCode, setExitCode] = useState<number | null>(terminal.exitCode);

  const handleResize = useCallback(() => {
    if (animationFrameRef.current !== null) {
      cancelAnimationFrame(animationFrameRef.current);
    }
    animationFrameRef.current = requestAnimationFrame(() => {
      animationFrameRef.current = null;
      if (!containerRef.current || !fitAddonRef.current || !termRef.current || !socketRef.current) return;
      if (containerRef.current.clientWidth === 0 || containerRef.current.clientHeight === 0) return;
      try {
        fitAddonRef.current.fit();
        const cols = termRef.current.cols;
        const rows = termRef.current.rows;
        setDimensions({ cols, rows });
        socketRef.current.sendResize(cols, rows);
      } catch {}
    });
  }, []);

  useEffect(() => {
    if (!containerRef.current) return;

    const term = new Terminal({
      allowProposedApi: true,
      cursorBlink: true,
      fontFamily: fontFamily ?? DEFAULT_TERMINAL_FONT_FAMILY,
      fontSize: fontSize ?? DEFAULT_TERMINAL_FONT_SIZE,
      lineHeight: 1.2,
      theme: {
        background: "#16232d",
        foreground: "#abb2bf",
        cursor: "#0891b2",
        selectionBackground: "rgba(15, 118, 110, 0.4)",
        black: "#1e293b",
        red: "#ef4444",
        green: "#10b981",
        yellow: "#f59e0b",
        blue: "#3b82f6",
        magenta: "#ec4899",
        cyan: "#06b6d4",
        white: "#f8fafc",
        brightBlack: "#475569",
        brightRed: "#f87171",
        brightGreen: "#34d399",
        brightYellow: "#fbbf24",
        brightBlue: "#60a5fa",
        brightMagenta: "#f472b6",
        brightCyan: "#22d3ee",
        brightWhite: "#ffffff",
      },
    });

    const fitAddon = new FitAddon();
    const unicodeAddon = new Unicode11Addon();
    term.loadAddon(fitAddon);
    term.loadAddon(unicodeAddon);
    term.unicode.activeVersion = "11";

    term.open(containerRef.current);
    termRef.current = term;
    fitAddonRef.current = fitAddon;

    try {
      fitAddon.fit();
    } catch {}

    const socket = connectTerminalSocket(terminal.id, {
      onOpen: () => {
        setConnected(true);
      },
      onClose: () => {
        setConnected(false);
      },
      onData: (data) => {
        term.write(data);
      },
      onControl: (control) => {
        if (control.type === "attached") {
          setHasSizeLease(control.hasSizeLease);
          setDimensions({ cols: control.cols, rows: control.rows });
        } else if (control.type === "lease_change") {
          setHasSizeLease(control.hasSizeLease);
        } else if (control.type === "resized") {
          setDimensions({ cols: control.cols, rows: control.rows });
          if (term.cols !== control.cols || term.rows !== control.rows) {
            try {
              term.resize(control.cols, control.rows);
            } catch {}
          }
        } else if (control.type === "exit") {
          setStatus("exited");
          setExitCode(control.exitCode);
          term.writeln(`\r\n[Process completed with status ${control.exitCode ?? 0}]`);
        }
      },
    });

    socketRef.current = socket;

    term.onData((data) => {
      socket.sendInput(data);
    });

    const resizeObserver = new ResizeObserver(() => {
      handleResize();
    });
    resizeObserver.observe(containerRef.current);
    window.addEventListener("resize", handleResize);

    const timer = setTimeout(() => {
      handleResize();
      term.focus();
    }, 50);

    return () => {
      clearTimeout(timer);
      window.removeEventListener("resize", handleResize);
      if (animationFrameRef.current !== null) {
        cancelAnimationFrame(animationFrameRef.current);
        animationFrameRef.current = null;
      }
      resizeObserver.disconnect();
      socket.close();
      term.dispose();
      termRef.current = null;
      fitAddonRef.current = null;
      socketRef.current = null;
    };
  }, [terminal.id, handleResize]);

  // Apply settings-driven font changes to the live terminal without
  // recreating it, then refit so the new glyph metrics take effect.
  useEffect(() => {
    const term = termRef.current;
    if (!term) return;
    let changed = false;
    if (fontFamily && term.options.fontFamily !== fontFamily) {
      term.options.fontFamily = fontFamily;
      changed = true;
    }
    if (fontSize && term.options.fontSize !== fontSize) {
      term.options.fontSize = fontSize;
      changed = true;
    }
    if (changed) {
      try {
        fitAddonRef.current?.fit();
      } catch {}
      handleResize();
    }
  }, [fontFamily, fontSize, handleResize]);

  const handleTakeLease = () => {
    socketRef.current?.takeLease();
    handleResize();
  };

  const handleClear = () => {
    termRef.current?.clear();
  };

  // Closing the pane terminates the shell; closeTabNow owns the deletion so
  // the canvas tab and the terminal process end together.
  const handleTerminate = () => {
    onClose();
  };

  return (
    <div className="terminal-panel" aria-label={`Terminal ${terminal.title}`}>
      <div className="terminal-top-bar">
        <div className="terminal-info">
          <span className="terminal-status-dot" data-status={status} title={`Status: ${status}`}>●</span>
          <strong className="terminal-title">{terminal.title}</strong>
          <span className="dim-tag">{dimensions.cols}×{dimensions.rows}</span>
          <span className={`lease-tag ${hasSizeLease ? "active" : "passive"}`} title={hasSizeLease ? "This window controls terminal dimensions" : "Passive view: dimensions are controlled by another client"}>
            {hasSizeLease ? "Lease active" : "Passive view"}
          </span>
          <code className="cwd-tag" title={terminal.cwd}>{terminal.cwd}</code>
        </div>

        <div className="terminal-actions">
          {!hasSizeLease && (
            <button
              className="secondary small"
              onClick={handleTakeLease}
              title="Take size lease control for this client"
            >
              ⚡ Take Control
            </button>
          )}
          <button
            className="secondary small"
            onClick={handleClear}
            title="Clear terminal screen"
          >
            ↺ Clear
          </button>
          <button
            className="danger-button small"
            onClick={handleTerminate}
            title="Terminate shell process"
          >
            Kill
          </button>
          <button
            className="icon-button"
            onClick={onClose}
            title="Close and terminate terminal"
            aria-label="Close"
          >
            ×
          </button>
        </div>
      </div>

      <div className="terminal-container" ref={containerRef} />
    </div>
  );
}
