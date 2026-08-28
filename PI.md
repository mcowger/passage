# Pi integration findings

## Decision

Passage uses **Pi RPC as its primary agent boundary**. The Bun daemon starts
one `pi --mode rpc` process for each active Passage agent, exposes only a
minimal browser-facing Pi channel for intentionally supported Pi commands and
normalized events, and directly reads Pi's JSONL files for durable history and
reconciliation.

```text
React PWA
    │ Passage HTTP / WebSocket transport
    ▼
Passage daemon
    ├── workspace, Git, terminal, and layout services
    ├── PiRpcManager
    │   ├── Pi RPC process for Agent A ── stdin/stdout JSONL
    │   ├── Pi RPC process for Agent B ── stdin/stdout JSONL
    │   └── bounded JSONL history reader/index
    └── Passage SQLite metadata only
             │
             ▼
      Pi JSONL sessions: canonical durable history
```

This supersedes the earlier SDK-first recommendation. Pi RPC provides the
prompt, steering, queue, model, thinking, Bash, session, and compaction commands
Passage needs. It can expose standard extension-UI requests only when extensions
are enabled and loaded by the Pi process; Passage does not depend on them in v1.
A process per active agent is an acceptable cost and gives each agent a clean
lifecycle/isolation boundary.

Passage does **not** write an agent transcript database. SQLite holds
Passage-owned project/workspace/agent metadata, UI state, and discardable JSONL
indexes. Pi JSONL remains authoritative for messages, branches, compaction, and
Pi-provided usage.

## Sources reviewed

### Pi-Web implementation

- `../pi-web/lib/rpc-manager.ts` — historical direct-SDK implementation used
  for comparison; useful for prompt semantics, extension injection, and UI
  mediation, but not an implementation dependency for Passage.
- `../pi-web/lib/session-reader.ts` — disk-authoritative history browsing.
- `../pi-web/lib/agent-event-stream.ts` — stream snapshot/reconnect ordering.
- `../pi-web/lib/agent-event-wire.ts` — event projection for a browser.
- `../pi-web/lib/project-command-env.ts` — host-injected Bash extension.
- `../pi-web/lib/subagent-extension.ts` — host-injected subagent extension.
- `../pi-web/lib/project-trust.ts` — trust gating of project resources.
- `../pi-web/AGENTS.md` — lifecycle, session tree, and stream caveats.

### First-party Pi references

- [RPC documentation](https://pi.dev/docs/latest/rpc)
- [Session format](https://pi.dev/docs/latest/session-format)
- [JSON event stream](https://pi.dev/docs/latest/json)
- [SDK documentation](https://pi.dev/docs/latest/sdk)
- [Extensions](https://pi.dev/docs/latest/extensions)
- [Coding-agent source](https://github.com/badlogic/pi-mono/tree/main/packages/coding-agent)

The Pi-Web checkout pins the `@earendil-works/pi-*` package family at `0.84.3`.
Passage should pin the **Pi CLI** to one exact verified version and version its
RPC schemas/JSONL fixtures against that CLI. Do not rely on `latest` docs for
wire-level behavior without checking the pinned release source.

## Why RPC fits Passage

| Capability | Pi RPC | Passage responsibility |
| --- | --- | --- |
| Prompt, steer, follow-up, queues, abort | Pi command/event stream | Preserve Pi semantics in the browser UI. |
| Model, thinking, compaction, Bash, session operations | Pi command/event stream | Present the focused controls selected in `docs/UI.md`. |
| Durable messages, branches, compaction, usage | Pi JSONL | Bounded reads, indexing, paging, and browser projections. |
| Live process lifetime | One Pi child process per active agent | Start, retain, restart, stop, capture stderr, and handle crashes. |
| Files, Git/worktrees, terminals, layouts | Not in Pi RPC | Passage daemon services and browser contracts. |
| Browser/LAN transport | Not in Pi RPC | WebSocket/HTTP, origin policy, subscriptions, terminal binary frames. |
| Custom tool display | Pi tool events contain source data | Passage renderer registry and declarative renderer packs. |

Pi RPC is sufficient for the agent portion of the product. Passage still needs
a small browser-facing contract because Pi has no network RPC listener and
does not know about Passage workspaces, PTYs, Git, files, or layouts. That is
not a competing agent RPC protocol.

## Pi RPC protocol

### Transport and framing

Start an agent process from Bun with:

```bash
pi --mode rpc
```

Pi RPC is a **Pi-specific JSONL protocol**, not JSON-RPC 2.0:

- The daemon writes one JSON command object followed by LF to stdin.
- Pi writes response objects and asynchronous agent events as JSON objects,
  one LF-delimited record at a time, to stdout.
- Commands use `type` and optional `id`, not JSON-RPC `method`/`params`.
- Responses use `type: "response"`, `command`, `success`, optional `data`, and
  an error field when unsuccessful.
- Pi exposes no HTTP, WebSocket, TCP, or Unix-domain RPC listener.

```text
stdin  → {"id":"req-1","type":"get_state"}\n
stdout → {"id":"req-1","type":"response","command":"get_state","success":true,"data":{...}}\n
stdout → {"type":"agent_start",...}\n
```

The parser must split **only on LF** (`\n`) and may strip one trailing CR for
CRLF. It must not use a generic line reader that treats U+2028/U+2029 as line
boundaries, because they are valid inside JSON strings. Maintain a buffered
stdout parser and a pending-request map keyed by Pi request `id`.

### Commands Passage uses

The exact command union is defined by the pinned Pi release. The core Passage
mapping uses Pi-native command objects rather than recreating equivalent SDK
operations:

| Passage action | Pi RPC command | Important semantic |
| --- | --- | --- |
| Send | `{"type":"prompt","message":...}` | While streaming, include `streamingBehavior` or Pi rejects it. |
| Steer now | `{"type":"steer","message":...}` | Delivered after current tool work and before the next model call. |
| Queue follow-up | `{"type":"follow_up","message":...}` | Waits for the current run to complete. |
| Stop agent | `{"type":"abort"}` | Distinct from stopping Bash or compaction. |
| Clear queues | `{"type":"clear_queue"}` | Pi owns queue behavior. |
| Change model | `{"type":"set_model","provider":...,"modelId":...}` | Use Pi's available-model query for valid choices. |
| Change thinking | `{"type":"set_thinking_level","level":...}` | Query Pi for levels supported by the current model. |
| Compact | `{"type":"compact",...}` | May produce activity after a normal run boundary. |
| Stop compaction | `{"type":"abort_compaction"}` | Only stops compaction. |
| Run/stop Pi Bash | `{"type":"bash",...}` / `{"type":"abort_bash"}` | Separate from Passage's user-controlled PTY terminals. |
| Inspect/reconcile | `get_state`, session/tree/entry commands supported by the pinned release | JSONL is still the durable source of truth. |

Images use Pi's image content shape:

```json
{
  "type": "image",
  "data": "base64-encoded-data",
  "mimeType": "image/png"
}
```

Passage sends only the commands it intentionally surfaces. It does not expose a
raw browser-to-Pi command console or accept arbitrary command JSON from a web
client.

### Prompt acknowledgement and completion

A successful Pi response to `prompt` means the prompt was accepted, queued, or
handled immediately. It does **not** mean the model run completed.

```text
Browser Send
  → Passage assigns browser request ID and Pi request ID
  → Pi RPC response: accepted/rejected
  → Passage acknowledges the browser command
  → Pi events: messages, tools, queues, compaction, errors
  → Pi reports settlement
  → Passage reloads JSONL and publishes a reconciled snapshot
```

Serialize only **prompt admission** and other mutating Pi commands per agent.
Do not serialize an entire prompt run: Pi needs to accept steering and
follow-up while the original turn is active.

These event meanings must remain distinct:

| Signal | Passage handling |
| --- | --- |
| `message_update` | Build provisional text/thinking/tool display only. |
| `message_end` | Finalize one streamed message projection. |
| `agent_end` | Keep listening: retry, compaction, extension-queued, or follow-up work may continue. |
| `agent_settled` | Important settlement signal; combine with current state and pinned-version behavior before marking the agent idle. |
| Direct JSONL read | Durable reconciliation after completion, reconnect, process restart, or uncertain delivery. |

Never close the browser's live agent subscription merely because the first
`agent_end` arrives.

## PiRpcManager

### One process per active Passage agent

`PiRpcManager` owns one `PiRpcProcess` per active Passage `agentId`:

```text
PiRpcProcess
├── agentId, workspaceId, cwd
├── Pi executable/version and launch arguments/environment
├── Bun child-process handle
├── stdin JSONL writer
├── stdout LF-only parser
├── bounded stderr buffer
├── pending Pi request map and mutation-admission tail
├── current Pi state snapshot
├── bounded browser event replay buffer
├── session ID/path once Pi reports or writes it
└── process generation, exit state, idle-retention timer
```

The process receives the workspace `cwd`. Its launch configuration must include
the selected Pi session location/resume operation according to the pinned CLI
contract. On startup, issue `get_state` before reporting that the Passage agent
is ready; capture the Pi session ID/path and model/thinking state from the
response when available.

### Startup, reconnect, and shutdown

1. Share one startup promise for an `agentId`; never start the same live Pi
   process twice concurrently.
2. Begin stdout parsing and event capture before issuing the initial command or
   making the process visible to browser clients.
3. Attach a browser subscriber by publishing current state, then replaying
   events newer than its supplied sequence. If the buffer cannot fill the gap,
   return a snapshot-required result and reload Pi JSONL history.
4. Browser disconnect does not stop Pi. Retain the process through a defined
   idle grace period and reattach on later browser connection.
5. On process exit, settle pending RPC requests with a process-exit error,
   capture bounded stderr/exit status, emit an attention/error state, and leave
   the persisted Pi session resumable.
6. Explicit agent shutdown closes stdin, waits briefly for a clean exit, then
   terminates the process tree if necessary. Clear subscriptions and replay
   state only after emitting final lifecycle status.
7. Passage daemon restart ends child processes. On next agent open, start a new
   Pi RPC process against the persisted session and rebuild the browser state
   from JSONL.

Pi process crash/restart behavior is a required product path, not an edge case.

### Browser bridge

The browser does not see a raw stdin/stdout pipe. It uses the existing Passage
WebSocket transport, which minimally multiplexes resource type and agent ID:

```text
Browser command: { channel: "pi", agentId, requestId, command: PiRpcCommand }
Browser event:   { channel: "pi", agentId, sequence, event: PiRpcEvent }

Other channels:  workspace | terminal | daemon
```

`PiRpcManager` validates the selected Pi command schema, assigns/correlates the
Pi `id`, maps process errors into a Passage error form, and normalizes only the
Pi records needed for stable UI rendering. Pi command names and event payloads
otherwise remain recognizable; Passage does not recreate an independent agent
command vocabulary.

Terminal byte streams remain Passage binary WebSocket frames. They are not Pi
RPC messages.

## Durable Pi JSONL history

### Reader/indexer responsibilities

Pi JSONL files are canonical durable history, but are not immutable append-only
logs: Pi may append entries or rewrite files during migrations and supported
metadata operations. `PiSessionHistoryReader` therefore:

1. opens files read-only with bounded byte/line limits;
2. parses the pinned session entry schema and preserves unknown entries;
3. tracks file revision information and invalidates its index on rewrite;
4. indexes entry IDs, parent IDs, timestamps, model/thinking changes,
   compactions, messages, usage, and session metadata;
5. reconstructs the selected tree branch/context from IDs according to the
   pinned Pi session-format rules;
6. pages normalized history to the browser without copying it into SQLite.

Use bounded direct reads for header/index discovery. Never hand-write or
silently repair Pi transcript entries. If Passage ever needs a Pi custom entry,
use the exact supported Pi mechanism for the pinned version and a `passage:`
namespace.

### History and lifecycle flow

```text
Read historical agent
  → resolve agent's Pi session file
  → PiSessionHistoryReader bounded parse/index
  → reconstruct requested branch/context
  → normalize/page browser response

Live agent settles or browser reconnects
  → query Pi RPC get_state
  → PiSessionHistoryReader reloads changed JSONL
  → publish reconciled snapshot
```

New sessions can exist briefly before Pi has flushed a durable JSONL file. Store
the stable session ID as soon as Pi reports it; update the Passage agent's path
mapping after the first durable flush. Represent an unpersisted active process
explicitly instead of inventing transcript data.

### Branches and forks

Pi has two different branch operations:

- **In-session navigation** selects a different tree leaf within one JSONL
  file.
- **Fork/clone** creates a separate session file with lineage metadata.

The history reader preserves entry IDs and parent relationships so later UI can
support both. A fork replaces the relevant active Pi RPC process association;
the old process must not remain attributed to the original agent/session.

## Event normalization and tool rendering

Pi's event wire shape is version-sensitive. `PiRpcEventNormalizer` is the sole
place Passage translates it into browser UI records. It retains Pi event type,
tool/message/entry IDs, model/thinking usage, timestamps, errors, and
delta-versus-final content boundaries.

Expected categories include:

```text
agent_start / agent_end / agent_settled
turn_start / turn_end
message_start / message_update / message_end
queue_update
compaction_start / compaction_end
prompt_error / extension_error / extension_ui_request
```

Legacy/new compaction aliases are normalized only when needed for the pinned Pi
version. Tests fixture real stdout records and JSONL files from that release.

Tool rendering is event-driven, not extension-driven:

```text
Pi RPC tool event
  → PiRpcEventNormalizer
  → normalized ToolActivity
  → Passage ToolRendererRegistry
      ├── first-party typed renderer
      ├── declarative renderer pack
      └── generic safe card
  → timeline / inspector / diff panel
```

This preserves the tool UI agreed in `docs/UI.md`: compact verb/target/status/
duration rows, expandable details, specialized edit/diff rendering, and a
per-agent Detailed/Concise presentation toggle. A renderer affects display and
grouping only; it cannot execute tools, alter Pi history, or orchestrate agents.

## Pi-Web's injected extension technique

### What Pi-Web does

Pi-Web uses Pi's direct SDK to add host-owned in-memory `InlineExtension`
factories through `resourceLoaderOptions.extensionFactories`. Its factories:

- replace Pi's Bash tool with Pi-Web's project-command environment;
- add Pi-Web subagent tools;
- select/override extensions before SDK session creation.

Each extension is a hidden in-memory factory that calls the normal Pi extension
API, such as `pi.registerTool(...)`. It is not generated source code and does
not send React/JSX to the browser.

Pi-Web also binds Pi extension UI to an SSE bridge. Pi UI calls such as
`select`, `confirm`, `input`, `editor`, `notify`, `setStatus`, `setWidget`, and
`custom` become typed browser events. IDs correlate blocking dialogs with their
responses; text widgets use keyed snapshots; factory widgets render Pi TUI
components headlessly to `string[]`; custom TUI panels proxy browser input back
to the extension. Its cleanup/generation safeguards are thoughtful.

### What Passage gains or loses with RPC

Pi RPC can forward normal Pi `extension_ui_request` events and accept matching
responses. It can therefore support standard extension dialogs if Passage later
chooses to expose them.

Pi RPC does **not** give Passage the direct-SDK-only ability to inject Pi-Web-
style `InlineExtension` factories, replace Pi built-in tools in-process, or
bind a custom host `uiContext` during service construction. `InlineExtension`
is therefore not applicable to Passage's RPC-managed agent process unless Pi
later adds an explicit RPC/configuration mechanism for loading equivalent trusted
extensions. A browser renderer cannot provide this capability.

This is an acceptable and desirable v1 limitation. The omitted capabilities are
exactly where Pi-Web gains plugin/subagent/Bash-environment orchestration that
Passage intentionally does not productize.

### Passage policy

- Do **not** adopt Pi-Web's injected Bash or subagent extensions.
- Do **not** proxy Pi's general `custom()` terminal-style UI; Passage already
  has its own xterm terminal and does not need a second terminal input protocol.
- Do **not** make arbitrary extension code or renderer code executable in the
  browser/daemon as a Passage plugin framework.
- Use direct Pi RPC tool events plus declarative renderer packs for custom tool
  presentation.
- If Passage later deliberately enables trusted extensions through a supported
  Pi RPC or static configuration mechanism, start with standard
  `select`/`confirm`/`input` UI mediation over the existing RPC event channel,
  using typed IDs, expiry, cancellation, output quotas, and teardown. This does
  not make Pi-Web's SDK-only `InlineExtension` injection available.

Host-owned inline extensions and workspace `.pi` extensions have different
trust properties. The latter are repository-controlled code and must not execute
merely because a workspace is opened.

## Resource and trust policy

Passage hides Pi skills, MCP, extensions, subagents, and related orchestration
management from its own product UI. It must nevertheless make a deliberate
resource-loading policy for each Pi process:

1. Browsing/opening an untrusted workspace never runs project-controlled Pi
   extensions, skills, MCP resources, or similar executable resources.
2. Starting a Passage agent in an untrusted workspace continues with the
   project resource policy disabled.
3. An explicit persisted workspace-trust decision may permit Pi's configured
   resource loader for that workspace, without creating a broad Passage
   extensions-management screen.
4. A Pi extension that requests unsupported UI results in a visible
   attention/error state rather than an invisible hung process.
5. Model discovery is included in trust tests because resource loading can
   register providers or execute code before a prompt runs.

This allows normal Pi behavior in an explicitly trusted workspace without
turning Passage into a skills/MCP/plugin orchestration product.

## Phase 0: Pi RPC acceptance tests

Before Passage depends on Pi, prove this behavior with the exact Pi CLI version
and target Bun runtime:

1. Launch `pi --mode rpc` from Bun with a workspace `cwd` and configured
   session location.
2. Send/parse LF-delimited request, response, and asynchronous event records;
   test U+2028/U+2029 framing explicitly.
3. Create/resume an agent, use `get_state`, and correlate Pi request IDs with
   simultaneous responses/events.
4. Prove accepted prompt, steer, follow-up, queue state, and agent settlement
   match Pi behavior.
5. Prove independent `abort`, `abort_bash`, and `abort_compaction` behavior.
6. Start two agents concurrently and verify output, cwd, process exit, stderr,
   and request correlation cannot cross agent boundaries.
7. Kill/crash a Pi process; emit attention, restart against its persisted
   session, and reconcile the browser from JSONL.
8. Read realistic Pi session files directly, including compaction, branches,
   rewrites, large history, malformed partial trailing lines, and unknown entry
   types.
9. Validate model/thinking availability and session controls through Pi RPC,
   not SDK imports.
10. Validate trusted/untrusted project resource behavior and an unsupported
    extension UI request.
11. Fixture real Pi stdout records and JSONL sessions so a Pi upgrade is an
    intentional compatibility change.

## Implementation rules

1. Keep Pi process spawning, stdin/stdout JSONL framing, request correlation,
   stderr, and event normalization in `src/daemon/agents/PiRpcManager` and its
   small focused collaborators.
2. Spawn one Pi RPC process per active Passage agent. Retain it across browser
   reconnects but never let it survive a Passage daemon restart unobserved.
3. Keep Pi JSONL authoritative. Use a bounded direct history reader/indexer;
   never mirror messages or Pi-derived usage into SQLite.
4. Forward Pi-native command semantics through a minimal agent channel. Do not
   build a competing generic agent/provider RPC surface.
5. Preserve the difference between accepted prompt, message finalization,
   agent-run end, agent settlement, and durable JSONL reconciliation.
6. Add Passage sequence/replay and browser snapshots around Pi events; Pi RPC
   alone cannot replay events to a reconnecting browser client.
7. Keep Passage PTY terminals separate from Pi's `bash` RPC command and Bash
   lifecycle.
8. Do not adopt direct-SDK injected extensions or custom TUI bridging for v1.
9. Require explicit trust before project-controlled Pi resources execute.
10. The pinned Pi CLI must run under the supported Bun runtime as an intentional
    agent process. There is no separate Node implementation layer or Node-based
    fallback sidecar.
