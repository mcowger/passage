# Back to daemon-owned Pi processes

## Decision and scope

Status: steps 1-6 implemented (see AGENTS.md for the current-state summary
and file pointers). This document remains the plan of record for the
acceptance bar each step was built against; it does not itself track
implementation status beyond this line.

Remove the per-agent Pi holders. Keep the pinned Pi CLI and its existing
stdio RPC integration. One Passage daemon owns each Pi child for that
daemon's lifetime.

```text
Browser
   | Passage HTTP + WebSocket
   v
Passage Bun daemon
   | PiRpcManager, AgentService, transcript projection
   +-- stdin/stdout --> pi --mode rpc, agent A
   +-- stdin/stdout --> pi --mode rpc, agent B
```

We accept interruption if Pi or Passage crashes. Planned shutdowns should
eventually drain work before stopping. Preserving a process across arbitrary
daemon replacement is no longer a requirement.

| Event | Target behavior |
| --- | --- |
| Browser disconnect, reload, or mobile suspension | Pi keeps working under the same daemon. |
| Close an agent canvas tab | Stop that Pi process and archive the agent; retain history. |
| Planned shutdown/deploy | Close admission, wait for supported work to settle, then stop. |
| Explicit forced shutdown or crash | Work may be interrupted; report it and retain persisted history. |
| Open a session after daemon restart | Start a new Pi process against the existing session when requested. Never resend the last prompt automatically. |

Keep Pi's current JSONL format, session IDs, file paths, launch flags,
extension/resource policy, model configuration, and workspace trust behavior.
Do not combine this work with changing session locations. A stopped Passage
session must remain openable with `pi --session <absolute-jsonl-path>`.
That is an exclusive handoff, not permission for Passage and the TUI to write
the same file concurrently.

No SDK migration, separate session daemon, TCP proxy, new agent runtime,
durable command journal, or generic extension scheduler. Retain browser replay,
bounded history reads, request correlation, and normal Pi event processing.
Removing holder replay does not mean removing all replay.

This plan replaces the direction in [ORHPANS.md](ORHPANS.md). Implementations
must update [DESIGN.md](DESIGN.md), [../PI.md](../PI.md), and the historical
holder plan as their behavior changes. Follow [WS.md](WS.md) and
[UI.md](UI.md) for protocol and browser changes.

## Current code that matters

| Area | Current implementation |
| --- | --- |
| Direct and holder selection, start promises, process maps | `src/daemon/agents/rpc/index.ts` |
| Holder process, protocol, startup, sweep, cleanup | `src/daemon/agents/holder/` |
| Holder socket client and reconnect | `src/daemon/agents/rpc/holder-transport.ts` |
| Service attachment, lazy start, settlement, shutdown | `src/daemon/agents/service.ts` |
| Early CLI dispatch, boot sweep, shutdown HTTP route and signals | `src/daemon/index.ts` |
| Build/copy/restart and optional holder stop | `scripts/deploy.ts` |
| Development stop with automatic SIGKILL after five seconds | `scripts/dev-stop.ts` |
| Browser replay and transcript reconciliation | `src/daemon/agents/events/index.ts`, `src/web/agentSocket.ts`, `src/web/components/AgentSessionPanel.tsx` |
| Additional daemon-owned work | `src/daemon/workspaces/actions.ts`, `src/daemon/workspaces/git.ts`, `src/daemon/workspaces/metadata-generator.ts`, `src/daemon/models/catalog.ts`, terminal and preview managers |

There is already a direct-spawn path, exercised by bare test managers and
`PASSAGE_PI_HOLDER=0`. This is not a sufficient production rollback switch:
`AgentService.ensureProcess()` still calls `manager.attach()`, and `attach()`
does not use the holder-enable check. A disabled holder spawn path can still
adopt a surviving holder.

The current service also drops subscriptions/event chains before stopping
processes, and the daemon disposes event hubs before agent shutdown. Safe
shutdown needs the opposite ordering: retain consumers until final work and
reconciliation finish.

## Delivery sequence

Each step builds on the preceding steps but has its own useful outcome and
acceptance tests. Keep the application runnable between steps. Do not perform
a blanket Git revert: retain unrelated fixes and current Pi compatibility.

| Step | Independently useful result |
| --- | --- |
| 1 | Direct RPC has a tested, bounded ownership and teardown lifecycle. |
| 2 | A controlled migration runs real agents directly, without duplicate session writers. |
| 3 | Holder machinery and obsolete deployment behavior are gone. |
| 4 | Daemon restart produces honest, recoverable agent/browser state. |
| 5 | Operators can enter and cancel a visible drain mode without stopping the daemon. |
| 6 | Safe shutdown and deployment use that drain mode end to end. |

Until step 6, restarting is interrupting maintenance, not a safe drain.
Deploy only after an operator has stopped/finished active work, or explicitly
accepted interruption. Do not advertise safe restart before its tests pass.

## Step 1: Establish the direct-process lifecycle

**Value:** make the existing direct path a dependable replacement before
changing production defaults.

**Changes**

- Exercise the direct manager with production-shaped `AgentService` options,
  not only bare test managers. Preserve executable arguments, limits, model,
  tools, session directory/ID, environment, and resource-loading flags.
- Keep one startup promise per agent, installed before asynchronous work.
  Concurrent callers must not receive a handle still waiting for its initial
  `get_state` readiness check. Include service attachment/reconciliation in
  the service's startup barrier; no prompt may use an unsubscribed handle.
- Give stop/shutdown an admission boundary. Reject new starts once shutdown
  begins; account for already admitted starts and operations. Handle stop or
  archive racing startup without allowing a late process to escape.
- Make shutdown idempotent with one shared completion promise. Close stdin
  for graceful Pi cleanup, use bounded termination escalation for hung
  children, await exit, and finish stdout/stderr consumption and pending
  request rejection. Do not wait forever after sending a signal.
- Verify process-tree cleanup, including Pi shell-tool descendants. Keep
  production children in the Passage systemd control group; do not introduce
  detached scopes. Inspect the deployed unit rather than assuming its
  `KillMode`, stop deadline, or restart policy. No unit is checked in today.
- Do not reuse the terminal manager's fire-and-forget `killProcessTree()` as
  proof that cleanup completed. Reuse or narrowly adapt cleanup code only
  where it supplies an awaitable result and verified ownership.

**Acceptance**

- Concurrent starts return one ready process; delayed/failed startup never
  exposes a usable half-initialized handle.
- Start versus stop, archive, and shutdown are tested in both orders.
- Pending RPC calls settle on exit; repeated shutdown awaits the same cleanup.
- A fake Pi that ignores EOF/SIGTERM cannot make shutdown hang indefinitely.
  Its known descendants are cleaned up; unrelated processes are untouched.
- The pinned CLI passes prompt admission, steer/follow-up, question response,
  compaction, settlement, and shutdown tests under NullModel.

**Tests/files:** extend `src/daemon/agents/rpc/index.test.ts`,
`src/daemon/agents/service.test.ts`, and `tests/pi-rpc/`. Use deterministic
barriers and fake children for race tests, not timing guesses.

## Step 2: Cut over without leaving a second session writer

**Value:** production uses daemon-owned Pi processes; the unreliable holder
reattachment path is no longer exercised.

**Changes**

- Select direct spawning unconditionally for normal agent operation. Remove
  attach-first behavior from `ensureProcess()`. A stopped agent starts through
  the normal service start/subscription path.
- Change daemon shutdown to stop owned Pi children, not detach. Retain event
  consumers and metadata until final lifecycle work has been accounted for.
- Keep the old binary/cleanup capability available for the one-time migration
  before deleting holder code. Do not deploy by just changing an environment
  variable or overwriting the installed binary.
- Add a narrow legacy-artifact guard before serving agent commands. Remaining
  `rpc.sock`, `holder.pid`, or `holder.json` requires verified cleanup; it must
  not trigger adoption or silent spawning against the same session.
  Historical `holder.log` alone is harmless and must not block startup.

**One-time operator procedure**

1. Identify the actual service, executable, database, session root, and holder
   scopes. Resolve explicit configuration; do not let a different cwd select
   the wrong `.data` directory. Record live holder/Pi/descendant identities
   before stopping anything. Validate metadata against those processes before
   invoking old cleanup code that might signal a stale, reused PID.
2. Arrange a maintenance window with no new submissions. Allow current work
   to finish or explicitly accept interruption. Stop the old daemon and
   prevent a supervisor/development watcher from starting it again.
3. With the saved holder-capable executable and the same configuration, stop
   this installation's holders. Verify the holder, Pi child, and owned
   descendants have actually exited, including detached-fallback launches.
4. Preserve JSONL and logs. Remove only verified-stale holder control files.
   Never delete a session directory, signal all processes named `pi`, or
   trust a stale PID file without checking process identity.
5. Install/start the direct-mode build only after verification succeeds.
   Reopen one existing session, then start a new one.

`shutdown-holders` exiting successfully or removing its socket is not enough
evidence: its current force fallback kills the recorded holder PID and removes
metadata without proving every Pi descendant has exited. An uncertain cleanup
blocks migration and requires operator review; do not repair the whole holder
protocol to solve this one-time task.

**Acceptance**

- An isolated old-holder fixture causes the new startup guard to refuse
  operation. No direct child starts and no JSONL write occurs.
- After verified cleanup, both an existing and a new session use direct RPC.
  No holder process, socket, or transient scope is created.
- Compare stopped-session hashes before/after artifact cleanup and startup
  refusal. They remain unchanged.
- Repeat the migration procedure: already-stopped processes and absent
  control files are handled safely.
- Rehearse deployment failure and rollback. Stop and verify all direct
  children before starting an older holder-capable build; never overlap them.

**Tests/files:** manager/service tests, isolated daemon subprocess tests, and
deployment-command tests. Never exercise migration against the operator's
real running agents as an automated test.

## Step 3: Delete holder machinery and align operations

**Value:** one process-ownership model remains, with fewer code paths to
maintain and diagnose.

**Changes**

- Delete `src/daemon/agents/holder/`,
  `src/daemon/agents/rpc/holder-transport.ts`, and holder-only tests, including
  `src/daemon/agents/rpc/holder.test.ts`, after transferring relevant lifecycle
  coverage to the direct path.
- Simplify `PiProcessHandle`, manager options, and callers. Remove holder
  spawning/adoption, sweep, detach-all, transport selection, holder-derived
  generations, and `stopHolders` options. Keep needed direct-process
  generations and event/request correlation.
- Remove the `pi-holder`, `shutdown-holders`, and holder-specific `pi-status`
  dispatch, `?holders=true`, and `PASSAGE_PI_HOLDER` /
  `PASSAGE_HOLDER_*` behavior. Retired control arguments must fail clearly,
  not accidentally start a daemon or turn into a different shutdown action.
- Retain only the narrow legacy-file refusal from step 2, without importing
  holder runtime/protocol code. It protects installations that skipped the
  intermediate build. Cleanup instructions refer to the saved old binary.
- Update `scripts/deploy.ts` to remove “holders survive” and the old
  `--stop-agents` distinction. Until step 6, require explicit interruption
  consent for a restart; building alone does not grant it.
- Align `DESIGN.md`, `PI.md`, and README lifecycle/deploy instructions. Mark
  `ORHPANS.md` historical and superseded. Preserve its useful migration
  context rather than leaving two contradictory plans of record.

**Acceptance**

- Production startup, create, resume, archive, and shutdown never load holder
  code, regardless of leftover holder environment variables.
- Search executable source/tests/scripts for retired symbols. Remaining
  mentions are deliberate refusal/migration tests, not operational paths.
- The full gate passes with direct RPC. Inspect the compiled package behavior,
  not just source-mode tests.
- Existing limits, image/file prompts, extension questions, stderr handling,
  and browser replay still work. No Pi JSONL schema or location changes.

## Step 4: Make restart recovery explicit

**Value:** a restart cannot leave an agent looking permanently active or make
the browser mistake a new process/event stream for the old one.

**Changes**

- Normalize persisted runtime status on boot without adopting or automatically
  re-prompting Pi. A missing process is `live: false`; interrupted running,
  stopping, or initializing work must not be reported as completed.
- Surface an interruption diagnostic using the existing attention/error
  presentation. Keep it Passage metadata/runtime state, never a fabricated
  Pi transcript entry. Preserve agent/tab identity and JSONL mapping.
- Rebuild the view through `PiSessionHistoryReader`. Represent an unpersisted
  first run or partial trailing record honestly; never hand-write a repair.
- Define stale-generation/event handling across daemon restart. Do not use
  a repeated process-local generation as proof of stream continuity.
  An old browser cursor must receive authoritative snapshot recovery even
  when the new hub's sequence is lower or its replay buffer is empty.
- Verify the existing snapshot-required path actually replaces stale state
  and catches events arriving during reconciliation. Limit fixes here to
  restart correctness; a general iPhone heartbeat/transport project remains
  separate.
- Explicit resume starts a fresh process on the saved Pi session. Do not
  recover by resending the last prompt or replaying mutations.

**Acceptance**

- Stop/restart the daemon with idle, running, initializing, question-blocked,
  and unpersisted agents. No stale spinner, invented completion, duplicate
  user prompt, or leftover Pi child.
- Keep a browser connected across restart with a high old sequence. It
  replaces its transcript/status and receives the next run's events.
- Browser disconnect alone leaves the same Pi PID running and producing
  history. Agent-tab close still stops and archives it.
- After releasing the Passage process, open the same fixture session with
  the pinned regular TUI without a model prompt; verify the saved history
  and branch. Use isolated configuration, not production credentials.
- Kill the isolated daemon mid-run and verify interruption recovery from
  whatever Pi actually persisted. Do not assert transparent crash recovery.

**Tests/files:** service/history/event-hub tests, `agentSocket.test.ts`,
transcript reconciliation tests, daemon restart integration, and
`agent-browser` desktop/mobile verification.

## Step 5: Add cancellable drain mode and truthful blockers

**Value:** operators can put Passage into maintenance mode, see what remains
active, and cancel without terminating anything.

**Changes**

- Introduce one daemon lifecycle controller with `running`, `draining`,
  `ready`, and `stopping` phases. In this step, `ready` does not exit.
  Drain is daemon memory, not persisted authority after a crash.
- Close new-work admission synchronously when drain begins. Requests admitted
  just before the boundary remain counted through all asynchronous work.
  A request that finishes uploading after the boundary must either have a
  tracked prior admission or be rejected before it starts Pi work.
- Enforce the same gate in service operations reached through HTTP, `/ws`,
  and internal callers. A disabled composer is not enforcement.
- Refuse new agents/starts/prompts, steering, follow-ups, manual compaction,
  model/thinking changes, and new workspace mutations/jobs. Reads that would
  lazily spawn Pi (capabilities/history/model probes) cannot bypass the gate:
  use available snapshots or return an explicit draining/unavailable result.
- Let already admitted runs and queued continuations finish. Keep reads,
  subscriptions, question answers, explicit abort/cancel, and resource-close
  controls working. Closing/archiving a resource still has its normal
  destructive meaning; draining itself does not close agent tabs.
- Add a bounded blocker snapshot to `/api/daemon/snapshot`: phase, daemon
  instance/drain identity, readiness revision, counts, and paged or capped
  blocker reasons. Readiness uses the complete internal set, not a UI page.
  No prompts, tool output, credentials, or raw Pi records in this snapshot.
- Add typed begin/cancel drain mutations returning fresh snapshots and use
  invalidations on the existing `/ws` daemon channel to request refetch.
  Extend the central protocol/dispatch and existing replay/dedup machinery;
  do not add a socket, SSE, browser polling loop, or separate fan-out system.
  Update `WS.md` for the daemon lifecycle messages.
- Show the drain state and blockers in the app shell. Preserve drafts and
  distinguish “daemon draining” from “Pi failed.” Cancellation reopens
  admission only while teardown has not begun.

**What counts as idle**

Never decide from SQLite `lastKnownStatus`, a quiet stdout interval, or the
first `agent_end`. Track current-handle facts and reconcile them with the
pinned Pi version:

- No admitted startup, prompt preflight, mutating RPC, cancellation, or
  compaction still in flight.
- A started run has settled through `agent_settled`, including retry and
  compaction continuations, and a current bounded `get_state` check confirms
  no streaming, compaction, or pending messages.
- No outstanding extension question, known tool/Pi-Bash activity, or known
  background work. A question response may restart activity and revoke
  readiness.
- Per-agent event chains, transcript seeds, and final history reconciliation
  have completed. Clearing their maps is not waiting for them.
- A state query failure, missing required state, or lost observation is an
  `unknown` blocker, not evidence of idle. A verified exited process is an
  interruption, not an indefinitely running agent.

Stable Pi RPC does not expose every extension's detached jobs or future
timers. Do not invent that visibility or claim universal extension idleness.
Use existing trustworthy signals for supported background work; document
unsupported autonomous extensions as outside the safe-drain guarantee.
Known unresolved work must block, with cancel or explicit force available.
Do not build a generic extension scheduler as part of this rollback.

**Other resources**

- Track already admitted Git/file/worktree operations, setup actions, metadata
  suggestion Pi processes, and model probes through completion and cleanup.
  `AgentService`'s agent map is not the whole daemon.
- Proposed conservative terminal policy: live PTYs block automatic shutdown
  until explicitly closed. Do not infer that an idle-looking shell has no
  important job. Revisit this policy explicitly if it makes normal deploys
  too cumbersome; do not silently terminate terminals as if they were idle Pi.
- Keep previews available during draining and shut them down during final
  teardown. Disclose that previews do not survive. Wait for pending preview
  startup/control operations before declaring ready.
- No generic job framework: add the minimal completion/close hooks to the
  existing resource owners.

**Acceptance**

- Test both orders of drain versus every admission entry point, including a
  start/command already awaiting I/O. Rejected requests create no optimistic
  transcript row, agent record, or child process.
- A prompt acknowledgement, `agent_end`, retry delay, compaction, queued
  follow-up, pending question, and delayed reconciliation each prevent early
  readiness. Idle agents that never ran do not wait for a nonexistent event.
- Question answers and abort remain usable from HTTP and WS while draining.
  New work is rejected consistently; cancellation restores normal admission.
- More agents/jobs than one snapshot page cannot produce false readiness.
- A live terminal, failed Pi state query, and known background task produce
  actionable blockers. A browser disconnect does not cancel drain.
- Two browsers observe begin/cancel/readiness changes through snapshots.
  Check desktop/mobile, keyboard access, reconnect, loading, and error states.

## Step 6: Finish safe shutdown and deployment

**Value:** a normal maintenance operation waits for an idle boundary and
stops cleanly, without bringing back holders or silently killing active work.

### Shutdown contract

Build on step 5 rather than creating a second shutdown controller:

```text
running  -- begin drain --------------------> draining
draining -- all tracked work settled -------> ready
ready    -- activity/readiness invalidated -> draining
draining/ready -- cancel -------------------> running
ready    -- commit + final recheck ---------> stopping --> exited
draining/ready -- explicit force -----------> stopping (interrupted)
```

- The existing shutdown route becomes a versioned, validated request to
  drain and stop. Acknowledgement means accepted, not “already shut down.”
  HTTP request timeout or caller disconnect does not cancel the operation.
- Also support holding a drain at `ready` for deployment. A commit request
  supplies the daemon/drain identity and readiness revision. Recheck all
  blockers, then seal all command admission synchronously before teardown.
  A stale ready snapshot or concurrent cancellation cannot authorize exit.
  Revalidate each process handle/activity revision at the final close boundary;
  late Pi activity invalidates readiness rather than being ignored. This is
  not an atomic freeze of arbitrary extension timers, which remain subject
  to the supported-work limitation in step 5.
- Keep existing Pi event/lifecycle subscriptions during drain. Do not hold
  an agent's event-chain lock while waiting for events needed to settle it.
- No overall automatic kill deadline for safe drain. Bounded state probes
  may fail into a blocker. A caller's wait deadline reports incomplete
  maintenance and exits nonzero without killing Pi or replacing the binary.
- Explicit force is a separate, clearly labeled interruption action. Only
  that path cancels active work and uses bounded process-tree escalation.
  A stalled final child shutdown must not silently turn a safe result into
  forced success; report/escalate it explicitly.

### Teardown order

1. Seal admission and resolve already-admitted completion/control operations.
2. Stop the verified-idle Pi children; await exit, output consumption, and
   final service event/reconciliation work while SQLite is still open.
3. Await cleanup of remaining owned helpers/actions, terminals already being
   closed, and previews. Attempt all cleanups and aggregate failures rather
   than abandoning later owners after the first error.
4. Dispose event hubs/subscriptions, close HTTP/WS, and close SQLite only
   after callbacks that use them have finished.
5. Remove this daemon's PID/port artifacts last and log the actual outcome.
   Repeated shutdown callers await one promise; cleanup failure is not exit
   status zero.

Shutdown stops processes but does not archive agent records, remove their
canvas tabs, delete history, or move session files.

### Deploy, signals, and development

- `bun run deploy` builds/stages the candidate first. A build failure leaves
  the running daemon untouched.
- Resolve the actual target service/API and daemon identity. Begin a held
  drain, wait for `ready`, and revalidate it. Do not copy over the active
  executable before readiness.
- Stop the service through the supervisor after the daemon has sealed
  admission for shutdown. Suppress automatic restart during the handoff,
  wait for old process/cgroup exit, atomically install the staged binary,
  then start and health-check the new daemon. Explicitly coordinate the
  commit response and service stop so a dropped connection is not mistaken
  for proof of exit.
- Cancelled/failed drain leaves the old daemon and installed binary intact.
  If installation/start fails after stopping, restore the saved binary and
  start it only after verifying no previous children remain. Do not roll
  back by overlapping two daemons.
- Update `scripts/dev-stop.ts`: its current five-second automatic SIGKILL
  conflicts with safe drain. Default stop uses the lifecycle API; timeout
  requires an explicit force decision. Resolve dev endpoints through
  `bun scripts/dev-port.ts`; stop on `CRITICAL`, never trust inherited ports.
- Route SIGINT/SIGTERM through the same lifecycle controller where possible.
  Audit the service's `TimeoutStopSec`, `KillMode=control-group`, and restart
  policy so planned draining happens before supervisor kill deadlines.
  Bare `systemctl restart`, OS termination, and external SIGKILL can still
  interrupt work; they are not substitutes for the safe deploy command.
- `bun --watch` reload is likewise not guaranteed to await drain. Document
  it as interrupting development behavior; test graceful lifecycle work
  with a non-watching daemon. No watcher replacement is required.

### Final acceptance

- Multiple active agents finish naturally; follow-ups and compaction finish;
  only then does shutdown occur. No automatic `abort`, `clear_queue`, or
  repeated prompt appears on the safe path.
- Race a prompt, question response, drain cancellation, and readiness commit.
  There is no untracked admission or shutdown from a stale ready revision.
- A stuck/unknown agent leaves Passage reachable with blockers. Cancel works;
  force reports interruption. Duplicate requests and repeated signals do not
  perform teardown twice or exit before cleanup finishes.
- Pause final output/history processing in a test. SQLite and consumers stay
  alive until it finishes; no late callback uses a closed database.
- Inject cleanup failures. Other owners are still cleaned up and the result
  is non-success, not a silent forced shutdown.
- Mock deployment commands for build failure, drain timeout/cancel, stale
  identity, automatic-restart races, install failure, rollback, and health
  failure. Verify no premature copy/restart.
- Run an isolated systemd rehearsal with fake/NullModel Pi: verify cgroup
  cleanup, no old Pi PIDs, new daemon health, browser reconnect, and preserved
  sessions. Do not restart the operator's real service as a test.

## Verification and completion

For each implementation step, run its targeted tests and the existing
typecheck/unit commands. Before deploying the direct-only cutover and the
finished shutdown mechanism, run the full gate:

```sh
bun install --frozen-lockfile
bun run typecheck
bun test
bun run test:gate
```

`test:gate` includes NullModel-backed live Pi, PTY, build, and packaging
checks. Ensure `PASSAGE_PI_LIVE=real` and `PASSAGE_PI_USE_REAL=1` are not set.
No real AI API calls or Cora review without explicit permission. Browser
changes require `agent-browser` desktop/mobile checks; supplement suspension
testing with a real iPhone when available.

Completion means:

- One direct Pi child per live agent; no holder runtime or reattachment path.
- Ordinary Pi session format, identity, location, and exclusive TUI handoff.
- Browser loss does not stop work; daemon loss is an explicit interruption.
- No mutation replay or duplicate last prompt after restart.
- Safe drain is observable and cancellable, cannot admit untracked new work,
  and does not equate unknown status with idle.
- Default deploy/stop uses the tested safe path. Force/crash/watch-reload
  limitations are documented rather than hidden behind continuity claims.
