/**
 * iOS keyboard inset polyfill (`docs/IOS-PWA-NATIVE.md` §4).
 *
 * Every iOS browser (all WKWebView) behaves as `resizes-visual`: the
 * keyboard shrinks the *visual* viewport and pans the layout viewport, but
 * never resizes layout / `dvh` / `100vh`. `interactive-widget=resizes-content`
 * is the declarative fix, but it is implemented in WebKit source only and had
 * NOT shipped in public Safari as of 27.0 (Bramus 2026-09-11; possibly 27.1).
 * Until it ships, export the covered height as `--kb-inset` so pinned bars
 * (composer, commit composer) can sit above the keyboard in pure CSS.
 *
 * Deliberately layout-preserving: callers offset with margin/padding, never
 * by resizing the document root synchronously inside the resize handler
 * (Safari extends the document to reveal the focused input and wins that
 * fight, producing white gaps). The shell (`--app-height`) therefore always
 * tracks the *layout* height, keyboard open or not.
 */

/**
 * Minimum covered height treated as a software keyboard.
 *
 * Standalone cold start (WebKit 254868) under-reports `visualViewport.height`
 * and `env()` safe-area insets by ~top+bottom insets (~60-95px on Dynamic
 * Island iPhones, more with an expanded Island / Live Activity); rounding and
 * toolbar settle add a few px on top. A real iOS keyboard covers ~280px+,
 * so anything under the threshold is safe-area noise, not a keyboard.
 * Treating noise as a keyboard floats the composer an inch high via
 * `margin-bottom: var(--kb-inset)` and (previously) shrank the shell,
 * leaving a black slab under the composer.
 */
export const KEYBOARD_INSET_THRESHOLD_PX = 150;

/** Covered height: layout height minus visible height/offset, gated by the
 *  keyboard threshold and floored at 0. */
export function computeKeyboardInset(innerHeight: number, visualHeight: number, visualOffsetTop: number): number {
  const raw = innerHeight - visualHeight - visualOffsetTop;
  if (raw < KEYBOARD_INSET_THRESHOLD_PX) return 0;
  return Math.max(0, raw);
}

/** Shell height: always the full layout height. Never the visual height —
 *  shrinking the shell to the visible area resizes the app behind Safari's
 *  back (it pans instead of resizing) and cements the cold-start
 *  under-report into a too-short shell with a black slab below the
 *  composer. The composer rides above the keyboard via `--kb-inset` alone. */
export function computeAppHeight(innerHeight: number): number {
  return innerHeight;
}

function readViewport() {
  const vv = window.visualViewport;
  if (!vv) return null;
  return vv;
}

/**
 * Starts syncing `--kb-inset` / `--app-height` on `<html>`. Listens to
 * `visualViewport` `resize` (keyboard open/close) and `scroll` (Safari pans
 * instead of resizing to reveal the focused input) plus `window` resize
 * (toolbar collapse changes the layout height without touching the visual
 * viewport), with the resize read deferred to rAF because the first
 * post-focus reading is stale. Cold-start recovery re-reads after settle
 * (WebKit 254868 under-reports until the viewport is exercised). Safari's
 * dismiss pan sometimes sticks (fractional offset survives keyboard close,
 * blurring/shifting crisp top bars), so the open→closed transition,
 * focusout, and cold-start settle all reset the page pan via scrollTo — the
 * page itself never scrolls (shell is overflow-hidden), this only releases
 * Safari's pan. Returns a cleanup.
 */
export function initKeyboardInset(): () => void {
  const root = document.documentElement;
  // Correct shell height even where visualViewport is missing.
  root.style.setProperty("--app-height", `${computeAppHeight(window.innerHeight)}px`);
  root.style.setProperty("--kb-inset", "0px");
  const vv = readViewport();
  if (!vv) return () => {};

  let frame = 0;
  let lastInset = 0;
  let settleTimer: ReturnType<typeof setTimeout> | undefined;
  const resetPan = () => {
    try {
      window.scrollTo(0, 0);
      document.documentElement.scrollTop = 0;
      document.body.scrollTop = 0;
    } catch {
      // Non-visual environment (tests): nothing to reset.
    }
  };
  const resetPanSoon = () => {
    resetPan();
    if (settleTimer) clearTimeout(settleTimer);
    settleTimer = setTimeout(resetPan, 120);
  };
  const sync = () => {
    const inset = computeKeyboardInset(window.innerHeight, vv.height, vv.offsetTop);
    root.style.setProperty("--kb-inset", `${inset}px`);
    root.style.setProperty("--app-height", `${computeAppHeight(window.innerHeight)}px`);
    if (lastInset > 0 && inset === 0) resetPanSoon();
    lastInset = inset;
  };
  const syncSoon = () => {
    cancelAnimationFrame(frame);
    frame = requestAnimationFrame(sync);
  };
  const onOrientation = () => {
    syncSoon();
    // Rotation settles after the event; re-read once it lands.
    if (settleTimer) clearTimeout(settleTimer);
    settleTimer = setTimeout(sync, 250);
  };
  const onFocusOut = () => {
    // Keyboard closing (or focus hopping between inputs): release any pan.
    resetPan();
  };

  sync();
  vv.addEventListener("resize", syncSoon);
  vv.addEventListener("scroll", sync);
  window.addEventListener("resize", syncSoon);
  window.addEventListener("orientationchange", onOrientation);
  window.addEventListener("focusout", onFocusOut);
  // Cold-start recovery: first readings under-report per WebKit 254868, and
  // the launch pan (if any) needs releasing once the viewport is exercised.
  const coldTimer = setTimeout(() => { sync(); resetPan(); }, 500);
  const coldTimerLate = setTimeout(sync, 1500);
  return () => {
    cancelAnimationFrame(frame);
    clearTimeout(coldTimer);
    clearTimeout(coldTimerLate);
    if (settleTimer) clearTimeout(settleTimer);
    vv.removeEventListener("resize", syncSoon);
    vv.removeEventListener("scroll", sync);
    window.removeEventListener("resize", syncSoon);
    window.removeEventListener("orientationchange", onOrientation);
    window.removeEventListener("focusout", onFocusOut);
  };
}
