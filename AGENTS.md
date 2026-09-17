# Passage contributor guide

## Read first

- `docs/DESIGN.md` is the product architecture, security, persistence, and scope authority.
- `docs/UI.md` defines UI behavior and accessibility.
- `PI.md` defines the Pi RPC boundary and durable-history rules.
- `docs/WS.md` is the WebSocket review standard. Consult it before adding or changing any project/workspace mutation, and before sending or receiving state updates.

## Product and runtime

Passage is a single-user, trusted-LAN coding environment. A persistent Bun daemon owns filesystem and Git access, worktrees, SQLite metadata, PTYs, Pi processes, HTTP, and WebSockets. The React PWA is an attachable view; closing or suspending the browser client (not a Passage canvas tab) must not stop daemon-owned work.

- Use Bun end-to-end. Initial host support is Linux x64.
- Pi is the only agent runtime. Pin behavior and fixtures to the verified Pi CLI (`0.85.1`); never rely on `latest` wire documentation without checking the pinned release.
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
- Mutations return fresh HTTP snapshots inline and broadcast invalidations over `/ws` per `docs/WS.md`. Never push content on the wire, add transports, or duplicate hub logic.

## Resource lifecycle invariant

There are no background processes that are not represented in the UI. A Passage
canvas tab is the only UI representation of the resource it owns, and closing
that tab tears the resource down in the same action:

- **agent tab** → stop the `pi --mode rpc` process and archive the agent (daemon `archive()` calls `manager.stop()`), keeping its history
- **terminal tab** → terminate the daemon-owned PTY shell
- **preview tab** → stop the agent-browser session and remove the preview record

Closing a tab must never leave a Pi process, PTY, WebSocket relay, or browser
session alive with no UI to reach it. Every resource a user starts is reachable
from exactly the tab that owns it.

Durable history is not a process. Closing an agent tab stops the Pi process but
must NOT delete, truncate, or rewrite the Pi JSONL session; history stays the
authoritative record per `PI.md` and remains readable after the tab closes.
Editors, diffs, explorer, changes, and overview are views over durable
files/workspaces and leave those untouched, apart from the unsaved-editor
confirmation.

Scope: this governs explicit Passage canvas-tab closes, not client disconnect.
Closing/suspending the browser or dropping its WebSocket must not stop
daemon-owned work; that work continues until the owning tab is closed.

## Security and workspace rules

- Resolve every filesystem and Git operation from a registered server-side canonical workspace root. Browser paths, labels, and displayed values are never authority; reject traversal and symlink escapes.
- Run Git only through the centralized service with fixed argument arrays, locale control, limits, cancellation, and timeouts. Never expose arbitrary shell-string execution through an API.
- A Passage-created worktree may be removed only when its durable ownership record exists in the database. Dirty or unmerged removal needs explicit force confirmation; never delete branches automatically.
- Project-controlled Pi extensions, skills, MCP resources, and related executable resources require an explicit persisted workspace-trust decision. Do not create an executable plugin framework.
- Passage has no application authentication. Retain Host and WebSocket Origin validation and treat LAN deployment as trusted-network-only unless an upstream TLS/auth proxy or VPN protects it.

## UI implementation and verification

- Preserve the workspace-first model: agents, terminals, editors, diffs, explorer, changes, and overview are peer workspace surfaces. Honor the resource lifecycle invariant above: closing a canvas tab ends the resource that owns it, and nothing runs un-represented behind a closed tab.
- Use Tailwind CSS v4 via Bun's native bundler and `bun-plugin-tailwind` (configured in `bunfig.toml`). Do not add Vite, PostCSS configs, or external Tailwind watch processes.
- Use shadcn/ui primitives (`src/web/components/ui/*`) configured via `components.json` and class merging via `cn()` in `src/web/lib/utils.ts`. Add new primitives with `bunx --bun shadcn@latest add <component>`.
- Prefer ready-made shadcn primitives and compositions (first-party via `bunx --bun shadcn@latest add`, or compatible third-party shadcn distributions/registries) over hand-built controls. Before building custom dropdowns, popovers, dialogs, selects, checkboxes, radios, switches, tabs, tooltips, toasts, alerts, accordions, or command palettes, search for an existing shadcn primitive/composition (e.g. `command` + `popover` combobox, `alert-dialog`, `sonner`) and adopt it; keep custom code to domain rendering (CodeMirror, Xterm, transcripts, diffs) plus thin composition around primitives. Never reimplement focus trapping, portal rendering, outside-click dismissal, or keyboard navigation that Radix/shadcn already provides.
- Theme tokens and color variables are defined in `src/web/styles.css` under `@theme inline`. Prefer shadcn components and Tailwind utility classes for interactive controls and modals (buttons, inputs, dialogs, badges, menus), while retaining custom container styling for CodeMirror, Xterm, and split pane layouts.
- Keep tool grouping presentation-only: it cannot alter Pi history, cross user messages, hide errors, or remove tool boundaries. Unknown tools retain a safe generic renderer.
- Mobile is a focused single-panel experience, not a compressed desktop split layout. Preserve desktop layouts while presenting drawers and full-screen artifact destinations on narrow screens.
- **Use `agent-browser` for interactive UI verification whenever changing browser-facing behavior.** Run the development server, exercise the affected user flow in `agent-browser`, and verify the relevant desktop layout plus mobile behavior when responsive code is affected. Check loading/error/reconnect states as applicable and verify keyboard-accessible controls for interaction changes. Do not consider a UI change complete based solely on unit tests, typechecks, or static inspection.

## Validation commands

```sh
bun install --frozen-lockfile
bun run typecheck
bun test
bun run test:gate
```

Run focused checks first, then the relevant integration gate. `bun run test:gate` is the full integration gate: typecheck, unit tests, live Pi checks, PTY checks, build, and package.

- Never run live tests against real AI APIs or external model providers unless the user gives explicit permission in the current turn.
- Always use the local NullModel test double for test runs. Do not set `PASSAGE_PI_LIVE=real` or `PASSAGE_PI_USE_REAL=1` without explicit turn-by-turn permission.
- Run Cora reviews only when the user explicitly requests one.

## Dev Server

The dev server (bun run dev) restarts on its own when code changes, and performs an automated reload in the browser.  You do not need to manually restart a dev server.  If one is already running, there is no need to kill it  yourself.

**CRITICAL: Every worktree runs its own dev server on its own dedicated port. NEVER assume a port number.** The port is assigned per-worktree by `scripts/dev-port.ts` (a stable hash of the worktree root in the 3000-3999 range), so it differs between checkouts. A port you saw in another session, another worktree, or a tunnel URL belongs to that checkout, not yours. Your shell will often carry `PORT`/`PASEO_PORT` inherited from a different checkout — treat those values as stale for your worktree: never trust, export, or connect to them directly. Before connecting to the dev server — for `agent-browser` verification, curl, or any other tooling — you MUST determine the port by running:

```sh
bun scripts/dev-port.ts
```

- If this worktree's dev server is already running, the script prints its actual port (recorded in `.data/dev.port` next to `.data/dev.pid` at boot, falling back to the pidfile process's live listener). This answer is authoritative even when your shell's `PORT`/`PASEO_PORT` says otherwise.
- If free, the script prints the intended port.
- If occupied by any other process, it outputs a `CRITICAL` error and exits non-zero. It will **never** blindly bump to another port. If this happens, you MUST stop and ask the user for help resolving the port conflict.

Do not hardcode, guess, or reuse a port (e.g. 3000) from prior sessions, other worktrees, or examples.
