# Passage

Your coding agents keep working after you close the tab.

Passage is a browser workspace for running multiple Pi coding agents in
isolated Git worktrees. The daemon owns the work, the browser is just a
view. Shut your laptop, open your phone, pick up where you left off.

## Why

- Many agents at once, each in its own worktree, each with its own Pi session.
- Close the browser and work continues. Reconnect and reconcile, nothing lost.
- Full workshop in every workspace: terminal, files, diffs, and a live web preview next to the agent.
- Phone-friendly. Chat first on mobile, full-screen tools when you need them, push alerts when an agent needs you.

## Features

Run agents side by side. Prompt, steer mid-run, queue follow-ups, stop cleanly. Switch models and thinking levels from pickers probed from Pi itself. Compact sessions, answer extension questions inline, mention workspace files with @, attach images, and use slash commands. Skill-backed commands unlock with an explicit trust decision per workspace, never by just opening a folder.

Every run renders as readable prose plus a compact tool trace. Thinking collapses, tools show verb plus target plus outcome, stats ride along (tokens, cost, context use). Drafts autosave so a failed send never eats your prompt.

Work in real Git worktrees. Create them from a label with AI-suggested branch and folder names, import or discover existing checkouts, repair broken links. Setup scripts from `paseo.json` run automatically on creation. Stage, commit (or auto-draft the message), pull, fetch, merge, and push without leaving the workspace. File edits are conflict-aware and diffs open inline or in the inspector.

Terminals are real PTYs with a sane sharing rule: one client holds the size lease, everyone else watches. No accidental phone resizes.

Previews run your dev server in server-side Chromium and stream it to the browser, so `localhost` on the host works from any device. Navigate, reload, change viewport, take control. Second clients stay view-only until they ask.

Take it anywhere. Installable PWA, offline shell with honest retry, drawer navigation and full-screen tools on small screens, browser notifications plus Web Push (with deep links back to the agent) when work finishes or needs input.

Make it yours with four builtin themes, per-surface fonts, timeline density controls, prompt templates, and editor/terminal preferences. One setting, applied everywhere.

Single user, trusted LAN, no login screen. Run it behind your own auth or VPN.

## Run it

Needs Bun 1.4.0 and the pinned Pi CLI.

```sh
bun install --frozen-lockfile
bun run dev
```

Resolve the per-worktree port with `bun scripts/dev-port.ts`, then open it.
Checks are `bun run typecheck`, `bun test`, `bun run test:gate`.

Details live in `docs/` (`DESIGN.md` for architecture, `UI.md` for interface, `PI.md` for the Pi boundary, `WS.md` for protocol). Code wins when they disagree.
