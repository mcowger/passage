// Pure helpers for the mobile terminal key bar (see TerminalKeyBar.tsx).
//
// Interaction spec follows pi-ghostty-web: a modifier tap arms it for the
// next key, a double-tap locks it until tapped again, and any applied key
// clears armed (but not locked) modifiers. Ctrl encodes a control byte,
// Alt prefixes ESC (Meta), Shift uppercases letters and turns Tab into
// backtab. Ctrl/Shift combine into CSI modifier params (xterm-style, e.g.
// Ctrl+Left is word-left `\x1b[1;5D`); Alt stays an ESC prefix.

export type ModifierKey = "ctrl" | "alt" | "shift";
export type ModifierState = "off" | "armed" | "locked";
export type StickyModifiers = Record<ModifierKey, ModifierState>;

export const NO_MODIFIERS: StickyModifiers = { ctrl: "off", alt: "off", shift: "off" };

export function hasActiveModifier(mods: StickyModifiers): boolean {
  return mods.ctrl !== "off" || mods.alt !== "off" || mods.shift !== "off";
}

/** Single-tap / double-tap-to-lock transition for one modifier. */
export function nextStickyState(
  current: ModifierState,
  sinceLastTapMs: number,
  doubleTapWindowMs = 400,
): ModifierState {
  if (current === "off") return "armed";
  if (current === "locked") return "off";
  return sinceLastTapMs <= doubleTapWindowMs ? "locked" : "off";
}

/** Clear one-shot armed modifiers; locked ones persist. */
export function clearArmed(mods: StickyModifiers): StickyModifiers {
  if (mods.ctrl !== "armed" && mods.alt !== "armed" && mods.shift !== "armed") return mods;
  return {
    ctrl: mods.ctrl === "armed" ? "off" : mods.ctrl,
    alt: mods.alt === "armed" ? "off" : mods.alt,
    shift: mods.shift === "armed" ? "off" : mods.shift,
  };
}

/** Control byte for Ctrl+char (Ctrl+C becomes `\x03`). Null when unencodable. */
export function ctrlByteFor(char: string): string | null {
  if ([...char].length !== 1) return null;
  // Uppercase first so Ctrl+r === Ctrl+R. Control bytes exist for
  // @ A-Z [ \ ] ^ _ (0x40-0x5F) mapping to 0x00-0x1F.
  const code = char.toUpperCase().charCodeAt(0);
  if (code === 0x20) return "\x00"; // Ctrl+Space is NUL
  if (code >= 0x40 && code <= 0x5f) return String.fromCharCode(code & 0x1f);
  return null;
}

function modifierParam(mods: StickyModifiers): number {
  return 1 + (mods.shift !== "off" ? 1 : 0) + (mods.alt !== "off" ? 2 : 0) + (mods.ctrl !== "off" ? 4 : 0);
}

const CSI_RE = /^\x1b\[([0-9;]*)([A-Za-z~])$/;

/** Fold Ctrl/Shift/Alt into a CSI sequence as an xterm modifier param. */
export function withCsiModifiers(seq: string, mods: StickyModifiers): string {
  const match = CSI_RE.exec(seq);
  if (!match) return seq;
  const param = modifierParam(mods);
  if (param === 1) return seq;
  const body = match[1];
  return `\x1b[${body === "" ? "1" : body};${param}${match[2]}`;
}

function applyToSequenceOrChar(input: string, mods: StickyModifiers): string {
  let out = input;
  if (CSI_RE.test(out)) {
    // Alt stays an ESC prefix (legacy xterm Meta behavior); only
    // Ctrl/Shift fold into the CSI param.
    out = withCsiModifiers(out, { ...mods, alt: "off" });
  } else if ([...out].length === 1) {
    if (mods.shift !== "off" && /[a-z]/.test(out)) out = out.toUpperCase();
    if (mods.ctrl !== "off") {
      const byte = ctrlByteFor(out);
      if (byte !== null) out = byte;
    }
  }
  // Multi-character input (e.g. pastes) passes through untouched.
  if (mods.alt !== "off") out = `\x1b${out}`;
  return out;
}

/**
 * Fold armed/locked sticky modifiers into one unit of input, then let the
 * caller clear armed states. Returns input unchanged when nothing is armed.
 * A stray arm never lingers: callers clear armed modifiers even when the
 * input passes through (e.g. a paste).
 */
export function applyStickyModifiers(input: string, mods: StickyModifiers): string {
  if (!hasActiveModifier(mods)) return input;
  if (input === "\t" && mods.shift !== "off") {
    // Shift+Tab is backtab; Shift is consumed by the translation itself.
    // A co-armed Ctrl still folds in as a CSI param (xterm `\x1b[1;6Z`).
    const rest: StickyModifiers = { ...mods, shift: "off" };
    if (!hasActiveModifier(rest)) return "\x1b[Z";
    return applyToSequenceOrChar("\x1b[Z", rest);
  }
  return applyToSequenceOrChar(input, mods);
}
