# Passage

Passage is a single-user, LAN-accessible coding environment built around Pi.
It gives you a browser workspace for running multiple Pi coding agents alongside
the rest of the tools needed to work in a repository.

The persistent Bun daemon owns the work. It manages projects, Git worktrees,
files, diffs, interactive terminals, and one `pi --mode rpc` process per active
agent. The React PWA is an attachable view, so closing a browser tab doesn't
stop daemon-owned work.

## What it includes

- Multiple Pi agents per workspace, with live prompts, steering, follow-ups, and
  model/thinking controls.
- Pi JSONL sessions as the source of truth for agent messages, branches,
  compaction, and usage.
- Git-aware projects and worktrees with workspace-local changes and diffs.
- Interactive PTY terminals, file browsing, CodeMirror editing, and a
  persistent split-pane layout.
- Desktop and mobile layouts served as a PWA over HTTP and WebSockets.
- Local SQLite metadata for projects, workspaces, agent links, preferences, and
  layouts. Passage does not copy agent transcripts into SQLite.

## Push notifications (PWA Web Push)

Passage can push agent `needs-attention` + `done` alerts even with the PWA
closed, via standards-based Web Push. No Apple Developer signup or paid
account is needed — the daemon signs with self-generated VAPID keys and
POSTs to Apple's push service.

### 1. Daemon setup (once)

```sh
bunx web-push generate-vapid-keys
```

Set the three env vars where the daemon runs (`.env`, systemd
`EnvironmentFile`, etc. — never commit them) and restart:

```sh
VAPID_PUBLIC_KEY=BK...
VAPID_PRIVATE_KEY=xyz...
VAPID_SUBJECT=mailto:you@example.com
```

`VAPID_SUBJECT` must be a `mailto:` or `https:` URL (Apple rejects bare
emails). Without these keys `/api/push/*` returns `push-not-configured`
and no pushes are sent.

### 2. Serve over HTTPS

Web Push needs a secure context + installed PWA. Serve the production
build (`bun run build` / `bun run start`) behind your HTTPS reverse proxy.
The daemon only needs outbound HTTPS to `web.push.apple.com` — the phone
receives via Apple, not via LAN, so off-LAN delivery still works.

### 3. iPhone setup (iOS 16.4+, non-EU)

1. Open the site in Safari → Share → Add to Home Screen.
2. Open the Home Screen app (not the Safari tab — Push APIs only exist
   in the installed app).
3. Settings → turn on Agent Notifications → Enable push on this device
   (tap directly; iOS ignores non-gesture prompts).
4. Send test to verify, then kill the PWA — pushes still arrive.

If permission was denied, remove/re-add the Home Screen app to get
prompted again. Android/desktop use the same toggle with no install step.

Tapping a notification deep-links to that workspace/agent
(`?workspaceId=&agentId=`). Every push shows a visible notification
(Apple forbids silent push); expired endpoints are pruned on 404/410.

## Development

Passage uses Bun end to end. Install Bun 1.4.0 and the pinned Pi CLI, then:

```sh
bun install --frozen-lockfile
bun run dev
```

The daemon binds a stable per-worktree port in `3000`–`3999` via
`scripts/dev-port.ts` (hashed from the worktree path) and records the
actual port in `.data/dev.port` next to `.data/dev.pid`.
Generic `PORT` is ignored so an inherited value cannot leak another
worktree's port; the hash is authoritative (Paseo sets `PASEO_PORT` when it
routes traffic). Always resolve the port with `bun scripts/dev-port.ts` —
never reuse a port seen in another checkout, since every worktree has its
own dedicated port.

Useful checks:

```sh
bun run typecheck
bun test
```

Passage is currently intended for single-user, trusted-LAN use on Linux x64.
