# Recovering browser connections on iOS

## Status and decision

Implementation plan. No runtime changes are made by this document.

Treat browser suspension and lost connections as normal. A returning browser
must be able to reconstruct its view without restarting Pi, resending a prompt,
or requiring a page reload.

This is independent of [BACKTOSQUAREONE.md](BACKTOSQUAREONE.md). Local `main` at
`2234f10` already implements the holder rollback and drain/shutdown lifecycle.
Those changes simplify daemon-to-Pi ownership; they do not repair
browser-to-daemon sockets or incomplete browser transcripts. Reuse the existing
restart recovery and lifecycle identity rather than implementing them again.

Keep HTTP snapshots and the existing WebSocket routes. No SSE migration,
Socket.IO, new transport, durable browser transcript store, or Pi restart as a
connection-repair technique. Keep recovery logic small and shared where agent,
workspace, and daemon lifecycle helpers currently duplicate it.

## Evidence and limits

The operator reports using **iOS 27**. The exact OS build, browser version,
and tab/PWA mode still need to be captured during reproduction. No iOS
27-specific WebKit defect has been established by this investigation.

The earlier investigation recorded 199 agent-channel WebSocket opens and 199
closes in its sampled daemon journal window, including iPhone traffic. Holder
logs showed Pi output continuing through browser connection churn. These are
historical observations, not a new measurement or proof of a particular iOS bug.

The daemon labels ordinary `/ws` connections as `agent` even when they carry
workspace subscriptions. A close may also result from a normal component
unmount or agent-view switch. Counts alone cannot distinguish app lifecycle,
network loss, proxy behavior, and browser suspension.

The code has recovery faults regardless of which event caused disconnection:

The agent/workspace findings below also apply to the new
`src/web/daemonSocket.ts` helper on `main`: it duplicates the same visibility,
reconnect, and drop-during-reconciliation behavior. Include it in the shared
lifecycle fixes so shutdown status does not remain stale after phone resume.

| Finding | Current location | Consequence |
| --- | --- | --- |
| Visibility return only replaces absent or `CLOSED` sockets | `src/web/agentSocket.ts`, `src/web/workspaceSocket.ts` | A dead socket still reporting `OPEN` can remain forever. `CONNECTING` also has no deadline. |
| No application heartbeat in these clients | Same helpers; `daemon/ping` already exists in `src/daemon/index.ts` | An idle healthy connection and a silent broken connection are indistinguishable. |
| Callbacks refer to a mutable socket variable | Same helpers | Once replacement is added, a late old close/message can corrupt the new connection unless callbacks are identity-checked. |
| Messages are dropped while `reconciling` | Same helpers | The last settlement, question, row update, or workspace invalidation can disappear during an HTTP fetch. |
| Reconciliation failure is cleared in `finally` | Same helpers | The client can claim recovery without a successful snapshot. |
| Same-epoch loads preserve `current.timeline` | `src/web/components/AgentSessionPanel.tsx:mergeLoadedHistory` | A correct HTTP response cannot repair missing rows in the same transcript epoch. |
| Summary and history are separate reads; neither binds the history page to a hub watermark | Session loader, agent HTTP routes, event hub | A sequence from before a fetch is not the boundary of the fetched state. |
| Some reconciliation callbacks do not await their fetch | For example `subscribeWorkspaces` use in `src/web/main.tsx` | A fulfilled callback is not necessarily evidence that the view has caught up. |
| Terminal close only marks disconnected; preview visibility return only refreshes metadata | `TerminalPanel.tsx`, `PreviewPanel.tsx`, their socket helpers | These views can remain stale independently of the agent transcript. |

`agentSocket.test.ts` and `workspaceSocket.test.ts` mainly test envelope parsing.
They do not currently establish the browser lifecycle behavior above. Some
`AgentSessionPanel.test.ts` cases explicitly require same-epoch preservation;
the replacement tests must distinguish ordinary refresh from loss recovery.

### Browser references

- [WebKit 247943](https://bugs.webkit.org/show_bug.cgi?id=247943) documents older
  Safari versions missing `onclose` after network loss. Its current status is
  resolved/configuration changed. It is evidence against trusting close events
  alone, not proof that this exact defect remains on the user's device.
- [WebKit 298616](https://bugs.webkit.org/show_bug.cgi?id=298616) concerns iOS 26
  WebSocket handshake failures and HTTP/3 negotiation. The report says the
  underlying issue was fixed in 26.1. Treat this as historical context, not a
  diagnosis of the operator's iOS 27 failures. Do not recommend an OS upgrade
  or disabling QUIC based on this report; a similar regression would need
  fresh reproduction and browser/proxy evidence.
- [MDN: pageshow](https://developer.mozilla.org/en-US/docs/Web/API/Window/pageshow_event)
  covers restoration from mobile freezing and the back-forward cache. It also
  fires on initial load and can fire while hidden; do not reconnect blindly on
  every occurrence.
- [MDN: navigator.onLine](https://developer.mozilla.org/en-US/docs/Web/API/Navigator/onLine)
  explains why it is a hint, not proof that Passage is reachable or unreachable.

Record the actual OS, browser version, and Safari-tab versus installed-PWA
mode when reproducing. Do not assume every iOS browser has identical behavior.

## Recovery contract

1. Browser disconnect never stops a daemon resource. Closing a canvas resource
   tab remains an explicit stop/archive operation; those are different actions.
2. A socket being `OPEN` proves neither application responsiveness nor a current
   view. Track transport health and subject synchronization separately.
3. A disconnected or stale view may remain visible, clearly labeled. Its old
   status must not silently choose prompt versus steer for a new submission.
4. A fresh application acknowledgement proves liveness of that connection.
   A successful authoritative snapshot plus contiguous catch-up proves view
   synchronization. Neither proof substitutes for the other.
5. Recovery automatically retries reads and subscriptions only. Never resend
   prompt, steer, follow-up, question answers, PTY bytes, or preview input just
   because the response was lost. Existing request dedup is bounded and
   process-local, not an exactly-once guarantee across daemon restart.
6. All queues, retries, diagnostics, and snapshots stay bounded. Do not require
   the browser to replay every token produced while the phone was asleep.

Follow [WS.md](WS.md), [DESIGN.md](DESIGN.md), [UI.md](UI.md), and
[WEB.md](WEB.md). Update the normative reconnect/heartbeat guidance alongside
implementation. In particular, the current fixed-delay policy and any chosen
schema changes must not be left inconsistent with the new behavior. No
speculative server heartbeat interval or browser HTTP polling loop is needed.

## Step 1: Make reconnect causes visible and reproducible

**Value:** distinguish actual network failures from normal view changes, and
make the later fixes testable without real model calls or an iPhone.

- Add a small fake-WebSocket/fake-clock harness for the existing helpers. It
  must simulate a silent `OPEN` socket, stuck `CONNECTING`, delayed old socket
  callbacks, hidden/visible transitions, page restoration, and delayed fetches.
- Give each physical connection a local identity. Record bounded lifecycle
  diagnostics: open/close, close code/reason/clean flag, connection cause,
  visibility, last inbound/ack age, reconnect attempt, and reconciliation
  success/failure. Log intentional dispose separately from unexpected close.
- Add matching daemon connection IDs and close metadata to existing logs.
  Browser diagnostics can remain a bounded local/debug-console facility; do
  not create a remote telemetry service or upload prompts/session contents.
- Capture mount/unmount causes when investigating churn. Each call to
  `subscribeAgent()` or `subscribeWorkspace()` currently opens a physical
  `/ws` socket; the route's multiplexing capability does not mean the browser
  already shares one socket across all consumers.

**Acceptance:** tests can reproduce the silent connection and reconciliation
loss deterministically. Diagnostics identify replacement and disposal without
logging prompts, tool output, filesystem contents, or credentials. Rapid
agent switching is recorded separately from network loss.

## Step 2: Replace suspect sockets on browser return

**Value:** returning to Passage repairs a silent socket without waiting for
WebKit to emit `close`.

- Use one connection-attempt owner and one reconnect timer per physical
  socket. Bind every callback to its socket/attempt identity; ignore obsolete
  open, message, close, error, and snapshot completions.
- On a real hidden-to-visible transition, replace the prior connection even
  if it still reports `OPEN` or `CONNECTING`, then reconcile active subjects.
  Request close on the old socket but do not wait indefinitely for its close
  event before opening the replacement. Brief server overlap is possible;
  obsolete callbacks cannot affect the new view.
- Handle visible `pageshow` restoration, including `persisted`, and `online`
  through the same coalesced recovery operation. Initial page load must not
  create duplicate connections. `navigator.onLine` may adjust diagnostics or
  retry pacing but must not permanently suppress attempts to reach Passage.
- While hidden, pause foreground health deadlines and aggressive reconnect
  attempts. Do not depend on timers or `pagehide` running during suspension.
  If `pagehide` occurs, invalidate/close the view connection as appropriate;
  it never archives an agent or terminates a PTY/preview.
- Make intentional component disposal terminal: remove lifecycle listeners,
  cancel timers, invalidate in-flight loads, and never reconnect afterward.
  Switching views must not destroy the resource being left behind.
- Add a manual “Reconnect view” action using this path, not `api.start()` or
  a prompt retry. Preserve the composer draft and attachments.

**Acceptance:** a fake socket remains `OPEN` but stops delivering; foreground
return creates a working replacement. A burst of `pageshow`, `online`, and
`visibilitychange` produces one recovery attempt. A delayed close from the old
socket cannot clear the new one. Disposed views never update or reconnect.

## Step 3: Detect silent failures while the page stays visible

**Value:** recovery does not depend on the user backgrounding the browser.

- Send the existing versioned `daemon/ping` command and require its correlated
  acknowledgement on the current socket. Browser JavaScript does not expose
  protocol-level WebSocket ping/pong, so this is an application check.
- Use a fresh request ID for every probe. A late acknowledgement from a prior
  attempt cannot satisfy the current probe. Successful HTTP health/history
  fetches do not prove that this WebSocket works.
- Keep one outstanding probe and bound connection establishment as well as
  acknowledgement wait. Probe/control frames must be handled even while a
  subject is reconciling. Lack of agent output is not a health failure: idle
  agents and long silent tools are legitimate.
- Proposed starting constants: foreground ping every 15 seconds, 10-second
  acknowledgement deadline, and 10-second connect deadline. Keep them named
  and testable; tune against device evidence rather than adding UI settings.
  Evaluate elapsed time on wake, then use the foreground-recovery path; do
  not process a backlog of expired hidden-page timers.
- Replace failed connections with capped exponential backoff and jitter
  (starting from the existing 800 ms delay, capped at 15 seconds). Reset after
  a successful handshake/subscription, not merely TCP open. Manual reconnect
  and a real foreground return get an immediate attempt, coalesced with any
  attempt already in progress.
- Surface offline/reconnecting/syncing separately from an agent error. Handle
  subscription rejection explicitly instead of showing connected forever
  after a successful WebSocket upgrade. Use a new request ID for each fresh
  subscribe: the daemon's global dedup cache must not return an old success
  without installing a subscription on the new socket.

**Acceptance:** blackhole inbound and outbound traffic independently, leave
an otherwise idle connection healthy, delay an old pong, and stall the open
handshake. Only failed current attempts reconnect. Backoff is bounded, hidden
pages do not churn, and successful recovery clears the connection warning.

## Step 4: Make snapshot recovery authoritative and race-free

**Value:** a reconnect repairs missed output, rather than simply giving the
browser another socket connected to an incomplete transcript.

This is the main state-correctness change. Implement the snapshot boundary
and its consumer together; blindly changing the merge function would re-create
the reorder/duplication bug that same-epoch preservation originally avoided.

### Establish one recovery snapshot boundary

- Add a bounded recovery snapshot through the existing agent HTTP route layer.
  It must pair summary/status, pending question, current transcript page,
  pagination cursor, transcript epoch, daemon stream identity, and an exact
  applied event watermark. Extend the existing snapshot shape or add a
  focused HTTP snapshot route; do not expose raw Pi records.
- Capture those values coherently with the service's event processing and
  `AgentEventHub` publication. A sequence read before or after an unrelated
  async history request is not a valid boundary. Wait for admitted projection
  work, copy the bounded snapshot, and capture its watermark under the same
  ordering mechanism. Do not block Pi execution while waiting for a browser.
- Use current daemon-projected in-flight content as well as persisted history.
  Pi JSONL alone cannot restore tokens or tool progress that have not yet
  been persisted. This does not make the browser or SQLite a new history store.
- Tie cursors to a daemon/stream incarnation, not just a numeric sequence or
  build hash. Restarting the same build creates a new stream. Reset/reconcile
  on incarnation changes even if old and new sequence numbers happen to match.
  Reuse the existing `DaemonLifecycle.instanceId` exposed by the daemon
  snapshot; do not introduce a competing daemon identity.
- Keep strict bounded schemas and existing envelopes. If new required fields
  are incompatible with v1, design/version that migration explicitly in
  `WS.md`; do not silently change the v1 contract or create parallel formats.
  An old cached PWA must recover or receive a clear reload-required result.

### Consume the snapshot, then catch up

Recommended sequence for initial attach and loss recovery:

1. Mark the subject syncing; stop applying untrusted deltas to its old view.
2. Fetch the coherent recovery snapshot. Superseded/aborted responses cannot
   update the current view. A failed fetch leaves recovery pending and visible.
3. Replace state from that snapshot, even if `transcriptEpoch` is unchanged.
   Epoch identifies the projection, not whether this browser received every
   update. Replace stale status, questions, and usage with the same boundary;
   do not keep stale values solely because they look newer or larger.
4. Subscribe on the current socket with a fresh request ID, from the snapshot's
   stream identity and sequence. The hub replays contiguous events and then
   activates live delivery using its existing buffered-subscription pattern.
5. Apply only later events from that stream. If replay is unavailable or the
   daemon changed during the fetch, take another bounded snapshot. Never skip
   to a newer watermark without acquiring the state it represents.

Do not drop frames under `if (reconciling) return` and then declare success.
Either unsubscribe that subject while fetching and recover via replay, or
retain a bounded generation-scoped buffer with explicit overflow recovery.
Use one strategy, not several overlapping reconciliation paths. Retry with
backoff on repeated eviction; do not create a tight snapshot loop. Keep the
view labeled syncing if it cannot catch up within the bounds.

### Preserve pagination and user work deliberately

- The current history loader fetches only 20 rows. Those rows are a page, not
  the complete transcript. On forced recovery, replace the loaded window and
  its cursor, or implement a tested page-aware reconciliation. Do not preserve
  potentially stale backfilled rows and call the entire transcript repaired.
- Preserve draft/attachments and anchor scrolling by a surviving row ID where
  possible. Fetch older pages on demand. Explain/recover a missing anchor
  rather than silently jumping or duplicating history.
- Keep ordinary same-epoch refresh behavior only when continuity is known.
  Pass an explicit load reason/result through the loader instead of treating
  settlement refresh, first load, reconnect, and replay loss as identical.
- Capabilities are not part of the transcript recovery barrier. A slow model
  catalog request must not freeze row delivery after history is synchronized.
  Propagate a real synchronization success/failure result; the current loader
  can swallow failures and resolve `Promise<void>` anyway.

**Acceptance:** lose a same-epoch row, the last `settled`, or a question event;
each is repaired. Publish events during a delayed snapshot and after capture
but before subscribe; each appears exactly once without relying on a later
event to reveal a gap. Test empty replay, overflow, failed HTTP fetch, equal
sequence after restart, unpersisted sessions, stale requests after switching
agents, and recovery after loading several older pages. Preserve tool order,
boundaries, errors, and draft contents.

## Step 5: Repair workspace and daemon invalidation recovery

**Value:** the agent view, sidebar, files, Git state, and drain status converge
together.

- Apply the connection lifecycle from steps 2–3 to workspace and daemon
  subscribers, including `src/web/daemonSocket.ts` and its tests.
  Audit `main.tsx`, `AgentPanel`, `ChangesPanel`, and `ExplorerPanel` callbacks
  for real awaited completion and surfaced failures.
- Workspace invalidations differ from transcript deltas. During a refetch,
  coalesce invalidations into a dirty flag and perform a trailing refetch if
  any arrived. Do not discard them and wait for another mutation to repair
  the screen. Establish the subscription before the recovery fetch so changes
  during that fetch are observed; repeat recovery if the connection changes.
  Keep fetches single-flight per affected subject/resource.
- On reconnect/foreground return, refresh the workspace list and relevant
  visible workspace snapshots. Keep file contents, Git status, and diffs in
  HTTP responses, never in invalidation payloads.
- Refresh `/api/daemon/snapshot` for drain/readiness changes through the
  existing `DaemonEventHub` invalidations. Reuse the same awaited-refetch and
  trailing-dirty handling; never retry shutdown/force/commit commands as part
  of connection recovery.
- Preserve unsaved editor buffers. Refreshing filesystem metadata must not
  overwrite local edits; retain revision/conflict handling.
- One physical `/ws` connection can carry multiple subjects, but consolidating
  all component sockets is not a prerequisite for these fixes. Do not combine
  this with a canvas or state-library rewrite. If consolidation is later
  justified by measured churn, preserve per-subject sequence and the existing
  subscription caps, with one liveness timer per physical connection.

**Acceptance:** window A mutates while phone B is hidden or mid-refetch. B
shows the latest workspace/Git/file state on return even if no further event
arrives. Concurrent invalidations coalesce; failures stay retryable; unsaved
editor content survives. A drain begun or cancelled from another client is
reflected after resume without repeating the lifecycle mutation.

## Step 6: Recover terminals and previews without replaying input

**Value:** the other two WebSocket routes do not remain frozen after the
agent view recovers.

- Reuse connection identity, foreground replacement, and bounded reconnect
  behavior, but retain each route's protocol. A healthy `/ws` heartbeat does
  not establish terminal or preview socket health.
- Terminal reconnect first checks that the existing PTY still exists. It
  reattaches to that PTY, not a new shell. The server currently sends a bounded
  byte replay on attach, not a complete terminal-screen snapshot. Preserve
  frame sequences and apply only missing contiguous output; do not append
  the same bytes to xterm twice. `terminalSocket.ts` currently discards this
  sequence information when it forwards the decoded payload.
- If terminal replay has a gap, report truncated output and reset the view
  explicitly as needed; a ring-buffer tail cannot guarantee exact ANSI screen
  reconstruction. Verify that any retry cannot create a blank-but-claimed-
  synchronized terminal. A full server-side terminal emulator is outside this
  plan, not an assumed existing capability.
- Refresh dimensions and the server's size lease. Foregrounding a phone must
  not steal another client's lease. An obsolete connection must not detach
  its replacement's lease/subscription.
- Never replay buffered terminal keystrokes or a pending paste after loss.
  If the PTY died during daemon restart, show that explicitly; shell creation
  is a separate action, not connection recovery.
- Preview reconnect fetches metadata and resumes at the newest frame with
  the existing ack pacing. Reset connection-scoped frame/ack state and ignore
  late image decodes from old connections. An old high frame sequence must
  not suppress all frames from a restarted stream.
- Refresh preview ownership and remain view-only until the server grants
  control. Do not replay clicks, keys, or navigation mutations. Use the same
  reconnect path on visibility return, not only a metadata refresh.
- Neither view's unmount/suspension performs a resource-delete request.

**Acceptance:** reconnect a live PTY without duplicate output or lost size
ownership; do not resend input. Recover preview after backgrounding and after
upstream stream restart; display current frames with bounded memory and no
stale input. A second desktop client retains its existing control rights.

## End-to-end verification

For implementation, add deterministic lifecycle/reconciliation tests before
fixing the relevant behavior. Use existing unit suites plus daemon HTTP/WS
integration and NullModel for Pi activity; no real AI APIs without permission.

Use `agent-browser` for desktop/mobile rendering, reconnect/error states, and
keyboard controls. Resolve the worktree port with `bun scripts/dev-port.ts`;
stop on `CRITICAL`. A narrow viewport or desktop WebKit test is not a substitute
for real iOS suspension testing.

On a real iPhone running the operator's iOS 27 build, reproduce first in the
affected browser/mode, then compare Safari and installed PWA mode separately.
Record exact versions and direct versus proxy access. Cover:

| Scenario | Required result |
| --- | --- |
| App switch or screen lock during model/tool work | Daemon work continues; foreground view catches up. |
| Final output or question arrives while suspended | Correct idle/question state on return, without another prompt. |
| Wi-Fi/cellular change, airplane mode, VPN/proxy interruption | Bounded reconnect, explicit stale state, eventual snapshot recovery. |
| Socket silently stops while reporting `OPEN` | Foreground probe detects it; replacement restores updates. |
| Back/forward cache restore and full page eviction | Restore/reload from daemon state and saved draft; no duplicate run. |
| Daemon restart with an old browser cursor | Fresh stream identity and snapshot; no permanent sequence rejection. |
| Rapid agent/workspace switching | No stale fetch overwrites, orphan timers, or resource termination. |
| Concurrent desktop browser and phone | Both converge; terminal/preview control is not stolen. |

If handshakes fail, compare browser diagnostics with proxy upgrade logs and
daemon `ws.open` before blaming Pi. Change HTTP/2/3 negotiation or proxy idle
timeouts only after reproducing that specific failure. Keep historical WebKit
bugs as references, not blanket explanations.

Done means the phone can lose its entire live connection, return to an accurate
view, and continue receiving events without restarting Pi, replaying mutations,
or manually reloading the page. Runtime checks apply when this plan is
implemented; this document-only change needs link and diff checks, not a
typecheck or application test run.
