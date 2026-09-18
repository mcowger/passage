/**
 * iOS keyboard inset polyfill (`docs/IOS-PWA-NATIVE.md` §4).
 *
 * Every iOS browser (all WKWebView) behaves as `resizes-visual`: the
 * keyboard shrinks the *visual* viewport and pans the layout viewport, but
 * never resizes layout / `dvh` / `100vh`. `interactive-widget=resizes-content`
 * is the declarative fix, but it is implemented in WebKit source only and had
 * NOT shipped in public Safari as of 27.0 (Bramus 2026-09-11; possibly 27.1).
 * Until it ships, export the covered height as
 * `--kb-inset` and the visible shell height as `--app-height` so pinned bars
 * (composer, commit composer) can sit above the keyboard in pure CSS.
 *
 * Deliberately layout-preserving: callers offset with margin/padding, never
 * by resizing the document root synchronously inside the resize handler
 * (Safari extends the document to reveal the focused input and wins that
 * fight, producing white gaps).
 */

/** Covered height: layout height minus visible height/offset, floored at 0. */
export function computeKeyboardInset(innerHeight: number, visualHeight: number, visualOffsetTop: number): number {
  return Math.max(0, innerHeight - visualHeight - visualOffsetTop);
}

/** Shell height: full layout height when the keyboard is closed, the visible
 *  height while it is open (so a sticky/flex composer rides up with it). */
export function computeAppHeight(innerHeight: number, visualHeight: number, keyboardInset: number): number {
  return keyboardInset > 0 ? visualHeight : innerHeight;
}

function readViewport() {
  const vv = window.visualViewport;
  if (!vv) return null;
  return vv;
}

/**
 * Starts syncing `--kb-inset` / `--app-height` on `<html>`. Listens to both
 * `resize` (keyboard open/close) and `scroll` (Safari pans instead of
 * resizing to reveal the focused input), with the resize read deferred to
 * rAF because the first post-focus reading is stale. Returns a cleanup.
 */
export function initKeyboardInset(): () => void {
  const root = document.documentElement;
  const vv = readViewport();
  if (!vv) return () => {};

  let frame = 0;
  const sync = () => {
    const inset = computeKeyboardInset(window.innerHeight, vv.height, vv.offsetTop);
    root.style.setProperty("--kb-inset", `${inset}px`);
    root.style.setProperty("--app-height", `${computeAppHeight(window.innerHeight, vv.height, inset)}px`);
  };
  const syncSoon = () => {
    cancelAnimationFrame(frame);
    frame = requestAnimationFrame(sync);
  };

  sync();
  vv.addEventListener("resize", syncSoon);
  vv.addEventListener("scroll", sync);
  window.addEventListener("orientationchange", syncSoon);
  return () => {
    cancelAnimationFrame(frame);
    vv.removeEventListener("resize", syncSoon);
    vv.removeEventListener("scroll", sync);
    window.removeEventListener("orientationchange", syncSoon);
  };
}
