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

## Development

Passage uses Bun end to end. Install Bun 1.4.0 and the pinned Pi CLI, then:

```sh
bun install --frozen-lockfile
bun run dev
```

The daemon picks a stable per-worktree port in `3000`–`3999` via
`scripts/dev-port.ts` (hashed from the worktree path).
Set `PORT` to override it.

Useful checks:

```sh
bun run typecheck
bun test
```

Passage is currently intended for single-user, trusted-LAN use on Linux x64.
