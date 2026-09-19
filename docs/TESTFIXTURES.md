# Pi test fixtures

## Status

Implemented. Corpus lives in `tests/fixtures/pi/` (`manifest.json`,
`history/`, `rpc/`) with the strict replay runner (`replay.ts`) and gate
(`fixtures.test.ts`); authoring tools live in `scripts/`
(`harvest-*.ts`, `synthesize-fixtures.ts`). This document does not authorize
a production replay mode, another agent runtime, or a provider abstraction.

`docs/DESIGN.md` remains authoritative for architecture and persistence.
`PI.md` remains authoritative for the Pi RPC boundary and durable-history
rules.

## Decision

Use a small, curated corpus of sanitized Pi fixtures for most deterministic
tests. Keep a minimal NullModel-backed compatibility gate for the pinned Pi CLI.

The two inputs cover different things:

- **Pi session JSONL** covers durable history: parsing, revision/rewrite
  detection, branches, compaction, usage, tool-result pairing, paging, and
  timeline projection.
- **Pi RPC stdout** covers live process behavior: command responses, streamed
  events, request correlation, queueing, cancellation, settlement, extension
  attention, stderr, and unexpected exit.
- **NullModel with the real pinned Pi executable** confirms that the current Pi
  binary can still create, stream, settle, abort, persist, and resume a real
  session without contacting an external model provider.

JSONL is not a substitute for RPC events. A settled session generally does not
contain every `message_update`, lifecycle event, or timing boundary Pi emitted
while generating it. Conversely, an RPC stream is not a substitute for reading
the durable JSONL file after a run settles.

## Why fixtures

Fixtures should make most Pi coverage fast, repeatable, provider-free, and
rich in actual Pi record shapes.

They are especially useful for cases that NullModel's small set of personas
does not naturally produce:

- real tool-call and tool-result shapes;
- long tool output and large assistant responses;
- branch selection where the live leaf differs from file order;
- compaction summaries and changing context occupancy;
- unknown future entry types;
- malformed partial tails and JSONL rewrites;
- sequence-sensitive streaming, queue, abort, and crash flows.

Fixtures must not replace every live check. A fixture runner only proves that
Passage handles the records it receives. It cannot prove that the pinned Pi
release still emits those records or retains the same semantics.

## Scope and boundaries

The fixture system is test-only.

- Do not add a user-facing replay mode.
- Do not make `PiRpcManager` select a fake provider or gain a production test
  branch.
- Do not create a generic agent/provider interface.
- Do not expose recorded Pi records through browser WebSockets. Browser traffic
  stays normalized, versioned Passage protocol traffic.
- Do not use a fixture runner to hand-write or repair Pi session files in
  production. Pi JSONL remains authoritative and is read-only to Passage.

The normal dependency-injection seam is the executable already accepted by
`PiRpcProcess`. Tests can start a test executable instead of `pi`; production
always starts the pinned Pi CLI.

## Fixture layout

Keep fixtures external and human-reviewable rather than accumulating large
embedded JSON strings in test source.

```text
tests/fixtures/pi/
  manifest.json
  history/
    basic-settled.jsonl
    sequential-tools.jsonl
    tool-error.jsonl
    branch-selection.jsonl
    compaction.jsonl
    unknown-entry.jsonl
    partial-tail.jsonl
    long-output.jsonl
  rpc/
    prompt-stream.json
    prompt-steer-follow-up.json
    abort-settlement.json
    extension-attention.json
    crash-after-response.json
```

The manifest should record:

- fixture name and concise purpose;
- source Pi CLI version and session-format version;
- fixture kind (`history` or `rpc`);
- expected characteristics, such as tool names, branch count, partial tail, or
  expected lifecycle sequence;
- content hash of every committed fixture.

Names describe the behavior under test, never the original workspace, session,
person, project, provider account, or task.

## Initial corpus

Start with roughly 10 to 14 scenarios. More files are not automatically better;
each fixture needs a clear regression it protects.

| Scenario | Primary coverage |
| --- | --- |
| Basic settled turn | Session header, user/assistant messages, model, usage. |
| Thinking and streamed text | Provisional thinking/text rendering and finalization. |
| Sequential tools | Tool-call/result pairing and completed process grouping. |
| Significant write/edit | Prominent activity and structured edit rendering. |
| Tool error | Errors remain visible and form grouping boundaries. |
| Long output/history | Byte limits, pages, lazy disclosure, and rendering performance. |
| Branch selection | Explicit active leaf versus file-order fallback. |
| Compaction | Summary entries, usage, and unknown context occupancy. |
| Unknown entry | Safe forward-compatible projection without exposing raw payloads. |
| Partial tail and rewrite | Recovery from incomplete writes and JSONL replacement. |
| Prompt, steer, follow-up | Admission and Pi queue semantics. |
| Abort and settlement | `stopping` until abort confirmation and non-streaming reconciliation. |
| Extension attention | Unsupported/blocking UI request and typed response handling. |
| Process exit | Bounded stderr, pending-request failure, crash state, and restart path. |

One scenario may have both an RPC script and a resulting JSONL fixture when the
test needs to verify the reconciliation boundary.

## Sanitizing source sessions

Do not commit a personal Pi session unchanged. Do not rely on a regex-only
redactor either. Pi sessions can carry private data in user prompts, assistant
messages, tool arguments/results, paths, remotes, nested extension payloads,
images, base64 content, and session metadata.

Use existing sessions only as shape references. The committed fixture should be
synthetic in meaning and preserve only the structure required for its scenario.

The fixture import/sanitization process should:

1. Select a source session for a specific behavior, not because it is long or
   representative in general.
2. Preserve the record and content-block shapes needed by the test.
3. Consistently remap session IDs, entry IDs, parent IDs, tool-call IDs,
   timestamps, providers, models, and paths to deterministic fixture values.
4. Replace every free-text value with deliberately fake prompts, prose, code,
   commands, output, and errors. Preserve size categories where a limit or UI
   behavior depends on size.
5. Remove images, base64 data, URLs, credentials, environment values, remote
   repository details, local hostnames, and unneeded metadata. Replace an
   attachment only when the attachment shape itself is under test.
6. Manually review the final JSONL and RPC script before it enters the repo.
7. Run the repository secret scanner over the fixture directory and reject a
   fixture that contains a home path, real domain, token-like value, or source
   workspace identifier.

The sanitizer is a fixture-authoring tool, not a general promise that arbitrary
private transcripts can be safely published. It should default to replacing
content, not trying to retain it.

Hand-authored fake content is preferred after the original record shape has
been understood. This is safer, makes fixtures easier to read, and avoids
turning test data into an accidental transcript archive.

## RPC replay process

The proposed test executable behaves enough like `pi --mode rpc` to test
Passage's real subprocess and JSONL framing boundary:

1. It reads LF-delimited Pi command objects from stdin.
2. It validates the expected command type, required fields, and order for a
   named scenario.
3. It writes the scenario's recorded/sanitized stdout objects as LF-delimited
   JSON records, including correlated `response` records and asynchronous Pi
   events.
4. When the scenario calls for it, it writes the matching sanitized durable
   session fixture into the test session directory.
5. It can emit stderr or exit with a configured code for failure scenarios.

This preserves coverage of `PiRpcProcess` framing, response correlation,
bounded stderr, lifecycle handling, and event normalization. It must not bypass
those classes by directly calling their internal event handlers.

The runner should fail loudly when Passage sends an unrecorded command or when
the command order differs from the scenario. Loose matching would conceal
regressions in the Pi command contract.

## Time and replay rate

Automated tests should use a logical scenario clock rather than sleep for the
recorded wall-clock duration of a real session.

An RPC scenario can declare events relative to command admission or a logical
advance:

```ts
type ReplayStep =
  | { after: "command:get_state"; emit: PiRecord[] }
  | { after: "command:prompt"; emit: PiRecord[] }
  | { advanceMs: 50; emit: PiRecord[] };
```

Unit and integration tests advance this clock explicitly. They should not wait
for token pacing or arbitrary wall time.

Browser visual tests may use a capped wall-clock scheduler to make streaming
legible. Keep it separate from CI assertions, cap emissions at one batch per
animation frame, and use a modest default such as 10 to 20 event batches per
second. Small text deltas may be batched, but tool and lifecycle boundaries
must remain separate and ordered.

## Relationship to NullModel and live checks

Keep NullModel for a small acceptance suite that launches the real pinned Pi
executable. It should cover at least:

- prompt admission, streaming, settlement, and durable session creation;
- persistence and resume of the same session;
- a confirmed abort followed by `isStreaming: false` reconciliation;
- isolation between two Pi processes.

Most command/lifecycle permutations, renderer states, malformed input, and
history shapes should move to fixture-backed tests. NullModel is a compatibility
gate, not the source of every edge case.

Tests remain offline by default. Do not set `PASSAGE_PI_LIVE=real` or
`PASSAGE_PI_USE_REAL=1` without explicit permission in the current turn.

## Fixture maintenance

Fixtures are pinned compatibility artifacts. When upgrading the Pi CLI:

1. Run the remaining NullModel compatibility gate against the proposed version.
2. Capture only the changed record shapes needed for a failing or newly
   supported behavior.
3. Sanitize and review the new source material.
4. Update the manifest's Pi/version metadata and hashes.
5. Make expected semantic changes explicit in tests and release notes; do not
   silently re-record the corpus until tests pass.

Unknown records remain valuable. Keep at least one fixture with a future entry
type so the history reader and UI continue to preserve safe structure without
assuming they understand every later Pi record.

## Verification expectations

Fixture additions should run focused history/RPC tests first, then the normal
repository checks:

```sh
bun run typecheck
bun test
bun run test:gate
```

Changes to browser-facing timeline behavior also require `agent-browser`
verification at desktop size and below 640px when responsive behavior changes.

