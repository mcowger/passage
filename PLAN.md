# Passage implementation plan

This plan turns [the design](docs/DESIGN.md) into dependency-ordered delivery
steps. Each step ends with a gate that must pass before dependent work begins.
Tests are added with each capability rather than deferred to the final phase.

## Current implementation status — 2026-09-08

Work is currently paused at Step 8 (Security & hardening). Steps 1 through 7 are complete, including git worktrees, file explorer, CodeMirror editor, diffs, daemon-owned terminals with xterm.js, split-tree canvas, PWA, and OpenChamber UI alignment. All unit tests (108 pass across 26 files), typechecks, and Phase 0 integration gates pass.

| Step | Status | Completed scope / remaining gate |
| --- | --- | --- |
| 1. Runtime feasibility | Complete | Bun 1.4.0, Pi CLI 0.85 (with 0.84.3+ compatibility), Bun HTML imports/build/package, Pi RPC with stdout log noise tolerance, and Bun native PTY pass on the initial Linux x64 support target. See `docs/adr/0001-bun-runtime-feasibility.md`. |
| 2. Daemon/protocol/persistence | Complete | Hono/Bun daemon, bounded Zod protocol/replay, origin safeguards, SQLite migrations/repositories, and production smoke checks are implemented. |
| 3. Projects/workspaces | Complete | Canonical-root registration, directory-workspace lifecycle, path containment, workspace APIs, and the responsive project/workspace shell are implemented. |
| 4. Pi agents | Complete | Supervised Pi RPC agents, direct bounded JSONL reconciliation, normalized history/timeline, replay/reconnect, agent API, composer, in-composer model picker, and agent UI are implemented. Tolerates non-JSON stdout log output and captures to bounded stderr without process crashes. |
| 5. Git/files/worktrees | Complete | Centralized Git status/diff, safe worktree metadata/marker lifecycle, bounded file reads/writes, Hono APIs, lazy explorer, Changes panel, CodeMirror editor with dirty buffers, and virtualized diffs are implemented. |
| 6. Daemon-owned terminals | Complete | Daemon-owned `TerminalManager`, native Bun PTY adapter, binary WebSocket protocol with sequenced control/data frames, single-client size lease with explicit take-control, xterm.js UI with Canvas/WebGL fallbacks, and mobile viewport controls are implemented. |
| 7. Workspace canvas & PWA | Complete | Versioned split-tree layout engine, panel restoration, split/tab/move/resize canvas, OpenChamber aesthetic alignment, PWA manifest and service worker, theme packs, command palette, and mobile single-panel drawer are implemented. |
| 8. Security & hardening | Partially implemented | Host/Origin safeguards and path containment exist; centralized limits registry, cross-resource recovery, and structured diagnostic logging remain. |
| 9. Verification & Playwright | Not started | Unit/integration/smoke tests pass (108 pass across 26 files); Playwright browser automation and full platform validation matrix remain. |
| 10. Beta packaging | Not started | Build/compile scripts exist; deployment documentation, reverse-proxy/VPN guidance, and MVP beta checklist remain. |

### Verified at pause

```sh
bun run typecheck
bun test
bun run test:phase0
```

The required compatibility and test suites pass, including typecheck, unit tests (108 pass across 26 files), live Pi process/session checks (with non-JSON stdout log tolerance), Bun native PTY checks, development/production smoke tests, and compiled-package smoke tests.

### Resume point

Proceed with Step 8 (Security & hardening):
1. Centralize resource limits across files, diffs, JSONL history, terminals, and replay buffers into a single limits registry.
2. Add structured diagnostic logging for security rejections, Pi process lifecycle/stderr, and recoverable worktree states without adding remote telemetry.
3. Verify cross-resource recovery flows for daemon restarts, browser disconnects, dirty worktree protection, and stale editor saves.
4. Pass the Step 8 security and hardening edge-case test gate before configuring Playwright (Step 9).

## Implementation rules

- Use one Bun package for the daemon, shared protocol, and React application.
- Treat Pi JSONL as canonical agent history; SQLite stores only Passage-owned
  metadata, layouts, preferences, and disposable indexes.
- Run one pinned `pi --mode rpc` process per active agent. Do not introduce a
  direct-SDK implementation, generic provider abstraction, or Node fallback.
- Resolve all filesystem and Git operations from registered server-side roots;
  browser-supplied paths, displayed paths, labels, and shell commands are never
  authority.
- Keep all streams, file reads, diffs, history pages, process output, and replay
  buffers bounded.
- Preserve the v1 exclusions in `docs/DESIGN.md`; defer unspecified product and
  protocol details until the step that requires an explicit decision.

## 1. Prove runtime feasibility

Establish the repository and eliminate runtime risks before building features.

### Deliver

- Create the Bun/TypeScript package, test setup, Bun HTML-import React
  application, and production full-stack serving path.
- Establish the shallow `src/daemon`, `src/shared`, and `src/web` structure.
- Pin supported Bun, Pi CLI, and native dependency versions.
- Treat Linux x64 as the initial supported host; require a new compatibility
  gate before claiming additional platforms.
- Build Phase 0 spikes for Pi RPC session create/resume, prompt/steer/follow-up,
  direct JSONL reading, Bun's native terminal API, Bun WebSockets, concurrent
  streaming, process failure, and production packaging.
- Record compatibility results, supported platforms, and initial performance
  budgets.

### Gate

- Bun can start and supervise the pinned Pi RPC CLI, create/resume sessions,
  exercise prompt/steer/follow-up, parse concurrent responses/events, and read
  resulting JSONL sessions directly.
- Bun's native terminal API can spawn, receive input, resize, and terminate on
  Linux x64.
- Pi RPC and PTY traffic can stream concurrently through Bun WebSockets while
  preserving stderr, crash, restart, shutdown, and process-exit behavior.
- The production bundle starts with Pi and native dependencies installed as
  they will be packaged.
- Any failed capability is fixed or explicitly deferred; no Node implementation
  layer or fallback sidecar is added.

## 2. Build daemon, protocol, and persistence foundations

Create the shared boundary required by every product surface.

### Deliver

- Implement the Bun daemon, Hono HTTP routing, static serving, WebSocket
  upgrades, graceful shutdown, and local structured logging.
- Define versioned Zod schemas for `pi`, `workspace`, `terminal`, and `daemon`
  commands/events, including request IDs, acknowledgements, subject IDs, and
  per-subject sequence numbers.
- Add HTTP snapshot endpoints, bounded replay buffers, and a
  snapshot-required fallback when replay is unavailable.
- Enforce configured Host/WebSocket Origin checks, same-origin development and
  production serving, and a LAN startup warning.
- Add ordered SQLite migrations and repositories for projects, locations,
  workspaces, agents, layouts, workspace settings, metadata jobs, and the
  disposable Pi session index.
- Establish opaque IDs, archive fields, canonical path fields, schema versions,
  and idempotent command handling.

### Gate

- Empty and existing databases migrate deterministically.
- The daemon validates and bounds all protocol input and output.
- Unknown origins are rejected before accessing workspace resources.
- Restart preserves Passage metadata while correctly treating prior live
  processes as no longer live.
- Browser protocol types expose neither raw Pi records nor arbitrary shell
  execution.

## 3. Deliver registered projects and directory workspaces

Build the first usable vertical slice and establish the filesystem trust
boundary before adding agents, Git mutation, or terminals.

### Deliver

- Register projects using both configured and canonical real paths.
- Model workspace identity independently from branch names and distinguish cwd,
  checkout root, and main repository root.
- Add named global/project worktree locations with canonical roots and enabled
  state.
- Enforce realpath containment for every workspace, file, and Git operation;
  reject traversal and symlink escapes.
- Build the initial responsive application shell, project/workspace sidebar,
  workspace overview, and semantic theme tokens.
- Support creating, labeling, reopening, and archiving directory workspaces.

### Gate

- Workspace identity and metadata survive daemon and browser restarts.
- No request can escape a registered canonical root.
- Closing a view does not archive or delete its underlying resource.
- The workspace overview renders authoritative server state on desktop and
  mobile.

## 4. Deliver the Pi agent vertical slice

Integrate Pi through its RPC process boundary and reconcile all durable state
from Pi JSONL.

### Deliver

- Implement `PiRpcManager` for LF framing, response correlation, normalized
  events, bounded stderr, process supervision, shutdown, and crash handling.
- Implement `PiSessionHistoryReader` as the only bounded Pi JSONL parser.
- Create and resume Passage-owned agents in workspace cwd, persist the Pi
  session ID immediately, represent the pre-flush process/session explicitly,
  and record the JSONL path after durable flush. Existing-session attachment
  remains post-MVP.
- Implement lifecycle states, including `needs-attention` as Passage UI state;
  settle pending requests and retain bounded stderr/exit status on process exit.
- Implement prompt admission, abort, model/thinking controls, `@` file
  references, Pi-supported attachments, draft recovery, and the selected
  Pi-native slash commands.
- Implement visibly distinct steering and follow-up queue state and Pi queue
  modes. Do not offer per-item removal or queue clearing, which Pi 0.84.3 does
  not expose.
- Add paged history, branch/compaction awareness, lazy thinking content, paired
  tool activity, completed process grouping, and a safe generic tool renderer.
- Render assistant Markdown with strict sanitization and bounded output.
- Add first-party renderers for shell, file read/search/list, file write/edit,
  Git/diff, image/artifact, and task/progress activity.
- Keep grouping presentation-only: it cannot alter Pi history, cross user
  messages, remove tool boundaries, or hide errors.
- Derive token, cost, and lifetime totals from Pi usage/history; derive timing
  only from observed Passage run spans and mark unavailable timing rather than
  estimating it after an unobserved restart.
- Reconcile live RPC state with JSONL after reconnect, visibility return,
  process restart, daemon restart, and run settlement.

### Gate

- Two agents in one workspace run independently in separate Pi RPC processes.
- Browser reload and WebSocket interruption lose no durable conversation state.
- Process or daemon restart resumes from Pi JSONL without claiming the old
  process is still live, and exposes process failure as bounded attention/error
  state rather than an invented Pi event.
- Settled browser history matches the canonical Pi session on disk.
- Prompt acknowledgement represents admission, not run completion.

## 5. Deliver Git, worktrees, files, editors, and diffs

Add safe isolated coding workflows on top of registered workspace identity.

### Deliver

- Centralize Git execution with fixed argument arrays, controlled locale,
  cancellation, timeouts, output limits, and bounded concurrency.
- Normalize repository/worktree discovery, branch and ahead/behind state,
  working-tree status, conflicts, renames, untracked files, binary files,
  submodules, and truncated results. Ask Git for main-checkout, checkout-root,
  and repository-root identity rather than inferring it from branch names.
- Implement worktree creation with an independent label, validated ref, named
  location, collision-safe folder, durable ownership record, and on-disk marker.
- Add optional `MetadataGenerator` suggestions through a narrowly scoped Pi RPC
  prompt with validated structured output, no visible agent or persisted
  transcript, deterministic slug fallback, and user confirmation before use.
- Make registration failures repairable; require both ownership records before
  removal, require explicit force confirmation for dirty or unmerged worktrees,
  and never delete branches automatically.
- Add the lazy explorer and a Changes view with concise additions/deletions and
  changed-file grouping.
- Add CodeMirror editing with dirty buffers and optimistic revision checks.
- Add structured, bounded, virtualized diffs with inline/side-by-side modes and
  explicit binary/oversize fallbacks plus links back to the editor.
- Treat filesystem watchers as advisory invalidation followed by authoritative
  refetch.
- Do not run arbitrary repository setup/teardown scripts or allocate ports as
  part of worktree creation.

### Gate

- Users can create labeled worktrees in multiple named locations and run agents
  in each workspace.
- Main checkout and repository roots are discovered authoritatively, failed
  registration remains visibly repairable, and Passage never silently deletes
  user work or branches.
- Stale edits cannot overwrite newer disk content without a compare/reload
  decision.
- Git status and diff behavior pass the specified rename, binary, submodule,
  conflict, untracked, large-output, and path-with-spaces cases.

## 6. Deliver daemon-owned terminals

Add interactive PTYs as a separate resource from Pi tool execution.

### Deliver

- Implement `TerminalManager` and the Bun native terminal adapter with workspace/cwd,
  dimensions, title, activity, bounded replay, and exit state.
- Define terminal create, attach, input, resize, snapshot, and exit control
  messages plus sequenced binary output frames.
- Preserve ordering across replay, resize, snapshot, and clear barriers.
- Add a single-client size lease with explicit take-control behavior. Keep input
  available to an attached client while clearly indicating size control.
- Integrate xterm.js with fit, search, links, Unicode, clipboard, Canvas
  fallback, and optional WebGL.
- Handle mobile visual viewport, safe areas, touch selection, keyboard controls,
  and terminal-size takeover.

### Gate

- Multiple terminals run concurrently with agents and editors.
- Reconnect produces bounded replay or an authoritative snapshot fallback.
- Passive clients cannot unexpectedly resize another client's terminal.
- PTY exit or daemon restart invalidates the corresponding live terminal ID.
- Passage never claims to resume or reconstruct a shell after daemon restart.

## 7. Assemble the persistent workspace canvas and PWA

Combine agents, terminals, editors, and diffs into the designed responsive
workspace experience.

### Deliver

- Implement the versioned split-tree layout, validation, migrations, stable pane
  IDs, minimum dimensions, resize, tab reorder, move, split, and safe close.
- Add panels for overview, agents, terminals, explorer, changes, editors, and
  diffs.
- Restore the desktop canvas per workspace; render one selected panel on mobile
  while preserving the desktop layout.
- Complete detailed/concise agent activity, image/artifact rendering, composer
  controls, activity/status indicators, accessibility, and keyboard alternatives
  to drag operations.
- Add the manifest, icons, static-shell service worker, update prompt, explicit
  offline state, and reconnect reconciliation. Do not cache mutable sessions,
  files, Git results, credentials, terminal output, or API responses.
- Add permission-gated browser notifications only for agent completion or
  attention; do not add push infrastructure.
- Add validated semantic theme/font packs and declarative tool-renderer packs;
  do not permit executable plugins, arbitrary HTML, or daemon access.

### Gate

- Every core resource can be opened, split, tabbed, moved, closed, and restored
  without changing the resource's lifecycle.
- Narrow screens provide focused single-panel destinations rather than a
  compressed desktop grid.
- PWA suspension and reconnect reload authoritative mutable state.
- Customization packs are bounded data and cannot execute code.

## 8. Harden security, limits, observability, and recovery

Apply cross-cutting protections and make every expected failure bounded and
repairable.

### Deliver

- Enforce Host and WebSocket Origin validation, same-origin production serving,
  and an explicit development exception.
- Document and display the trusted-LAN warning: Passage has no application auth
  or TLS identity layer in v1.
- Centralize limits for files, diffs, history, Markdown, process output,
  concurrency, timeouts, replay, and stderr.
- Log bounded diagnostic context for security/protocol rejections, Pi stderr and
  exit status, stream/resource sequence state, and repairable worktree failures.
  Do not add remote analytics, metrics collection, or telemetry.
- Complete recovery flows for browser/mobile disconnect, Pi crash, daemon
  restart, interrupted worktree registration, stale edits, dirty removal, and
  oversized data.
- Document data locations, backup/recovery boundaries, supported platforms, and
  deployment behind external TLS/auth/VPN controls.

### Gate

- Origin, traversal, symlink, malformed-input, oversized-data, destructive-
  operation, and restart tests pass.
- Only server-resolved canonical paths inside registered roots authorize an
  operation; browser paths, displayed paths, and labels never do.
- Each declared failure yields a bounded error, attention state, snapshot, or
  repair workflow.
- No raw shell-string API, executable plugin path, remote analytics, or implied
  application authentication exists.

## 9. Complete system verification and usability validation

Run the full test matrix and verify the integrated product against explicit
performance and recovery budgets.

### Deliver

- Unit tests for protocol schemas, path containment, layout operations and
  migrations, timeline grouping, renderer matching, and command idempotency.
- Pi fixture and live integration tests for framing, correlation, lifecycle,
  queueing, compaction, process failure, and JSONL reconciliation.
- Temporary-repository Git/worktree tests covering all designed edge cases.
- PTY tests for input, resize, size leases, replay, binary ordering, and exit.
- Playwright tests for desktop panes, agent flows, editors, diffs, reconnect,
  restart, and recovery.
- Responsive automation plus manual iOS/Android PWA, keyboard, safe-area,
  suspend/resume, and terminal validation.
- Security and performance-budget checks, followed by a focused usability review
  of panes, editors, navigation, and mobile control surfaces.

### Gate

- The full supported-platform suite passes without critical gaps.
- Performance budgets pass or have an explicit documented acceptance decision.
- Tests demonstrate authoritative Pi history and recovery behavior rather than
  relying only on mocked browser state.

## 10. Package and release the MVP beta

Release only after the design's definition of done is met and v1 exclusions are
confirmed.

### Deliver

- Produce the Bun production bundle with pinned Pi and native dependencies.
- Publish deployment, origin, reverse-proxy/VPN, HTTPS, data-location, backup,
  recovery, limit, and supported-version documentation. State that production
  SPA/API traffic uses one configured origin, additional origins require
  explicit configuration, and upstream TLS/auth remain the operator's
  responsibility because Passage v1 has no application authentication.
- Validate service-worker upgrades without interrupting active work.
- Run an MVP acceptance checklist covering project/workspace management,
  multiple Pi agents, steering/follow-ups, terminals, editors, diffs, persistent
  layouts, desktop/mobile PWA behavior, light/dark/system themes,
  density/activity detail, independent UI/editor/terminal fonts, and declarative
  custom-tool presentation packs.
- Move all non-goals to a post-MVP backlog rather than implementing them during
  release stabilization.

### Gate

- A single user on a trusted LAN can complete the full MVP workflow on desktop
  and mobile. Browser reload, WebSocket reconnect, visibility/online return,
  mobile suspend/resume, post-run settlement, Pi crash, and daemon restart all
  reconcile predictably with authoritative state.
- The release contains no provider abstraction, hosted collaboration, forge
  integration, executable plugins, Passage-managed Pi orchestration, remote
  telemetry, offline mutation, terminal profiles, setup recipes, or automatic
  port orchestration.

## Dependency-aware parallel work

- After Step 1, build tooling, compatibility fixtures, the migration runner,
  initial schema work, and the basic web shell may proceed in parallel;
  persistence-dependent features wait for Step 2's gate.
- After Step 2, persistence repositories, protocol tests, path-boundary tests,
  and shell UI may proceed in parallel.
- After Step 3, Pi integration and Git/worktree services may proceed in parallel,
  though both must preserve the established workspace boundary.
- After resource contracts stabilize, terminal UI, editor/diff UI, timeline
  rendering, layout UI, PWA behavior, and recovery tests may proceed in parallel.
- Security review, cross-resource recovery, full platform validation, and release
  acceptance remain final integration gates.

## Decisions to resolve during implementation

The design intentionally does not fix every low-level choice. Record decisions
when their owning step begins:

- Step 1: supported versions, platforms, package patches, and packaging.
- Step 2: envelopes, command-idempotency retention, and replay budgets.
- Step 4: Pi RPC schemas, settlement behavior, and session-path discovery.
- Step 5: worktree marker/repair/ref behavior and file revision hashing.
- Step 6: terminal binary framing and size-lease/input semantics.
- Step 7: layout migration, PWA update, and customization-pack schemas.
- Step 8: final limits, recovery policy, and deployment boundaries.

These decisions must preserve the authorities, boundaries, limits, and v1 scope
defined in `docs/DESIGN.md`.
