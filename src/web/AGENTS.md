# Frontend testing

Default to SSR + pure functions. Reach for a real DOM only for interaction.

## What to use when

- `ReactDOMServer.renderToString` / `renderToStaticMarkup` for markup assertions.
- Extract pure helpers for logic (`computeKeyboardInset`, `detectTrigger`,
  `hasFileDrag(types)`, …) and test those directly.
- happy-dom + Testing Library only when SSR can't cover it: user interaction,
  `useEffect`, portals, `localStorage`, `matchMedia`, clipboard/drag events.
  Name these files `*.interaction.test.tsx`.

## happy-dom rules

- Opt in per file, never globally. A `[test] preload` in `bunfig.toml` breaks
  the repo: `GlobalRegistrator` defines `document`/`window`/`navigator` as
  readonly (kills the fake-global socket tests) and replaces `Request`
  (breaks daemon origin-policy tests). This was measured, not guessed —
  global preload failed 19 tests.
- Usage is one line at the top of the test file:

  ```tsx
  import { setupDomTests } from "../test-utils/dom.ts";
  setupDomTests();
  ```

  (`src/web/test-utils/dom.ts` registers happy-dom, extends `expect` with
  jest-dom matchers, auto-`cleanup`, resets DOM between tests, and unregisters
  afterward so file order never matters.)
- Use render-bound queries — `const { getByRole } = render(...)` — never the
  `screen` global. `screen` binds to `document` at import time, before the
  `beforeAll` registers happy-dom, and every query throws.
- Async handlers that `await` before their final `setState` need one
  `await act(async () => { fireEvent... })` per click. Don't batch
  select-then-submit in a single `act` — the submit reads stale state.
- Don't convert the socket tests (`socketLifecycle`, `agentSocket`, …) to
  happy-dom. Their hand-rolled `fakeEventTarget` / `FakeWebSocket` harness
  (see `docs/IOSWEBSOCKETS.md`) is deliberate and precise.

## Mock pitfalls

- `mock.module` is process-wide and survives `mock.restore()`. A factory must
  spread the real module (`...RealDialog`) and override only what it stubs,
  or later files crash with missing-export errors (see `b622ae6`).
- Daemon lifecycle tests spawn real processes with ms-scale timing and flake
  under load. Don't stack full-suite runs back-to-back; confirm a suspected
  flake against a stashed clean tree before blaming your change.

Unit tests alone are never done for browser-facing changes — verify with
`agent-browser` per the root `AGENTS.md`.
