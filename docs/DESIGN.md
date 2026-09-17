# Passage design

## Status

Proposed greenfield architecture and phased implementation plan. This document
uses **Passage** as the working product name, matching this repository.

## Product thesis

Passage is a single-user, LAN-accessible, web-based coding environment for
running multiple **Pi** agents and interactive terminals in isolated Git
workspaces. It combines Paseo's durable project/workspace/worktree model and
flexible pane canvas with Pi-Web's focused Pi integration, readable agent
timeline, local-first history, and PWA-quality browser experience.

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
 ├── File and Git service ──── registered workspace files
 └── Metadata store ────────── local SQLite database
```

## Decisions made

| Area | Decision |
| --- | --- |
| Deployment | Single-user daemon that is LAN-accessible by default. Application authentication is out of scope; the operator may place it behind upstream authentication. |
| Agent runtime | Pi only, integrated through one `pi --mode rpc` process per active agent. No provider abstraction in v1. |
| Canonical agent history | Pi JSONL sessions, including branches, compaction, and usage records. Passage never maintains a duplicate transcript. |
| Other persistence | A small local SQLite registry holds only Passage metadata, preferences, and pane layouts; it is never authoritative for Pi-derived data. |
| Runtime | Bun end to end. Bun starts and supervises the pinned `pi` executable directly; Pi uses its supported shebang runtime. Passage has no separate Node daemon, implementation layer, or fallback sidecar. |
| Initial host support | Linux x64. Other platforms require their own Bun native terminal and packaging gates before support is claimed. |
| UI | React, Bun HTML imports, Tailwind CSS, and shadcn/ui. Bun handles development rendering, bundling, and production packaging. |
| MVP | Multiple agents and live terminals per workspace; durable projects/workspaces/worktrees; Git/files/diff; a persistent split-pane canvas; responsive PWA. |
| Worktree locations | Users choose configured named locations. Workspace labels are independent of Git branch names and on-disk directory names. |
| Extensibility | Built-in typed renderer registry plus safe declarative theme/font/tool-renderer packs. No executable plugin framework in v1. |
| Pi extras | Pi is the only agent runtime, but Passage hides Pi skills, MCP, extensions, subagents, and orchestration management from its product UI. |

## Goals

1. Make it natural to manage many independent pieces of work: projects contain
   workspaces; workspaces contain zero or more agents and terminals.
2. Make Git worktrees safe, visible, and pleasant: a workspace has a stable
   label, a branch, an explicit owning location, and a known cleanup policy.
3. Make Pi the only agent system and retain its history as the source of truth.
4. Render agent work transparently by default: every tool appears as a compact
   expandable row, with a per-agent Concise mode that groups sequential
   activity when desired.
5. Support a real interactive terminal, file editor, and Git diff view in the
   same workspace canvas.
6. Work well in a browser, including a phone PWA, without pretending a phone
   can display a desktop split layout.
7. Keep the implementation understandable: one repository, one Bun package,
   one daemon, one browser app, and no premature packages or provider layers.
8. Support high-signal local activity statistics without analytics, usage
   reporting, or a remote monitoring product.

## Explicit non-goals for v1

- Multiple model providers, ACP, or a generic provider marketplace.
- Passage-managed skills, MCP servers, extensions, subagents, agent teams,
  orchestration UI, or terminal profiles.
- Arbitrary executable server or browser plugins.
- Hosted multi-user workspaces, collaboration, tenancy, relay networking, or
  account management.
- Pull-request hosting-provider integrations and review-comment publishing.
- Cloud telemetry, remote usage monitoring, or a separate message database.
- Offline editing or offline agent control. The PWA caches the application
  shell only; all mutable workspace state remains daemon-authoritative.

## Research synthesis

### Adopt from Paseo

- Durable separation of **project**, **workspace**, **agent**, and terminal
  lifecycle. In particular, do not infer workspace ownership from `cwd`.
- A workspace can represent a main checkout, a linked worktree, or a directory;
  `cwd`, checkout root, and main repository root are distinct where needed.
- The daemon owns PTYs, agent execution, Git operations, and event streaming.
- A serializable workspace-local split tree allows panels to be split, tabbed,
  dragged, and restored.
- Git status and structured diffs are first-class workspace surfaces.
- CodeMirror, xterm.js, bounded terminal replay, binary terminal frames, and a
  single terminal-size claimant are sound implementation patterns.
- File changes use an optimistic revision check rather than silently replacing
  a concurrently edited file.

Useful references examined include:

- `../paseo/docs/data-model.md`
- `../paseo/docs/agent-lifecycle.md`
- `../paseo/docs/terminal-performance.md`
- `../paseo/packages/server/src/utils/worktree.ts`
- `../paseo/packages/server/src/terminal/terminal.ts`
- `../paseo/packages/app/src/components/split-container.tsx`

### Adopt from Pi-Web

- Pi's JSONL session files are canonical durable history; Pi may append entries
  or rewrite session files during migrations and supported metadata operations.
  UI state is only a projection and caches are disposable.
- Read history from disk after a run settles rather than trusting transient
  browser stream state.
- Treat steering and follow-up as distinct visible actions: steering changes
  an active run; follow-up waits for it to complete.
- Normalize Pi's streamed and persisted block types before rendering. Accumulate
  streaming tool JSON until complete, pair call/results, and lazily load costly
  thinking content.
- Keep a final response prominent and progressively disclose process details.
- Reconcile after reconnect, refresh, focus, or mobile suspension instead of
  trusting a continuous event connection.
- Put project/worktree/session navigation and activity badges in a clean,
  focused sidebar. Use its PWA keyboard, safe-area, notification, and mobile
  viewport lessons.

Useful references examined include:

- `../pi-web/lib/session-reader.ts`
- `../pi-web/lib/rpc-manager.ts`
- `../pi-web/lib/streaming-message.ts`
- `../pi-web/hooks/useAgentSession.ts`
- `../pi-web/components/MessageView.tsx`
- `../pi-web/components/ChatWindow.tsx`

### Deliberately avoid

- Paseo's broad provider matrix, package topology, Expo/Electron/native client
  burden, skills/MCP orchestration, and executable plugin runtime.
- Pi-Web's Next.js process ownership, `globalThis` service registries, large
  all-purpose React hooks/components, and fixed single-chat-centric layout.
- Any second source of truth for messages, token totals, session branches, or
  compaction history.

## User-facing information architecture

### Core hierarchy

```text
Project
├── Default workspace (the project root itself; a virtual worktree, not a linked worktree)
└── Worktree workspace(s)
    ├── Agent(s)          ── each maps to one Pi session
    ├── Terminal(s)       ── live PTYs, scoped to the workspace
    ├── Files and editors
    ├── Changes and diffs
    └── Per-workspace pane layout
```

Definitions:

- **Project** — a logical codebase rooted at a registered filesystem location.
- **Workspace** — a specific directory/environment where work happens: either
  the project's Default workspace (the repository root itself) or one linked
  Git worktree. It is not synonymous with a branch or a terminal. Every
  workspace — Default included — hosts its own agents, terminals, files,
  and diffs.
- **Agent** — a durable Passage record that points to exactly one Pi session.
  It owns the Passage title, workspace membership, and UI lifecycle; Pi owns
  the transcript.
- **Terminal** — a live PTY owned by the daemon and attached to a workspace.
  It is not persisted as a resumable shell across daemon restart.
- **Panel** — a view of a workspace resource: agent, terminal, editor, diff,
  explorer, changes, overview, or web preview.

### Desktop layout

```text
┌───────────────────┬────────────────────────────────────────────────┐
│ Projects          │ Workspace header: label · branch · activity      │
│ └─ Workspaces     ├────────────────────────────────────────────────┤
│    ├─ Agents      │ Persistent split-and-tab canvas                  │
│    └─ Terminals   │  [Agent A] │ [Terminal]                          │
│                   │  ──────────┼──────────────────                   │
│ Files             │  [Diff]    │ [Editor]                            │
│ Changes           │                                                │
└───────────────────┴────────────────────────────────────────────────┘
```

The sidebar is navigation and activity, not a second competing workspace. A
workspace overview is the default initial panel and answers: which branch is
this, what is running, what needs attention, and what changed.

### Mobile layout

Mobile displays one focused panel at a time. It preserves the desktop split
tree but does not attempt to render simultaneous panes. A workspace switcher
and panel picker provide access to agents, terminals, files, and changes.

The terminal remains fully interactive on mobile. It must account for visual
viewport changes, safe-area insets, touch scroll/selection, copy/paste, and
the software keyboard. A visible focus/take-control action prevents a phone
from accidentally resizing a terminal actively used from a desktop browser.

## Domain model and persistence

### Sources of truth

| Data | Authority | Notes |
| --- | --- | --- |
| Agent messages, content blocks, session tree, compaction, Pi usage | Pi JSONL session | Read through a bounded, version-pinned Pi JSONL reader; do not mirror messages to SQLite. |
| Checked-out files and Git state | Filesystem and Git | Git CLI calculates status, worktree state, and diffs. |
| Live Pi RPC and PTY processes | Daemon memory | Process lifetime is independent of a browser connection and ends on daemon restart. |
| Passage object identity, workspace policy, layout, labels, and settings | Local SQLite | Small, migration-versioned registry; no transcript duplication. |
| Browser drafts and ephemeral view state | Browser local storage / memory | Disposable and never required to reconstruct a workspace. |

### SQLite records

Use `bun:sqlite` with ordered SQL migrations. Keep schemas small and use JSON
only for versioned structured preferences/layouts rather than generic blobs.

SQLite is the durable state file, not an invitation to model every value as a
separate relation. Add a table only when records have an independent lifecycle,
need their own bounded query, or require database-enforced references. Keep
strictly one-to-one workspace state on `workspaces`: layout and preferences are
targeted JSON-column updates, not separate repositories. Disposable indexes and
unused future-facing records do not belong in SQLite; rebuild them in memory if
a measured read path later needs them.

Snapshot reads stay bounded and set-oriented. Load projects, workspaces, and
enabled locations once each, then group or filter them in memory. Do not issue
one child query per project when the complete bounded collection is already
small. The absence of complex joins is intentional; SQLite remains useful for
atomic durable updates, foreign-key checks, and cleanup of independently owned
records.

Before the first user release, the schema is one clean version-1 baseline rather
than a history of development-only migrations. After users have durable data,
schema changes use ordered migrations and never rewrite an applied migration.

| Record | Essential fields |
| --- | --- |
| `projects` | opaque ID, configured root path, canonical real path, display label, archived timestamp |
| `worktree_locations` | opaque ID, global/project scope, display label, configured root path, canonical root, enabled flag |
| `workspaces` | opaque ID, project ID, kind, `cwd`, checkout root, main repository root, branch/ref, display label, location ID, ownership state, archive timestamp, versioned layout JSON, workspace preferences JSON |
| `agents` | opaque ID, workspace ID, Pi session ID/path, generated or overridden title, model/thinking preference, last known status, archive timestamp |

All primary identities are opaque IDs. Paths are attributes, never database
keys. The registry stores both configured and canonical paths: configured paths
preserve the user's intent; canonical paths enforce filesystem boundaries.

### Project and workspace invariants

1. A workspace belongs to exactly one project; an agent or terminal belongs to
   exactly one workspace.
2. A workspace `cwd` is the directory given to Pi, terminals, files, and Git
   operations. It may be below the workspace checkout root.
3. A main-checkout workspace is never assumed from a branch name. Git is asked
   for its actual checkout and worktree roots.
4. Only an explicit workspace record may authorize Passage to delete a
   worktree it created.
5. A terminal's ID remains valid only while its daemon-owned PTY exists.
6. Closing a panel is never the same as archiving an agent or deleting a
   workspace.

### Worktree locations, labels, and metadata generation

A worktree creation flow asks for:

1. **Purpose** — optional natural-language task or desired outcome.
2. **Workspace label** — human-readable, editable, and independent of branch.
3. **Branch** — editable Git branch/ref. It is validated as a Git ref, not as a
   path.
4. **Named location** — a global or project-specific configured destination.
5. **Physical folder** — suggested from the label and branch, collision-safe,
   and editable within the selected named location.

Example:

```text
Location: Fast SSD worktrees → /mnt/fast/worktrees/payments
Label:    Retry-safe invoice import
Branch:   feature/invoice-import-retries
Folder:   retry-safe-invoice-import--invoice-import-retries--wk_7d2a
```

The folder suffix makes collisions harmless; the label, not the path, is what
the UI presents. Worktree locations are named records, not one global root.
They can be configured globally or overridden per project.

`MetadataGenerator` supplies optional suggestions for Passage-owned workspace
metadata, such as labels, branch names, folder names, and other explicitly
approved fields. It uses a narrowly scoped Pi RPC prompt, validates structured
output, does not create a visible workspace agent or persist transcript data,
and never applies suggestions without user confirmation. Deterministic local
slugging is the fallback.

### Pi session mapping and lifecycle

Creating an agent starts an agent-specific Pi RPC process in that workspace
`cwd` and establishes its Pi session. The durable JSONL file may not exist until
Pi flushes it, including for Bash-only/no-message sessions. Passage persists the
stable Pi session ID immediately, updates the path mapping after the first
durable flush, and explicitly represents an unpersisted process/session. A
Passage agent is therefore a durable workspace-scoped handle over a Pi-owned
conversation.

```text
initializing → idle ⇄ running → stopping → idle
                    └────────→ needs-attention
                    └────────→ error
all non-archived states ────────────────→ archived
```

`stopping` means Passage accepted a cancellation request but has not yet
confirmed that Pi is idle. It blocks further agent commands. Passage only
returns the agent to `idle` after Pi reports settlement and reconciliation
confirms `isStreaming: false`; cancellation failure leaves an error state.

`needs-attention` is a UI state for user input, permission, process failure, or
an unaddressed error; it is not an invented Pi transcript event. Browser reloads
reattach to the live RPC process if it exists, then reconcile against Pi JSONL
on disk. Process exit settles pending RPC requests, records bounded stderr and
exit status, emits an attention/error state, and leaves the persisted Pi session
resumable. After daemon restart, agents remain resumable from their Pi session
but their previous process is not claimed to be live; the next open/reconcile
starts a new Pi RPC process and rebuilds state from JSONL.

Existing Pi sessions can be manually attached to a workspace in a later phase.
V1 creates Passage-owned sessions and preserves all Pi-created history for
them.

## Runtime architecture

### Repository layout and build

Keep a single Bun package and a deliberately shallow source tree:

```text
src/
  daemon/
    http/                 HTTP routes and WebSocket upgrade
    agents/               Pi RPC manager/client, JSONL reader, session projections
    terminals/            PTY ownership, replay, resize leases
    workspaces/           projects, files, Git, worktrees, watchers
    metadata/             SQLite migrations and repositories
  shared/
    protocol/             Zod schemas and event envelopes
    domain/               pure domain types and split-tree model
  web/
    app/                  routes, providers, feature shells
    components/           product components and shadcn/ui primitives
    features/             agents, terminals, files, changes, workspaces
    styles/               Tailwind and semantic theme tokens
```

Use Bun for package management, scripts, test runner, daemon runtime, React/HTML
bundling, production serving, and packaging. The daemon imports the React HTML
entrypoint directly. During development, Bun provides browser HMR while serving
the UI, API, and WebSocket from one process and origin. Production uses an
ahead-of-time Bun full-stack build with the HTML import resolved to bundled
assets.

### Chosen stack

| Concern | Choice | Rationale |
| --- | --- | --- |
| Server | Bun with Hono and Bun-native WebSockets | Hono provides mature routing/validation ergonomics without adopting a server framework or Node runtime. |
| Protocol validation | Zod | One runtime schema defines HTTP and WebSocket payloads. |
| Metadata | `bun:sqlite` | Built into the target runtime; no ORM is justified for this small local registry. |
| Client | React + Bun HTML imports + TypeScript | Direct browser SPA bundled by Bun without a separate frontend server. |
| UI | Tailwind CSS + shadcn/ui + Radix primitives | Accessible composable primitives and a token-based visual system. |
| Client state | TanStack Query for snapshots; Zustand for live connection/layout state | Separates server cache from high-frequency local WebSocket state. |
| Panes/dragging | Custom split-tree renderer + dnd-kit | The layout needs durable product semantics, not a black-box docking library. |
| Editor | CodeMirror 6 + lazily loaded Lezer languages | Lightweight, embeddable, and extensible for a pane-based editor. |
| Terminal | Bun native terminal subprocess API plus xterm.js with fit, search, links, unicode, clipboard; WebGL optional | Keeps PTY ownership in Bun; xterm.js provides the mature browser terminal and Canvas fallback. |
| Pi agents | Pi CLI in RPC mode, supervised by a Bun `PiRpcManager` | Pi owns agent commands/events and session state behind a simple process boundary. |
| Markdown | `react-markdown`, GFM/math plugins, KaTeX, strict sanitization | Safe, robust rich model-output rendering. |
| Git | Git CLI via argument arrays and a centralized service | Git worktree behavior is authoritative and feature complete in Git itself. |
| File watching | A watcher adapter with debounced reconciliation | File events are advisory; status/file reads always recheck the filesystem. |

### Bun compatibility gate

Before product work depends on them, prove all of the following in one
disposable Bun integration spike:

1. Launch the pinned `pi --mode rpc` CLI from Bun; create/resume a session,
   send prompt/steer/follow-up commands, parse concurrent responses/events, and
   read the resulting JSONL session directly.
2. Spawn, write to, resize, and terminate a PTY through Bun's native terminal
   subprocess API on Linux x64.
3. Run isolated Pi RPC processes and a PTY concurrently while streaming through
   a Bun WebSocket; validate stderr, crash, restart, and process shutdown.
4. Build and start the production Bun bundle with Pi and native dependencies
   installed as they will be packaged.

The Pi RPC process is a required agent process, not a fallback sidecar. Bun
starts and supervises the `pi` executable directly. A failed compatibility item
blocks the dependent feature and must be resolved or explicitly deferred before
the MVP commitment is made.

## Browser/daemon protocol

### Transport responsibilities

- **HTTP** returns bounded snapshots: project/workspace lists, Pi history pages,
  file contents, Git status/diffs, current runtime snapshots, and static assets.
- **WebSocket** carries a minimal browser-facing `pi` channel for selected
  Pi-native commands, normalized Pi events, acknowledgements, snapshots, and
  replay; separate Passage-owned channels carry file/Git invalidation,
  pane-independent presence, and terminals. One narrow exception exists:
  `GET /api/previews/:previewId/ws` relays bounded agent-browser frames and
  input for web previews. It is high-volume disposable content (like PTY
  bytes), never enters `WorkspaceEventHub`, replay buffers, SQLite, or Pi
  history, and requires the `Host`/`Origin`, ownership, size-cap, and
  single-lease rules in `docs/WS.md`.
- **Binary WebSocket frames** carry high-volume terminal bytes. Semantic agent
  events remain structured JSON so tool-call boundaries cannot be lost.
  Preview frames are high-volume disposable JPEG content relayed through the
  preview socket with ack pacing and latest-frame-wins resume; they are never
  replayed.

All messages use a versioned Zod-defined envelope:

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

The envelope selects a Passage resource and adds request/event sequencing; it
does not recreate Pi's command vocabulary. The minimal `pi` channel carries only
the pinned Pi RPC commands and normalized events intentionally exposed for a
specific Passage agent. `workspace`, `terminal`, and `daemon` channels carry
Passage-owned resource operations. Clients send an acknowledged command ID so
retries are idempotent. The daemon assigns monotonically increasing sequence
numbers per subject stream.

### Reconnection and replay

Each live resource maintains a bounded replay buffer and a current snapshot.
On reconnect the client supplies the last sequence it observed. The daemon
either replays contiguous events or responds that a snapshot is required. The
client then reloads the authoritative HTTP state and resubscribes.

This applies separately to:

- Pi RPC events and run state;
- terminal output and terminal metadata;
- workspace/Git/file invalidations.

After an agent run settles, the browser reloads the relevant Pi JSONL history
page. Streamed content is a responsive provisional projection, not the final
record. Visibility, online, and WebSocket reconnect events trigger a runtime
state reconciliation; mobile suspension is expected rather than treated as an
exception.

### Backpressure and limits

- Coalesce raw terminal chunks on the daemon and client, without crossing
  ordering barriers such as resize/snapshot/clear events.
- Bound terminal replay by bytes and time; send a terminal snapshot if the
  client falls behind.
- Page Pi history and lazy-load expensive thinking content.
- Cap Git command output, file content, diff size, and rendered markdown size.
- Centralize Git/process concurrency and timeouts; callers never execute an
  arbitrary shell string through an HTTP endpoint.

## Pi integration and agent experience

### Pi RPC boundary

`PiRpcManager` is the only daemon module that starts Pi processes and owns Pi
RPC stdin/stdout framing, response correlation, stderr capture, process
lifecycle, and event normalization. `PiSessionHistoryReader` is the only module
that parses Pi JSONL for durable history/reconciliation. Raw Pi RPC records and
JSONL entry shapes never cross the browser protocol boundary unnormalized.

Together they provide:

- agent-specific process start/resume, exit, crash, and shutdown;
- Pi command dispatch for prompt admission, steering, follow-up, abort, model,
  thinking, and compaction;
- bounded direct JSONL history pages and branch/compaction awareness;
- normalized content, tool, usage, and lifecycle events;
- a small, explicit mapping of Pi errors/permissions/process failures to
  attention states.

This is a Pi-specific process boundary, not a generic multi-provider interface.
It contains Pi version changes without recreating Pi's agent semantics.

### Composer and queue behavior

Each agent panel has one composer. It supports a normal prompt, `@` file
references, Pi-supported image attachments, draft recovery, model choice,
thinking level, and a small set of Pi-native slash commands.

When a run is active, the UI presents two clearly labeled actions:

- **Steer** — inject now into the active Pi run.
- **Follow-up** — enqueue after the active run completes.

Their queues are visibly distinct. Pi 0.84.3 exposes queue modes but not
per-item removal or queue clearing; Passage does not falsely offer either
control. The default keyboard action is never ambiguous: the button label and
shortcut describe the action that will occur. Passage delegates queue semantics
to Pi rather than reimplementing a competing scheduler.

Sending a prompt is acknowledged only when Pi accepts or rejects prompt
admission. That acknowledgement does not indicate run completion. Passage keeps
the browser subscription active through message finalization, `agent_end`,
retries, compaction, queued follow-ups, and the pinned-version settlement signal,
then reloads bounded Pi JSONL history and publishes the reconciled snapshot.

### Timeline projection and progressive disclosure

The raw Pi content sequence remains intact. `TimelineProjection` turns it into
readable UI blocks:

1. Consecutive streamed/persisted thinking fragments become one **Thinking**
   block. It is collapsed by default after completion and its full content is
   lazy-loaded when necessary.
2. A tool call and its matching result become one **Tool activity** item. Tool
   input is displayed only after its streamed JSON is complete.
3. Consecutive tool activities without user-facing assistant prose between
   them become one **Process group** after completion, for example
   `Explored 8 files · ran 3 commands · edited 2 files`. It expands to all
   constituent calls, inputs, outputs, durations, and errors.
4. A renderer may mark an activity as significant (for example an edit,
   permission prompt, failed test, or image result), which creates a group
   boundary and remains prominent.
5. Assistant prose and the final answer remain outside a completed process
   group and therefore easy to scan.

Coalescing is a presentation projection only. It cannot alter Pi history,
collapse across user messages, remove tool boundaries, or hide errors.

### Tool renderer registry

All tools first render through a safe generic card: tool name, status, elapsed
time, expandable normalized JSON input, text/ANSI result, and any attachments.
First-party renderers register a typed match and presentation for common work:

- shell command and command result;
- file read/search/list;
- file write/edit with before/after diff;
- Git/diff action;
- image/artifact output;
- task/progress result.

Declarative renderer packs can map a custom tool name and fields onto those
safe presentation types. A pack may define labels, summary fields, field order,
path links, status mapping, and group-boundary significance. It cannot execute
JavaScript, inject arbitrary HTML, access the filesystem, or call a daemon API.
Unknown tools always retain the generic fallback rather than becoming invisible.
Custom-tool packs affect rendering and grouping only; they cannot execute tools,
alter Pi history, change tool ordering, or participate in agent orchestration.

Executable plugins are a deliberate later design problem: they require trust,
isolation, lifecycle management, compatibility, and UI sandboxing that v1 does
not need.

### Local activity statistics

Each run displays concise local facts where available:

- input, output, cache-read, and cache-write tokens;
- model cost from the local Pi model configuration;
- start time, first-token latency, generation duration, and output tokens/sec;
- tool count, tool durations, retries, and queue wait time;
- lifetime session totals derived from Pi history.

Token and cost totals come from Pi's persisted usage data. Runtime timing uses
Passage run spans and is labeled unavailable rather than guessed after an
unobserved restart. These are local UI diagnostics, not telemetry: nothing is
sent to Passage or a third party.

## Workspace, filesystem, Git, and worktrees

### Filesystem boundary

The daemon exposes only registered workspace roots and their permitted
subdirectories. Every request resolves a real path server-side and verifies it
remains inside the registered canonical root; traversal and symlink escapes are
rejected. Browser-provided paths, displayed paths, and workspace labels are
never authority.

File writes require an expected revision (content hash plus modified time).
When the file changed since it was read, the server returns a conflict and the
editor provides reload/compare choices rather than overwriting it.

### Git service

A centralized Git service invokes the Git CLI with fixed argument arrays,
locale control, output limits, cancellation, timeouts, and a bounded
concurrency scheduler. It owns:

- repository/worktree discovery;
- branch, ahead/behind, dirty, and conflict status;
- working-tree and staged diff targets;
- structured file-change summaries;
- worktree creation, refresh, and safe removal.

The client receives a normalized status/diff model covering additions,
modifications, deletions, renames, untracked files, binary files, submodules,
and too-large/truncated output. It does not parse arbitrary Git porcelain or
patch text on the main UI path.

### Worktree lifecycle

Creation performs these steps transactionally where Git permits:

1. Validate project, selected named location, target folder, and branch/ref.
2. Resolve the destination's canonical parent and ensure it is an enabled
   Passage worktree location.
3. Run `git worktree add` with an explicit argument list.
4. Record a durable Passage workspace record with owned state.
5. Refresh Git status and offer agent/terminal creation.
6. If durable registration fails, report a repairable state and do not silently
   delete user work.

Removal requires the workspace ownership record. Dirty or unmerged worktrees
require an explicit force-confirmation path. Removal never deletes branches
automatically.

A new worktree auto-starts its workspace setup action when one is defined:
the `worktree.setup` command list from the worktree's `paseo.json`, executed
sequentially in the worktree directory. Setup scripts are commonly slow, so
runs are asynchronous: starting an action returns a run snapshot immediately
and the commands proceed in the background, with at most one active run per
workspace. The same action can be re-run (and a running one cancelled) on
any workspace via the workspace actions API; run start/settle is published
as an `actions-changed` workspace invalidation and clients refetch the run
snapshot over HTTP. Runs are live daemon memory and do not survive a daemon
restart. Only commands from `paseo.json` ever execute — the API accepts an
action id, never a command string — and a setup failure never fails creation
or deletes user work; the create response carries the background run
reference for the caller to poll. Teardown scripts and auto-allocated ports
remain omitted as high-risk orchestration features with weak safety and
little value to the core model.

### Files, editor, changes, and diff panels

- **Explorer** provides a lazy directory tree and changed-files section.
- **Editor** uses CodeMirror 6, local dirty buffers, conflict-aware save, and
  lazy syntax languages. Files open as normal tabs/panels.
- **Changes** shows concise status, additions/deletions, and file grouping.
- **Diff** renders server-created structured diffs with syntax highlighting,
  inline/side-by-side modes, virtualization, binary/oversize fallbacks, and
  links back to the editor.

## Terminal design

`TerminalManager` owns all PTYs. A terminal has a workspace, cwd, shell command
chosen by platform default, title, current dimensions, activity state, bounded
replay, and exit state. It is live runtime state rather than a persisted shell
profile.

The client uses xterm.js. The server sends output over binary WebSocket frames
with a terminal ID and sequence number; terminal create/attach/resize/input/
exit/snapshot events are structured control messages.

Only one attached client holds the terminal **size lease** at a time. Focus or
an explicit take-control action acquires it; passive viewers receive output but
cannot resize the PTY. This prevents a narrow mobile viewport from changing
line wrapping in an active desktop session. Input remains available to the
single user from an attached client, with a clear control indicator.

V1 supports platform-default shells and a direct `cwd`; it intentionally omits
named terminal profiles, startup script catalogs, and arbitrary global shell
configuration. An agent's shell tool activity remains in its timeline and is
not confused with a user-controlled terminal pane.

## Pane canvas and visual system

### Split-tree model

Layouts are serialized, schema-versioned trees stored per workspace:

```ts
type Pane = { id: string; kind: PaneKind; resourceId?: string };
type LayoutNode =
  | { type: "tabs"; tabs: Pane[]; activePaneId: string }
  | { type: "split"; axis: "horizontal" | "vertical"; ratio: number;
      first: LayoutNode; second: LayoutNode };
```

Pane kinds are `overview`, `agent`, `terminal`, `explorer`, `changes`, `editor`,
`diff`, and `preview`. A preview tab views a live workspace-bound browser
session; closing it closes only the view, never the underlying preview.
Dragging a tab supports reordering, moving to a tab set, and
splitting in a directional drop zone. The model enforces minimum dimensions,
stable panel IDs, and schema migrations. Closing a resource pane removes only
that view; resource archival/deletion always requires a separate command.

### Themes, chat display, and fonts

Tailwind consumes semantic CSS variables rather than fixed component colors:

```text
--background --surface --surface-raised --border --foreground --muted
--accent --success --warning --danger --user-message --tool-message
--font-ui --font-mono --font-editor --font-terminal
```

Theme packs are JSON/token assets validated by the daemon. Font packs reference
locally registered `.woff2` resources served from Passage-managed storage;
they never require an arbitrary remote stylesheet. UI, editor, and terminal
fonts are independently selectable. Changing a terminal font triggers a safe
fit after it loads.

Chat display settings include density and activity-detail defaults, so users
can choose concise grouped activity or expanded tool detail without changing
the underlying history. The system supports light, dark, system, and imported
validated theme packs rather than hard-coding one visual treatment.

## PWA and LAN operation

### PWA behavior

- Serve a manifest, icons, and a service worker.
- Cache versioned static application assets and an offline explanatory shell.
- Do not cache mutable sessions, files, Git results, credentials, terminal
  output, or authenticated API responses as offline data.
- Prompt users before activating a new app version when it may disrupt an open
  connection.
- Reconnect and reload daemon snapshots on online/visibility return.
- Support browser notifications for agent completion/attention only after a
  user grants permission. Push infrastructure is not an MVP requirement.

### Deliberate LAN security posture

The requested v1 daemon is LAN-accessible and has **no application-level
authentication**. Anyone able to reach it can potentially read registered
workspace files, control Pi agents, run terminal commands, and alter Git
worktrees. It is appropriate only on a trusted network or behind the
operator's own authenticated reverse proxy/VPN.

This is not a reason to omit baseline browser protections:

- validate `Host` and WebSocket `Origin` against configured allowed origins;
- serve the SPA and API from the same configured public origin in production;
- require explicit configuration before accepting browser origins other than
  the daemon's own origin; development also uses that origin;
- keep realpath workspace boundaries, command allowlists, output limits, and
  safe worktree deletion regardless of network trust;
- log local security-relevant rejections without collecting remote analytics.

PWA installation, service workers, clipboard APIs, and secure WebSockets on a
remote LAN host require HTTPS. TLS and any identity/authentication remain the
responsibility of the upstream proxy/operator, not Passage v1.

## Phased implementation plan

Each phase ends with working, tested behavior. The first public MVP is complete
only after Phase 5.

### Phase 0 — Bun feasibility spike

**Objective:** remove the only existential runtime risks before committing to
the product build.

- Set up one Bun package, TypeScript, `bun test`, and a minimal Bun HTML-import
  React page.
- Prove Bun-supervised Pi process/session/history/steer/follow-up behavior.
- Prove Bun's native terminal lifecycle and production packaging.
- Prove a Bun WebSocket can stream Pi output and terminal bytes concurrently.
- Record exact supported OS/runtime versions and any package patches in an ADR.

**Exit criteria:** all four compatibility-gate checks above pass in CI and on a
developer workstation. If a check fails, defer its dependent product feature.

### Phase 1 — Daemon foundation and durable workspace identity

**Objective:** establish a safe, simple local platform boundary before adding
rich UI behavior.

- Create the Bun daemon, Hono HTTP routes, static asset serving, WebSocket
  handshake, Zod protocol package directory, and protocol versioning.
- Add SQLite migrations and repositories for projects, workspaces, locations,
  agents, and layout records.
- Implement project registration, canonical-path enforcement, configured
  allowed origins, and LAN startup warnings.
- Implement named global/project worktree locations and the workspace overview
  query.
- Bootstrap React, Tailwind, shadcn/ui, theme tokens, project/workspace sidebar,
  and basic responsive shell.

**Exit criteria:** a user can register a project and get its Default workspace, name
it, reopen it after daemon restart, and access it only through its registered
canonical root from the responsive web UI.

### Phase 2 — Pi agent core and readable timeline

**Objective:** make Pi sessions useful in a Passage workspace without a second
history system.

- Implement `PiRpcManager`, LF-only RPC client/parser, `PiSessionHistoryReader`,
  session-to-agent mapping, and snapshot/replay/reconciliation protocol.
- Create/resume Passage-owned Pi agents as isolated RPC processes in a workspace.
- Implement normal prompt, abort, explicit steer, follow-up queue, model and
  thinking controls, and browser draft recovery.
- Read paged history directly from Pi JSONL; support compaction and branch
  metadata correctly.
- Add normalized streaming reducer, thinking blocks, call/result pairing,
  completed process grouping, generic tool card, and first-party tool renderers.
- Add local per-run/lifetime statistics and attention/error states.

**Exit criteria:** two agents in one workspace run as isolated Pi RPC processes,
survive browser reload, recover from process restart, reconcile after network
interruption, and display the same settled history Pi records on disk.

### Phase 3 — Git-aware workspaces, worktrees, files, and diffs

**Objective:** make isolated code work safe and inspectable.

- Implement centralized Git execution, status refresh, structured diff model,
  and Git error/limit handling.
- Implement new worktree flow with suggested metadata, named destination,
  independent label, ownership marker, dirty-removal confirmation, and repair
  visibility.
- Add explorer, file reads, optimistic revision-checked writes, CodeMirror
  editor, changed-file list, and bounded diff viewer.
- Add file/Git watch invalidations with debounce and focus reconciliation.

**Exit criteria:** a user can create two labeled worktrees in different named
locations, run agents in them, edit files safely, and inspect working-tree
changes/diffs without exposing paths outside registered roots.

### Phase 4 — Interactive terminals and workspace canvas

**Objective:** turn the product into a multi-surface coding environment.

- Implement `TerminalManager`, Bun native terminal adapter, binary output frames,
  bounded replay, snapshots, resize/input/exit controls, and a size lease.
- Add xterm.js desktop and mobile integration, touch/viewport tests, font-fit
  handling, clipboard, links, search, and a non-WebGL fallback.
- Implement the serialized split-tree renderer, tabs, drag/drop directional
  splits, resizing, layout persistence/migration, and resource-safe close
  behavior.
- Add workspace overview activity cards and fast actions for agents, terminals,
  files, and changes.

**Exit criteria:** multiple agents, terminals, editors, and diffs can be split,
tabbed, moved, restored, and used concurrently in a workspace. A phone can
interactively use a terminal without unexpectedly resizing an active desktop
terminal.

### Phase 5 — PWA polish, packs, hardening, and MVP beta

**Objective:** deliver the promised browser-quality, maintainable MVP.

- Implement service worker, manifest, install/update UX, mobile panel picker,
  safe-area/visual-viewport behavior, reconnect reconciliation, and optional
  local browser notifications.
- Implement validated theme/font packs and declarative custom-tool renderer
  packs; include several polished built-in themes and terminal/editor font
  settings.
- Add large-history, large-diff, slow-network, suspended-mobile, multi-tab,
  daemon-restart, worktree-repair, and unsafe-origin test cases.
- Document LAN risk, upstream TLS/proxy deployment, supported platforms,
  Pi/Bun compatibility versions, data locations, backup/recovery, and limits.
- Run usability review on desktop and mobile, fixing confusing editor/pane
  interactions before beta.

**Exit criteria:** the end-to-end MVP supports the declared product thesis on
desktop and mobile PWA, has no Node runtime dependency, and has tested recovery
paths for browser disconnects, daemon restarts, worktree cleanup, and conflict
edits.

### After MVP, only when justified

1. Attach/import existing Pi sessions and richer Pi branch navigation.
2. Review workflow improvements and forge integrations.
3. Trusted executable local plugins, designed as a dedicated security project.
4. User-controlled repository setup recipes, with an explicit trust model.
5. Optional upstream-auth identity awareness or remote-control improvements.
6. Additional providers only if Pi-only constraints demonstrably block users.

## Quality and verification strategy

| Layer | Verification |
| --- | --- |
| Domain/protocol | `bun test` for Zod schemas, split-tree mutations/migrations, worktree metadata, path boundary logic, coalescing, and tool renderer matching. |
| Pi RPC | Fixture JSONL sessions plus live Bun integration tests for process start/resume/crash, LF framing, response/event correlation, prompt/steer/follow-up/compaction, and restart reconciliation. |
| Git/worktrees | Temporary Git repositories covering main checkout, linked worktree, dirty removal, rename, binary, submodule, path-with-spaces, and failed registration recovery. |
| PTY | Platform integration tests for spawn/input/resize/lease/replay/exit and binary WebSocket ordering. |
| Browser | Playwright desktop tests for panes, editors, diffs, process grouping, reconnect, and file conflict flows. |
| Mobile/PWA | Playwright responsive tests plus manual iOS/Android install, keyboard, terminal, suspend/resume, safe-area, and viewport validation. |
| Security | Tests for traversal, symlink escape, malformed protocol input, oversized output, unknown origins, and destructive worktree-operation confirmation. |

Performance budgets are defined before implementation for initial history page,
terminal input echo, terminal replay, first visible stream token, large-diff
fallback, and PWA reconnect. The product reports local activity statistics but
does not collect user telemetry to measure these externally.

## Principal risks and mitigations

| Risk | Mitigation |
| --- | --- |
| Pi RPC CLI or Bun native terminal API fails | Phase 0 is a hard gate; defer the affected feature rather than adding a separate Node implementation layer. |
| LAN daemon is exposed to an untrusted device | Document prominently, retain origin/path/process safeguards, and recommend upstream TLS/auth/VPN. This is an accepted v1 deployment risk. |
| Mobile browser suspends a live connection | Sequence/replay, authoritative snapshots, visibility reconciliation, and post-run Pi-history reload. |
| One browser resizes another terminal | Single active size lease with explicit mobile takeover. |
| Worktree cleanup deletes user work | Persist explicit ownership in the database, require it for deletion, reject dirty removal by default, and preserve branches. |
| Pi upgrades break rendering | Isolate RPC framing/normalization and JSONL parsing, pin the CLI version, and keep compatibility fixtures. |
| Rich custom tools become a plugin-security problem | Use safe declarative packs and a robust generic fallback; no executable plugin API in v1. |
| Large histories/diffs freeze the UI | Server limits/paging, lazy thinking, virtualized lists, process grouping, and oversize fallbacks. |
| Pane canvas overwhelms mobile | Persist the full layout but render only a focused panel on narrow screens. |

## MVP definition of done

Passage is ready for MVP beta when a single user on a trusted LAN can:

1. Open a project; create, label, reopen, and safely remove workspaces across
   multiple named worktree locations.
2. Start and resume multiple Pi RPC agents in any workspace, with Pi JSONL as
   the authoritative history.
3. Prompt, steer, queue follow-ups, inspect clear token/performance facts, and
   understand agent work through expandable thinking/tool groups.
4. Open multiple interactive terminals, editors, and Git diffs beside agents;
   arrange and restore them through a persistent split/tab canvas.
5. Use the same environment from a desktop browser and an installed mobile PWA,
   including an interactive mobile terminal and reliable reconnect behavior.
6. Customize visual theme, density, and UI/editor/terminal fonts; add safe
   declarative custom-tool presentation packs.
7. Recover predictably from browser disconnection, mobile suspension, Pi process
   crash/daemon restart, stale file edits, large data, and interrupted worktree
   setup.
