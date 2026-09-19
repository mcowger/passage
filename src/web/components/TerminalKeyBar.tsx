import { useCallback, useEffect, useRef, useState } from "react";
import {
  applyStickyModifiers,
  clearArmed,
  nextStickyState,
  NO_MODIFIERS,
  type ModifierKey,
  type StickyModifiers,
} from "./terminalKeys.ts";

/**
 * Sticky-modifier state for the mobile key bar (pi-ghostty-web interaction:
 * tap to arm for the next key, double-tap to lock, tap a locked modifier to
 * release). `consume` folds the live modifiers into one unit of input and
 * clears one-shot armed states; it is ref-backed so long-lived xterm
 * `onData` closures can safely call it.
 */
export function useStickyModifiers(doubleTapWindowMs = 400) {
  const [mods, setMods] = useState<StickyModifiers>(NO_MODIFIERS);
  const modsRef = useRef(mods);
  modsRef.current = mods;
  const lastTapRef = useRef<Record<ModifierKey, number>>({ ctrl: 0, alt: 0, shift: 0 });

  const tapModifier = useCallback(
    (key: ModifierKey) => {
      const now = Date.now();
      const elapsed = now - lastTapRef.current[key];
      lastTapRef.current[key] = now;
      setMods((prev) => ({ ...prev, [key]: nextStickyState(prev[key], elapsed, doubleTapWindowMs) }));
    },
    [doubleTapWindowMs],
  );

  const consume = useCallback((data: string): string => {
    const out = applyStickyModifiers(data, modsRef.current);
    setMods((prev) => clearArmed(prev));
    return out;
  }, []);

  return { mods, tapModifier, consume };
}

type TerminalKeyBarProps = {
  mods: StickyModifiers;
  onTapModifier: (key: ModifierKey) => void;
  /** Receives the raw sequence; the parent folds sticky modifiers in. */
  onSendKey: (raw: string) => void;
};

type KeyDef = {
  label: string;
  ariaLabel: string;
  raw: string;
  title?: string;
  repeat?: boolean;
};

const MODIFIER_LABEL: Record<ModifierKey, string> = { ctrl: "Ctrl", alt: "Alt", shift: "Shift" };

// Core row: the keys unreachable on phone keyboards that must stay one tap
// away — Esc/Tab, sticky modifiers, the emergency Ctrl+C / Ctrl+D pair, and
// arrows for history/line editing.
const NAV_KEYS: KeyDef[] = [
  { label: "←", ariaLabel: "Left arrow", raw: "\x1b[D", title: "Left arrow", repeat: true },
  { label: "↑", ariaLabel: "Up arrow", raw: "\x1b[A", title: "Up arrow", repeat: true },
  { label: "↓", ariaLabel: "Down arrow", raw: "\x1b[B", title: "Down arrow", repeat: true },
  { label: "→", ariaLabel: "Right arrow", raw: "\x1b[C", title: "Right arrow", repeat: true },
];

const EXPANDED_NAV: KeyDef[] = [
  { label: "Home", ariaLabel: "Home", raw: "\x1b[H" },
  { label: "End", ariaLabel: "End", raw: "\x1b[F" },
  { label: "PgUp", ariaLabel: "Page up", raw: "\x1b[5~" },
  { label: "PgDn", ariaLabel: "Page down", raw: "\x1b[6~" },
  { label: "⇧Tab", ariaLabel: "Shift Tab", raw: "\x1b[Z", title: "Shift+Tab (backtab)" },
  { label: "⏎", ariaLabel: "Enter", raw: "\r" },
  { label: "⌫", ariaLabel: "Backspace", raw: "\x7f" },
];

// Direct Ctrl combos (no sticky dance needed for the frequent ones).
const EXPANDED_CTRL: KeyDef[] = [
  { label: "^Z", ariaLabel: "Control Z", raw: "\x1a", title: "Ctrl+Z (suspend)" },
  { label: "^X", ariaLabel: "Control X", raw: "\x18" },
  { label: "^V", ariaLabel: "Control V", raw: "\x16", title: "Ctrl+V (verbatim insert)" },
  { label: "^L", ariaLabel: "Control L", raw: "\x0c", title: "Ctrl+L (clear screen)" },
  { label: "^R", ariaLabel: "Control R", raw: "\x12", title: "Ctrl+R (reverse search)" },
  { label: "^U", ariaLabel: "Control U", raw: "\x15", title: "Ctrl+U (kill line)" },
  { label: "^K", ariaLabel: "Control K", raw: "\x0b", title: "Ctrl+K (kill to end)" },
  { label: "^W", ariaLabel: "Control W", raw: "\x17", title: "Ctrl+W (delete word)" },
  { label: "^A", ariaLabel: "Control A", raw: "\x01", title: "Ctrl+A (line start)" },
  { label: "^E", ariaLabel: "Control E", raw: "\x05", title: "Ctrl+E (line end)" },
];

const EXPANDED_SYMBOLS: KeyDef[] = [
  { label: "|", ariaLabel: "Pipe", raw: "|" },
  { label: "/", ariaLabel: "Slash", raw: "/" },
  { label: "~", ariaLabel: "Tilde", raw: "~" },
  { label: "-", ariaLabel: "Dash", raw: "-" },
  { label: "_", ariaLabel: "Underscore", raw: "_" },
  { label: ".", ariaLabel: "Dot", raw: "." },
  { label: "`", ariaLabel: "Backtick", raw: "`" },
  { label: "$", ariaLabel: "Dollar", raw: "$" },
  { label: "*", ariaLabel: "Star", raw: "*" },
  { label: "!", ariaLabel: "Bang", raw: "!" },
];

const REPEAT_DELAY_MS = 350;
const REPEAT_INTERVAL_MS = 70;

function KeyButton({
  def,
  onSendKey,
}: {
  def: KeyDef;
  onSendKey: (raw: string) => void;
}) {
  // Touch hold-to-repeat for arrows: pointerdown sends immediately and starts
  // repeating; the synthetic click that follows is suppressed. Mouse and
  // keyboard keep the plain click path (desktop has a real keyboard).
  const suppressClickRef = useRef(false);
  const timersRef = useRef<{ delay?: number; interval?: number }>({});

  const clearRepeat = useCallback(() => {
    window.clearTimeout(timersRef.current.delay);
    window.clearInterval(timersRef.current.interval);
    timersRef.current = {};
  }, []);

  useEffect(() => clearRepeat, [clearRepeat]);

  if (!def.repeat) {
    return (
      <button
        type="button"
        className="term-key"
        aria-label={def.ariaLabel}
        title={def.title ?? def.ariaLabel}
        onMouseDown={(e) => e.preventDefault()}
        onClick={() => onSendKey(def.raw)}
      >
        {def.label}
      </button>
    );
  }

  return (
    <button
      type="button"
      className="term-key"
      aria-label={def.ariaLabel}
      title={`${def.title ?? def.ariaLabel} (hold to repeat)`}
      onMouseDown={(e) => e.preventDefault()}
      onPointerDown={(e) => {
        if (e.pointerType === "mouse") return;
        e.preventDefault();
        onSendKey(def.raw);
        suppressClickRef.current = true;
        clearRepeat();
        timersRef.current.delay = window.setTimeout(() => {
          timersRef.current.interval = window.setInterval(() => onSendKey(def.raw), REPEAT_INTERVAL_MS);
        }, REPEAT_DELAY_MS);
      }}
      onPointerUp={clearRepeat}
      onPointerCancel={clearRepeat}
      onPointerLeave={clearRepeat}
      onClick={() => {
        if (suppressClickRef.current) {
          suppressClickRef.current = false;
          return;
        }
        onSendKey(def.raw);
      }}
    >
      {def.label}
    </button>
  );
}

export function TerminalKeyBar({ mods, onTapModifier, onSendKey }: TerminalKeyBarProps) {
  const [expanded, setExpanded] = useState(false);

  const modifierTitle = (key: ModifierKey): string => {
    const state = mods[key];
    const base = `${MODIFIER_LABEL[key]} (sticky: tap to arm, double-tap to lock)`;
    return state === "off" ? base : `${base} — currently ${state}`;
  };

  return (
    <div
      className="terminal-keybar"
      role="toolbar"
      aria-label="Terminal keys"
      onContextMenu={(e) => e.preventDefault()}
    >
      <div className="terminal-keybar-row">
        {(Object.keys(MODIFIER_LABEL) as ModifierKey[]).map((key) => (
          <button
            key={key}
            type="button"
            className="term-key term-key-mod"
            data-state={mods[key]}
            aria-label={`${MODIFIER_LABEL[key]} modifier`}
            aria-pressed={mods[key] !== "off"}
            title={modifierTitle(key)}
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => onTapModifier(key)}
          >
            {MODIFIER_LABEL[key]}
          </button>
        ))}
        <button
          type="button"
          className="term-key"
          aria-label="Escape"
          title="Escape"
          onMouseDown={(e) => e.preventDefault()}
          onClick={() => onSendKey("\x1b")}
        >
          ESC
        </button>
        <button
          type="button"
          className="term-key"
          aria-label="Tab"
          title="Tab (completion)"
          onMouseDown={(e) => e.preventDefault()}
          onClick={() => onSendKey("\t")}
        >
          TAB
        </button>
        <button
          type="button"
          className="term-key term-key-danger"
          aria-label="Control C"
          title="Ctrl+C (interrupt)"
          onMouseDown={(e) => e.preventDefault()}
          onClick={() => onSendKey("\x03")}
        >
          ^C
        </button>
        <button
          type="button"
          className="term-key"
          aria-label="Control D"
          title="Ctrl+D (EOF / exit)"
          onMouseDown={(e) => e.preventDefault()}
          onClick={() => onSendKey("\x04")}
        >
          ^D
        </button>
        {NAV_KEYS.map((def) => (
          <KeyButton key={def.ariaLabel} def={def} onSendKey={onSendKey} />
        ))}
        <button
          type="button"
          className="term-key term-key-expand"
          aria-label={expanded ? "Show fewer keys" : "Show more keys"}
          aria-expanded={expanded}
          title={expanded ? "Show fewer keys" : "More keys (Home, End, Ctrl combos, symbols)"}
          onMouseDown={(e) => e.preventDefault()}
          onClick={() => setExpanded((v) => !v)}
        >
          ⋯
        </button>
      </div>
      {expanded && (
        <div className="terminal-keybar-row terminal-keybar-extra">
          {EXPANDED_NAV.map((def) => (
            <KeyButton key={def.ariaLabel} def={def} onSendKey={onSendKey} />
          ))}
        </div>
      )}
      {expanded && (
        <div className="terminal-keybar-row terminal-keybar-extra">
          {EXPANDED_CTRL.map((def) => (
            <KeyButton key={def.ariaLabel} def={def} onSendKey={onSendKey} />
          ))}
        </div>
      )}
      {expanded && (
        <div className="terminal-keybar-row terminal-keybar-extra">
          {EXPANDED_SYMBOLS.map((def) => (
            <KeyButton key={def.ariaLabel} def={def} onSendKey={onSendKey} />
          ))}
        </div>
      )}
    </div>
  );
}
