# Passage Composer Autocomplete

Authority: `docs/DESIGN.md` (architecture) > `docs/UI.md` (interaction) >
`PI.md` (Pi RPC boundary) > `docs/WS.md` (protocol review standard).
If this document conflicts with DESIGN.md, DESIGN.md wins and this document
MUST be fixed.

Status: implemented (`@` files + `/` commands, popover everywhere including
mobile). Browsing/opening a workspace never executes project-controlled
resources; all workspaces are treated as untrusted until an explicit
persisted workspace-trust decision exists, so only Pi built-ins are listed.

Note: `/compact` (action kind) is served by a new typed
`POST /api/agents/:id/compact` route that maps to the existing typed Pi
`compact` RPC call via `PiRpcManager` after explicit confirmation. It accepts
no raw Pi JSON, consistent with the allowlist-only constraint.

## 1. Scope

- **`@` — workspace files only.** No agent-session mentions. `listAgents`
  is not used here.
- **`/` — Pi built-in commands and skills, invokable anywhere in the draft.**
  Not line-start only. `Esc` dismisses.
- **Out of scope:** `!` shell escape (deferred for reconsideration), `#`
  snippets (removed — Pi has no such concept, do not build).

Current state: `AgentComposerInner` (`src/web/components/AgentPanel.tsx`)
is a plain `<textarea>` whose placeholder advertises behavior that does not
exist yet. This plan fills the `@` + `/` gap without violating invariants.

Consequential cleanup: update the composer placeholder from
`"@ for files/agents; / for commands and skills; ! for shell; # for snippets"`
to `"@ for files; / for commands"` (or equivalent) so advertised behavior
matches built behavior.

## 2. Shared UX contract (both triggers)

- **Trigger rule:** `@` or `/` fires at start-of-line or after whitespace,
  with a bounded query token (`[^\s]{0,64}`). Fires **anywhere in the draft**
  for both triggers. `Esc` dismisses and restores the pre-trigger caret;
  retyping re-opens. Typing a space after an empty trigger shows the
  unfiltered list (recent files / all commands).
- **Presentation — popover everywhere, including mobile:** one
  `ComposerAutocomplete` popover anchored above the composer caret (or
  composer card edge if caret anchoring is costly). Fixed max-height (~8
  visible rows), internally scrollable, virtualized past ~50 rows. **No
  full-screen sheet on `<640px`.** On mobile the popover stays a popover:
  same anchor, same scroll, sized within `visualViewport` + safe-area insets
  so the software keyboard cannot cover it or the composer.
- **Component reuse:** build on existing shadcn `popover` + `command`
  primitives (no hand-rolled focus trap / portal / outside-click / keyboard
  nav, per `AGENTS.md`). Reuse `FileTypeIcon` and `ToolRow`-style mono
  target grammar.
- **Keyboard/a11y:** `Up/Down` + `Tab/Enter` to accept, `Esc` to dismiss;
  `role="listbox"` + `aria-activedescendant`; `:focus-visible` ring;
  toolbar icon-button alternative to open `@`/`/` browsing for touch and
  keyboard-only users.
- **Layout stability:** popover is absolutely positioned, reserves no space
  when closed; timeline streaming never shifts it. Draft autosave
  (`passage:agent:{id}:draft`) stores raw text with trigger token, not popup
  state. Failed send retains inserted refs.

## 3. `@` — file mentions

- **Popup content:** single `Files` section: file-type icon +
  workspace-relative path + truncated directory hint. No `Agents` section.
- **File ref syntax (decided):** backticked `` @`relative/path.ts` ``,
  rendered in timeline/user card with file-type icon + mono path treatment.
  Composer shows raw backticked text; rendering happens at display time.
- **Data source (new bounded HTTP):**
  `GET /api/workspaces/:id/files/search?q=&limit=` (default 20, max 50).
  - Daemon resolves from the registered canonical root, realpath-checks,
    rejects traversal/symlink escapes (existing filesystem boundary).
    Case-insensitive substring/prefix match over a bounded walk; debounced
    ~150ms, cancelled on keystroke. Client falls back to filtering the last
    `ExplorerPanel` listing when slow/offline — never blocks typing.
  - Zod `.strict()` schema in `src/shared/protocol/workspace.ts`; reuse
    `MAX_FILE_PATH_LENGTH`; relative paths only; under the 48KB
    `MAX_PROTOCOL_PAYLOAD_BYTES` cap.
- **Insertion:** replace `@query` with `` @`relative/path` `` + trailing
  space, caret after the space. If the file is renamed/deleted later, the
  sent prompt keeps the literal text (no live link maintenance).
- **Rendering:** user-message card and any echo of the prompt renders
  `` @`path` `` as an inline chip: file-type icon + mono path. Unknown/long
  paths truncate middle-out, preserving suffix.
- **No WS work:** HTTP snapshots only; existing `files-changed`
  invalidation keeps the explorer fresh. Reads emit nothing.

## 4. `/` — slash commands and skills

- **Constraint from `PI.md`:** allowlist only. No raw browser-to-Pi JSON, no
  competing agent vocabulary, no skills/MCP orchestration UI. Passage exposes
  only intentionally supported Pi-native commands for the pinned Pi CLI.
- **Invocation anywhere:** `/` + query token is detected at any caret
  position (start, middle, end of draft). Accepting a command inserts its
  template **at the caret** (replacing `/query`), preserving surrounding
  text, e.g. `please check this /compact and then continue` →
  `please check this /compact  and then continue`. `Esc` dismisses without
  touching the draft.
- **Data source:** extend `AgentCapabilities` (or add
  `GET /api/agents/:id/commands`) with
  `slashCommands: [{ name, description, hint, kind }]`, built daemon-side
  from the pinned Pi version's verified set. Kinds: `prompt-text` (inserts
  `/name …` template into the draft) vs `action` (e.g. compact — routes
  through the existing typed `api.*` path with confirmation, never raw Pi
  JSON).
- **Skills gating (trust policy):** skill-backed entries appear only in
  explicitly trusted workspaces; untrusted workspaces show Pi built-ins only
  plus a one-line footer
  (`skills unavailable — untrusted workspace`). Browsing/opening a workspace
  never executes project-controlled resources.
- **Unknown input:** `/unknown-command` typed and sent without selection
  stays plain prompt text; daemon validates on `prompt`/`steer`/`followUp`
  admission. No client-side command execution.

## 5. Changes by area

| Area | Change |
| --- | --- |
| `src/shared/protocol/` | `files-search` request/response schemas (`.strict()`, bounded, relative paths); `slashCommands` capability schema |
| `src/daemon/http/files.ts` | New `files/search` route: canonical-root resolve, bounded match, caps; reads emit nothing |
| `src/daemon/agents/*` | Pinned-version `/` allowlist + trust gate; map `action` kinds to existing typed Pi RPC calls via `PiRpcManager` |
| `src/web/components/` | `ComposerAutocomplete.tsx` + `useComposerTrigger.ts` (anywhere-position token parser, debounced search, keyboard controller); file-ref chip renderer in user-message card |
| `src/web/api.ts` | `searchFiles()`, slash-command source (via `capabilities()` or new getter) |
| `src/web/styles.css` | Popover/scroll tokens only; reuse theme vars; no new color semantics |

Explicitly **not** built: `!` handling, `#` storage/CRUD/placeholders,
agent mentions, full-screen mobile sheet, user-definable `/` commands, any
new socket/transport/envelope.

## 6. Security & limits

- Relative paths + opaque IDs only; absolute paths rejected both ends.
- Traversal/symlink-escape tests for `files/search` (mirror existing
  boundary tests).
- 48KB payload / 64KB command caps intact; query `≤64 chars`, results
  `≤50`, backticked ref length bounded by `MAX_FILE_PATH_LENGTH`.
- No new execution endpoint; `/` actions reuse existing typed routes;
  `prompt` admission semantics unchanged (accepted ≠ completed).
- `Host`/`Origin` validation unchanged.

## 7. Verification

- Unit (`bun test`): anywhere-position tokenizer (mid-draft `@`/`/`,
  email/code-fence false positives, multi-byte caret), insertion +
  caret-restore with surrounding text, `Esc` no-op, schema bounds,
  trust-gated command filter.
- Daemon: temp-repo search (spaces, renames, symlink escape, 1000-entry
  cap), pinned-version allowlist fixture.
- Browser (`agent-browser`, required): desktop + `<640px` with software
  keyboard — popover stays anchored, scrollable, never covers composer;
  keyboard-only accept/dismiss; loading/error/reconnect states.
- Gates: `bun run typecheck`, `bun test`, focused integration; full
  `bun run test:gate` before merge. NullModel only unless explicit per-turn
  live permission.

## 8. Delivery order

1. `@` files: trigger infra + `files/search` + scrollable popover +
   backticked insert + chip render + placeholder update.
2. `/` anywhere: Pi-version spike → allowlist → capabilities wiring →
   caret-position insert + trust footer.
3. Polish: mobile-keyboard anchoring, virtualization/perf budgets (first
   suggestion <150ms local, <400ms searched), a11y audit, help text.

## 9. WS review checklist (for the implementing PR)

- [ ] Invalidation-only payload (no content/listings/status/diffs on wire)?
- [ ] Zod `.strict()` schema in `src/shared/protocol/`, bounded, opaque IDs?
- [ ] Emit-after-commit; reads/failures emit nothing; emit never throws?
- [ ] Replay-then-live + `snapshot-required` with working `snapshotUrl` (if WS touched at all — expected: not touched)?
- [ ] Caps intact (subscriptions, subjects, listeners, bytes)?
- [ ] Client: debounced targeted refetch + full reconcile on gap/close/suspend?
- [ ] Tests: hub unit (replay/eviction/dispose) + route emit/no-emit + client parse (`workspaceSocket.test.ts` pattern)?
- [ ] Two-client `agent-browser` check (mutate in A, observe B without reload; kill/reconnect/suspend reconciles; loading/error states)?
- [ ] No new socket, transport, envelope, or state library?
