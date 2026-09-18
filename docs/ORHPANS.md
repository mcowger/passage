# Deprecated: per-agent Pi holders (historical plan)

## Status

**Deprecated. Superseded by [BACKTOSQUAREONE.md](BACKTOSQUAREONE.md).**

Keep this document as a historical reference for identifying and reversing the
holder changes. It is no longer a plan of record or guidance for new work.
Retain the original design below until this reference is explicitly deleted.

The replacement direction is daemon-owned Pi CLI RPC processes, accepting
interruption on crashes and adding safe draining for planned shutdowns. The
holder implementation described below has been removed (`BACKTOSQUAREONE.md`
steps 1-3); this inventory is kept only to identify what was reversed. The
safe-drain and shutdown mechanism (steps 4-6) is still planned, not
implemented. Follow `BACKTOSQUAREONE.md` for migration order, safeguards, and
acceptance tests.

Historical implementation inventory:

- Same-binary dispatch (`passage pi-holder <agentId> …`, `passage
  shutdown-holders`, `passage pi-status [agentId]`) in `src/daemon/index.ts`,
  before SQLite/Hono/serve/pidfile setup; holder entrypoint in
  `src/daemon/agents/holder/cli.ts`.
- Holder runtime (`holder/server.ts`, dependency-light: no SQLite/HTTP) with
  verbatim byte-proxy, bounded replay + stderr, hello/replay/ping/status/
  stop control frames (`holder/protocol.ts`), pi-exit linger, and idle
  timeout (`PASSAGE_HOLDER_IDLE_MS`, default 24h; never fires mid-run
  because pi output resets the idle clock).
- Daemon socket transport (`rpc/holder-transport.ts`) with the same
  `request()`/`subscribe()` surface; `PiRpcManager` is holder-first with
  generation persisted in `holder.json` (bumped per fresh holder, reused on
  attach). Bare `new PiRpcManager(n)` managers (unit tests) and
  `PASSAGE_PI_HOLDER=0` keep the direct-spawn fallback.
- Attach-first reconnect in `AgentService.ensureProcess`, boot orphan sweep
  (`sweepOrphanHolders`, called before serving), `passage_stop` on
  stop/archive, detach-without-stop on daemon shutdown, and
  `POST /api/daemon/shutdown?holders=true`.
- Spawning prefers `systemd-run --user --scope --unit passage-pi-<id>.scope`
  with a detached fallback (`PASSAGE_HOLDER_NO_SYSTEMD=1` forces fallback).
- `bun run deploy` keeps holders by default; `bun run deploy --stop-agents`
  shuts them down first for a clean slate.
- Suites: `holder/protocol.test.ts` (validation, sweep matrix),
  `holder/server.test.ts` (proxy, replay, reconnect, teardown, sweep),
  `rpc/holder.test.ts` (restart survival + clean stop through real holder
  processes), plus a service-level boot-sweep test.

## Problem

Today each `pi --mode rpc` process is a direct child of the Passage daemon,
spawned by `PiRpcManager`/`PiRpcProcess` (`src/daemon/agents/rpc/index.ts`)
via `Bun.spawn` with anonymous `pipe` stdio:

- Daemon shutdown (`shutdown()` in `src/daemon/index.ts`) explicitly stops
  every agent process via `agentService.shutdown()` → `manager.shutdown()`.
- `systemctl --user restart passage` (the `deploy` script path) kills the
  whole cgroup under the default `KillMode=control-group`, so even a
  `setsid`'d child would die.
- A new daemon process cannot reattach to the old anonymous pipes even if
  the child survived: the `Bun.Subprocess` handle and its fds are gone.

Result: every daemon restart stops every agent mid-run. Reconnect-and-resume
from JSONL (acceptable prompt, re-issue on boot) preserves *context* but not
*continuity*: the run still stops, one LLM turn is wasted, and re-sending a
prompt whose tools already ran risks double side-effects.

Goal: **agents keep working straight through a daemon/UI restart**, with an
equally deliberate way to **shut Pi children down when asked**.

## Decision

Detached per-agent holder over a Unix socket (no TCP):

```text
daemon (client)  <-- Unix sock -->  pi-holder (survives restart)  <-- pipes -->  pi --mode rpc
                                     .data/sessions/<agentId>/rpc.sock
```

- The holder owns the `pi` child and its stdio. The daemon is a *client* of
  the holder, not the parent of `pi`.
- Transport is a per-agent Unix socket under the existing sessions root.
  Same LF-delimited JSONL framing the daemon uses with `pi` today, so
  `PiRpcManager` gains a transport switch with no Pi protocol changes.
- No TCP listener. Unix sockets give the same reconnect with filesystem
  permissions and no new network surface.
- Same compiled binary, subcommand dispatch (`passage pi-holder …`), not a
  second binary. See "Binary mode" below.

Non-goals:

- No change to the Pi wire protocol, the pinned Pi CLI version policy, or
  the JSONL-is-authoritative history rule (`PI.md` still applies end to end).
- No TCP/loopback listener for holders.
- No change to the browser protocol version; reconnect masking stays
  daemon-side.
- Resume-from-JSONL remains as the *fallback* when a holder itself crashes
  (existing `start(agentId)` path against the same `sessionDir`/`sessionId`).

## Binary mode: same artifact, early dispatch

The build (`scripts/build.ts --compile`) produces one `dist/passage` binary
from `src/daemon/index.ts`. The holder is an early branch in that entrypoint:

```text
passage pi-holder <agentId> --session-dir … --session-id … --cwd … --socket …
```

Rules:

1. Dispatch on `argv[2] === "pi-holder"` at the top of `index.ts`, **before**
   SQLite open, Hono setup, `Bun.serve`, pidfile/`dev.port` writes, and
   logging configuration beyond a holder-scoped logger.
2. Lazy-import the holder module inside that branch so normal daemon startup
   cost is unchanged and the holder path pulls in no HTTP/WebSocket/SQLite
   code. Keep the holder dependency-light: stdio framing, socket server,
   `pi` spawn/supervision, bounded buffers. Nothing else.
3. Pass everything the holder needs as CLI flags: `agentId`, `sessionDir`,
   `sessionId`, `cwd`, socket path, Pi executable/model flags, buffer limits.
   The holder **must never open SQLite** — after a daemon restart it runs
   with only what it was started with, which is exactly the point.
4. Set `process.title = "passage-pi-holder:<agentId>"` in holder mode so
   `ps` output matches the systemd scope name.
5. Self-spawn helper (`getSelfCommand()`): `[process.execPath]` when
   `Bun.isStandaloneExecutable`, else `[process.execPath, <entrypoint>]`
   for `bun run` dev. Used in exactly one place (holder spawn).

Consequences:

- Daemon and holder are always the same build → no framing version skew.
- `deploy` keeps copying one file. Old holders keep running the previous
  build across a deploy; new agents get the new build. The mixed-version
  window is safe because the holder↔daemon socket stays on the pinned
  LF-JSONL framing (same rule as the Pi wire itself).
- A second binary is only justified by sandboxing (different uid /
  capabilities), which a single-user LAN daemon does not need.

## Architecture

### Processes

| Process | Role | Lifetime |
| --- | --- | --- |
| `passage` (daemon) | HTTP/WS, SQLite, workspaces, terminals, Pi clients | Restarts freely |
| `passage pi-holder <agentId>` (one per live agent) | Owns one `pi --mode rpc` child; byte-proxy + bounded replay | Until explicit stop, sweep, `pi` exit, or idle timeout |
| `pi --mode rpc` (one per holder) | Agent runtime | Owned by its holder |

### Data flow (steady state)

```text
daemon PiRpcManager --(Unix socket, LF-JSONL commands)--> holder --(stdin pipe)--> pi
daemon <--(Unix socket, LF-JSONL responses/events + control frames)-- holder <--(stdout pipe)-- pi
```

- The holder is deliberately dumb: it does **not** interpret Pi semantics.
  It proxies daemon→`pi` stdin bytes and `pi`→buffer→socket bytes.
- The holder maintains the bounded stdout replay buffer (same bound family
  as today's `maxEventBytes`) and a bounded stderr capture (same as today's
  `maxStderrBytes`), queryable on reconnect.
- On (re)connect the daemon issues `get_state` + `get_entries`, reconciles
  against Pi JSONL (`readPiHistory`), then replays any buffered lines it
  missed — the same reconcile path `AgentService` uses today, with the
  transport swapped.

### Files (per agent, under the existing sessions root)

```text
.data/sessions/<agentId>/
  rpc.sock          Unix socket (0700 dir, 0600 socket)
  holder.pid        holder PID for liveness checks
  holder.json       { agentId, sessionId, socketPath, holderVersion, startedAt }
  holder.log        capped structured holder/Pi connection telemetry (0600)
  <existing pi session files…>   (untouched; holder spawns pi with the same
                                  --session-dir/--session-id as today)
```

Socket directory mode `0700`, socket `0600`. Never under `/tmp` (symlink /
name-squat risk).

## Holder wire protocol

Two frame classes over the one socket, both LF-delimited JSON objects
(consistent with the Pi framing rules: split only on LF, allow one trailing
CR):

1. **Data frames**: verbatim Pi records in both directions (daemon commands
   with daemon-assigned `id`s; Pi responses/events back). The holder adds
   nothing except buffering.
2. **Control frames** (`type: "passage_*"` namespace, never forwarded to
   `pi`):
   - `passage_hello` / `passage_hello_ack` — version handshake
     (`holderVersion`, `agentId`, `piGeneration`, buffer resume offset).
   - `passage_replay { after }` — resend buffered stdout records newer
     than offset.
   - `passage_stderr` — bounded stderr snapshot + truncation flag.
   - `passage_status` — `{ piAlive, piExitCode?, daemonCount, uptimeMs }`.
   - `passage_stop` — graceful stop request (see "Shutdown").
   - `passage_ping` / `passage_pong` — liveness.

Connection policy: multiple daemon connections are technically possible
during a restart handoff (old daemon dying + new daemon connecting); last
writer wins for stdin, all connections receive stdout broadcast. In practice
there is one daemon at a time.

## Daemon changes

1. **Transport abstraction in `PiRpcManager`.** Split today's `PiRpcProcess`
   into framing/correlation (kept, transport-agnostic) plus a transport:
   `SpawnedPipeTransport` (current `Bun.spawn` behavior; keep for tests and
   as fallback) and `HolderSocketTransport` (connect to `rpc.sock`, hello /
   replay handshake, same `request()` / `subscribe()` surface). `AgentService`
   code above the manager does not change.
2. **Request IDs across reconnect.** Today's IDs are
   `passage-<generation>-<n>`. The generation must survive daemon restart
   (persist per-agent generation in SQLite or in `holder.json` and bump on
   each new holder). Pending requests at disconnect time fail fast with a
   process-exit-style error (same semantics as a crashed `pi` today); the
   caller retries against the reconnected transport with a fresh ID.
3. **Reconnect path.** New `manager.attach(agentId)` (vs. `start`): connect
   socket → hello → `get_state` → reconcile → subscribe. `ensureProcess`
   tries attach first, falls back to spawn-holder-then-start when no live
   holder exists.
4. **Orphan sweep on boot** (see below) before accepting agent commands.
5. **`passage shutdown-holders`** CLI + `POST /api/daemon/shutdown` flag
   (see "Shutdown").

## Escaping systemd (required)

Default `KillMode=control-group` on `passage.service` kills detached
children too. Pick one:

- **Preferred: transient scopes.** Daemon spawns holders via
  `systemd-run --user --scope --unit passage-pi-<agentId>.scope <passage-bin>
  pi-holder …`. Daemon restart provably cannot signal them, and each agent
  is visible in `systemctl --user status`. **or**
- **Fallback: `KillMode=process`** on `passage.service` + `setsid`'d
  holders. Weaker but workable.

Dev (`bun --watch`) needs nothing special: the watcher restarts the daemon,
holders persist, the daemon re-attaches.

## Shutdown: four levels (the kill switch)

The holder **never** dies on daemon disconnect — that is the feature. It
dies from exactly one of:

1. **Per-agent stop (normal path).** Today's `archive()` / `stop()` call
   sites keep their meaning but send `passage_stop` over the socket instead
   of killing a child: holder closes `pi` stdin, waits ~2s for clean exit,
   then SIGTERM/SIGKILL the `pi` tree, removes the socket/pidfile, and
   exits. Closing an agent tab still ends the resource (lifecycle invariant
   intact).
2. **Global kill.** `passage shutdown-holders` (iterate all `rpc.sock`
   entries, `passage_stop` each, `SIGKILL` stragglers after a deadline) and
   a matching `POST /api/daemon/shutdown?holders=true`. `deploy` grows a
   flag: plain `deploy` = holders survive the upgrade (new goal);
   `deploy --stop-agents` = old behavior for when you want a clean slate.
3. **Orphan sweep on daemon boot.** Before serving agent commands: list
   `rpc.sock` entries, join against SQLite agent records + holder liveness
   (pidfile + `passage_ping` over the socket). Kill-and-remove anything
   with no live, unarchived agent (stale after `archive-while-down`,
   manual DB edits, or crashes). Log every sweep kill. This is what keeps
   the "no background process without a UI tab" invariant true.
4. **Self-exit.** Holder exits when: its `pi` exits on its own (reap, keep
   the bounded exit/stderr record briefly for the next daemon to collect,
   then exit); or an idle timeout fires (idle `pi` + no daemon connection
   for a configured period, e.g. 24h — never while `isStreaming`). Timeout
   is configurable, default on.

Stale-socket handling: socket file exists but nothing listens → daemon
treats as dead holder, removes files, spawns fresh (same as a crashed `pi`
today).

## Deploy / rollback

- `bun run deploy` (plus optional `--stop-agents`): build → copy binary →
  `systemctl --user restart passage`. Holders in transient scopes survive;
  the new daemon sweeps and re-attaches. Mixed holder versions are expected
  and supported via the pinned socket framing; holders drain naturally as
  agents are archived.
- Rollback = deploy the previous binary; same attach logic applies.
- Emergency: `systemctl --user stop passage` + `passage shutdown-holders`
  (or `systemctl --user stop 'passage-pi-*.scope'`) guarantees zero Pi
  processes.

## Security

- Sockets live in `0700` dirs with `0600` sockets under the daemon-owned
  sessions root. No `/tmp`, no TCP, no LAN exposure.
- `passage_stop` is only accepted over the Unix socket (filesystem
  credentials), never over HTTP except via the authenticated-local
  `POST /api/daemon/shutdown` route that itself only the operator can reach
  (same trust posture as the rest of the daemon: trusted LAN / upstream
  proxy).
- systemd scope names are derived from validated agent IDs only
  (`^[A-Za-z0-9_-]{1,128}$`, same as `PiRpcManager.start`); never
  interpolate unchecked input into `systemd-run` args — fixed argv array.

## Observability

- Every holder also writes capped, structured connection telemetry to
  `<sessionsRoot>/<agentId>/holder.log` so its history survives daemon
  restarts and `systemd-run` stderr collection. The file records socket
  connects/hello/replay/close, Pi stdin forwarding, and rate-limited Pi
  stdout activity without prompt or frame contents. The daemon journal logs
  its matching connect/hello/output-received events and service subscription
  state, correlated by `connectionId`.
- `passage pi-status [agentId]` (or `GET /api/agents/:id` `live`/`generation`
  fields, already present) shows holder-vs-direct transport, holder
  version, and reconnect count for debugging the mixed-version window.

## Testing

- Unit: framing/replay over a socketpair; handshake + `after`-offset
  replay; stale-socket detection; generation bump rules; sweep decision
  matrix (live agent + live holder → keep; archived + live holder → kill;
  live agent + dead socket → respawn; unknown socket → kill).
- Integration (NullModel pin, per `AGENTS.md` — no live APIs): spawn holder,
  prompt, kill daemon handle, reconnect, assert run continued and events
  reconciled; `passage_stop` full tree teardown (assert `pi` PID gone);
  sweep kills orphans and spares live agents; deploy-simulation (restart
  daemon, assert zero interrupted runs).
- Gate: existing `test:gate` plus a holder suite; systemd scope path tested
  behind an env flag so CI without systemd still runs the `KillMode`-free
  cases.

## Rollout

1. Phase 0: transport abstraction + socket transport behind an env flag
   (`PASSAGE_PI_HOLDER=1`), direct-spawn remains default. Holder mode +
   sweep + `shutdown-holders` land but are opt-in.
2. Phase 1: default holder on for new agents; existing live agents migrate
   on next (re)start. `deploy` keeps holders by default.
3. Phase 2: remove or retain direct-spawn as test-only fallback. Decide
   after one release of holder-default telemetry (reconnect counts, sweep
   kills, mixed-version incidents: expect zero).

## Open questions

- Idle-timeout default (24h proposed) and whether to expose per-workspace
  override in workspace settings.
- Whether `deploy` should also sweep holders older than the new binary
  (cleaner version story) vs. natural drain (less disruption). Proposed:
  natural drain.
- `holder.json` vs. SQLite as the generation source of truth. Proposed:
  SQLite (daemon-owned), mirrored into `holder.json` for post-mortem.
