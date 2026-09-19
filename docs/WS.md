# Passage WebSocket standard

Authority: `docs/DESIGN.md` (architecture) > this document (WS review
standard) > `docs/WEB.md` (preview transport) > `PI.md` (Pi RPC boundary).
If this document conflicts with DESIGN.md, DESIGN.md wins and this document
MUST be fixed.

Status terms: **MUST / MUST NOT** = review-blocking. **SHOULD** = expected
unless the PR justifies otherwise. **MAY** = allowed.

The event catalog lives in code (`src/shared/protocol/`, emitters in
`src/daemon/http/`) and MUST NOT be duplicated here.

## 1. Invariants (review-blocking)

1. **HTTP = snapshots, WS = invalidations.** A WS payload MUST NOT carry
   file content, listings, `GitStatus`, or diffs. Receivers refetch the
   authoritative HTTP snapshot. (`MAX_PROTOCOL_PAYLOAD_BYTES` = 48KB,
   `src/shared/protocol/index.ts`.)
2. **Three sockets, no more.** `GET /ws` (JSON text) for `pi` + `workspace` +
   `daemon` (`ping`, and `subscribe`/`unsubscribe` to lifecycle
   invalidations -- one well-known subject, `DAEMON_SNAPSHOT_SUBJECT`,
   see `src/daemon/lifecycle/`); `GET /api/terminals/:id/ws` (binary
   frames + JSON control) for PTY bytes; `GET /api/previews/:previewId/ws`
   (bounded frame/input relay) for web-preview streams. A PR MUST NOT add a
   fourth socket, SSE (`EventSource`), polling loops, or a new envelope
   format.
   The preview socket is a narrow exception: high-volume disposable frames
   and input only, never `/ws` invalidation envelopes, replay buffers,
   SQLite rows, or Pi history. It MUST validate `Host`/`Origin`, verify
   preview ownership, cap frame/input sizes, enforce a single input/viewport
   lease, and close slow or malformed clients. Upstream it connects only to
   the loopback agent-browser stream port discovered by
   `WebPreviewManager`; CDP, daemon sockets, and stream ports MUST NOT be
exposed beyond loopback.
3. **One envelope shape.** All `/ws` traffic uses the versioned Zod
   envelopes in `src/shared/protocol/`: `commandEnvelopeSchema`
   (`{version, requestId, channel, type, payload}`),
   `eventEnvelopeSchema`
   (`{version, stream, subjectId, sequence, type, payload}`),
   `snapshotRequiredSchema`. `PROTOCOL_VERSION` MUST be `1` until a
   migration is designed. Schemas MUST be `.strict()` with bounded
   strings/bytes.
4. **Ownership.** `PiRpcManager` alone owns Pi framing; `AgentEventHub`
   (`src/daemon/agents/events/index.ts`) owns `pi` fan-out;
   `WorkspaceEventHub` (`src/daemon/workspaces/events.ts`) owns
   `workspace` fan-out; `DaemonEventHub` (`src/daemon/lifecycle/events.ts`)
   owns `daemon` fan-out; `DaemonLifecycle` (`src/daemon/lifecycle/index.ts`)
   owns the running/draining/ready/stopping phase and readiness recompute;
   `TerminalManager` (`src/daemon/terminals/manager.ts`) owns PTY fan-out;
   `ReplayBuffer` / `IdempotencyCache` (`src/daemon/replay/index.ts`) own
   replay and request dedup. A PR MUST NOT duplicate this logic per
   feature.
5. **Bun end-to-end.** `Bun.serve` `websocket:` + Hono routes + native
   `WebSocket`. No Node `ws` shims, no `socket.io` /
   `@socket.io/bun-engine`, no `react-use-websocket`, no PartySocket, no
   provider abstraction (AGENTS.md).

## 2. Reference patterns (pointers, not catalog)

Copy these shapes, do not reinvent:

- `src/web/agentSocket.ts:subscribeAgent(agentId, onMessage, onReconcile)`
- `src/web/workspaceSocket.ts:subscribeWorkspace(workspaceId, onInvalidate, onReconcile)`
- `src/web/terminalSocket.ts:connectTerminalSocket(terminalId, ...)`
- Consumer pattern: mutator reloads inline, WS echoes debounced,
  reconnect/suspend reconciles immediately.

## 3. How to add an event (normative steps)

1. **Schema first** in `src/shared/protocol/` (Zod `.strict()`, bounded
   strings, relative `path` only, opaque IDs only -- never absolute paths,
   never content).
2. **Emit after commit** in the HTTP route. The mutating caller returns the
   fresh snapshot inline and ignores its own echo. Failed mutations and
   reads MUST emit nothing. Emit helpers MUST stay never-throw (drop
   invalid payloads, keep the HTTP mutation green).
3. **Subscribe/unsubscribe** follow the existing hub shape: `afterSequence`
   replay-then-live, per-socket caps (32 agent + 32 workspace), 256
   subjects / 1024 listeners per hub, `snapshot-required` with a
   `snapshotUrl` when the client falls behind.
4. **Client wiring:** `onInvalidate` -> debounced targeted refetch;
   `onReconcile` -> full snapshot reload on gap / close / `online` /
   `visibilitychange`. MUST NOT `setState` full objects from the payload.
5. **Limits preserved:** 48KB payload / 64KB command caps, `1013` close on
   slow clients (`sendSocketJson`, `src/daemon/index.ts`), listener
   `try/catch` isolation, `dispose()` on shutdown.

## 4. Client-state policy

- Server cache vs. live state stay separate (DESIGN.md). `useState` +
  the `subscribe*` helpers are the current default -- sufficient at this
  size (`main.tsx` top-level state + local panel flags).
- `@tanstack/react-query` and `zustand` are **sanctioned but deferred**:
  sanctioned by DESIGN.md, not in `package.json`, not required for review.
  When introduced: Query owns snapshots (`invalidateQueries` on
  invalidation events; `setQueryData` only for small trusted chips, never
  file/Git bodies); a store owns live connection/layout state only (socket
  status, sequences, lease). A PR MUST NOT put listings/history/transcripts
  in a client store, and MUST NOT introduce Redux/Jotai/Valtio/Recoil
  alongside.
- `react-use-websocket` is rejected: it hides the
  sequence/replay/`snapshot-required` semantics this protocol depends on.
  Keep the hand-rolled `subscribe*` hooks.

## 5. Reconnect / heartbeat / presence / backpressure

- Reconnect: fixed 800ms timer for a real `close` + `online`/`pageshow`/
  `visibilitychange` reconciliation (mobile suspend is expected). A
  foreground return also force-replaces a connection that still reports
  `OPEN`/`CONNECTING` if a heartbeat probe against it doesn't ack within
  `RESUME_PROBE_DEAD_AFTER_MS` -- iOS Safari suspends backgrounded sockets
  without firing `close` (docs/IOSWEBSOCKETS.md), so `OPEN` does not mean
  alive. Every physical socket has a generation counter; callbacks from a
  socket a reconnect has superseded are ignored. Exponential backoff with
  jitter SHOULD be added only when reconnect storms are observed --
  single-user fixed delay is intentional.
- Heartbeat: every `/ws` client (`src/web/socketLifecycle.ts`) sends a
  `daemon/ping` probe with a fresh request id once per second
  (`PING_INTERVAL_MS`) and declares the connection dead after
  `PING_DEAD_AFTER_MS` (~4 missed probes) with no ack, triggering a forced
  reconnect. This is deliberately more aggressive than typical proxy-driven
  heartbeat advice (25-30s): Passage is single-user and LAN-trusted
  (AGENTS.md), so 1/sec pings are cheap, and the trigger is observed
  evidence of iOS silently killing backgrounded sockets
  (docs/IOSWEBSOCKETS.md), not speculation. A stale ack for a superseded
  probe MUST NOT satisfy a newer one. Terminal liveness is still PTY output
  + socket close (unchanged). A server-initiated ping interval remains
  unnecessary.
- Client health: each `/ws` client reports `"online" | "checking" |
  "offline"` (`ConnectionHealth`) from its heartbeat. The sidebar's
  connection indicator (`Sidebar.tsx`) reflects the always-mounted daemon
  socket's real status rather than an assumed-connected label.
- Presence: none in v1 (single-user). The terminal size-lease
  (`lease_change`) is the only control signal and stays terminal-scoped.
- Backpressure: coalesce terminal chunks without crossing
  resize/snapshot/clear barriers; page Pi history; cap Git/file/diff
  server-side; never buffer unboundedly for slow clients.

## 6. Security

`Host`/`Origin` validation, realpath workspace boundaries, fixed Git arg
arrays, output caps, and worktree-ownership checks apply regardless of LAN
trust. Passage has no app auth (daemon startup warning) and MUST be treated
as trusted-network-only unless behind an authenticated proxy/VPN.

## 7. Review checklist (paste into the PR)

- [ ] Invalidation-only payload (no content/listings/status/diffs on wire)?
- [ ] Zod `.strict()` schema in `src/shared/protocol/`, bounded, opaque IDs?
- [ ] Emit-after-commit; reads/failures emit nothing; emit never throws?
- [ ] Replay-then-live + `snapshot-required` with working `snapshotUrl`?
- [ ] Caps intact (subscriptions, subjects, listeners, bytes)?
- [ ] Client: debounced targeted refetch + full reconcile on gap/close/suspend?
- [ ] Tests: hub unit (replay/eviction/dispose) + route emit/no-emit +
      client parse (`workspaceSocket.test.ts` pattern)?
- [ ] Two-client `agent-browser` check (mutate in A, observe B without
      reload; kill/reconnect/suspend reconciles; loading/error states)?
- [ ] No new socket beyond the three sanctioned ones, no new transport, envelope, or state library?

Verification:

```sh
bun install --frozen-lockfile
bun run typecheck
bun test
bun run test:gate
```

Live-model tests require explicit per-turn permission (NullModel
otherwise). `agent-browser` is required for browser-facing changes
(AGENTS.md), desktop plus `<640px` where responsive code is touched.
Preview-stream changes MUST verify ack pacing (`?pacing=ack&maxFps=15`),
latest-frame-wins resume without backlog replay, view-only until
`Take control`, and HTTP snapshot reconcile on reconnect.
