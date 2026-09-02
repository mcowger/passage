# Passage contributor guide

## Read first

- `docs/DESIGN.md` is the product architecture, security, persistence, and scope authority.
- `docs/UI.md` defines UI behavior and accessibility; `docs/UI_MOCKS.md` illustrates its interaction rules, not pixel-perfect output.
- `PI.md` defines the Pi RPC boundary and durable-history rules.
- `PLAN.md` defines the implementation order, current resume point, and phase gates. Do not begin a dependent phase before its prerequisite gate passes.

## Product and runtime

Passage is a single-user, trusted-LAN coding environment. A persistent Bun daemon owns filesystem and Git access, worktrees, SQLite metadata, PTYs, Pi processes, HTTP, and WebSockets. The React PWA is an attachable view; closing or suspending a browser must not stop daemon-owned work.

- Use Bun end-to-end. Bun is pinned to `1.4.0`; initial host support is Linux x64.
- Pi is the only agent runtime. Pin behavior and fixtures to the verified Pi CLI (`0.84.3`); never rely on `latest` wire documentation without checking the pinned release.
- Do not add Node, a Node fallback/sidecar, Vite, a direct Pi SDK integration, ACP, a provider abstraction, or multi-provider support.
- Keep one Bun package and the shallow `src/daemon`, `src/shared`, and `src/web` ownership model. Do not introduce premature packages or broad framework layers.

## Architectural invariants

- Start one `pi --mode rpc` process per active Passage agent. `PiRpcManager` alone owns Pi process lifecycle, LF-delimited JSONL framing, request correlation, bounded stderr, replay, and event normalization.
- Pi JSONL sessions are the authoritative agent history for messages, branches, compaction, and Pi usage. SQLite holds only Passage metadata, preferences, layouts, and discardable indexes—never a copied transcript or Pi-derived usage totals.
- `PiSessionHistoryReader` is the sole bounded, read-only Pi JSONL parser. Preserve unknown entries; never hand-write or silently repair Pi session files.
- Browser Pi traffic is a minimal, versioned Passage protocol of intentionally supported Pi-native commands and normalized events. Do not expose raw Pi records, arbitrary browser-to-Pi JSON, or a competing agent vocabulary.
- A successful Pi `prompt` response means admission, not completion. Keep subscriptions alive through message finalization, `agent_end`, settlement, queued work, compaction, reconnects, and JSONL reconciliation.
- Keep daemon-owned PTY terminals separate from Pi `bash`/`abort_bash` RPC. Terminal byte streams use binary WebSocket frames and an explicit single-client size lease.
- All browser protocol payloads use Zod-defined, versioned envelopes with request IDs and per-subject sequences. Bound reads, history pages, files, diffs, process output, stderr, and replay buffers.

## Security and workspace rules

- Resolve every filesystem and Git operation from a registered server-side canonical workspace root. Browser paths, labels, and displayed values are never authority; reject traversal and symlink escapes.
- Run Git only through the centralized service with fixed argument arrays, locale control, limits, cancellation, and timeouts. Never expose arbitrary shell-string execution through an API.
- A Passage-created worktree may be removed only when both its durable ownership record and on-disk marker exist. Dirty or unmerged removal needs explicit force confirmation; never delete branches automatically.
- Project-controlled Pi extensions, skills, MCP resources, and related executable resources require an explicit persisted workspace-trust decision. Do not create an executable plugin framework.
- Passage has no application authentication. Retain Host and WebSocket Origin validation and treat LAN deployment as trusted-network-only unless an upstream TLS/auth proxy or VPN protects it.

## UI implementation and verification

- Preserve the workspace-first model: agents, terminals, editors, diffs, explorer, changes, and overview are peer workspace surfaces. Closing a pane closes only the view, never the underlying resource.
- Keep tool grouping presentation-only: it cannot alter Pi history, cross user messages, hide errors, or remove tool boundaries. Unknown tools retain a safe generic renderer.
- Mobile is a focused single-panel experience, not a compressed desktop split layout. Preserve desktop layouts while presenting drawers and full-screen artifact destinations on narrow screens.
- Meet the UI specification's accessibility requirements: WCAG AA contrast, text/icon alternatives to color-only state, visible focus, deliberate focus order, and keyboard/context-menu alternatives for every drag-based pane action.
- **Use `agent-browser` for interactive UI verification whenever changing browser-facing behavior.** Run the development server, exercise the affected user flow in `agent-browser`, and verify the relevant desktop layout plus mobile behavior when responsive code is affected. Check loading/error/reconnect states as applicable and verify keyboard-accessible controls for interaction changes. Do not consider a UI change complete based solely on unit tests, typechecks, or static inspection.
- Playwright coverage is a design requirement for mature browser tests, but is not currently configured. Do not invent a Playwright command; add it only when the supporting tooling and test scope are introduced.

## Validation commands

```sh
bun install --frozen-lockfile
bun run typecheck
bun test
bun run test:phase0
```

Run focused checks first, then the relevant integration gate. `bun run test:phase0` is the full compatibility gate: typecheck, unit tests, live Pi checks, PTY checks, smoke tests, build, package, and compiled-package smoke test. For daemon/build/package changes, also use the applicable `smoke:development`, `smoke:production`, `smoke:package`, `build`, or `package` script from `package.json`.
