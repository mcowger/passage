# iOS PWA Native-App Playbook for Passage — Modern iPhones (iOS 17–26, Notch / Dynamic Island)

**Date:** 2026-09-18 | **Target:** Passage React PWA (standalone, chat/composer-heavy) on iPhone Safari / Home-Screen web clip
**Goal:** Use 100% of usable screen, kill unexpected zoom + pull-to-refresh, tame keyboard layout shift, feel native.

## Scope: iOS 27.0 only

This playbook targets **iOS 27.0 (Safari + Home-Screen PWA) exclusively**. No fallbacks for older iOS, Android, or desktop beyond what costs nothing (a `100vh` line, a meta token). Consequences, verified Sept 2026:

- **`interactive-widget` is NOT shippable on 27.0.** Implemented in WebKit source mid-Aug 2026 (PR 70058), confirmed working only in MobileMiniBrowser; no public Safari or Safari Technology Preview ships it — earliest hope is 27.1 (Bramus 2026-09-11; Engineered.at; html.to). The meta token stays (ignored = harmless progressive enhancement) and the `visualViewport` → `--kb-inset` polyfill stays **required**, not optional.
- **`viewport-fit=cover` handling is still required** — broken since Safari 26 and still broken per Bramus Sept 2026. Keep `viewport-fit=cover` + `env()` + the `100vh`-over-`100dvh` cold-start ordering (WebKit 254868).
- **`theme-color` meta is still ignored** on iOS 26/27 (Liquid Glass derives chrome from `body`/fixed-element backgrounds). Keep the meta for other engines; let `body` bg drive iOS chrome.
- **Scroll anchoring is new in 27.0** (`overflow-anchor: auto` default; WebKit blog 2026-09-17; WWDC26 session 204). Passage owns timeline scroll (pinned-tail autoscroll + backfill compensation), so `.timeline` sets `overflow-anchor: none` to avoid double-compensation with the native behavior.
- 27.0 also fixed fixed/nested anchor-positioned scroll overcompensation and viewport-meta parsing edge cases (Safari 27 release notes) — no Passage changes needed (composer is sticky, not fixed).

## Implementation status (Passage, 2026-09-18)

Done in-tree:
- `index.html`: zoom-blocking viewport removed → `width=device-width, initial-scale=1, viewport-fit=cover, interactive-widget=resizes-content`; `theme-color` light/dark pair + `color-scheme` + `mobile-web-app-capable`.
- `manifest.webmanifest`: `id`/`scope`/`start_url: /?source=pwa`.
- Shell (`tokens.css`): `100vh` fallback + `--app-height`, `overscroll-behavior: none`, `touch-action: manipulation`, tap-highlight off, text-size-adjust 100%, 16px input floor on coarse pointers.
- Keyboard (`lib/keyboard-inset.ts`, wired in `main.tsx`): visualViewport `resize`+`scroll` → `--kb-inset`/`--app-height`; composer + commit-composer ride via `margin-bottom: var(--kb-inset)`.
- Paint-vs-inset: composer/commit-composer/sheet paddings use `max(room, env())`, backgrounds bleed to the edge.
- Composer editor 13.5px → 16px on coarse pointers (no focus zoom; desktop unchanged).

Still open (need binaries/device): PNG `apple-touch-icon` 180 + manifest 192/512/maskable (only SVG ships — iOS pre-15.4 ignores SVG icons); per-size `apple-touch-startup-image` splash or runtime generator; custom Share-sheet install coaching (no `beforeinstallprompt` on iOS); real-device checklist §7 (cold start, rotation, keyboard, Live Activities, iOS 26 tint).

> TL;DR baseline is in §0. Details + why + trade-offs follow. All recommendations tested against 2024–2026 sources; WebKit bugs still open are called out.

---

## 0. Recommended baseline (copy-paste)

### 0.1 HTML head

```html
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover, interactive-widget=resizes-content" />
<!-- maximum-scale=1 / user-scalable=no intentionally OMITTED — see §2 -->
<meta name="mobile-web-app-capable" content="yes" />
<meta name="apple-mobile-web-app-capable" content="yes" />
<meta name="apple-mobile-web-app-status-bar-style" content="black-translucent" />
<meta name="apple-mobile-web-app-title" content="Passage" />
<meta name="theme-color" content="#0F1218" />
<meta name="theme-color" content="#0F1218" media="(prefers-color-scheme: dark)" />
<meta name="color-scheme" content="light dark" />
<link rel="manifest" href="/manifest.webmanifest" />
<link rel="apple-touch-icon" sizes="180x180" href="/icons/apple-touch-icon-180.png" />
<!-- splash: generate per-size apple-touch-startup-image OR runtime generator (see §1.6) -->
```

`manifest.webmanifest`:
```json
{
  "name": "Passage",
  "short_name": "Passage",
  "display": "standalone",
  "start_url": "/?source=pwa",
  "scope": "/",
  "background_color": "#0F1218",
  "theme_color": "#0F1218",
  "icons": [
    { "src": "/icons/192.png", "sizes": "192x192", "type": "image/png" },
    { "src": "/icons/512.png", "sizes": "512x512", "type": "image/png", "purpose": "any" },
    { "src": "/icons/maskable-512.png", "sizes": "512x512", "type": "image/png", "purpose": "maskable" }
  ]
}
```

Why this exact set:
- `viewport-fit=cover` is **the master switch** — without it all `env(safe-area-inset-*)` are `0px` and iOS letterboxes content (WebKit safe-area demo; MDN viewport-fit; WWDC21 Design for Safari 15).
- `display: standalone` (+ legacy `apple-mobile-web-app-capable`) is the only way to drop Safari chrome on iPhone — `requestFullscreen()` is iPad-only, `display: fullscreen/minimal-ui` silently fall back to `standalone` on iOS (game-guide gist; firt.dev PWA-iOS table; OpenPWA iOS install ref).
- `black-translucent` is still the **only** way to get true edge-to-edge behind the status bar; `default`/`black` letterbox content below an opaque bar, and the tag is read at **install time** — existing installs must delete/re-add to pick up changes (piclaw PWA.md failure log 2026-05-11; Apple Configuring Web Applications).
- `interactive-widget=resizes-content` is declared for the day WebKit ships it (in source, not in Safari 27.0 — see Scope) and works where supported today; on iOS 27.0 it is ignored, so you still need the JS polyfill in §4 (Bramus 2026-09-11; Artur Basak 2026-06-26; WebKit bug 259770).
- Keep `theme-color` for Chrome/Android + PWA splash, but **do not rely on it for iOS 26 Safari chrome** — see §1.5.

### 0.2 CSS shell

```css
/* App shell owns the full screen. Only inner panes scroll. */
html, body {
  margin: 0; padding: 0;
  height: 100vh; /* NOT 100% or 100dvh alone — see §1.3 cold-start bug */
  height: 100dvh; /* progressive: browsers that handle it correctly use dynamic */
  overflow: hidden;
  overscroll-behavior: none;
  background: #0F1218; /* = theme + rubber-band + iOS26 toolbar sample */
  touch-action: manipulation; /* kill double-tap zoom delay, keep pan+pinch */
  -webkit-text-size-adjust: 100%;
  -webkit-tap-highlight-color: transparent;
}
#app {
  height: 100vh; height: 100dvh;
  height: var(--app-height, 100dvh); /* JS-corrected — see §1.3 */
  display: flex; flex-direction: column;
  overflow: hidden;
  /* NEVER position:fixed on body/#app on current iOS — clips shell (see §1.3) */
}
.scroll-area {
  flex: 1; min-height: 0;
  overflow-y: auto;
  -webkit-overflow-scrolling: touch;
  overscroll-behavior: contain;
}
/* Safe-area consumers — paint background edge-to-edge, pad content */
.header {
  padding-top: env(safe-area-inset-top, 0px);
  padding-left: max(16px, env(safe-area-inset-left));
  padding-right: max(16px, env(safe-area-inset-right));
}
.tabbar, .composer {
  padding-bottom: max(12px, env(safe-area-inset-bottom));
  padding-left: max(16px, env(safe-area-inset-left));
  padding-right: max(16px, env(safe-area-inset-right));
}
/* Inputs: the 16px rule */
input, select, textarea {
  font-size: 16px; /* prevents iOS auto-zoom on focus */
  line-height: 1.25;
}
/* Native feel */
button, a { touch-action: manipulation; }
.no-callout { -webkit-touch-callout: none; -webkit-user-select: none; user-select: none; }
```

### 0.3 JS shell (keyboard + viewport correction)

```js
// --app-height + --kb-inset — polyfill for interactive-widget on iOS
const vv = window.visualViewport;
function syncViewport() {
  if (!vv) return;
  // keyboard inset = layout height minus visible height/offset
  const inset = Math.max(0, window.innerHeight - vv.height - vv.offsetTop);
  document.documentElement.style.setProperty('--kb-inset', inset + 'px');
  // keep shell sized to *visible* height while typing, full height otherwise
  // (use innerHeight when keyboard closed; vv.height when open — see §4)
  const appH = inset > 0 ? vv.height : window.innerHeight;
  document.documentElement.style.setProperty('--app-height', appH + 'px');
  // pin composer above keyboard without resizing whole page
  document.documentElement.style.setProperty('--kb-offset', inset + 'px');
}
if (vv) {
  vv.addEventListener('resize', () => requestAnimationFrame(syncViewport));
  vv.addEventListener('scroll', syncViewport); // Safari PANS, not just resizes
}
window.addEventListener('orientationchange', () => setTimeout(syncViewport, 200));
syncViewport();

.composer {
  position: sticky; /* or fixed */
  bottom: calc(var(--kb-inset, 0px) + env(safe-area-inset-bottom));
}
```

That is 80% of "native feel." The rest of this doc explains *why* each line exists and what to do when it breaks.

---

## 1. How much screen can you use?

### 1.1 Standalone = full screen minus system-reserved insets

| Mode | Chrome | Usable height | Notes |
|---|---|---|---|
| Safari tab | URL bar + toolbar (~79px+) + status bar | dynamic | `100vh` ≠ visible; use `100dvh` / `visualViewport.height` |
| Home-Screen PWA (`display: standalone`) | **none** — only status bar (theoretically transparent with `black-translucent`) | fixed, predictable | `100vh` ≈ `100dvh` ≈ `innerHeight` once settled; storage/cookies **isolated** per PWA; killed on background (restart from scratch); links out-of-scope open Safari View Controller |

Sources: iPhone game-guide gist (Safari vs PWA table); OpenPWA iOS Add-to-Home-Screen ref (display/browser vs standalone behavior, scope, install tied to installing browser since iOS 16.4); WWDC23 What's New in Web Apps (standalone, scope, storage separation); firt.dev iOS PWA compatibility tables.

**Passage implication:** build your own nav/back — there is no browser back button in standalone. Detect with `navigator.standalone === true` (iOS authoritative) OR `matchMedia('(display-mode: standalone)').matches` (cross-platform; unreliable alone on iOS — piclaw §10). Gate install-banner UI on *not* standalone.

### 1.2 `viewport-fit=cover` + `env(safe-area-inset-*)` = edge-to-edge done right

- Without `viewport-fit=cover`, `env(safe-area-inset-*)` = `0px` everywhere and Safari letterboxes (WebKit iPhone-X guide; gist §1).
- With it, content paints **behind** notch/Dynamic Island/rounded corners/home indicator. You then:
  - Let backgrounds bleed (header/tabbar/composer backgrounds extend to physical edge).
  - Pad *content* with `env()`: `padding-top: env(safe-area-inset-top)` for headers; `padding-bottom: max(12px, env(safe-area-inset-bottom))` for bottom bars; left/right in landscape (WWDC21 Design for Safari 15 session; Progressier safe-area simulator).
  - Typical values on Dynamic-Island iPhone PWA: top ~59px, bottom ~34px (vs ~8px each in Safari tab where browser chrome absorbs the cutout — piclaw comparison table).
  - Use `max()` minimums so no-notch devices still get breathing room, and add ≥20px top buffer in landscape games/HUD where `safe-area-inset-top` can report 0 (game-guide gist §4).
  - `env()` is safe on Android/desktop — resolves to `0px` where unsupported.

Do NOT put blanket `padding-bottom: env(...)` on `body` — the shell should reach the physical bottom; inset only the bars that touch edges (piclaw §5; StackOverflow 79902310 white-gap thread: `100dvh + env(safe-area-inset-bottom)` shell pattern).

### 1.2b Paint vs inset — some content *should* go into the safe area

The rule is not "avoid the safe area." It is: **paint backgrounds edge-to-edge; inset interactive content.**

- The home-indicator zone (~34px) is translucent — a solid container background bleeding behind it looks native; a white/black letterbox gap looks broken.
- What must clear the indicator: text, input caret, send button hit-target. What should bleed: container/card backgrounds, blur, borders.
- Pattern: outer bar `background: var(--background)` extends to `bottom: 0` with `padding-bottom: max(breathing-room, env(safe-area-inset-bottom))`; inner card keeps its own radius/margin. Never `calc(room + env())` — that double-stacks whitespace and floats the bar too high.
- Passage composer is the canonical case: `.composer-container` (sticky `bottom: 0`, shell background) bleeds to the physical edge while `.composer-card` floats `max(8–10px, env(safe-area-inset-bottom))` above the indicator. Slight tightening there (replacing `calc(10px + env())` with `max(8px, env())`) drops ~10px of dead gap and reads as native without risking hit-target overlap — the indicator is a swipe zone, not a tap zone, so a card edge sitting just above it is correct.

### 1.3 The `100vh` vs `100dvh` cold-start trap (iOS PWA bug)

This is the #1 "white gap / clipped composer" root cause:

- **Safari tab:** `100vh` includes area behind toolbar (too tall). `100dvh` (iOS 15.4+) tracks visible height correctly. Prefer `100dvh` / `window.innerHeight` for canvas sizing.
- **Standalone PWA cold start:** WebKit bug 254868 (open since 2023-04-01, still reported on iOS 18.3.1): `100svh`, `-webkit-fill-available`, `visualViewport.height`, and `env()` insets under-report by exactly `safe-area-inset-top/bottom` on fresh launch (force-quit / reboot / first install). `100vh` is the **only** unit correct from cold start; `100dvh` self-corrects only after rotation or viewport "exercise." `height: 100%` breaks `viewport-fit=cover` entirely.
- **Second trap (iOS 26.x):** `position: fixed` on root `body`/`#app` turns it into a viewport-sized clipping box that truncates the composer/timeline (piclaw 2026-05-11 update). Fix: keep `body`/`#app` in **normal flow** (`overflow: hidden`, flex column) + JS `scrollTo(0,0)` resets on focus (see §4). The `pwa-safezone` library documents the same class of bug from the opposite direction (`position:fixed; inset:0` detaching layout viewport → oversized `innerWidth`, e.g. 524 vs 393) and puts its scroll-lock on `html` only, gated behind `display-mode: standalone`.

**Passage rule:**
```css
#app { height: 100vh; height: var(--app-height, 100dvh); }
```
- CSS fallback `100dvh` correct for browser mode; JS override to `100vh`-derived px correct for standalone cold start (piclaw §3 strategy).
- Optional hardening: toggle `viewport-fit` auto→cover on standalone launch to force `env()` recalc (game-guide probing workaround), plus staggered `requestAnimationFrame`/timeout re-syncs. Test cold start explicitly: install → force-quit → launch → check insets immediately.

Also note iOS 26 regression 301108: `viewport-fit=cover` / `height=device-height` misbehave with the new see-through/liquid-glass address bar. If full-bleed breaks after an iOS 26 update, check that bug first.

### 1.4 Status bar

- `apple-mobile-web-app-status-bar-style: black-translucent` + `viewport-fit=cover` = content behind transparent status bar; you own `padding-top` (piclaw §4). `default`/`black` = opaque bar, content starts below.
- Tag is cached at **install time** — server change alone doesn't update existing installs.
- firt.dev recommends `theme-color` over status-bar-style since iOS 15, **except** `black-translucent` remains the only fullscreen path — keep both.

### 1.5 `theme-color` is dead on iOS 26 Safari (keep it anyway)

- iOS 26 (Sept 2025, Liquid Glass) **ignores** `<meta name="theme-color">` in Safari browser mode. Chrome derives toolbar from `background-color` of fixed/sticky elements near viewport edges (within ~4px top / 3px bottom, ≥80% wide, ≥3px high) falling back to `body` background, sampled at initial render — JS changes afterward don't re-tint (Ben Nasedkin 2026-01-15; Jahir Fiquitiva 2026-03-03; Ben Frain 2025-11-16; ThatDevPro theme-color ref 2026-05-25; Apple Dev Forums thread 801239; Medienbäcker "Web Behind Glass" 2025-09-08).
- **Fix:** set `body { background-color: <brand> }` to match desired chrome + design fixed headers knowing their bg *is* the toolbar color. Avoid transparent fixed-element bgs (unpredictable sampling), avoid `background` shorthand resetting `background-color` to transparent, and watch `dialog`/`popover` fixed elements hijacking tint (Frain bug 302272, dup of 300965, fix hoped in 26.2).
- Keep `theme-color` meta + manifest `theme_color`/`background_color` anyway: Chrome/Android, PWA splash, and pre-26 iOS still honor them. Match meta ↔ manifest ↔ `body` bg to avoid splash-flash mismatch (Joel.net install-experience guide).

### 1.6 Icons & splash

- Manifest `icons` ignored pre-15.4; `apple-touch-icon` link overrode manifest even after (firt.dev). Ship **both**: 180×180 `apple-touch-icon` (no transparency — filled black/white otherwise) + 192/512 manifest (+ maskable for Android).
- iOS splash: auto-composed from `background_color` + icon on modern iOS; precise per-size control still requires `apple-touch-startup-image` links per resolution (Netguru 6 Tips, updated Feb 2026; Progressier generator; `ios-pwa-splash-screen` runtime generator; Kool Codez 2025-11-13). Match splash bg to app shell bg for seamless launch. Note landscape splash quirk: Safari stretches portrait art (Progressier docs).
- No `beforeinstallprompt` on iOS — show custom "Share → Add to Home Screen" coaching, keyed off `navigator.standalone` / iOS UA (OpenPWA; Joel.net `initInstallPrompt` pattern; Derkonline 2026-03-02).

---

## 2. Preventing unexpected zoom

Three distinct zooms, three fixes. Do all three.

### 2.1 Auto-zoom on input focus (the big one)

iOS Safari auto-zooms any `input`/`select`/`textarea` whose **computed** `font-size` < `16px`, and stays zoomed until pinch-out/double-tap (Rick Strahl 2023-04-17; HumansFix.ai Bolt guide 2026-03-14; Codegenes roundup).

Fix (accessible, recommended):
```css
input, select, textarea { font-size: 16px; line-height: 1.25; padding: 12px 16px; }
```
- Check *computed* size — parent `14px` cascading into inputs still triggers it; use `text-base md:text-sm`-style responsive tokens if desktop design wants smaller.
- Small `height`/padding can still trigger on old Safari even at 16px — keep ≥ ~24px+ vertical box.
- Alternative hack: `maximum-scale=1` suppresses auto-zoom even with small fonts (iOS honors it for *auto* zoom while still allowing manual pinch — unlike Android where it hard-blocks pinch). Selective iOS-only injection preserves Android pinch. But it trips Lighthouse/WCAG and is belt-and-suspenders at best — keep the 16px sweep as primary (Strahl; audiocontrol/deskwork commit d2fed62 2026-05-09 combines both as defense-in-depth: `width=device-width, initial-scale=1, maximum-scale=1, interactive-widget=resizes-content`).

**Passage recommendation:** 16px everywhere on inputs + keep `maximum-scale=1` **out** of the default meta for accessibility; add it only if QA proves residual auto-zoom on legacy sizes. Never ship `user-scalable=no` globally (WCAG 1.4.4 requires 200% zoom; Apple docs note it also blocks scroll-into-view on input).

### 2.2 Double-tap-to-zoom

```css
html, body { touch-action: manipulation; }
```
is the modern contract: enables pan + pinch, disables double-tap zoom + click-delay (MDN `touch-action`; TheLinuxCode 2026-02-06). Scope broader `pan-x pan-y` (blocks pinch AND double-tap) only to maps/game surfaces, never globally — `touch-action: none` globally breaks scroll + accessibility.

Safari caveats: `touch-action: manipulation` on `*` alone is unreliable in old threads; the robust combo is viewport + `touch-action` + (if needed) `touchend` 300–500ms double-tap `preventDefault` guard or `document.ondblclick = e => e.preventDefault()` (StackOverflow 79157684, 2024-11-05). Verify on-device; don't ship the JS guard unless double-tap zoom reproduces with CSS alone.

### 2.3 Pinch-zoom

Modern iOS (10+) **intentionally ignores** `user-scalable=no` / `maximum-scale=1` for manual pinch (accessibility release note). Only `touch-action: pan-x pan-y` (no `pinch-zoom`) or `gesturestart → preventDefault()` / `touchmove` `e.scale !== 1 → preventDefault()` reliably blocks it (StackOverflow 4389932; paulau.dev 2026-01-22).

**Don't block pinch globally.** Passage is a reading/typing app — blocking pinch violates WCAG and Apple HIG. Only lock gestures inside CodeMirror/xterm canvases that implement their own zoom/pan:
```css
#map-canvas, .code-surface { touch-action: pan-x pan-y; }
```

Also set `-webkit-text-size-adjust: 100%` (not `none` — `none` breaks accessibility text scaling) to stop auto inflation without disabling user zoom.

---

## 3. Pull-to-refresh, rubber-banding, scroll chaining

### 3.1 The CSS answer (ship this)

```css
html, body { overscroll-behavior: none; }
.scroll-area { overscroll-behavior: contain; }
```
- `contain` on the scroller = no scroll chaining, no pull-to-refresh, keeps local bounce/glow. `none` = also kills local bounce (MDN `overscroll-behavior`; Chrome Dev Blog "Take control of your scroll"; CSS Overscroll spec 2026-04-30).
- iOS support: Baseline since ~2022 / iOS 16+. Older iOS (9–15) ignores it — see JS fallback below. Note iOS **standalone PWA disables native pull-to-refresh entirely**; if you *want* PTR in installed mode you must reimplement (e.g. pulltorefresh.js gated on `navigator.standalone` — StackOverflow 75972895).
- Preserve swipe-nav choice deliberately: `overscroll-behavior-y: contain` kills PTR but keeps x-swipe nav; `overscroll-behavior: contain` (both axes) kills both (WebDevRedFox 2026-01-28).

### 3.2 The layout answer (required for app feel)

Make the **document non-scrolling**; scroll only inner panes (Codemia 2025-09-23; Tutorialpedia iPad guide 2025-12-18):

```css
body { height: 100vh; height: 100dvh; overflow: hidden; }
.scroll-area { flex:1; overflow-y: auto; -webkit-overflow-scrolling: touch; }
```
- Fixes: fixed header/footer jitter during viewport recalcs (Marketur WordPress PWA fix 2026-03-03 — inject nav at viewport level via footer hook, `position: fixed` + in-container `env()` + spacer, activate only in standalone).
- Fixed elements stay put during overscroll per spec (CSS Overscroll §4); `sticky` unsticks past its container — prefer `fixed` for tab bars overlapped by keyboard handling in §4.

### 3.3 The JS fallback (older iOS / surgical control)

`{ passive: false }` + selective `preventDefault` — allow touches starting in `.scroll-area`, block page-level bounce, including edge-of-inner-scroller (at-top-pull-down / at-bottom-pull-up) checks via `scrollTop`/`scrollHeight`/`clientHeight` + touch delta/angle (StackOverflow 10357844; Codemia; Tutorialpedia). Classic `iNoBounce` still works on iOS 15 where CSS doesn't (StackOverflow 69261011 + Safari 9–15 vs 16+ media-query split).

Pitfalls: blanket `touchmove → preventDefault` kills inner scroll; forgetting `passive:false` makes Safari ignore the call; desktop emulation doesn't reproduce rubber-band physics — test on-device.

**Passage rule:** CSS `overscroll-behavior` + locked-body/inner-scroller now; add selective-touchmove guard only if QA on iOS 15–16 repros bounce. Set `body` bg = brand so any residual rubber-band flash matches chrome (§1.5).

---

## 4. Keyboard showing → layout shift (the hard one)

### 4.1 Mental model

- Every iOS browser (Safari, Chrome/Firefox/Edge-on-iOS — all WKWebView) behaves as **`resizes-visual`**: keyboard shrinks the *visual* viewport, pans the *layout* viewport to reveal the focused input, but does **not** resize layout/`100dvh`/`100vh`/ICB. Fixed bottom bars get covered unless you move them (Bramus explainer; Basak 2026-06-26).
- Chrome/Firefox on Android default to **`resizes-content`** (layout shrinks, `dvh` recomputes, flex reflows). `interactive-widget=resizes-content|overlays-content|resizes-visual` in the viewport meta lets authors choose — Chrome 108+, Firefox 132+ (Engineered.at 2024-12-04; Chrome viewport-resize-behavior blog).
- **iOS 27.0 does not support `interactive-widget` at all** — WebKit bug 259770 (2023-08-03, still open) is implemented in source only, unshipped in public Safari (Bramus 2026-09-11). Earlier guides claiming "16+ supports it" were aspirational; always ship the JS path. Re-check on 27.1+.

### 4.2 The polyfill Passage should ship (visualViewport → CSS var)

Don't fight Safari by resizing `documentElement` synchronously in the `resize` handler — Safari extends the document to make room for the input and wins, causing white gaps/crashes (StackOverflow 78844736 top answers). Instead **leave layout alone; export the keyboard inset**:

```js
const vv = window.visualViewport;
function syncKeyboardInset() {
  const inset = Math.max(0, window.innerHeight - vv.height - vv.offsetTop);
  document.documentElement.style.setProperty('--kb-inset', inset + 'px');
}
vv.addEventListener('resize', () => requestAnimationFrame(syncKeyboardInset));
vv.addEventListener('scroll', syncKeyboardInset); // ← critical: Safari pans
```
```css
.composer { position: fixed; bottom: calc(var(--kb-inset, 0px) + env(safe-area-inset-bottom)); }
```
- Listen to **both** `resize` and `scroll` (`offsetTop` changes on pan without resize); re-read in `rAF` (first reading is stale post-focus) (SO 78844736 second answer).
- Degrades gracefully: where `resizes-content` works, inset = 0 → no-op. Ship meta + JS together.
- Basak hook variant (`useVisualViewportHeight` → container `height: vv.height`) suits full-screen editors; `--kb-inset` variant suits pinned composer/toolbar — Passage wants the latter.
- Sparka correction (2025-08-26): naive `vv.height → CSS var → height` observers cause loops; prefer `dvh` + minimal JS. Keep JS to inset + `--app-height` only.

Supplemental Safari-specific tricks (use sparingly):
- `:focus { animation: opacity 0.1s 0→1 }` on inputs suppresses Safari's viewport-shift animation (SO 78844736).
- `touch-action: none` on `body` + `pan-*` on content root stops Safari interpreting overscroll during keyboard transitions.
- Aggressive `scrollTo(0,0)` on `focusin`/`focusout`/vv-scroll at 16/50/100/200ms when root is *not* fixed (piclaw hybrid strategy) — needed precisely because we can't use fixed root (§1.3).
- Dev.to 2025-01-26 `keyboardWillShow`/`paddingBottom` sketch uses non-standard events — do not copy verbatim; `visualViewport` is the standard signal.

### 4.3 Composer/UX details

- Keep composer `position: fixed`/`sticky bottom-0` + `bottom: var(--kb-inset) + safe-area`; keep messages in `.scroll-area` with `keyboard-dismiss` affordance; never let `body` scroll (else `sticky` scrolls behind keyboard — WorldBank FE-007).
- `inputmode`, `enterkeyhint="send"`, `autocomplete` reduce keyboard mode switches; CodeMirror surfaces need explicit `blur`/`scrollIntoView({block:'nearest'})` handling — test editor + chat composer separately (deskwork d2fed62 live-verify list).
- Validate greeting/empty state + scrolled state + landscape + hardware keyboard + dictation heights; keyboard height varies (~300px default, larger with suggestions/emoji).

---

## 5. Other native-feel essentials

| Detail | Do | Why |
|---|---|---|
| Tap feedback | `-webkit-tap-highlight-color: transparent` + custom `:active` states | Removes gray flash; custom press states feel native |
| Callout/selection | `-webkit-touch-callout: none; user-select: none` on chrome/nav/icons; keep `user-select: text` in messages/code/terminal | Stops long-press "Copy/Lookup" on buttons while preserving content copy |
| Momentum scroll | `-webkit-overflow-scrolling: touch` on scrollers | Native-feel inertia on iOS (Codemia) |
| Click delay | `touch-action: manipulation` | Removes 300ms tap delay legacy |
| Fonts | `system-ui, -apple-system` stack; `16px` min on inputs | Native type feel + no focus zoom |
| Icon/back | In-app back + swipe-safe layout (left-edge swipe = Safari back) | No browser chrome in standalone (Derkonline) |
| Offline/shell | App shell that never shows blank spinner; service worker scoped to `/`; `start_url`/`scope`/`id` set | Standalone kills on background — relaunch must be instant (Joel.net; WWDC23 scope rules) |
| Storage | Expect per-PWA isolated storage, 7-day cap pressure, re-login after install | Tell user; persist drafts locally (Derkonline test-on-device warning) |
| Haptics/selection | Prefer native `<select>`, `<input>` where possible | Free OS pickers, a11y, perf (Kool Codez) |
| Dark mode | `color-scheme: light dark` + `theme-color` media variants + body-bg match | Correct form controls + iOS26 chrome (ThatDevPro patterns A/B) |
| Motion | `prefers-reduced-motion` respected; 60fps transforms, no layout thrash on keyboard events | Keyboard handlers run per-frame — keep them to CSS-var writes |

---

## 6. Passage-specific recommendations (prioritized)

1. **Ship §0 baseline** (meta + shell + `--kb-inset` sync) behind no flag — it fixes notch/zoom/PTR/keyboard in one pass.
2. **Fix shell height to `--app-height`** with `100vh` cold-start override; remove any `position:fixed` on `body`/`#app`; move scroll to `.scroll-area` panes (chat timeline, file list, terminal alt-buffer separately).
3. **Sweep inputs to 16px** (chat composer, CodeMirror search, settings forms, command palette `cmdk` input). Audit computed sizes — Tailwind `text-sm` on inputs is the usual culprit.
4. **Pin composer with `--kb-inset + safe-area`**; add `focusin/focusout` `scrollTo(0,0)` resets if QA shows Safari panning the page under the keyboard.
5. **Set `body` bg = `theme_color` = `background_color`**; audit fixed/sticky elements near edges for iOS 26 tint hijack (especially modals/`dialog`/`popover`/toasts). Add Jahir-style hidden tint element only if brand chrome proves impossible otherwise.
6. **Generate icons + splash** (180 apple-touch-icon + manifest 192/512/maskable + startup images or `ios-pwa-splash-screen` runtime) and custom Share-sheet install coaching (no `beforeinstallprompt` on iOS).
7. **Add in-app nav/back** and scope discipline (`start_url`/`scope`/`id`); external links → `_blank`/Safari, never trap user without back.
8. **Test matrix (§7)** on real iPhone standalone cold start, keyboard, rotation, Live Activities/Dynamic Island expansion, background kill/relaunch.

Out of scope but noted: Web Push on iOS requires standalone + user install (WWDC23) — file separately from layout work.

---

## 7. Test checklist (real device, standalone installed PWA)

- [ ] Cold start (install → force-quit → launch): no white gap, header clears Dynamic Island, tabbar/composer flush to bottom, `env()` non-zero.
- [ ] Rotate portrait↔landscape ×3: canvas + `env()` + touch coords correct; landscape top buffer ≥20px.
- [ ] Tap every input: no auto-zoom, no horizontal slosh afterward; pinch-zoom still available (a11y).
- [ ] Rapid taps on CTAs: no double-tap zoom; no 300ms lag.
- [ ] Pull down at top / up at bottom of each pane: no page refresh, no rubber-band page shift; inner scrollers still bounce naturally.
- [ ] Keyboard open/close on composer + CodeMirror + empty state: composer stays above keyboard + home indicator; no header-off-screen, no white slab under footer, no stuck dual-scroll (CSSWG 10464 symptoms).
- [ ] Background/foreground + reboot: state restores, layout correct, no re-login surprise (or messaged).
- [ ] Active Live Activity / expanded Dynamic Island + dark/light + tint-disabled (Settings → Safari → Tabs → Allow Website Tinting off): chrome still legible.
- [ ] iOS 26 liquid-glass scroll: toolbar tint follows header/body sanely; no penalty-bar; overscroll color = body bg.

---

## Sources (recent first; primary sources preferred)

- Artur Basak — Measuring the visible part of the viewport (2026-06-26) — layout vs visual viewport, `interactive-widget` table, `visualViewport` hook. https://arturbasak.dev/garden/viewport_en
- audiocontrol-org/deskwork commit d2fed62 (2026-05-09) — `maximum-scale=1 + interactive-widget=resizes-content` + 16px defense-in-depth. https://github.com/audiocontrol-org/deskwork/commit/d2fed62c548801c6295c53361b45a3d9e388c0b7
- ThatDevPro — HTML meta theme-color: iOS 26 Safari Fix + Dark Mode (2026-05-25) — iOS26 ignores theme-color, body-bg fix. https://www.thatdevpro.com/reference/html-meta-theme-color/
- piclaw docs/PWA.md (2026-05-11 root-body update) — standalone vs Safari table, `100vh`-over-`100dvh`, no-fixed-root, scroll-reset hybrid. https://github.com/rcarmo/piclaw/blob/main/docs/PWA.md
- Marketur — Fixed Bottom Navigation in WordPress PWA (iOS Fix) (2026-03-03) — viewport recalcs, injection-point isolation. https://marketur.net/fixed-bottom-navigation-wordpress-pwa/
- Derkonline — Build a PWA That Feels Native on iOS Despite Safari's Limits (2026-03-02) — standalone, safe areas, back button, test-on-device. https://derkonline.com/blog/pwa-that-feels-native-on-ios
- Jahir Fiquitiva — How to correctly tint Safari's toolbar in iOS 26 (2026-03-03) — fixed-element tint requirements + Safari-26-only selector. https://jahir.dev/blog/safari-toolbar
- HumansFix.ai — Form Inputs Zooming on iOS Fix Guide (2026-03-14) — 16px rule, Tailwind `text-base md:text-sm`. https://humansfix.ai/guides/bolt/form-inputs-zooming-ios
- TheLinuxCode — How to Disable Zoom on Mobile (2026-02-06) — viewport is master switch, CSS only tunes gestures. https://thelinuxcode.com/how-to-disable-zoom-on-a-mobile-web-page-using-css-what-actually-works-in-2026/
- paulau.dev — Disable Pinch Zoom on iOS Safari (2026-01-22) — `touch-action: pan-x pan-y`, modern Safari ignores `user-scalable=no`. https://paulau.dev/blog/disable-pinch-zoom-on-ios-safari/
- WebDevRedFox — Let's Stop Misusing overscroll-behavior (2026-01-28) — `contain` vs y-only, don't kill x-swipe nav. https://webdevredfox.org/post/lets-stop-misusing-overscroll-behavior
- Ben Nasedkin — Why iOS 26 Safari Toolbar Colors Work Differently (2026-01-15) — Liquid Glass derivation, render-time sampling. https://nasedk.in/blog/ios26-safari-toolbar-colors/
- Kool Codez — How Close Can a PWA Get to Native? (2025-11-13) — icons/manifest/Apple tags/splash at runtime. https://koolcodez.com/blog/how-close-can-a-pwa-get-to-a-native-app/
- Ben Frain — iOS26 Safari theme-color/tab-tinting with fixed elements (2025-11-16) — popover/dialog tint hijack, WebKit 302272/300965. https://benfrain.com/ios26-safari-theme-color-tab-tinting-with-fixed-position-elements/
- WebKit bug 301108 (2025-10-20) — iOS 26 `viewport-fit=cover`/`device-height` regression. https://bugs.webkit.org/show_bug.cgi?id=301108
- Codemia — Disable overscroll but allow scrollable divs (2025-09-23) — locked page + inner scroller + selective touchmove. https://codemia.io/knowledge-hub/path/ios_safari__how_to_disable_overscroll_but_allow_scrollable_divs_to_scroll_normally
- Medienbäcker — The web behind glass (2025-09-08, upd. 26.1) — Liquid Glass extremes, single-color, bottom-fixed avoidance. https://medienbaecker.com/articles/the-web-behind-glass
- Sparka/Francisco Moretti — Fix mobile keyboard overlap with VisualViewport (2025-08-25, corr. 08-26) — prefer `dvh`, drop naive observers. https://dev.to/franciscomoretti/fix-mobile-keyboard-overlap-with-visualviewport-3a4a
- StackOverflow 79902310 (2025) — iOS PWA white gap, `100dvh` minus safe-area, `100dvh + env()` shell fix. https://stackoverflow.com/questions/79902310/
- dev.to 0x2e — iOS Safari viewport bug fix practical guide (2025-01-26) — `interactive-widget` polyfill sketch. https://dev.to/0x2e_tech/ios-safari-viewport-bug-fix-a-practical-guide-14hp
- Engineered.at — Control Viewport Resize with interactive-widget (2024-12-04) — resizes-visual/content/overlays semantics, Chrome 108+/FF 132+. https://engineered.at/articles/control-the-viewport-resize-behavior-on-mobile-with-interactive-widget
- StackOverflow 79157684 (2024-11-05) — disable double-tap zoom on Safari mobile, `touchend` guard. https://stackoverflow.com/questions/79157684/
- StackOverflow 78844736 (2024-08-07) — polyfill `interactive-widget=resizes-content` on iOS, `--kb-inset` pattern + `:focus` animation trick. https://stackoverflow.com/questions/78844736/
- Bramus — Viewport Resize Behavior explainer (spec) — layout vs visual viewport, three widget modes. https://github.com/bramus/viewport-resize-behavior/blob/main/explainer.md
- WebKit PR 70058 — implement `interactive-widget=resizes-content` (flag, unshipped). https://github.com/WebKit/WebKit/pull/70058
- WebKit bug 259770 (2023-08-03–present) — implement interactive-widget; no shippable opt-out. https://bugs.webkit.org/show_bug.cgi?id=259770
- WebKit bug 254868 (2023-04-01–present, conf. 18.3.1) — wrong heights with `viewport-fit=cover` in installed apps. https://bugs.webkit.org/show_bug.cgi?format=multiple&id=254868
- CSSWG issue 10464 — will resizes-content fix fixed header/footer + OSK? (YES, when shipped). https://github.com/w3c/csswg-drafts/issues/10464
- CSS Overscroll Behavior Level 1 (2026-04-30 draft) — `contain` vs `none`, fixed/sticky during overscroll. https://drafts.csswg.org/css-overscroll-behavior/
- MDN — `touch-action`; `overscroll-behavior`; viewport meta `viewport-fit`. https://developer.mozilla.org/en-US/docs/Web/CSS/Reference/Properties/touch-action / .../overscroll-behavior
- Chrome Dev Blog — Take control of your scroll (overscroll-behavior). https://developer.chrome.com/blog/overscroll-behavior
- Apple — Configuring Web Applications; Supported Meta Tags; Configuring the Viewport; WWDC21 Design for Safari 15; WWDC23 What's New in Web Apps; WebKit iPhone-X safe-area guide. https://developer.apple.com/library/archive/documentation/AppleApplications/Reference/SafariWebContent/ConfiguringWebApplications/ConfiguringWebApplications.html etc.
- firt.dev — PWA iOS compatibility; iOS 15.4 icons note. https://firt.dev/notes/pwa-ios
- OpenPWA — iOS Add to Home Screen reference. https://openpwa.net/reference/installation/ios-add-to-home-screen/
- Rick Strahl — Preventing iOS Textbox Auto Zooming (2023-04-17) — 16px vs selective maximum-scale. https://weblog.west-wind.com/posts/2023/Apr/17/Preventing-iOS-Textbox-Auto-Zooming-and-ViewPort-Sizing
- iPhone game-guide gist (fozzedout) — `100vh`-only cold start, `viewport-fit` toggle probe, HUD `max(env())` pattern. https://gist.github.com/fozzedout/5e77925381991a9570151550992baf14
- garethcheyne/npm-pwa-safezone — `100lvh` anchor, html-only scroll-lock, debug overlay. https://github.com/garethcheyne/npm-pwa-safezone
- Joel.net — Native install experience with PWA (beforeinstallprompt + iOS branch + manifest id/scope). https://joel.net/building-a-native-app-install-experience-with-a-progressive-web-app-pwa
