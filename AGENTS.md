# Passage contributor guide

Authority: `docs/DESIGN.md` (architecture/security/scope), `docs/UI.md` (UI/a11y), `PI.md` (Pi RPC/history), `docs/WS.md` (mutations/state updates — read before touching either).

## Runtime

- Bun end-to-end on Linux x64. Single package: `src/daemon`, `src/shared`, `src/web`.
- Pi is the only agent runtime (pinned CLI `0.85.1`). No Node, Vite, Pi SDK, ACP, provider abstractions, or multi-provider support.
- Daemon owns FS/Git/worktrees/SQLite/PTYs/Pi/HTTP/WS. Browser is an attachable view; browser close/suspend must not stop daemon work.

## Pi holder rollback

- Follow [docs/BACKTOSQUAREONE.md](docs/BACKTOSQUAREONE.md) for the staged rollback to daemon-owned CLI RPC processes, ending with safe draining shutdown. Crash interruption is accepted; never automatically resend an uncertain prompt.
- [docs/ORHPANS.md](docs/ORHPANS.md) is deprecated historical reference for what was reversed, not implementation authority. Retain it until explicitly asked to delete it; do not reintroduce the holder architecture.
- Steps 1-5 are implemented: `PiRpcManager` spawns and owns each Pi child directly (no holder process, socket, or reattachment path); `pi-holder`, `shutdown-holders`, and `pi-status` are retired. A daemon restart stops every agent's Pi child, interrupting active work, and normalizes any agent left `initializing`/`running`/`stopping`/`needs-attention` to a dedicated `interrupted` status on boot (`AgentService.reconcileAfterRestart`) — never a fabricated Pi transcript row, and never `error` (Pi reported nothing wrong; Passage just lost track of the work). Step 5 is implemented: `DaemonLifecycle` (`src/daemon/lifecycle/`) adds a running/draining/ready phase machine gating new agent work (`AgentService.admissionGate`), with readiness computed only from live agent state (`listQuickBlockers`/`listBlockers`) — per product decision, only agents block drain; terminals, previews, and workspace Git/file/worktree operations never do. `POST`/`DELETE /api/daemon/drain` begin/cancel it; the `daemon` WS channel and `GET /api/daemon/snapshot` carry phase/blockers; Sidebar's footer has a minimal begin/cancel control. Safe shutdown/deploy (step 6, actually stopping on `ready`) is still planned, not implemented — `ready` today never exits the process.

## Pi invariants

- One `pi --mode rpc` per agent, owned solely by `PiRpcManager` (framing, correlation, replay, event normalization).
- Pi JSONL is the only agent history. SQLite holds metadata/indexes only — never transcripts or usage totals. `PiSessionHistoryReader` is the sole parser: read-only, bounded, preserve unknowns, never hand-write/repair.
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

## Git

- "Rebase on main" means local `main` by default, not `origin/main`. Don't fetch or use the remote tracking branch unless explicitly asked.

## Checks

```sh
bun install --frozen-lockfile
bun run typecheck
bun test
bun run test:gate
```

`test:gate` = typecheck + unit + live Pi + PTY + build + package. Never use real AI APIs (`PASSAGE_PI_LIVE=real`, `PASSAGE_PI_USE_REAL=1`) or Cora review without explicit per-turn permission; tests use NullModel.

## Dev server

`bun run dev` hot-restarts. Ports are per-worktree — never hardcode or trust inherited `PORT`/`PASEO_PORT`. Always resolve via `bun scripts/dev-port.ts`; if it reports `CRITICAL` (port taken), stop and ask the user.
