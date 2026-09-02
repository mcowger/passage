# ADR 0001: Bun runtime feasibility

- **Status:** Accepted
- **Date:** 2026-08-28

## Context

Phase 0 required a runtime and packaging compatibility gate before feature work.
The pinned versions are Bun 1.4.0, Pi CLI 0.84.3, and Hono 4.13.5.

## Decision

Use Bun end to end. Use Bun-native HTML imports, browser HMR, full-stack serving,
and compiled packaging; do not introduce Vite, a Node runtime, or a Node fallback.

Pi RPC live create/resume, prompt, steer, follow-up, settlement, JSONL reading,
and the two-session isolation test passed locally. `node-pty` 1.1.0 and
1.2.0-beta.15 both failed with `EBADF` and are rejected. Bun's native terminal
API passed spawn, input, idle, resize, output, and termination on local Linux
x64.

Linux x64 is the initial supported host and its local feasibility is verified.
Other platforms require a separate compatibility gate before support is
claimed. Bun 1.4 types currently exclude Windows for native terminals.

## Consequences

- The daemon, Pi processes, web build, and production executable share Bun's
  runtime and tooling.
- The compiled Passage executable still requires the pinned Bun runtime to be
  installed for Pi's JavaScript CLI; configure `PASSAGE_BUN_PATH` when `bun` is
  not on `PATH`.
- Terminals use Bun's native terminal API rather than `node-pty`; Windows
  support is deferred rather than supplied by a fallback.
- Additional platform support remains deferred until its native terminal and
  packaging behavior passes the same gate.
- The complete required workstation/CI gate is:

```sh
bun run test:phase0
```

Its individual verification commands are:

```sh
bun install --frozen-lockfile
bun test
bun run test:pi-rpc
bun run test:phase0:pi-live
bun run test:pty-websocket
bun run test:phase0:pty
bun run typecheck
bun run smoke:development
bun run build
bun run smoke:production
bun run package
bun run smoke:package
```
