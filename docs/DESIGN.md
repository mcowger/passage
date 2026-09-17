# Passage design

## Purpose

This document is normative design guidance for Passage. It defines the
architecture, domain model, protocol rules, and UX contracts that keep the
tool consistent as it evolves. Follow it when adding or changing behavior.

Authority: this document (architecture) > `docs/WS.md` (transport standard)
> `docs/WEB.md` (preview transport) > `docs/GIT.md` (Git mutation plan) >
`PI.md` (Pi RPC boundary). If code and this document disagree, change the
code or amend the document — do not leave them divergent.

This document uses **Passage** as the working product name, matching this
repository.

## Product thesis

Passage is a single-user, LAN-accessible, web-based coding environment for
running multiple **Pi** agents and interactive terminals in isolated Git
workspaces.

The browser is an attachable view. A persistent Bun daemon owns filesystem,
Git, worktrees, Pi RPC processes, and PTYs, so ongoing work does not stop when
a browser tab is closed or a mobile device is suspended.

```text
React PWA (desktop or mobile)
       │ HTTP + WebSocket
       ▼
Persistent Bun daemon
 ├── Pi RPC manager ────────── one Pi RPC process per active agent
 ├── Pi history reader ─────── Pi JSONL sessions (canonical history)
 ├── Workspace service ─────── Git repositories and linked worktrees
 ├── Terminal service ──────── PTY processes
 ├── Preview manager ───────── agent-browser sessions (one per live preview)
 ├── File and Git service ──── registered workspace files
 └── Metadata store ────────── local SQLite database
```

## Design decisions

| Area | Decision |
| --- | --- |
| Deployment | Single-user daemon that is LAN-accessible by default. No application authentication; the daemon logs a startup warning and the operator is expected to place it behind upstream authentication/VPN. |
| Agent runtime | Pi only, integrated through one `pi --mode rpc` process per active agent. Model/thinking catalogs are probed from Pi itself (`get_available_models`); models carry per-model `supportedThinkingLevels`. No provider abstraction. |
| Canonical agent history | Pi JSONL sessions, including branches, compaction, and usage records. Passage never maintains a duplicate transcript; the daemon is the single source of truth for chat transcripts and the browser reloads bounded history pages after a run settles. |
| Other persistence | A small local SQLite registry holds only Passage metadata, preferences, and pane layouts; it is never authoritative for Pi-derived data. Schema version is 1. |
| Runtime | Bun end to end. Bun starts and supervises the pinned `pi` executable directly. No separate Node daemon, implementation layer, or fallback sidecar. |
| Host support | Linux x64. |
| UI | React, Bun HTML imports, Tailwind CSS, and shadcn/ui (+ Radix primitives, lucide-react, cmdk command palette, sonner toasts). Bun handles development rendering, bundling, and production packaging. Client state is `useState` + hand-rolled `subscribe*` socket helpers (`agentSocket`, `workspaceSocket`, `terminalSocket`, `previewSocket`); TanStack Query and Zustand are sanctioned but deferred per `docs/WS.md` and are **not** dependencies. Splits use a custom split-tree renderer + `react-resizable-panels`; there is **no** dnd-kit dependency — pane move/split is via `moveTab`/`splitTabGroup`/tab actions, context menus, and keyboard paths. |
| Markdown | Agent prose renders with `streamdown` (plus `shiki`/`prism-react-renderer` for code). |
| Scope | Multiple agents and live terminals per workspace; durable projects/workspaces/worktrees **including `directory` workspaces**; Git/files/diff with stage/commit/pull/fetch/merge; web previews via agent-browser; workspace setup actions from `paseo.json`; a persistent split/tab canvas; responsive PWA. |
| Worktree locations | Users choose configured named locations. Workspace labels are independent of Git branch names and on-disk directory names. Locations may be `global` or `project` scoped with an `enabled` flag. |
| Extensibility | Built-in theme/font/tool-renderer packs served read-only over HTTP (`GET /api/customization/*`; no upload endpoint). No executable plugin framework. |
| Pi extras | Pi is the only agent runtime. Subagent/MCP/extension orchestration management stays hidden, but Passage surfaces: Pi slash commands (`/compact` action with confirmation, `/model` and `/thinking` prompt-text), extension UI question cards (`pendingUiRequest` + `POST /api/agents/:id/ui-response`), the `skillsAvailable` capability flag, and model/thinking pickers. Skill-backed slash entries require an explicit persisted workspace-trust decision; without one, only Pi built-ins are offered. |

## Goals

1. Make it natural to manage many independent pieces of work: projects contain
   workspaces; workspaces contain zero or more agents and terminals.
2. Make Git worktrees safe, visible, and pleasant: a workspace has a stable
   label, a branch, an explicit owning location, and a known cleanup policy.
   Directory workspaces, discovery/import of existing checkouts, and repair of
   broken ownership records are part of the same model.
3. Make Pi the only agent system and retain its history as the source of truth.
4. Render agent work transparently by default: every tool appears as a compact
   expandable row, with per-session always/latest/none expansion for
   thinking and per-tool output.
5. Support a real interactive terminal, file editor, Git diff view, and live
   web preview in the same workspace canvas.
6. Work well in a browser, including a phone PWA, without pretending a phone
   can display a desktop split layout (drawer navigation + full-screen
   destinations; one focused panel at a time).
7. Keep the implementation understandable: one repository, one Bun package,
   one daemon, one browser app, and no premature packages or provider layers.
8. Support high-signal local activity statistics without analytics, usage
   reporting, or a remote monitoring product.

## Explicit non-goals

- Multiple model providers, ACP, or a generic provider marketplace.
- Passage-managed MCP servers, extensions, subagents, agent teams,
  orchestration UI, or terminal profiles (terminal creation takes only
  `title`/`cols`/`rows`/`cwd`).
- Arbitrary executable server or browser plugins.
- Hosted multi-user workspaces, collaboration, tenancy, relay networking, or
  account management.
- Pull-request hosting-provider integrations and review-comment publishing.
- Cloud telemetry, remote usage monitoring, or a separate message database.
- Offline editing or offline agent control. The PWA caches the application
  shell only (`passage-shell-v1`; never `/api/*` or `/ws*`); all mutable
  workspace state remains daemon-authoritative, with an explicit offline
  screen and retry.
- Custom theme/font/renderer pack uploads (packs are builtin-only and
  read-only).
- Preview element picking with composer attachment: the
  `PreviewElementContext` schema + formatter exist for future use, but no
  pick-mode UI is part of the design (see `docs/WEB.md` for the deferred
  plan).
- Skill-backed slash commands without an explicit persisted workspace-trust
  decision (all workspaces are treated as untrusted).

## Research synthesis

The Paseo/Pi-Web references below motivated the architecture. They are
context, not requirements; the normative sections above and below win on any
conflict.

### Adopted from Paseo

- Durable separation of **project**, **workspace**, **agent**, and terminal
  lifecycle. In particular, do not infer workspace ownership from `cwd`.
- A workspace can represent a main checkout, a linked worktree, or a
  directory; `cwd`, checkout root, and main repository root are distinct where
  needed (`workspaceKindSchema = directory | main-checkout | worktree`).
- The daemon owns PTYs, agent execution, Git operations, and event streaming.
- A serializable workspace-local split tree allows panels to be split, tabbed,
  and restored.
- Git status and structured diffs are first-class workspace surfaces.
- CodeMirror, xterm.js, bounded terminal replay, binary terminal frames, and a
  single terminal-size lease are sound implementation patterns.
- File changes use an optimistic revision check rather than silently replacing
  a concurrently edited file.

### Adopted from Pi-Web

- Pi's JSONL session files are canonical durable history. UI state is only a
  projection and caches are disposable.
- Read history from disk after a run settles rather than trusting transient
  browser stream state (multi-stage load with scroll backfill).
- Treat steering and follow-up as distinct visible actions: steering injects
  into an active run; follow-up waits for it to complete.
- Normalize Pi's streamed and persisted block types before rendering.
  Accumulate streaming tool JSON until complete, pair call/results, and
  lazily load costly thinking content.
- Keep a final response prominent and progressively disclose process details.
- Reconcile after reconnect, refresh, focus, or mobile suspension instead of
  trusting a continuous event connection.
- Put project/worktree/session navigation and activity badges in a clean,
  focused sidebar with PWA keyboard, safe-area, notification, and mobile
  viewport handling.

### Deliberately avoided

- Paseo's broad provider matrix, package topology, Expo/Electron/native client
  burden, skills/MCP orchestration, and executable plugin runtime.
- Pi-Web's Next.js process ownership, `globalThis` service registries, large
  all-purpose React hooks/components, and fixed single-chat-centric layout.
- Any second source of truth for messages, token totals, session branches, or
  compaction history.
- `react-use-websocket`, Socket.IO shims, SSE polling loops, or
  Redux/Jotai/Valtio/Recoil alongside the hand-rolled sequence/replay
  protocol (rejected in `docs/WS.md`).

## User-facing information architecture

### Core hierarchy

```text
Project
├── Default workspace (the project root itself; kind main-checkout, not a linked worktree)
├── Directory workspace(s) (kind directory, ownership not-owned)
└── Worktree workspace(s) (kind worktree, ownership owned/repair)
    ├── Agent(s)          ── each maps to one Pi session
    ├── Terminal(s)       ── live PTYs, scoped to the workspace
    ├── Files and editors (explorer, editor, changes, diff)
    ├── Web preview(s)    ── workspace-bound agent-browser sessions
    ├── Workspace action(s) ── setup runs from paseo.json (daemon memory only)
    └── Per-workspace pane layout + per-workspace settings
```

Definitions:

- **Project** — a logical codebase rooted at a registered filesystem location
  (`configuredRootPath` + canonical `canonicalRootPath`, display label,
  archived timestamp).
- **Workspace** — a specific directory/environment where work happens: the
  project's Default workspace (`main-checkout`), a linked Git worktree
  (`worktree`), or an arbitrary registered directory (`directory`). It is not
  synonymous with a branch or a terminal. Every workspace hosts its own
  agents, terminals, files, diffs, previews, and actions.
- **Agent** — a durable Passage record that points to exactly one Pi session.
  It owns the Passage title, workspace membership, model/thinking preference,
  `live`/`persisted` flags, `generation`, `runStartedAt`, and UI lifecycle
  (`pendingUiRequest` for extension question cards); Pi owns the transcript.
- **Terminal** — a live PTY owned by the daemon and attached to a workspace.
  It is not persisted as a resumable shell across daemon restart.
- **Preview** — a workspace-bound agent-browser session (`stopped →
  starting → ready ⇄ disconnected`, plus `stopping → stopped` and `error`),
  with `targetUrl`, viewport, `currentUrl`, lease state, and timestamps.
- **Panel** — a view of a workspace resource: `overview`, `agent`,
  `terminal`, `editor`, `diff`, `explorer`, `changes`, or `preview`
  (`PaneTabKind`; no generic `files` kind).

### Desktop layout

```text
┌───────────────────┬────────────────────────────────────────────────┐
│ Projects &        │ Workspace header: label · branch · activity      │
│ Worktrees         ├────────────────────────────────────────────────┤
│ └─ Workspaces     │ SplitCanvas (tab groups + horizontal/vertical   │
│    ├─ Agents      │ splits via react-resizable-panels)              │
│    └─ Terminals   │  [Agent A] │ [Terminal]                          │
│                   │  ──────────┼──────────────────                   │
│ + Register project│  [Diff]    │ [Editor]                            │
│ Footer: connection│                                                │
└───────────────────┴────────────────────────────────────────────────┘
```

The sidebar (`Projects & Worktrees`, `Register project`, per-project rows with
Default sorted first, child agent/terminal rows under the selected workspace,
status colors/labels) is navigation and activity, not a second competing
workspace. A workspace overview is the default initial panel. Supporting
surfaces: `CommandPalette` (cmdk), workspace `SettingsModal`,
`WorkspaceDetailsModal`, `NewWorktreeModal`, `DirectoryPicker`, toasts
(sonner), and browser notifications for agent completion/attention (opt-in,
only when the tab is not visible).

### Mobile layout

Mobile displays one focused panel at a time with drawer navigation (drawer
sidebar, wide touch rows at least 44px). It preserves the desktop split tree
but does not attempt to render simultaneous panes. Files, diffs, editors,
terminals, and previews open as full-screen destinations with Back-to-agent
behavior and composer state retained.

The terminal remains fully interactive on mobile with safe-area insets, visual
viewport handling, and touch scroll/selection. A visible take-control action
holds the size lease so a phone cannot accidentally resize a terminal actively
used from a desktop browser. The composer keeps message field + send-mode
label visible; model/thinking/attachments collapse into a compact row, and
desktop Enter-to-send becomes newline-insert on mobile.

## Domain model and persistence

### Sources of truth

| Data | Authority | Notes |
| --- | --- | --- |
| Agent messages, content blocks, session tree, compaction, Pi usage | Pi JSONL session | Read through a bounded, version-pinned Pi JSONL reader + transcript projection; do not mirror messages to SQLite. Multi-stage history load with scroll backfill. |
| Checked-out files and Git state | Filesystem and Git | Git CLI calculates status, worktree state, and diffs. |
| Live Pi RPC and PTY processes, preview sessions, action runs | Daemon memory | Process lifetime is independent of a browser connection and ends on daemon restart. Action runs and preview runtime (ports, PIDs, frames, leases) are never in SQLite. |
| Passage object identity, workspace policy, layout, labels, settings, preview metadata | Local SQLite | Small, migration-versioned registry (schema version 1); no transcript duplication. |
| Browser drafts and ephemeral view state | Browser local storage / memory | Per-agent drafts and timeline expansion overrides. Disposable. |

### SQLite records

Schemas are Zod-strict. IDs are opaque (`prj_*`, `wsp_*`, `agt_*`, `loc_*`,
`prv_*`). Paths are attributes, never keys; the registry stores both
configured and canonical paths.

| Record | Essential fields |
| --- | --- |
| `projects` | opaque ID, configured root path, canonical root path, display label, archived timestamp |
| `worktree_locations` | opaque ID, `projectId` nullable, `scope` (`global`/`project`), display label, configured root path, canonical root, `enabled` flag |
| `workspaces` | opaque ID, project ID, `kind` (`directory`/`main-checkout`/`worktree`), `cwd`, checkout root (nullable), main repository root (nullable), branch/ref (nullable), display label, `locationId` (nullable), `ownershipState` (`main-checkout`/`owned`/`not-owned`/`repair`), `markerId`/`markerPath` (nullable, ownership marker), `repairDetail` (nullable), archive timestamp, versioned layout JSON, workspace settings JSON |
| `agents` | opaque ID, workspace ID, Pi session ID/path, generated or overridden title, model/thinking preference, last known status, `live`, `persisted`, `generation`, `runStartedAt`, archive timestamp |

Snapshot reads stay bounded and set-oriented (`/api/workspaces/snapshot` caps
each collection at 100). The schema is one clean version-1 baseline; after
users have durable data, schema changes use ordered migrations and never
rewrite an applied migration.

### Project and workspace invariants

1. A workspace belongs to exactly one project; an agent, terminal, or preview
   belongs to exactly one workspace.
2. A workspace `cwd` is the directory given to Pi, terminals, files, and Git
   operations. It may be below the workspace checkout root.
3. A main-checkout workspace is never assumed from a branch name. Git is asked
   for its actual checkout and worktree roots.
4. Only an explicit workspace record may authorize Passage to delete a
   worktree it created. Main checkouts cannot be removed; dirty worktrees
   require explicit force confirmation; branches are never deleted
   automatically.
5. A terminal's ID remains valid only while its daemon-owned PTY exists. Dead
   terminal tabs are detectable (`findFirstDeadTerminalTab`).
6. **Closing a canvas tab ends the underlying resource**: agent tabs archive
   the agent, terminal tabs terminate the PTY, preview tabs stop and delete
   the preview (`endTabResource`/`closeTabNow` in `main.tsx`). Editors, diffs,
   explorer, changes, and overview are views over durable files/workspaces
   and leave those untouched, apart from the unsaved-editor confirmation.

### Worktree locations, labels, and metadata generation

A worktree creation flow asks for:

1. **Purpose** — optional natural-language task or desired outcome (drives
   AI suggestion).
2. **Workspace label** — human-readable, editable, and independent of branch.
3. **Branch** — editable Git branch/ref, validated as a Git ref (not a path),
   with `createBranch`/`baseRef` options.
4. **Named location** — a global or project-specific configured destination.
5. **Physical folder** — suggested from the label and branch, collision-safe,
   and editable within the selected named location.

Example:

```text
Location: Passage-Standard → /home/matt.cowger/workspace/worktrees
Label:    Update Design Docs
Branch:   feature/update-design-docs
Folder:   update-design-docs--wk_7f3a
```

The folder suffix makes collisions harmless; the label, not the path, is what
the UI presents. Worktree locations are named records, not one global root.

`MetadataGenerator` (backed by a narrow `PiRpcManager(1)` prompt, validated
structured output, `suggestModel` workspace setting passed as `pi --model`,
deterministic local slugging fallback) supplies suggestions for labels, branch
names, and folder names. It never creates a visible workspace agent, never
persists transcript data, and never applies suggestions without user
confirmation.

### Pi session mapping and lifecycle

Creating an agent starts an agent-specific Pi RPC process in that workspace
`cwd` and establishes its Pi session. The durable JSONL file may not exist
until Pi flushes it, including for Bash-only/no-message sessions. The history
endpoint returns either `{history, nextBefore?}` or `{unpersisted: true,
history: null}`; Passage persists the stable Pi session ID immediately and
updates the path mapping after the first durable flush.

Agent statuses (`agentStatusSchema`): `initializing → idle ⇄ running →
stopping → idle`, plus `needs-attention` (user input, permission, extension
question card, process failure, unaddressed error) and `error`; any
non-archived state may transition to `archived`. Summaries additionally carry
`live`, `persisted`, `generation`, `runStartedAt`, and optional
`pendingUiRequest`.

`stopping` means Passage accepted a cancellation request but has not yet
confirmed that Pi is idle. It blocks further agent commands and locks the
composer (`Stopping…`). Passage only returns the agent to `idle` after Pi
reports settlement and reconciliation confirms `isStreaming: false`.

Browser reloads reattach to the live RPC process if it exists, then reconcile
against Pi JSONL on disk (`transcriptEpoch` bumps force a full timeline
replace; otherwise live `row_upsert` events merge). Process exit settles
pending RPC requests, records bounded stderr and exit status, emits an
attention/error state, and leaves the persisted Pi session resumable. After
daemon restart, agents remain resumable from their Pi session but their
previous process is not claimed to be live.

Daemon agent operations (HTTP + `/ws` `pi` channel): `start`, `prompt`,
`steer`, `follow-up`, `abort`, `model`, `thinking`, `compact` (typed endpoint
with composer confirmation), `ui_response` (answers an extension question
card), plus `capabilities` (models, thinking levels, slash commands,
`skillsAvailable`) and the `/api/models` global probe.

## Runtime architecture

### Repository layout and build

Keep a single Bun package and a deliberately shallow source tree:

```text
src/
  daemon/
    http/                 HTTP routes and WebSocket upgrade (agents, models,
                          workspaces, worktrees, git, files, terminals,
                          actions, previews, layout-settings, transcript-preview)
    agents/               Pi RPC manager/client, JSONL reader, transcript
                          projection, slash commands, events, service
    terminals/            PTY ownership, replay, resize leases
    workspaces/           projects, files, files-search, Git, worktrees,
                          metadata-generator, actions, events
    previews/             WebPreviewManager + relay (agent-browser)
    models/               Pi model-catalog probe (get_available_models)
    metadata/             SQLite migrations and repositories
    replay/               ReplayBuffer + IdempotencyCache
  shared/
    protocol/             Zod envelopes (agents, terminals, workspace, previews)
    domain/               workspaces, agents, layout, settings, terminals,
                          previews, customization, files, git, workspace-actions
    jsonl/                JSONL parser
  web/
    main.tsx              App shell, workspace state, SplitCanvas wiring
    api.ts                typed HTTP client (timeouts 30s reads / 120s mutations)
    agentSocket.ts / workspaceSocket.ts / terminalSocket.ts / previewSocket.ts
    components/           product components and shadcn/ui primitives
                          (AgentPanel, AgentSessionPanel, Sidebar, SplitCanvas,
                          Explorer/Changes/Editor/Diff/Terminal/Preview panels,
                          CommandPalette, SettingsModal, WorkspaceDetailsModal,
                          NewWorktreeModal, DirectoryPicker, QuestionCard, …)
    lib/                  timeline-expansion, tool-display, tool-diff,
                          streaming-tokens, transcript-apply, clipboard, utils
    styles/               Tailwind + semantic theme tokens
```

Use Bun for package management, scripts, test runner, daemon runtime,
React/HTML bundling, production serving, and packaging. The daemon imports the
React HTML entrypoint (`../web/index.html`) directly plus `manifest.webmanifest`,
`icon.svg`, and `sw.js` routes. Development serves UI, API, and WebSocket from
one process and origin with HMR. Production uses an ahead-of-time Bun
full-stack build.

### Chosen stack

| Concern | Choice | Rationale |
| --- | --- | --- |
| Server | Bun with Hono and Bun-native WebSockets (`Bun.serve` `websocket:`) | Mature routing/validation ergonomics without a server framework or Node runtime. |
| Protocol validation | Zod (`.strict()`, bounded strings/bytes, `PROTOCOL_VERSION = 1`) | One runtime schema defines HTTP and WebSocket payloads. Caps: 48KB event payload, 64KB WS command, 32 agent + 32 workspace subs per socket, 256 subjects / 1024 listeners per hub, 256 inflight commands; `1013` close on slow clients. |
| Metadata | `bun:sqlite` | Built into the target runtime; no ORM for this small local registry. |
| Client | React + Bun HTML imports + TypeScript | Direct browser SPA bundled by Bun without a separate frontend server. |
| UI | Tailwind CSS + shadcn/ui + Radix primitives, lucide-react, cmdk, sonner | Accessible composable primitives and a token-based visual system. |
| Client state | `useState` + `subscribe*` helpers for snapshots vs. live state | Per `docs/WS.md`: Query/store split is sanctioned but deferred; no TanStack/Zustand dependencies. |
| Panes | Custom split-tree renderer + `react-resizable-panels` | Durable product semantics (`TabGroupNode`/`SplitNode`), not a black-box docking library; no dnd-kit. |
| Editor | CodeMirror 6 + lazily loaded Lezer languages (`@codemirror/lang-*`) | Lightweight, embeddable, pane-based editor with word-wrap/tab-size settings. |
| Terminal | Bun native terminal subprocess API plus xterm.js with fit, unicode11, canvas, and optional WebGL | Keeps PTY ownership in Bun; xterm.js provides the mature browser terminal. |
| Pi agents | Pi CLI in RPC mode, supervised by `PiRpcManager` (+ `PiSessionHistoryReader`, transcript projection, model catalog probe) | Pi owns agent commands/events and session state behind a simple process boundary. |
| Markdown/code | `streamdown` + `shiki`/`prism-react-renderer` | Safe rich model-output and code rendering. |
| Git | Git CLI via fixed argument arrays and a centralized service with concurrency slots, timeouts, and output caps | Git worktree behavior is authoritative in Git itself; merge preflight via `merge-tree --write-tree`. |
| File watching | No filesystem watcher daemon-side; WS invalidations + debounced targeted refetch and focus/visibility reconciliation | Status/file reads always recheck the filesystem. |

### Compatibility requirements

Before relying on a runtime capability, prove it in a disposable Bun
integration spike on Linux x64:

1. Launch the pinned `pi --mode rpc` CLI from Bun; create/resume a session,
   send prompt/steer/follow-up/abort/model/thinking/compact/ui_response
   commands, parse concurrent responses/events, and read the resulting JSONL
   session directly.
2. Spawn, write to, resize, and terminate a PTY through Bun's native terminal
   subprocess API.
3. Run isolated Pi RPC processes and a PTY concurrently while streaming through
   a Bun WebSocket; validate stderr, crash, restart, and process shutdown.
4. Build and start the production Bun bundle with Pi and native dependencies
   installed as they will be packaged.

The Pi RPC process is a required agent process, not a fallback sidecar. A
failed compatibility item blocks the dependent feature and must be resolved or
explicitly deferred.

## Browser/daemon protocol

### Transport responsibilities

- **HTTP** returns bounded snapshots: project/workspace snapshot, Pi history
  pages (`limit`, `before`, `nextBefore`), capabilities, file listings/content,
  Git status/diffs, terminals, previews + candidates, actions + runs, layout,
  settings, theme/font/renderer packs, and static assets. Reads time out at
  30s; mutations (worktree setup, Git network ops, Pi start-up, preview
  launch) at 120s.
- **WebSocket** carries three sockets and no more (per `docs/WS.md`): `GET
  /ws` (JSON text for `pi` + `workspace` + `daemon/ping`); `GET
  /api/terminals/:id/ws` (binary PTY frames + JSON control); `GET
  /api/previews/:previewId/ws` (bounded agent-browser frame/input relay with
  `?pacing=ack&maxFps=15`, latest-frame-wins, view-only until Take control).
  Preview frames never enter `WorkspaceEventHub`, replay buffers, SQLite, or
  Pi history.
- **Binary WebSocket frames** carry high-volume terminal bytes. Semantic agent
  events remain structured JSON so tool-call boundaries cannot be lost.

All `/ws` messages use a versioned Zod-defined envelope:

```ts
type PassageCommandEnvelope = {
  version: number;
  requestId: string;
  channel: "pi" | "workspace" | "terminal" | "daemon";
  type: string;
  payload: unknown;
};

type PassageEventEnvelope = {
  version: number;
  stream: "pi" | "terminal" | "workspace" | "daemon";
  subjectId: string;
  sequence: number;
  type: string;
  payload: unknown;
};
```

The `pi` channel carries only the pinned Pi RPC commands and normalized events
for a specific Passage agent (`subscribe/unsubscribe/start/prompt/steer/
follow-up/abort/model/thinking/ui_response`); `workspace`, `terminal`, and
`daemon` channels carry Passage-owned operations (`subscribe/unsubscribe`,
`daemon/ping`). Request IDs are idempotent (`IdempotencyCache` +
canonical-JSON fingerprints; conflicts are rejected). The daemon assigns
monotonically increasing sequence numbers per subject stream.

### Reconnection and replay

Each live resource maintains a bounded replay buffer (`ReplayBuffer`) and a
current snapshot. On reconnect the client supplies the last sequence it
observed. The daemon either replays contiguous events or responds
`snapshot-required` with a `snapshotUrl`. The client then reloads the
authoritative HTTP state and resubscribes. Reconnect uses a fixed 800ms timer
plus `online`/`visibilitychange` reconciliation; exponential backoff is
deferred until reconnect storms are observed.

This applies separately to Pi RPC events/run state, terminal output/metadata,
and workspace/Git/file invalidations (invalidation-only payloads: never file
content, listings, `GitStatus`, or diffs on the wire). After an agent run
settles, the browser reloads the relevant Pi JSONL history page. Preview
streams are explicitly exempt: frames are not replayed; reconnect resumes at
the newest frame and reconciles via HTTP snapshots.

### Backpressure and limits

- Coalesce raw terminal chunks on the daemon and client, without crossing
  ordering barriers such as resize/snapshot/clear events.
- Bound terminal replay by bytes and time; send a terminal snapshot if the
  client falls behind; close slow clients (`1013`).
- Page Pi history (timeline capped at 500 rows/page) and lazy-load expensive
  thinking content; scroll-near-top backfills with scroll-position restore.
- Cap Git command output, file content/read size, diff size, rendered markdown
  size, action stdout/stderr (20KB per command), and preview frame/input sizes.
- Centralize Git/process concurrency and timeouts; callers never execute an
  arbitrary shell string through an HTTP endpoint (workspace actions accept an
  action id, never a command string).

## Pi integration and agent experience

### Pi RPC boundary

`PiRpcManager` is the only daemon module that starts Pi processes and owns Pi
RPC stdin/stdout framing (LF-delimited), response correlation, stderr capture,
process lifecycle, and event normalization. `PiSessionHistoryReader` is the
only module that parses Pi JSONL for durable history/reconciliation; the
transcript projector turns it into `AgentHistory` timelines. Raw Pi RPC records
and JSONL entry shapes never cross the browser protocol boundary unnormalized.
`queryAvailableModels` probes `pi --mode rpc` (`get_available_models`, 10s
timeout) so `/api/models` and per-agent capabilities agree.

Together they provide agent-specific process start/resume, exit, crash, and
shutdown; prompt/steer/follow-up/abort/model/thinking/compaction/extension-UI
dispatch; bounded direct JSONL history pages with branch/compaction awareness
(`branches`, `revision`, `transcriptEpoch`, `rewritten`, `partialTail`,
malformed/unknown counters); normalized content/tool/usage/lifecycle events;
and a small explicit mapping of Pi errors/permissions/process failures to
attention states.

### Composer and queue behavior

Each agent panel has one composer with normal prompt, `@` file references
(rendered as chips, completed from the workspace root), Pi-supported image
attachments (`png`/`jpeg`/`gif`/`webp` with count caps and `Attached image`
fallback text), draft recovery per agent/workspace (failed submissions
retained), model and thinking pickers, and daemon-allowlisted `/` commands
(`compact` action with confirmation dialog; `model`/`thinking` prompt-text).

When a run is active, the UI presents two clearly labeled actions: **Steer
now** (inject into the active Pi run) and **Queue follow-up** (enqueue after
completion), plus a separate destructive **Abort/Stop** control that becomes
disabled `Stopping…` with live counters frozen until the daemon confirms
settlement. Passage delegates queue semantics to Pi rather than reimplementing
a competing scheduler, and presents queue state without offering per-item
removal or clearing (not exposed by Pi). Sending is acknowledged only on Pi
prompt admission, not run completion; the subscription stays active through
finalization, `agent_end`, retries, compaction, queued follow-ups, and the
pinned-version settlement signal, then reloads bounded Pi JSONL history.
Extension question cards (`pendingUiRequest` + `QuestionCard`) pin the timeline
to the question and answer via the typed `ui-response` route.

### Timeline projection and progressive disclosure

`AgentHistory.timeline` items: `user`/`assistant`/`thinking` (with `lazy`
flag), `tool` (`id`, `name`, `input`, `result?`, `status`
running/complete/error, `significant`, `error?`), `summary` (`compaction` |
`branch`), daemon-level `error` (chronological, survives reconnect but not
daemon restart), and `unknown`. Raw Pi order is preserved; `usage`
(input/output/cacheRead/cacheWrite/total/cost) plus `contextUsage` (current
window occupancy) ride alongside.

Presentation: thinking is a compact disclosure collapsed after completion with
on-demand body load; tool call + result is one row (input shown only after
streamed JSON completes); per-session `timelineExpansion`
(`always`/`latest`/`none` for thinking, each baseline tool
`read/write/edit/bash/find/grep/ls`, and other tools; defaults `latest`)
controls disclosure. Errors render as labeled alerts naming Pi
where appropriate. Streaming shows live token estimates (tokens, tok/s,
elapsed from `runStartedAt`) with pinned-to-bottom autoscroll that yields to
manual scroll. Coalescing is a presentation projection only: it never alters
Pi history, crosses user messages, or hides errors.

### Tool renderer registry

All tools first render through a safe generic card: tool name, status, elapsed
time, expandable normalized JSON input, text/ANSI result, and attachments.
The single builtin pack (`builtin` / `Default Tool Renderers`) registers:

- `read` (Read, file), `edit` (Edit, file), `write` (Write, file),
  `bash` (Ran, command), `glob` (Search files, search), `grep` (Search
  text, search), `git` (Git, git).

The schema additionally supports `summaryTemplate` and `category`
(`file`/`git`/`command`/`agent`/`search`/`generic`).
Declarative packs may choose labels, target fields, result fields, path links,
status mapping, and significance; they cannot render arbitrary HTML or execute
code. Unknown tools always retain the generic fallback rather than becoming
invisible. Custom-tool packs affect rendering and grouping only; they cannot
execute tools, alter Pi history, change tool ordering, or participate in agent
orchestration.

### Local activity statistics

Each run displays concise local facts where available: input/output/cache-read/
cache-write tokens, model cost from Pi persisted usage, current-window context
occupancy (`contextUsage` with click-for-details), start time
(`runStartedAt`), a live activity phase (thinking/responding/composing tool
call/running tool/receiving tool result) plus elapsed time, sampled from the
relayed Pi frame stream rather than estimated from message text, tool
durations, and lifetime session totals from Pi history. Runtime timing is labeled unavailable
rather than guessed after an unobserved restart. These are local UI
diagnostics, not telemetry: nothing is sent to Passage or a third party.

## Workspace, filesystem, Git, and worktrees

### Filesystem boundary

The daemon exposes only registered workspace roots and their permitted
subdirectories. Every request resolves a real path server-side and verifies it
remains inside the registered canonical root; traversal and symlink escapes are
rejected (symlinks are not writable). Browser-provided paths, displayed paths,
and workspace labels are never authority.

File writes require an expected revision (content hash plus modified time).
When the file changed since it was read, the server returns a conflict and the
editor provides reload/compare choices rather than overwriting it. Operations:
list (cursor-paged), read (size/binary guarded), write, create
(file/directory), rename, duplicate, delete, search (capped limit), and
directory suggestions for pickers.

### Git service

A centralized Git service invokes the Git CLI with fixed argument arrays,
locale control, output limits, cancellation, timeouts, and a bounded
concurrency scheduler. It owns repository/worktree discovery, branch,
ahead/behind/`aheadOfMain`, dirty/conflict status, staged vs. working-tree
diffs (unified, binary/oversize/truncated handling, untracked-file diffs with
budgets), structured file summaries (added/modified/deleted/renamed/untracked/
conflict/binary/submodule, staged vs. working-tree flags), and worktree
creation/refresh/safe removal. Mutations: `stage`, `unstage`, `stage-all`,
`unstage-all`, `discard` (refuses unmerged paths), `commit` (returns new
HEAD), `pull --ff-only`, `fetch --prune`, and `merge` into main: the source
branch is replayed onto main with `git rebase` (aborted and reported if it
conflicts), then main fast-forwards, gated by a `merge-tree --write-tree`
conflict preflight. The client receives a normalized
status/diff model and never parses porcelain on the main UI path.

### Worktree lifecycle

Creation performs these steps transactionally where Git permits:

1. Validate project, selected named location, target folder, and branch/ref
   (`createBranch`/`baseRef` supported).
2. Resolve the destination's canonical parent and ensure it is an enabled
   Passage worktree location.
3. Run `git worktree add` with an explicit argument list.
4. Record a durable Passage workspace record with owned state.
5. Refresh Git status and offer agent/terminal creation.
6. If durable registration fails, persist a `repair` record with
   `repairDetail` and do not silently delete user work.

Removal requires the workspace ownership record, rejects main checkouts,
requires explicit force confirmation for dirty/unmerged worktrees, and never
deletes branches automatically. Additional flows: `discover` (unregistered
checkouts with `isRegistered`/`workspaceId`/`archived` flags), `import`
(existing path → workspace), `repair`/`reconcile` (re-resolve canonical path
and Git discovery), and AI `suggest` (label/branch/folder).

A new worktree auto-starts its workspace setup action when one is defined:
the `setup` (`Worktree setup`) command list from the worktree's `paseo.json`
(everything else in that file is ignored), executed sequentially in the
worktree directory. Runs are asynchronous with at most one active run per
workspace (`running`/`succeeded`/`failed`/`cancelled`, per-command exit
code/stdout/stderr capped at 20KB, `currentCommand`, `startedAt`/`finishedAt`);
start returns a snapshot immediately, settle is published as an
`actions-changed` workspace invalidation, and clients refetch over HTTP. Runs
are daemon memory only and do not survive a daemon restart. Only commands
from `paseo.json` ever execute — the API accepts an action id, never a
command string — and a setup failure never fails creation or deletes user
work; the create response carries the background run reference for the caller
to poll. Teardown scripts and auto-allocated ports are out of scope
(`paseo.json` `servicePorts` is ignored).

### Files, editor, changes, and diff panels

- **Explorer** — lazy directory tree + changed-files section with muted
  language icons and text/icon Git state.
- **Editor** — CodeMirror 6 with local dirty buffers (tab/header markers,
  save-handler registry, dirty-close confirmation), conflict-aware save,
  line-wrap/tab-size settings, lazy syntax languages.
- **Changes** — status summary, additions/deletions, grouped files with
  status/line stats, branch/worktree identity, stage/unstage/commit/pull/
  fetch/merge/discard actions.
- **Diff** — server-structured diffs with inline default (side-by-side where
  supported), syntax highlighting, sticky context, binary/oversize/renamed/
  deleted fallbacks, and editor handoff.
- **Overview** — default panel answering branch/running/attention/changed;
  doubles as the new-workspace empty state with create-agent/terminal actions.

## Terminal design

`TerminalManager` owns all PTYs. A terminal has a workspace, `cwd`, title,
dimensions, activity/exit state (`running`/`exited` + `exitCode`),
`hasSizeLease`, and bounded replay. Creation input is `title`/`columns`/`rows`/
`cwd` only — no named profiles or startup-script catalogs.

The client uses xterm.js. The server sends output over binary WebSocket frames;
create/attach/resize/input/exit/snapshot/`lease_change` are structured control
messages. Only one attached client holds the size **lease** at a time (first
attacher wins; focus does not steal; explicit `takeLease`/`Take control`
moves it; only the holder may resize; holder departure passes the lease).
Viewers receive output but cannot resize. Terminals are live runtime state and
do not survive daemon restart; an agent's shell-tool activity stays in its
timeline and is never confused with a user terminal pane.

## Pane canvas and visual system

### Split-tree model

Layouts are serialized, schema-versioned (`version: 1`) trees stored per
workspace:

```ts
type PaneTab = { id: string; kind: PaneKind; title: string; targetId?: string; pinned?: boolean };
type TabGroupNode = { type: "tabs"; id: string; tabs: PaneTab[]; activeTabId: string };
type SplitNode = { type: "split"; id: string; direction: "horizontal" | "vertical";
  sizes: number[]; children: LayoutNode[] };
type LayoutNode = TabGroupNode | SplitNode;
```

Pane kinds are `overview`, `agent`, `terminal`, `explorer`, `changes`,
`editor`, `diff`, and `preview` (max 50 tabs/group, 10 children/split). The
model enforces minimum dimensions, stable IDs, normalization/rebalancing,
dead-terminal detection, overview migration, and schema migration. Closing a
resource pane for `agent`/`terminal`/`preview` ends that resource
(archive/terminate/stop+delete); other kinds only remove the view.

### Themes, chat display, and fonts

Tailwind consumes semantic CSS variables rather than fixed component colors.
Four builtin themes ship (`passage-light` default warm light,
`passage-dark` charcoal, `nord`, `high-contrast-dark`) with full token sets
(`background`/`surface*`/`border*`/`accent*`/`muted`,
`statusRunning/Idle/Error/Warning`, `userCard*`, `composer*`,
`chip*`/`secondary*`, `diffAdd/Remove/Hunk*`,
`terminalBackground/Foreground`, `editorBackground`). Three builtin font packs
ship (`system-default`, `fira-code`, `jetbrains-mono`) as font-family strings
only — no remote stylesheets. Per-workspace settings (`workspaceSettingsSchema`
v1): `themeId`, `fontId`, `toolRendererPackId`,
`notificationsEnabled`, `editorWordWrap`
(default true), `editorTabSize` (default 2), `terminalFontSize` (default 13),
`suggestModel` (empty = Pi default), `timelineExpansion`
(thinking/tools-baseline/otherTools, each `always`/`latest`/`none`, defaults
`latest`). There is no density setting and no custom-pack upload; theme
application sets `data-theme-mode` + CSS vars, fonts set `--font-ui`/
`--font-mono`, and a terminal font change triggers a safe fit.

## PWA and LAN operation

### PWA behavior

- Serve a manifest, icons, and a service worker (`passage-shell-v1`).
- Cache versioned static application assets and an offline explanatory shell.
- Do not cache mutable sessions, files, Git results, terminal output,
  previews, or authenticated API responses as offline data; offline is an
  explicit screen with retry, never stale editable data.
- Reconnect and reload daemon snapshots on online/visibility return; preview
  streams resume at the newest frame.
- Support browser notifications for agent completion/attention only after a
  user grants permission (`notificationsEnabled` + `Notification` permission)
  and only when the tab is not visible. Push infrastructure is out of scope.

### LAN security posture

The daemon is LAN-accessible and has **no application-level
authentication**. Anyone able to reach it can potentially read registered
workspace files, control Pi agents, run terminal commands, alter Git
worktrees, and view/control previews. It is appropriate only on a trusted
network or behind the operator's own authenticated reverse proxy/VPN.

This is not a reason to omit baseline browser protections:

- preview sockets validate `Host`/`Origin` (same-host or loopback) and verify
  preview ownership, enforce a single input/viewport lease, cap frames/inputs,
  and close slow/malformed clients; agent-browser stream ports and CDP stay
  on loopback and are never exposed to the browser;
- serve the SPA and API from the same origin;
- keep realpath workspace boundaries, symlink/traversal rejection, command
  allowlists (Git fixed args, `paseo.json` action IDs only, agent-browser
  fixed args), output/size caps, and ownership-gated worktree deletion
  regardless of network trust;
- expose no raw Pi/CDP/shell endpoints; unknown preview IDs 404 before
  upgrade;
- log local security-relevant rejections without collecting remote analytics.

There is no general configured-allowed-origins gate on `/ws` or HTTP — only
the preview path enforces origin checks. PWA installation, service workers,
clipboard APIs, and secure WebSockets on a remote LAN host require HTTPS.
TLS and any identity/authentication remain the responsibility of the upstream
proxy/operator.

## Verification

| Layer | Verification |
| --- | --- |
| Domain/protocol | `bun test` for Zod schemas, split-tree mutations/migrations, worktree metadata/suggestions, path boundary logic, timeline expansion, tool display/diff, renderer matching. |
| Pi RPC | Fixture JSONL sessions plus live Bun integration tests (`test:pi-rpc`, `test:pi-live`) for start/resume/crash, LF framing, correlation, prompt/steer/follow-up/compact/model/thinking/ui_response, and restart reconciliation. |
| Git/worktrees | Temporary Git repositories covering main checkout, linked worktree, directory workspace, dirty removal, rename, binary, submodule, path-with-spaces, failed registration → repair. |
| PTY | Platform integration tests (`test:pty-websocket`, `test:pty-live`) for spawn/input/resize/lease/replay/exit and binary WebSocket ordering. |
| Browser | `agent-browser` verification for browser-facing changes (separate session from any preview under test), desktop plus `<640px` where responsive code is touched; preview changes verify ack pacing, latest-frame-wins resume, view-only-until-take-control, and HTTP reconcile on reconnect. |
| Mobile/PWA | Responsive tests plus manual install, keyboard, terminal, suspend/resume, safe-area, and viewport validation; shell-only service worker with offline screen. |
| Security | Tests for traversal, symlink escape, malformed protocol input, oversized output, unknown preview IDs/origins, destructive worktree-operation confirmation. |
| Gates | `bun install --frozen-lockfile`, `bun run typecheck`, `bun test`, `bun run test:gate`. |

Performance budgets apply to initial history page, terminal input echo,
terminal replay, first visible stream token, large-diff fallback, and PWA
reconnect. The product reports local activity statistics but does not collect
user telemetry.

## Risks and mitigations

| Risk | Mitigation |
| --- | --- |
| Pi RPC CLI or Bun native terminal API fails | The compatibility requirements above are a hard gate; defer the affected feature rather than adding a separate Node implementation layer. |
| LAN daemon is exposed to an untrusted device | Document prominently, retain path/process/ownership safeguards and preview origin + lease checks, and recommend upstream TLS/auth/VPN. This is an accepted deployment risk. |
| Mobile browser suspends a live connection | Sequence/replay + `snapshot-required`, authoritative snapshots, visibility reconciliation, post-run history reload, preview newest-frame resume. |
| One browser resizes another terminal/preview | Single active size/input lease with explicit takeover (`takeLease`/`Take control`); focus never steals. |
| Worktree cleanup deletes user work | Explicit ownership persisted, required for deletion, dirty removal force-gated, branches preserved, failures become `repair` records. |
| Pi upgrades break rendering | Isolated RPC framing/normalization + JSONL parsing, pinned CLI, compatibility fixtures, `SLASH_COMMANDS_VERSION = pi-rpc-1`. |
| Rich custom tools become a plugin-security problem | Safe read-only builtin renderer pack + generic fallback; no executable plugin API. |
| Large histories/diffs freeze the UI | Server limits/paging (500 timeline rows/page, 20KB action chunks), lazy thinking, scroll backfill with position restore, process hiding via expansion, oversize fallbacks. |
| Pane canvas overwhelms mobile | Persist the full layout but render one focused panel with drawer + full-screen destinations on narrow screens. |

## Consistency checklist

When changing Passage, keep these invariants intact:

1. One source of truth per datum: Pi JSONL for transcripts, filesystem/Git
   for files and status, daemon memory for live processes, SQLite for
   identity/policy/layout, browser storage for disposable drafts.
2. Invalidation-only `/ws` payloads (never file content, listings,
   `GitStatus`, or diffs); exactly three sockets; versioned strict envelopes;
   idempotent request IDs.
3. `PiRpcManager` alone owns Pi framing; history reader alone parses JSONL;
   raw Pi shapes never cross the browser boundary.
4. Closing an `agent`/`terminal`/`preview` tab ends that resource; all other
   pane kinds only remove the view.
5. Single lease holder for terminal size and preview input/viewport; explicit
   takeover only, never focus-steal.
6. Fixed Git argument arrays, `paseo.json` action IDs only, loopback-only
   preview URLs, bounded outputs everywhere.
7. Per-workspace layout + settings; per-session expansion;
   builtin read-only packs; generic fallback for unknown tools.
