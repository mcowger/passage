# Passage contributor guide

Authority: `docs/DESIGN.md` (architecture/security/scope), `docs/UI.md` (UI/a11y), `PI.md` (Pi RPC/history), `docs/WS.md` (mutations/state updates — read before touching either).

## Runtime

- Bun end-to-end on Linux x64. Single package: `src/daemon`, `src/shared`, `src/web`.
- Pi is the only agent runtime (pinned CLI `0.85.1`). No Node, Vite, Pi SDK, ACP, provider abstractions, or multi-provider support.
- Daemon owns FS/Git/worktrees/SQLite/PTYs/Pi/HTTP/WS. Browser is an attachable view; browser close/suspend must not stop daemon work.

## Pi process ownership

- One `pi --mode rpc` per agent, owned directly by `PiRpcManager` (no holder process, socket, or reattachment path). Crash interruption is accepted; never automatically resend an uncertain prompt. Do not reintroduce a holder architecture.
- Implemented state: `pi-holder`, `shutdown-holders`, and `pi-status` are retired. A daemon restart warms every agent left non-idle (fresh Pi child on the same session dir + ID) and auto-continues mid-run ones with a canned `follow_up` (`AgentService.warmAfterRestart`, after `reconcileAfterRestart` normalizes stale-active statuses to `interrupted`) — never a fabricated Pi transcript row, and never `error` for a death Passage itself caused. Why a run stopped is recorded as a fact in `agents.stop_reason` (`shutdown`/`user_abort`/`crash`, queryable straight from sqlite), never inferred later: a mid-run kill with admission already closed records `shutdown`, an unexpected mid-run exit records `crash`, an explicit user stop/abort records `user_abort` (which boot recovery never resumes, however the status reads). Later status reads may normalize the status to `interrupted`/`error`, but the reason survives them and the next boot resumes from it; any manual message or confirmed continuation clears it. There is deliberately no drain phase (retired with `src/daemon/lifecycle/`, `agentBlockers.ts`, the drain endpoints, and the Sidebar drain control): shutdown records `shutdown` for every run it stops itself, cancels in-flight runs (abort trio + bounded ~3s confirmation) instead of waiting for them, kills stragglers, and exits; boot recovery resumes every recorded `shutdown`/`crash`, confirmed or not. `POST /api/daemon/shutdown` accepts `{}` or `{force:true}` (skips the cancel phase); teardown order is agents first (while SQLite is open, so final diagnostics/status/markers persist) then other owned resources then hubs/HTTP/SQLite then PID artifacts. SIGINT/SIGTERM share the one path (a second signal exits raw as a backstop). `scripts/dev-stop.ts` posts the shutdown API (`--force` opts into skipping the cancel phase, then signal escalation). `scripts/deploy.ts`: install deps, build, compile, atomic install while the old daemon runs, then a detached `systemctl restart` plus verification that the new build commit is serving (polls `/api/health` up to ~90s; no rollback). The systemd unit's `TimeoutStopSec` is 10s: shutdown is cancel-then-kill (~seconds) by construction, and boot recovery owns whatever a SIGKILL cuts off, so the bound only ever bites a truly wedged process. (`KillMode` stays at systemd's default `control-group`: a group SIGTERM may beat the abort RPCs to the Pi children, which is fine -- the kills land the recorded shutdown path and boot resumes them. `Restart=always` relaunches after crashes; the deploy verification is what catches a boot crash loop.) Not live-rehearsed against the operator's real systemd unit beyond past incidents — do not restart the operator's real service as a test.

## Pi invariants

- One `pi --mode rpc` per agent, owned solely by `PiRpcManager` (framing, correlation, replay, event normalization).
- Pi JSONL is the only agent history. SQLite holds metadata/indexes only — never transcripts or usage totals. `PiSessionHistoryReader` is the sole parser: read-only, preserve unknowns, never hand-write/repair, and never refuses a legitimate session with an unevidenced size/record cap — a real session (e.g. one carrying a large embedded image) previously hit exactly this and got permanently bricked into `error` with no self-healing path. Bound what gets paged to the client (see `docs/DESIGN.md` Backpressure and limits), not what gets read from Pi's own source of truth; a genuine resource failure should surface with its own honest cause instead.
- Browser speaks a minimal versioned Passage protocol, never raw Pi records or free-form Pi JSON. `prompt` success = admission, not completion: hold subscriptions through finalization, `agent_end`, compaction, reconnect, reconciliation.
- PTYs are separate from Pi `bash`/`abort_bash`. Terminal bytes go over binary WS frames with a single-client size lease.
- All protocol payloads: Zod, versioned, request IDs + per-subject sequences, bounded reads/pages/diffs/output. Mutations return fresh HTTP snapshots + `/ws` invalidations per `docs/WS.md` — never push content, new transports, or duplicate hub logic.

## Lifecycle

- No unrepresented background work: closing a canvas tab tears down its resource (agent → stop Pi + archive, keep history; terminal → kill PTY; preview → stop session + remove record). Never leave a process/session alive with no owning tab.
- Closing an agent tab never deletes/rewrites Pi JSONL. Tab close ≠ browser close: dropping the browser/WS must not stop daemon work.

## Security / workspaces

- Resolve all FS/Git from server-side canonical roots. Reject traversal and symlink escapes; browser paths are display-only.
- Git only via the centralized service (fixed argv, locale, limits, timeouts). No shell-string APIs.
- Remove a Passage worktree only with its DB ownership record; dirty/unmerged needs explicit force. Never auto-delete branches.
- Executable project resources (extensions, skills, MCP) need a persisted workspace-trust decision. No plugin framework.
- Don't over-engineer security until the feature is unusable: match the control to the threat model instead of stacking maximal restrictions plus workaround machinery.
- No app auth; keep Host/Origin validation, LAN-trusted-only without upstream TLS/auth/VPN.

## UI

- Workspace-first peer surfaces; honor Lifecycle above. Tool grouping is presentation-only (no history edits, cross-message merges, hidden errors, or dropped tool boundaries; unknown tools get a generic renderer).
- Tailwind v4 via `bun-plugin-tailwind` (`bunfig.toml`); tokens in `src/web/styles.css` `@theme inline`. No Vite/PostCSS/watchers.
- shadcn first (`bunx --bun shadcn@latest add <component>`, `cn()` in `src/web/lib/utils.ts`): never reimplement focus trap/portal/dismiss/keyboard nav. Custom code is for CodeMirror/Xterm/transcripts/diffs/splits only.
- Mobile = single panel + drawers/full-screen artifacts, not compressed desktop. Verify browser-facing changes with `agent-browser` (desktop + mobile if responsive, incl. loading/error/reconnect/keyboard) — unit tests alone are not done.
- Client-rendered component tests use happy-dom scoped per-file via `setupDomTests()` (`src/web/test-utils/dom.ts`, `*.interaction.test.tsx`) — never a global `[test] preload`, which breaks the fake-global socket tests (readonly globals) and daemon `Request` tests. SSR + pure-function tests stay the default; use render-bound queries, never the `screen` global.

## Git

- CRITICAL: "Rebase on main" means local `main` by default, not `origin/main`. Don't fetch or use the remote tracking branch unless explicitly asked.

## Checks

```sh
bun install --frozen-lockfile
bun run typecheck
bun test
bun run test:gate
```

`test:gate` = typecheck + unit + live Pi + PTY + build + package. Never use real AI APIs (`PASSAGE_PI_LIVE=real`, `PASSAGE_PI_USE_REAL=1`) or Cora review without explicit per-turn permission; tests use NullModel.

## Dev server

`bun run dev` hot-restarts via `scripts/run-dev.ts`. Ports are per-worktree — never hardcode or trust inherited `PORT`/`PASEO_PORT`. Always resolve via `bun scripts/dev-port.ts`; if it reports `CRITICAL` (port taken), stop and ask the user.

Dev/server env isolation: never run `src/daemon/index.ts` directly from a shell that may descend from staging — inherited `PASSAGE_DB_PATH`/`PASSAGE_SESSIONS_ROOT`/`PASSAGE_PID_FILE` once pointed a worktree daemon at production sqlite and migrated it. `bun run dev` scrubs every inherited `PASSAGE_*` var and explicitly sets worktree-local `.data` paths (`scripts/dev-env.ts`); the daemon likewise strips all `PASSAGE_*` plus `PORT`/`PASEO_PORT` from every child it spawns (Pi agents, terminals, setup actions, previews, model probes — `sanitizedSubprocessEnv()` in `src/daemon/env.ts`, canonical list `PASSAGE_ENV_VARS`). A source-run daemon whose data paths still resolve outside its own `.data` dir logs `daemon.dev_data_paths_outside_worktree` instead of proceeding quietly.
