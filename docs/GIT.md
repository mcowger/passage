# Git Workflows in ± Changes — Plan

Status: **implemented.** Covers interactive staging/discarding,
integrated commit composer, and pull/fetch, including mobile/touch and
multi-client broadcast. `docs/DESIGN.md` remains the architecture authority;
`docs/WS.md` is the WebSocket review standard; `docs/UI.md` governs UI
behavior and accessibility.

## 0. Starting point (verified)

* `src/web/components/ChangesPanel.tsx` — read-only: `gitStatus()` snapshot,
  All/Working-Tree/Staged tabs, `Diff ↗` / `Edit` per row. No mutations.
* `src/daemon/workspaces/git.ts` — `GitService` with `discover` / `status` /
  `diff` only. Fixed arg arrays, `LC_ALL=C`, concurrency slot, timeout,
  output cap. No shell strings.
* `src/daemon/http/git.ts` — `GET status`, `GET diff` only.
* `src/shared/domain/git.ts` — `GitStatus` / `GitFileStatus` / `GitDiff` types.
* `src/web/api.ts` — `gitStatus` / `gitDiff` only.
* Live fan-out is `AgentEventHub` plus `WorkspaceEventHub`
  (`src/daemon/workspaces/events.ts`: per-subject sequences + `ReplayBuffer`
  + `snapshot-required`) on `/ws`, plus per-terminal sockets. Git mutations
  emit `git-status-changed` invalidations defined in
  `src/shared/protocol/workspace.ts` — the event catalog lives in code per
  `docs/WS.md` and is not duplicated here.

## 1. Backend — new `GitService` operations

File: `src/daemon/workspaces/git.ts`. Follow existing patterns (fixed arg
arrays, reuse `run()` slot/timeout/output cap).

| Method | Git invocation | Notes |
|---|---|---|
| `stage(cwd, paths[])` | `git add -- <paths>` | Non-empty, all inside root |
| `unstage(cwd, paths[])` | `git reset HEAD -- <paths>` | Added + modified |
| `stageAll(cwd)` | `git add -A` | No path args |
| `unstageAll(cwd)` | `git reset HEAD` | No path args |
| `discard(cwd, path)` | tracked: `git restore --source=HEAD -- <path>`; untracked file-only: `git clean -f -- <path>` (never `-d`/`-x` in v1) | Single file; refuse conflict (`UU`) paths |
| `commit(cwd, message)` | `git commit -m <message>` | Reject empty/whitespace; return new HEAD |
| `pull(cwd)` | `git pull --ff-only` | No rebase/merge picker in v1 |
| `fetch(cwd)` | `git fetch --prune` | Refreshes `ahead/behind` |

Safety (per DESIGN.md filesystem boundary): resolve every path through
`WorkspaceService.resolvePath()` → realpath → must stay inside the canonical
workspace root. Reject traversal, symlink escapes, absolute browser paths. Cap
`paths[]` (e.g. 100 entries / arg-byte budget). Mutations serialize through
the existing concurrency slot.

## 2. HTTP routes + validation

File: `src/daemon/http/git.ts`. Zod schemas in `src/shared/` (extend
`domain/git.ts` or `protocol/`): `paths` = 1–100 non-empty strings; `message`
= trimmed 1–1000 chars.

```text
POST /api/workspaces/:id/git/stage        { paths: string[] }  → GitStatus
POST /api/workspaces/:id/git/unstage      { paths: string[] }  → GitStatus
POST /api/workspaces/:id/git/stage-all    {}                   → GitStatus
POST /api/workspaces/:id/git/unstage-all  {}                   → GitStatus
POST /api/workspaces/:id/git/discard      { path: string }     → GitStatus
POST /api/workspaces/:id/git/commit       { message: string }  → { head, status }
POST /api/workspaces/:id/git/pull         {}                   → GitStatus
POST /api/workspaces/:id/git/fetch        {}                   → GitStatus
```

Reuse the existing `error()` helper (`GitError → 422 git-failed`, validation
→ 400). Add `friendlyApiError` entries in `src/web/api.ts` for
`nothing-staged`, `merge-conflict`, `no-upstream`, `diverged` — raw
kebab-case codes are never shown to users. Never expose arbitrary command
execution; surface Git stderr truncated to existing limits as a readable
`Alert`, not a raw dump.

`WorkspaceApi` additions: `gitStage`, `gitUnstage`, `gitStageAll`,
`gitUnstageAll`, `gitDiscard`, `gitCommit`, `gitPull`, `gitFetch` — all
returning the parsed `GitStatus` (plus `head` for commit).

## 3. Multi-client broadcast (existing WebSocket channels)

The mutating caller gets the reconciled `GitStatus` inline in its HTTP
response. **All other clients learn via invalidation on the existing `/ws`
multiplex** — same envelope, sequencing, replay, and `snapshot-required`
pattern as `AgentEventHub`.

### 3a. Event contract

After each successful mutation the daemon publishes a `git-status-changed`
invalidation; the authoritative schema is `gitStatusChangedPayloadSchema` in
`src/shared/protocol/workspace.ts` (invalidation-only: `{workspaceId,
reason}` — `GitStatus` never rides the wire, file lists can exceed
`MAX_PROTOCOL_PAYLOAD_BYTES`). Receivers refetch authoritative `GET
/git/status` (plus `GET /git/diff` if a diff tab is open).

### 3b. Daemon work

* New `WorkspaceEventHub` mirroring `AgentEventHub`, backed by the existing
  `ReplayBuffer`: per-`workspaceId` sequences, bounded replay,
  `snapshot-required` with `snapshotUrl:
  /api/workspaces/:id/git/status` when a client falls behind. Wire alongside
  `agentEvents` in `src/daemon/index.ts`; dispose on shutdown.
* `handleCommand`: add `channel: "workspace"` with `subscribe` /
  `unsubscribe` (same `afterSequence` semantics as the pi channel, same
  per-socket subscription cap). `createGitRoutes` takes the hub and calls
  `hub.emit(workspaceId, "git-status-changed", …)` after each mutation.
* Zod-validated envelopes only; `subjectId` is the opaque workspace ID, never
  a path. No new socket endpoint, no raw Git output on the wire.

### 3c. Client work (`src/web/`)

* New `subscribeWorkspace(workspaceId, afterSequence)` mirroring
  `agentSocket.ts:subscribeAgent` — same `/ws` socket, reconnect handling,
  replay-then-live, `snapshot-required → GET status`, visibility/`online`
  reconciliation (mobile suspend is expected, not exceptional).
* `ChangesPanel` subscribes on mount; on `git-status-changed` from *another*
  client it refetches `gitStatus()`. Its own mutation already returned a fresh
  snapshot, so the echo is ignored/debounced. Pending per-file spinners stay
  local — only committed status is shared.
* Sidebar/header `↑↓` + change counts ride the same event (same `gitStatus`
  source), so multi-client chrome stays consistent for free.

## 4. Frontend — `ChangesPanel` evolution

Keep the existing structure (summary bar, tabs, `ChangeRow`); add row, header,
and composer blocks. Per AGENTS.md, use shadcn primitives only — no hand-built
dropdowns/dialogs/tooltips/popovers:

| Need | Primitive (`src/web/components/ui/*`) |
|---|---|
| Stage/Unstage/Stage All/Discard/Commit/Pull/Fetch | `Button` — `size="xs"` desktop standard (24px); `secondary` for stage/unstage, `default` for Commit (sole primary), `ghost` + `icon-xs` for refresh, `destructive`/`outline` for Discard confirm |
| Commit message | `Textarea` + `Label` (`Input` rejected — message is multiline) |
| Discard / untracked-delete / dirty-pull confirms | `AlertDialog` (Content/Header/Title/Description/Footer/Action/Cancel) |
| Pull/Fetch overflow, per-row `⋯` on touch | `DropdownMenu` |
| Failures (commit/pull/discard) | `Alert` + `AlertDescription`; transient success via `Sonner` toast |
| Cmd+Enter hint | `Kbd` |
| Desktop hover explanations | `Tooltip`; touch uses a visible `⋯` button, never long-press-only |
| Long file lists | `ScrollArea` + existing tabs; `Separator` between sections |
| Status letters | Existing `Badge` mapping, unchanged |

### 4a. Staging & discarding

* Row: `[+] Stage` on working-tree rows / `[–] Unstage` on staged rows as
  `Button size="xs"` with `aria-label="Stage <path>"`. Keep `Diff ↗` / `Edit`.
  A row with a pending mutation shows an inline `Spinner` and disables only
  its own buttons.
* Header: `Stage All` / `Unstage All` in `.panel-actions`, disabled when the
  respective list is empty (reuse existing `stagedFiles`/`unstagedFiles`
  filters).
* Discard: ghost/destructive icon-button per working-tree row →
  `AlertDialog` ("Discard changes to `path`? This cannot be undone.", mono
  path; untracked files get distinct "Delete untracked file…" copy). Confirm
  → `gitDiscard` → replace `status` with returned snapshot → `sonner` toast
  (no undo — state is gone). Conflict rows offer no Discard; link to diff.
* Failures render via `friendlyApiError()` into the panel `Alert`.

### 4b. Commit composer (sticky footer)

```text
┌ Staged (2) ─────────────────────┐
│ Textarea: "Commit message…"     │
│ [Commit staged (2)  ⌘↵]  [Pull] [Fetch] │
│ ↑1 ↓2 · on feature/x           │
└─────────────────────────────────┘
```

* After `.changes-list`, `position: sticky; bottom: 0`, surface bg + top
  border (same grammar as the agent `Composer`), safe-area padding
  (`pb-[env(safe-area-inset-bottom)]`).
* `Commit` disabled when `stagedFiles` is empty, message is blank, or a
  mutation is pending. `Cmd/Ctrl+Enter` in the `Textarea` submits (document
  with `Kbd`). Failed submissions retain their message as a per-workspace
  draft (browser memory/localStorage, mirroring composer draft rules).
* Empty-staged state shows "Stage files above to commit" instead of hiding —
  no layout jitter (UI.md principle 5). Ahead/behind + branch reuse the
  summary-bar line; Pull/Fetch sit next to Commit.
* Dirty-tree pull is rejected client-side ("Commit or discard first") before
  hitting the daemon; daemon errors still handled. No merge-tool UI in v1
  (DESIGN.md non-goal) — diverged/conflict `Alert` points at Fetch + terminal
  resolution.

## 5. Mobile / touch (UI.md chat-first, `<640px`)

* Changes opens as a **full-screen destination** with `Back to [agent]`;
  the desktop split tree persists but only this panel renders.
* `xs` 24px buttons fail the 44px touch rule: under coarse pointers
  (`pointer: coarse` / `<640px`) rows become min-44px tall with a full-width
  action row (`Stage`, `Diff`, `Discard`); header batch actions stack
  full-width. No hover-only reveal.
* Composer stays sticky bottom, `100dvh` + `visualViewport` aware so the
  keyboard never covers the `Textarea`; `Commit` becomes full-width `h-11`
  primary on mobile (documented larger-button exception). Pull/Fetch collapse
  into a "Sync" `DropdownMenu` to save width.
* `AlertDialog` confirmations use the primitive's responsive pattern
  (full-width stacked footer buttons on mobile).
* Status never color-only — keep `M/A/D/R/C/?` + text labels at AA contrast.

## 6. Accessibility & keyboard

* Row buttons carry `aria-label` with path; upgrade the current
  button-only tabs to `role="tab"` / `aria-selected` while touching the file.
* `:focus-visible` teal ring from theme tokens; palette entries for Stage
  All/Unstage All; `Cmd+Enter` commits. No drag interaction here.
* `prefers-reduced-motion`: no transitions on refresh; `Spinner` only.
* `xs` remains the standard size; only Commit (primary) and mobile 44px
  targets are documented exceptions.

## 7. Verification

```sh
bun install --frozen-lockfile
bun run typecheck
bun test
```

* `bun test`: `GitService` stage/unstage/discard/commit/pull/fetch on temp
  repos (spaces, renames, binaries, conflict-refusal, traversal rejection);
  route validation; hub unit tests (subscribe/replay/snapshot-required/
  dispose, mirroring `events/index.test.ts`); route tests asserting
  emit-on-mutation; client test for invalidation→refetch +
  reconnect-reconcile.
* `agent-browser` (required by AGENTS.md for browser-facing changes): dev
  server → stage/unstage single + all, discard tracked + untracked (confirm
  + cancel), commit empty/staged/Cmd+Enter, pull ff-only + diverged error,
  fetch ahead/behind update — on desktop **and** `<640px` (full-screen
  destination, 44px targets, keyboard-open composer, safe-area). Two clients
  on one workspace: stage in one, observe the other update without reload.
  Check loading/error/reconnect states and keyboard-only flow.
* Gate with `bun run test:gate` (NullModel only; no live APIs) before merge.

## 8. Build order (done)

1. ~~Daemon~~ `stage/unstage/stageAll/unstageAll` + routes + tests.
2. ~~Hub~~ `WorkspaceEventHub.emitGitStatus` + emit-on-mutation + tests
   (`workspace` subscribe/unsubscribe already existed).
3. ~~UI~~ row + header staging buttons, `subscribeWorkspace` wiring,
   toast/error handling.
4. ~~Daemon + UI~~ `discard` with `AlertDialog` (tracked vs. untracked copy).
5. ~~Composer~~ `commit` + `Textarea` + `Cmd+Enter` + draft retention.
6. ~~`pull`/`fetch`~~ + ahead/behind refresh + diverged/conflict errors.
7. ~~Mobile pass~~ 44px rows, sticky safe-area composer, sheet confirms,
   two-client + `agent-browser` mobile verification.

Incidental fixes required by the feature: `ahead`/`behind` were swapped when
parsing `rev-list --left-right --count` (verified against `git status -sb`);
`handleWorkspaceCommand` was missing the terminal-socket guard, which failed
`bun run typecheck` on a clean tree.
