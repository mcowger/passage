# Passage UI mocks

These ASCII mocks visualize the interaction rules in [UI.md](UI.md). They are
layout references, not pixel-perfect specifications. Labels in brackets are
interactive controls; `▸` is expandable; `●` carries a named state in the
accessible implementation.

## 1. Wide desktop — workspace opens on most recent agent

The active workspace restores its canvas and activates its most recent agent.
The inspector is available but remains closed until a file/diff is explicitly
opened or pinned.

```text
┌──────────────────────┬──────────────────────────────────────────────────────────────┐
│ Passage              │ payments / Retry-safe invoice import  feature/import-retries │
│ [+ New workspace]    │ Fast SSD · ↑1 ↓0 · 4 files changed       [+ New agent] [⋯]  │
│ [⌕ Search / commands]├──────────────────────────────────────────────────────────────┤
│                      │ [● Invoice retry implementation] [Terminal] [Changes]  [+]  │
│ PINNED               ├──────────────────────────────────────────────────────────────┤
│ ▾ Payments           │ ● Invoice retry implementation    GPT-5.6 · High · 48 tok/s │
│   ● Retry-safe       │                                                              │
│     feature/import   │  ┌────────────────────────────────────────────────────────┐  │
│     Fast SSD         │  │ Add retries to the invoice importer and run the suite. │  │
│     ↑1 ↓0 · +12 −4  │  └────────────────────────────────────────────────────────┘  │
│     2 agents · 1 T  │                                                              │
│     ├ ● Invoice     │  GPT-5.6 · 18.4s · 1.2k in / 680 out · 48 tok/s · $0.02      │
│     └ ◌ Terminal 1  │                                                              │
│   ◌ Main             │  I added bounded retries around the transient response...   │
│     main · +0 −0    │                                                              │
│   ● Reconcile taxes │  [Thinking · 8s                                        ▸]     │
│     fix/tax-sync     │  [Read    src/server/invoice.ts          success · 0.2s ▸]    │
│     +6 −1 · 1 run   │  [Searched "importInvoice" in src        success · 0.1s ▸]    │
│                      │  [Edited  src/server/invoice.ts          +18 −4 · 0.4s ▸]    │
│ RECENT               │  [Ran     bun test invoice                failed · 24s ▸]    │
│ ▸ Commerce           │                                                              │
│ ▸ Docs               │  [Changed: invoice.ts, invoice.test.ts]       [Copy] 2m ago │
│                      │                                                              │
│ ──────────────────── │ ──────────────────────────────────────────────────────────── │
│ LAN · connected      │ Message the agent, @ files, or / commands                    │
│ [Settings]           │ [GPT-5.6 ▾] [High ▾] [Steer now ▾]             [Attach] [↗]  │
└──────────────────────┴──────────────────────────────────────────────────────────────┘
```

Notes:

- The rich row remains a compact operational summary; only the active
  workspace exposes its agent and terminal children by default.
- User intent is a subdued card. Assistant prose is document-like rather than
  another oversized bubble.
- Detailed mode is active: every tool is a compact, readable row.
- The composer makes its model, thinking level, and current send behavior
  explicit. While a run is active, `Steer now` and `Queue follow-up` are
  distinct choices.

## 2. Wide desktop — contextual inspector opens for a diff

Clicking `Edited src/server/invoice.ts` first reveals a small inline preview.
Choosing `Open diff` reuses the current workspace's right inspector.

```text
┌──────────────────────┬──────────────────────────────────────────┬──────────────────┐
│ ▾ Payments           │ [● Invoice retry implementation]          │ [invoice.ts ×]   │
│   ● Retry-safe       ├──────────────────────────────────────────┤ [invoice.test ×] │
│     ├ ● Invoice      │ GPT-5.6 · idle · 1.9k tok · $0.03    [⋯] │──────────────────│
│     └ ◌ Terminal 1  │                                          │ invoice.ts  Diff │
│                      │  Added bounded retry handling.           │ + import retry   │
│   ◌ Main             │                                          │                  │
│                      │  [Edited src/server/invoice.ts            │ @@ importInvoice │
│                      │    +18 −4 · 0.4s]                        │  41  const ...   │
│                      │  ┌────────────────────────────────────┐  │-  return fetch() │
│                      │  │ + retry(async () => fetch(...))     │  │+  return retry(  │
│                      │  │ - return fetch(...)                 │  │+    () => fetch( │
│                      │  │                    [Open diff ↗]    │  │+    { attempts }) │
│                      │  └────────────────────────────────────┘  │                  │
│                      │                                          │ [Source] [Diff]  │
│                      │                                          │ [Mention lines]  │
│                      │                                          │ [Move to canvas] │
│                      │                                          │                  │
│                      │                                          │ +18 −4 · live   │
└──────────────────────┴──────────────────────────────────────────┴──────────────────┘
```

- The inspector is for file and diff artifacts, not a second general-purpose
  agent canvas.
- It has its own workspace-local tabs and width. Switching workspaces never
  makes this worktree's files appear in another worktree.
- `Move to canvas` promotes the file to a focused editor panel. Agents and
  terminals open in the main canvas instead.

## 3. Detailed and Concise agent trace modes

The per-agent toggle changes presentation only; Pi history and individual tool
boundaries are unaffected. Expansion choices are remembered for this agent
session, not applied globally.

```text
DETAILED (default)                         CONCISE
───────────────────────────────────────    ───────────────────────────────────────
[Thinking · 8s                     ▸]      [Thinking · 8s                    ▸]
[Read invoice.ts          0.2s     ▸]      [Process · explored 4 files,
[Searched "retry"        0.1s     ▸]         edited 2 files, ran 1 command
[Read errors.ts           0.1s     ▸]         24.8s                         ▸]
[Edited invoice.ts  +18 −4 0.4s   ▸]
[Edited invoice.test.ts +9 0.2s   ▸]         [Ran bun test · failed 24s      ▸]
[Ran bun test · failed   24s      ▸]         ^ significant failure remains visible

[Detailed ▾]                                  [Concise ▾]
```

`Thinking`, an edit summary, attention/permission request, failure, and a
significant image/artifact result establish a process-group boundary. Concise
mode never hides an error inside an anonymous summary.

## 4. Tool row expansion and artifact escalation

Every closed tool row exposes a semantic action, target, status, and duration—
never raw JSON. Tool-specific renderers add an appropriate preview; unknown
tools use the same generic shape.

```text
Closed row
┌─────────────────────────────────────────────────────────────────────────────┐
│ ✎ Edited  src/server/invoice.ts                           +18 −4 · 0.4s  ▸ │
└─────────────────────────────────────────────────────────────────────────────┘

Expanded row: bounded inline preview
┌─────────────────────────────────────────────────────────────────────────────┐
│ ✎ Edited  src/server/invoice.ts                           +18 −4 · 0.4s  ▾ │
├─────────────────────────────────────────────────────────────────────────────┤
│ Input: replace the direct request with bounded retry                         │
│                                                                             │
│  58 - return fetchInvoice(request)                                          │
│  58 + return retry(() => fetchInvoice(request), { attempts: 3 })            │
│                                                                             │
│                                      [Open diff] [Open file]                │
└─────────────────────────────────────────────────────────────────────────────┘

Large/interactable artifact
┌─────────────────────────────────────────────────────────────────────────────┐
│ ▸ Ran  bun test --watch                                    running · 1m 42s │
│    Live terminal output opens in a terminal panel.              [Open ↗]    │
└─────────────────────────────────────────────────────────────────────────────┘
```

Short excerpts and bounded diffs remain inline. Large files/diffs, editor work,
and every live interactive terminal escalate to a dedicated surface.

## 5. Dragging a pane into a split

Pane manipulation is direct: a tab is dragged, valid edge targets appear, and a
preview is shown before drop. No persistent split buttons crowd every header.
Context menus and keyboard shortcuts provide the same operations without drag.

```text
Before drag
┌─────────────────────────────────────────────────────────────────────────────┐
│ [● Agent: Invoice retry ×] [Terminal 1 ×] [+]                                │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                             │
│                         Agent timeline                                      │
│                                                                             │
└─────────────────────────────────────────────────────────────────────────────┘

Dragging [Terminal 1] over the right edge
┌─────────────────────────────────────────────────────────────────────────────┐
│ [● Agent: Invoice retry ×]                                        [dragged] │
├──────────────────────────────────────────────────────┬──────────────────────┤
│                                                      │ ┌──────────────────┐ │
│                    Agent timeline                    │ │ Drop terminal    │ │
│                                                      │ │ to split right   │ │
│                                                      │ └──────────────────┘ │
└──────────────────────────────────────────────────────┴──────────────────────┘

After drop
┌──────────────────────────────────────┬──────────────────────────────────────┐
│ [● Agent: Invoice retry ×]            │ [Terminal 1 ×]                        │
├──────────────────────────────────────┼──────────────────────────────────────┤
│                                      │ $ bun test                             │
│ Agent timeline                       │ ✓ 42 tests passed                      │
│                                      │ $ _                                    │
└──────────────────────────────────────┴──────────────────────────────────────┘
```

## 6. Compact desktop / tablet — inspector is an overlay

At widths where a pinned inspector would make the active canvas unusably narrow,
the inspector slides over the right side. The workspace remains visible behind a
restrained backdrop and resumes unchanged when the inspector closes.

```text
┌───────────────────────┬─────────────────────────────────────────────────────┐
│ ▾ Payments            │ payments / Retry-safe import                  [⋯]    │
│   ● Retry-safe        ├─────────────────────────────────────────────────────┤
│     ├ ● Invoice       │ [Agent: Invoice retry]                               │
│     └ ◌ Terminal 1   │                                                       │
│   ◌ Main              │ Assistant response and compact tool trace            │
│                       │                                                       │
│                       │ ─────────────────────────────────────────────────── │
│                       │ Message the agent... [Model ▾] [Think ▾] [Send ▾]   │
└───────────────────────┴─────────────────────────────────────────────────────┘
                                      ╲ dimmed canvas ╱
                           ┌──────────────────────────────────┐
                           │ [invoice.ts ×] [test.ts ×]   [×] │
                           ├──────────────────────────────────┤
                           │ invoice.ts · Diff                │
                           │                                  │
                           │ @@ retry behavior                │
                           │ + return retry(...)              │
                           │                                  │
                           │ [Source] [Diff] [Move to canvas] │
                           └──────────────────────────────────┘
```

## 7. Mobile — chat-first with workspace drawer

The selected agent is the home destination. The explicit navigation control
opens a left drawer; it does not use a global edge swipe that would conflict
with terminals, code, or diff gestures.

```text
Normal mobile chat
┌──────────────────────────────────────┐
│ [☰] Retry-safe invoice import   [⋯]  │
├──────────────────────────────────────┤
│ ● Invoice retry · GPT-5.6 · 48 tok/s │
│                                      │
│ ┌──────────────────────────────────┐ │
│ │ Add retries and run the suite.   │ │
│ └──────────────────────────────────┘ │
│                                      │
│ I added bounded retries...            │
│                                      │
│ [Thinking · 8s                   ▸]  │
│ [Edited invoice.ts   +18 −4 · 0.4s ▸]│
│ [Ran bun test        failed · 24s  ▸]│
│                                      │
├──────────────────────────────────────┤
│ Message the agent...                 │
│ [GPT-5.6] [Steer now ▾]       [Send] │
└──────────────────────────────────────┘

Workspace drawer after [☰]
┌───────────────────────┬──────────────────────────────────────┐
│ Passage           [×] │ dimmed selected agent                 │
│ [+ New workspace]     │                                      │
│ [⌕ Search]             │                                      │
│                       │                                      │
│ ▾ Payments             │                                      │
│   ● Retry-safe         │                                      │
│     feature/import     │                                      │
│     Fast SSD · +12 −4 │                                      │
│     2 agents · 1 T    │                                      │
│   ◌ Main               │                                      │
│     main · clean       │                                      │
│                       │                                      │
│ ▸ Commerce             │                                      │
│                       │                                      │
│ [Settings]             │                                      │
└───────────────────────┴──────────────────────────────────────┘
```

On constrained keyboard height, the message field and current send behavior
remain visible. Model/thinking selection moves to a compact row or full-screen
sheet instead of covering the conversation.

## 8. Mobile — full-screen artifact destinations

Artifacts opened from chat use an immersive destination with an explicit return
path. Agent state and composer are retained underneath.

```text
Diff from chat
┌──────────────────────────────────────┐
│ [‹ Back to Invoice retry]       [⋯] │
├──────────────────────────────────────┤
│ invoice.ts · feature/import           │
│ [Source] [Diff]                       │
├──────────────────────────────────────┤
│ @@ importInvoice                      │
│  58 - return fetchInvoice(request)    │
│  58 + return retry(                   │
│  59 +   () => fetchInvoice(request),  │
│  60 +   { attempts: 3 },              │
│  61 + )                               │
│                                      │
│ [Mention lines] [Open editor]         │
└──────────────────────────────────────┘

Interactive terminal from chat
┌──────────────────────────────────────┐
│ [‹ Back to Invoice retry] Terminal 1 │
├──────────────────────────────────────┤
│ $ bun test                            │
│ ✓ invoice retries                     │
│ ✓ rejected requests                   │
│                                      │
│ $ _                                    │
│                                      │
│                                      │
├──────────────────────────────────────┤
│ [Ctrl] [Alt] [Esc] [Tab] [↑] [↓] [←] │
│ Size: This device controls terminal  │
└──────────────────────────────────────┘
```

If a desktop browser currently owns the terminal size lease, the mobile footer
instead says `Desktop controls terminal size` and offers `[Take control]`.

## 9. Workspace overview — no agents yet

A brand-new workspace does not open to an empty chat transcript. It provides
the minimum context and direct next actions.

```text
┌──────────────────────────────────────────────────────────────────────────────┐
│ commerce / Retry-safe invoice import  feature/import-retries  Fast SSD   [⋯] │
├──────────────────────────────────────────────────────────────────────────────┤
│                                                                              │
│  Retry-safe invoice import                                                    │
│  Worktree · feature/import-retries · clean · created just now                │
│                                                                              │
│  No agents or terminals are running here.                                    │
│                                                                              │
│  [ + Start an agent ]     [ > Open a terminal ]     [ View files ]           │
│                                                                              │
│  Recent changes                                                               │
│  No working-tree changes                                                      │
│                                                                              │
└──────────────────────────────────────────────────────────────────────────────┘
```

## 10. State legend

| Marker | Meaning | Typical treatment |
| --- | --- | --- |
| `●` | Running / active | Named icon plus teal/cyan or activity treatment. |
| `◌` | Idle / quiet | Muted named icon. |
| `!` | Needs attention | Violet/attention treatment, readable label, toast target. |
| `×` | Error or failed result | Red/danger treatment, readable label, never hidden in Concise mode. |
| `✓` | Successful completed action | Green/success treatment, restrained in normal rows. |
| `▸` / `▾` | Expand / collapse | Disclosure controls for thinking, tool details, and process groups. |

No marker relies on color alone. Tooltips supplement accessible names and visible
text where space permits.
