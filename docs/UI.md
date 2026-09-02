# Passage UI specification

## Status and scope

This is the UI and interaction specification for Passage. It refines the
product architecture in [DESIGN.md](DESIGN.md); that document remains
authoritative for runtime, persistence, security, and implementation phases.

The target is a light, precise, technical coding workspace: calm enough to
read an agent response, dense enough to operate many workspaces, and flexible
enough for agents, terminals, files, editors, and diffs to be peer surfaces.

## Visual references investigated

The following were inspected for layout and interaction evidence. They are
references, not UI assets to copy.

| Product | Reference | What Passage takes from it |
| --- | --- | --- |
| Paseo | `../paseo/packages/website/public/homepage-hero.png` | Workspace-first desktop composition; rich project/workspace rail; agent and diff side by side. |
| Paseo | `../paseo/packages/website/public/mobile-mockup.png` | Full-featured mobile changes and terminal surfaces. |
| Paseo | `../paseo/docs/design.md` | Quiet chrome, deliberate whitespace, semantic color, and desktop/compact versions of the same product. |
| Paseo | `../paseo/docs/explorer-sidebar.md` | Explorer dock, retained panels, workspace-local pane placement. |
| Pi-Web | `../pi-web/docs/screenshot2.png` | Readable hybrid chat, compact thinking/tool cards, persistent composer, file explorer and inspector. |
| Pi-Web | `../pi-web/components/MessageView.tsx` | Tool call/result pairing, thinking disclosure, embedded diffs, and outcome-focused transcript rendering. |
| Pi-Web | `../pi-web/components/AppShell.tsx` | Responsive shell, resizable inspector, and chat-first mobile substitutions. |
| OpenChamber | Live instance study; see [OPENCHAMBER_UI_ANALYSIS.md](OPENCHAMBER_UI_ANALYSIS.md) and `screenshots/` | Uniform compact rows with in-place expansion, tone-based quiet cards, status badges paired with text, header context ring, right-rail panel surfaces. |

## Decided UI direction

| Area | Decision |
| --- | --- |
| Visual personality | Light, precise, technical. Flat cool-neutral surfaces, hairline borders, teal/cyan interaction accent, and semantic status colors. |
| Typography | Clean sans serif for UI and prose; technical monospace for code, paths, tools, metrics, and terminal content. |
| Theme behavior | One selected theme controls UI, editor, diff, and terminal by default; workspace-local editor, diff, and terminal overrides are optional and retain the selected theme's semantic roles. |
| Workspace entry | Restore the workspace canvas, activating its most recent agent when one exists; otherwise show the workspace overview. |
| New-workspace layout | Persistent rich sidebar; central overview or newly created agent; an available but initially closed contextual inspector. |
| Desktop header | One compact contextual workspace bar. |
| Sidebar | Rich operational project/workspace rows. Only the active workspace exposes child agent/terminal rows by default. |
| Agent transcript | Hybrid: subtle user card, document-like assistant response, compact thinking/tool trace. |
| Tool density | Detailed is the per-agent default: every tool is a compact row. A session-local Concise mode groups sequential activity. |
| Tool row | Semantic icon, friendly verb, one-line target, outcome, and duration before expansion. |
| Statistics | Compact header on each assistant turn; agent header adds live model/status summary. |
| Artifacts | Inline concise previews first; large/interactable artifacts open in a dedicated panel. |
| Inspector | One reusable, right-side file/diff inspector with a restored tab set per workspace. |
| Pane manipulation | Drag tabs to reorder, move, or split. Context menu and keyboard shortcuts provide accessible alternatives without permanent split buttons. |
| Background activity | Badge and toast; no agent steals focus. |
| Mobile | Chat first. Workspace navigation opens in a drawer; files, diffs, editors, and terminals open full-screen with Back to chat. |

## Design principles

1. **The workspace is the durable context.** A conversation is important but is
   one workspace surface, alongside a terminal, editor, and diff.
2. **The current task remains legible.** Assistant prose, final answers, user
   intent, and changed outcomes have more visual weight than process detail.
3. **Operational detail is nearby, not noisy.** Rich sidebar metadata and
   inline statistics support fast scanning without turning every pane into a
   dashboard.
4. **Dense content gets progressive disclosure.** Thinking, tool arguments,
   output, large diffs, logs, and raw JSON are available but never the default
   reading path.
5. **State must not cause layout jitter.** Loading, status changes, counters,
   and streamed output reserve their space or update in place.
6. **Mobile is a focused control surface.** It exposes all core capabilities in
   full-screen destinations rather than squeezing a desktop split layout onto a
   phone.
7. **Color is semantic, not decoration.** Teal/cyan identifies interaction;
   green, amber, red, and violet communicate known state categories and are
   always reinforced by text/iconography.
8. **Direct manipulation is primary.** Dragging communicates where a pane will
   go. Context menus and shortcuts ensure it is not the only possible input.

## Visual foundation

### Color tokens

The values below are the initial light theme, not component-specific colors.
Every value is exposed as a semantic CSS custom property and may be replaced by
a validated theme pack. Contrast is tested at WCAG AA or better for text and
interactive controls.

```text
--background:          #f8fafc  /* application canvas */
--surface:             #ffffff  /* pane and input surface */
--surface-subtle:      #f1f5f9  /* sidebar sections, inactive tab */
--surface-hover:       #e8f0f3
--surface-selected:    #d9eeed
--border:              #d4dde3
--border-strong:       #b8c6ce
--foreground:          #16232d
--foreground-muted:    #5f707c
--foreground-subtle:   #82919b

--accent:              #0f766e  /* primary action / selected interactive */
--accent-hover:        #115e59
--accent-subtle:       #ccfbf1
--focus-ring:          #0891b2

--success:             #15803d
--success-subtle:      #ecfdf3
--warning:             #b45309
--warning-subtle:      #fffbeb
--danger:              #b91c1c
--danger-subtle:       #fef2f2
--attention:           #7c3aed
--attention-subtle:    #f5f3ff

--diff-add:            #166534
--diff-add-subtle:     #dcfce7
--diff-remove:         #991b1b
--diff-remove-subtle:  #fee2e2
--diff-hunk:           #0e7490
--diff-hunk-subtle:    #e0f2fe
```

The dark theme preserves these semantic roles rather than inverting raw
components. Its near-black surfaces and high-contrast teal/cyan accent should
feel like the same product, not a separate design.

### Typography

Bundle local variable fonts for the defaults, with system fallbacks. Theme/font
packs can replace them as described in `DESIGN.md`.

| Role | Default | Size and behavior |
| --- | --- | --- |
| UI and prose | Bundled variable sans-serif font, system sans-serif fallback | 14px interface base; 15px assistant prose; 1.6–1.7 line height for long text. |
| Technical mono | Bundled variable monospace font, system monospace fallback | 12–13px tools, paths, metadata, diff, editor, and terminal. |
| Compact metadata | Technical mono or UI sans where scanning wins | 11–12px; muted but never below readable contrast. |
| Pane/workspace title | UI sans | 13–14px medium weight; avoid large heading hierarchies in working surfaces. |

Use weight, contrast, and spacing for hierarchy. Large type is reserved for an
empty workspace or destructive confirmation, never routine chat chrome.

### Shape, borders, and motion

The following are initial usability-tested defaults, not immutable product
requirements.

- Use 1px borders to delineate panes, rows, cards, inputs, and code regions.
- Use 4px radius for compact controls/tool rows and 6px for larger panes,
  dialogs, and user message cards.
- Avoid shadows on normal desktop panes. Drawers, dialogs, drag previews, and
  medium-width overlays may use one restrained elevation shadow.
- Avoid nested card outlines. A grouped surface has one outer border; its rows
  use dividers only when scanning benefits.
- Use 120–180ms opacity/transform transitions. Do not animate streamed content,
  pane dimensions during status updates, or terminal text.
- Respect `prefers-reduced-motion`; disable motion that conveys no state change.

## Application shell

### Desktop breakpoints

The following breakpoints and dimensions are initial usability-tested defaults,
not fixed product requirements.

| Viewport | Shell behavior |
| --- | --- |
| `>= 1280px` | Pinned sidebar and, when opened, resizable right inspector. Main canvas is always visible. |
| `960–1279px` | Pinned/collapsible sidebar. Inspector opens as a right overlay by default, preserving usable primary-pane width. A user may explicitly create canvas splits. |
| `640–959px` | Tablet compact mode. Sidebar is an overlay drawer; one primary canvas panel is visible; files/diffs use full-height overlay. |
| `< 640px` | Mobile chat-first mode. Navigation is a drawer; non-agent artifacts are full-screen destinations. |

### Desktop geometry

```text
┌──────── sidebar ────────┬──────────── workspace ────────────┬─ inspector ─┐
│ Passage / project switch │ [project / workspace / status]     │ [file tabs] │
│ New workspace            │ ─────────────────────────────────  │ [diff/file] │
│ Search / command palette │ [agent | terminal | editor panes]  │             │
│                           │                                    │             │
│ Project tree             │                                    │             │
│  Workspace rows          │                                    │             │
│   └ active child rows    │                                    │             │
└──────────────────────────┴────────────────────────────────────┴─────────────┘
```

- Sidebar default: 320px; minimum: 272px; maximum: 420px.
- Inspector default: 420px; minimum: 340px; maximum: 50% of viewport width.
- Workspace header: 44px high, one bottom border, no second global toolbar.
- Pane tab strip: 36px high. It is the sole persistent pane chrome apart from
  resource-specific controls.
- Sidebars and inspector widths persist independently per workspace where
  relevant. The inspector tab set is always workspace-specific.

### Contextual workspace header

The header identifies the context before it presents actions:

```text
[project breadcrumb] / [workspace label] [branch/ref] [location] [Git state]
                                                      [New agent] [New terminal] [⋯]
```

- Workspace label is the primary header text; branch/ref is compact monospace
  metadata and opens the workspace/worktree details.
- Git state includes readable text/icon status plus changed-file summary. It
  does not rely on red/green alone.
- `New agent` is the primary teal action. `New terminal` is a secondary action.
- The overflow menu contains archive/remove, worktree operations, workspace
  settings, external-editor/file-manager handoffs, and inspector controls.
- On narrower desktop widths, location and non-critical Git data move to the
  overflow/detail popover before core identity or actions are truncated.

### Workspace selection and restoration

Selecting a workspace restores its saved split-tree and activates its most
recent non-archived agent whenever one exists, adding or opening its panel when
necessary. If no agent exists, select the workspace overview. Restore inspector
tabs only for the selected workspace. This preserves spatial memory without
making an old file tab obscure the task at hand.

A newly created workspace opens with:

1. the rich sidebar focused on the new workspace;
2. the workspace overview as the central panel;
3. an initially closed but available inspector;
4. an empty-state action to create an agent or terminal.

Creating the first agent replaces the overview's primary focus with that agent
while retaining the overview as a reopenable panel.

## Sidebar and navigation

### Structure

```text
Passage
├── New workspace
├── Search / Command palette
├── Pinned / recent projects
│   └── Project
│       ├── Workspace
│       │   ├── Agent          ← children only for active workspace
│       │   └── Terminal
│       └── Quiet workspace    ← metadata summary, child rows collapsed
└── Footer: connection state · settings
```

Projects are the top-level grouping. Workspaces remain visible within their
project even when quiet; agent and terminal child rows are visible by default
only under the active workspace. A workspace with attention can use an icon,
badge, and toast target without automatically expanding or stealing focus.

### Rich workspace row

Each workspace row is a compact operations summary, normally two to three
lines, not a decorative card:

```text
● Retry-safe invoice import                                      [⋯]
  feature/invoice-import-retries · Fast SSD · ↑1 ↓0 · +12 −4
  2 agents (1 running) · 1 terminal · GPT-5.6 · 2m ago
```

- Line one: status icon/dot, human workspace label, and overflow actions.
- Line two: branch/ref, named worktree location, ahead/behind, and change
  statistics. Omit unavailable fields without changing the row's left anchors.
- Line three: agent/terminal activity, active model when relevant, and last
  activity time.
- Status uses icon, visible text where space permits, and an accessible
  name/description exposed to assistive technology. Tooltips are supplementary
  only. Tiny dots reserve their own fixed-width slot so rows do not jitter as
  state changes.
- Long values truncate in the middle or left according to meaning: preserve a
  branch suffix and trailing path segments; preserve workspace-label prefix.

The rich row is intentionally more information-dense than an agent timeline.
Users scan it to decide *where to work*, not to read an explanation.

### Active child rows

An expanded active workspace lists agents and terminals below its workspace
row. Each child gives its title/name, state, model or shell context where useful,
and last activity. An attention badge is readable and targetable. Selecting a
child focuses its existing panel or opens one in the main canvas; it never
destroys an existing panel arrangement.

Project and workspace context menus cover low-frequency operations. On touch,
the same menu is available through a visible overflow button rather than a
long-press-only gesture.

### Background activity

When a non-focused agent completes, fails, or needs user input:

1. update its sidebar status and parent workspace counters;
2. show a short, dismissible toast with agent title and action (`Open`);
3. issue a browser notification only if the user opted in and the app is not
   visible;
4. never change focus, move panes, or change the selected workspace.

## Workspace canvas and inspector

### Main canvas

The main canvas hosts the serialized split tree from `DESIGN.md`. It contains
agent, terminal, editor, diff, explorer, changes, and overview panels. Its
default is not a permanently dense three-column layout: right-side inspection
is contextual, and the canvas remains generous when the user is reading or
steering an agent.

Every canvas tab shows resource icon, title, relevant status, unsaved/changed
marker where appropriate, and close control. Pane splitting/moving is primarily
direct manipulation:

- Drag a tab over a tab strip to reorder or combine it.
- Drag over an edge to reveal directional split targets and a live drop preview.
- Drop only after a valid target is visually clear; invalid zones never look
  accepting.
- Do not show permanent split/right/down buttons in every pane header.
- Right-click/long-press context menus and documented keyboard commands expose
  `Move`, `Split right`, `Split down`, `Move to inspector`, `Close`, and `Reset
  workspace layout` for keyboard and assistive-technology users.

Closing a tab removes a view, not the underlying agent, terminal, workspace, or
file. A terminal can be closed only through its own terminal action; an agent
is archived only through an explicit lifecycle action.

### Contextual right inspector

The inspector is a reusable right split for file and diff inspection. It is
closed until a user explicitly opens a panel-level artifact or pins it. Opening
a new artifact reuses the inspector and opens a tab rather than continually
creating new canvas splits.

- Each workspace stores an independent inspector width and file/diff tab set.
- Switching workspace hides the prior inspector's resources; it never presents
  a path from one worktree as though it belongs to another.
- File source, Markdown preview, image preview, and diff are inspector-native.
- A file can be moved from the inspector to the main canvas for focused editing.
- Agents and terminals open in the main canvas by default. They may be moved
  through the canvas split tree, not treated as inspector tabs.
- On medium desktops, the inspector becomes a right overlay. On mobile it is a
  full-screen artifact destination.

## Agent panel

### Header

The 40px agent header remains visible while the timeline scrolls:

```text
[state] Agent title                         [model] [thinking] [live stats] [⋯]
```

- `state` is an idle, running, waiting, attention, or error state conveyed by a
  named icon and accessible description; a tooltip is supplementary only.
- `model` and `thinking` are compact selectors. They show the current setting,
  not only an icon.
- `live stats` shows the useful active signal without becoming a dashboard—for
  example `1.2k tok · 48 tok/s · 18s` while generating.
- The overflow menu contains archive, duplicate/fork when available, transcript
  actions, display settings, and technical diagnostics.

### Turn structure

```text
                         [user intent card]

[assistant turn header: model · duration · tokens · rate · cost]
assistant answer rendered as a readable document

[Thinking · 8s                                            ▸]
[Read  src/server/worktree.ts                      success · 6s ▸]
[Edited  src/web/Workspace.tsx                       +18 −4 · 9s ▸]
[Ran  bun test                                       failed · 24s ▸]

[Changed files: Workspace.tsx, worktree.ts] [Copy] [timestamp]
```

#### User content

- Keep user intent visually distinct in a subtle pale teal/cyan card with a
  maximum 80% reading rail. Align it consistently with the transcript rail;
  do not require right alignment.
- Keep attachments, file references, and edit/retry controls attached to the
  card rather than creating a separate metadata strip.
- Long user content is readable and wraps; it is not reduced to a tiny chat
  bubble merely because it is user-authored.

#### Assistant content

- Render assistant prose left-aligned and unbubbled on a clean surface.
- Constrain normal prose to a readable rail within a wide agent pane; let code,
  tables, terminal output, and diffs use the full available width as needed.
- Assistant-turn header is compact technical metadata: model, thinking status,
  wall time, input/output/cache tokens, rate, and local cost where available.
- Do not render empty boilerplate headers. Inactive/missing metrics reserve no
  space; an active streaming metric updates in place.

#### Thinking

Thinking is a distinct compact disclosure, collapsed after completion. Its
header contains `Thinking`, an optional duration, and a state indicator. The
body loads on demand when historical thinking was omitted from the first history
page. Thinking may stream live, but it never visually outweighs assistant prose
or an error requiring attention.

#### Tools and process detail

The default **Detailed** mode renders every completed tool as a compact row.
Each row has:

1. semantic icon;
2. friendly verb (`Read`, `Searched`, `Edited`, `Ran`) rather than only the raw
   tool function name;
3. one-line monospace target (path, command, query, or artifact name);
4. textual/icon outcome plus semantic status treatment;
5. elapsed duration;
6. disclosure affordance for normalized input, result, diff, images, and error
   detail.

Raw JSON is never the closed-row preview. Unknown/custom tools use the same
grammar with their safe generic renderer.

The per-agent **Detailed / Concise** toggle is stored for that agent/session
only. It is visible in the agent header or overflow at compact widths:

- **Detailed** (default): individual compact rows remain visible.
- **Concise**: adjacent non-significant tools become a process group such as
  `Explored 8 files · ran 3 commands · edited 2 files`. Expand it to recover
  the same rows and all details.

Expansion state for thinking, tools, and process groups is remembered for the
current agent/session. It does not globally change other agents or sessions.
Errors, edit summaries, permission/attention items, and important image/artifact
results remain prominent boundaries in both modes.

### Inline artifact escalation

The timeline keeps small explanatory artifacts near the tool/result that
produced them but refuses to become a second editor or terminal.

| Artifact | Inline behavior | Dedicated-panel behavior |
| --- | --- | --- |
| File read/search | One short excerpt with path and `Open file`; omit full file body. | Inspector source/preview tab. |
| File edit | Concise changed-file summary and bounded diff preview. | Inspector diff or main-canvas editor. |
| Git diff | Bounded hunk preview; preserve error/conflict context. | Inspector diff with navigation and source handoff. |
| Terminal | Command/status summary only. A live interactive terminal never embeds in the transcript. | Main-canvas terminal; full-screen terminal on mobile. |
| Image/artifact | Scaled preview when small and relevant. | Inspector/full-screen viewer. |
| Large result/log | One-line outcome and byte/line count. | Expand a capped text view or open a dedicated panel. |

Implementation defines named limits such as `INLINE_PREVIEW_MAX_LINES`,
`INLINE_PREVIEW_MAX_BYTES`, and `INLINE_DIFF_MAX_CHANGED_LINES`; values are
performance-tested rather than hard-coded independently by renderers. Crossing
a size or interactivity threshold offers an explicit `Open` action and opens the
contextual inspector on wide screens.

### Tool renderer presentation contract

Built-in and declarative tool renderers produce a common visual model:

```text
icon · verb · target · outcome · duration · significance · expandable details
```

Declarative packs may choose labels, target fields, result fields, path links,
status mapping, and significance. They cannot render arbitrary HTML or execute
code. This makes custom tool calls feel native without reintroducing an
executable plugin surface.

## Composer

The composer is sticky at the bottom of an agent panel, separated from the
timeline by one border and a surface background. It should be immediately
available without covering the last assistant outcome.

```text
┌──────────────────────────────────────────────────────────────────────┐
│ Message the agent, @ files, or / commands                         [↗] │
├──────────────────────────────────────────────────────────────────────┤
│ [Model ▾] [Thinking ▾] [Send ▾]                    [Attach] [Send]   │
└──────────────────────────────────────────────────────────────────────┘
```

- Visible desktop controls: selected **Model**, **Thinking** level, and
  **Send mode**. Attachments, slash-command browsing, compact, and more
  controls use compact icon/menu affordances.
- File mention completion uses the current workspace root, shows relative path
  and type icon, and inserts a readable reference.
- A normal idle action is `Send`.
- During a run, the send-mode control explicitly exposes `Steer now` and
  `Queue follow-up`; it never silently chooses one. The active label and
  keyboard shortcut describe what will happen.
- Steering and follow-up queues use distinct labeled/tinted chips, not
  color-only treatment. Pi 0.84.3 does not expose per-item queue removal, so
  Passage presents queue state and mode without promising a false removal action.
- Abort is a separate destructive/stop control, never hidden inside Send.
- Autosave drafts per agent/workspace. Retain a failed submission as a draft.
- On mobile, preserve the message area and current send-mode label; move model,
  thinking, attachments, and other secondary controls into a compact control
  row/menu when the keyboard leaves limited viewport height.

## Files, editor, changes, and diff

### Explorer and changes

The Explorer is a workspace panel that presents a lazy file tree and a Changes
section. It distinguishes normal files, modified files, untracked files,
conflicts, and large/binary items using icon plus text/status treatment. File
icons remain visually muted; syntax/language identity should not compete with
Git state or agent attention.

Changes are a practical review surface:

- workspace-level changed-file, additions, and deletions summary;
- grouped changed files with status letter/icon and line statistics;
- branch/ref and worktree identity near the top;
- direct open to bounded inline preview or inspector diff;
- clear fallback for binary, deleted, renamed, or oversized files.

### Editor and file viewer

File inspection offers source, supported preview, and diff modes in the
inspector. The header presents truncated relative path, language/size metadata,
live-file status, line wrap control, selected-line/file mention action, and
close/move controls.

Moving a file to the main canvas promotes it to a focused CodeMirror editor.
Dirty state appears in its tab and header. A stale write produces a compare/
reload decision rather than silent overwrite. Source syntax and diff colors
follow the selected theme unless the user sets an editor override.

### Diff grammar

- Use technical monospace, fixed line-number gutters, and sticky file/hunk
  context where scrolling benefits.
- Added/removed/context/hunk lines use semantic tokens from the active theme.
- Show text indicators such as `Added` and `Removed` in accessible detail—not
  green/red alone.
- Default to inline diff; use side-by-side only when width permits and the user
  selects it.
- Virtualize or cap large diffs and make truncation explicit.

## Terminal

Terminal panels use the selected terminal font and compatible theme palette.
Their tabs show name, cwd/workspace context when needed, activity, and exit
state. The terminal receives no extra cards or visual decoration: xterm content
is the working surface.

- Keep a compact top bar for terminal name, connection/activity, search, clear,
  take-control/size lease, and close.
- Full terminal output, selection, clipboard, links, and search remain usable.
- A terminal receiving output in the background gets a subtle activity marker;
  it does not animate excessively or take focus.
- A mobile terminal is an immersive full-screen destination with a Back to
  agent/workspace action, safe-area padding, visual viewport handling, and a
  keyboard accessory for common modifier/navigation keys.
- The size-lease indicator is explicit on every attached client. A phone must
  take control before its viewport can resize a terminal used on desktop.

## Mobile and PWA interaction

### Chat-first navigation

The mobile home view is the selected agent conversation. The compact top bar
contains a navigation button, truncated workspace label, meaningful status, and
an overflow/action control. The navigation button opens a left workspace drawer
containing the same project/workspace hierarchy as desktop, adapted to touch.

- The drawer is at most 85vw wide and has at least 44px target rows.
- Selecting a workspace/agent closes the drawer and returns to the selected
  conversation.
- Rich workspace summaries remain available, but nonessential fields can wrap
  to a detail sheet rather than making every row impractically tall.
- Do not use a global edge-swipe gesture that conflicts with terminal selection
  or horizontal code/diff scrolling. The drawer affordance remains explicit.

### Artifact destinations

Opening a file, diff, editor, or terminal from a chat on mobile opens a focused
full-screen destination. The destination has a visible `Back to [agent title]`
control and retains the underlying agent/composer state. It is not a partially
visible desktop inspector squeezed into the viewport.

The saved desktop split tree still exists; mobile presents one chosen panel at a
surface.

### Mobile composer and PWA constraints

- Use `100dvh`, `visualViewport`, and safe-area insets so the software keyboard
  cannot obscure the composer or terminal input.
- Keep the message field, stop state, and current send behavior discoverable
  while keyboard height is constrained.
- Use full-screen sheets for workspace creation, model/thinking selection,
  tool details, and settings.
- Preserve scroll position and selected artifact when app focus returns. Reopen
  WebSocket state and reconcile run/terminal snapshots rather than assuming a
  suspended connection survived.
- Cache only the PWA shell. Offline state is an explicit screen with retry,
  never a stale editable copy of project/session data.

## Accessibility and keyboard behavior

- Meet WCAG AA text and interactive contrast in bundled themes; test custom
  theme packs before enabling them.
- Every status color has icon, text, accessible name, or all three.
- All pane operations available by drag have context-menu and keyboard paths.
- Tab strips, tool disclosures, tree rows, menus, drawers, dialogs, editor,
  terminal wrapper, and composer must have deliberate focus order and labels.
- Use visible `:focus-visible` teal/cyan focus rings; do not rely on hover to
  reveal required actions.
- Keep desktop hover actions as accelerators, never the only route to archive,
  close, inspect, or manipulate a resource.
- Honor reduced motion, increase hit targets for coarse pointers, and retain
  text alternatives for status badges/diff markers.
- Provide keyboard shortcuts for command palette, new agent, new terminal,
  focus sidebar, focus composer, move/split pane, open inspector, close panel,
  and switch active tabs. The exact bindings are documented in product help and
  are configurable only after the default set is stable.

## Component inventory

Build feature-sized components around the UI contracts above; do not repeat the
large all-purpose shell/components seen in the reference projects.

```text
web/
  app/
    AppShell
    WorkspaceShell
  features/
    navigation/
      ProjectWorkspaceSidebar
      WorkspaceRow
      AgentTerminalChildRow
    workspace/
      WorkspaceHeader
      WorkspaceOverview
      SplitCanvas
      PaneTabStrip
      Inspector
    agent/
      AgentPanel
      AgentHeader
      Timeline
      AssistantTurn
      ThinkingDisclosure
      ToolActivityRow
      ProcessGroup
      Composer
    artifacts/
      ExplorerPanel
      ChangesPanel
      FileInspector
      EditorPanel
      DiffView
      TerminalPanel
    settings/
      ThemeAndFontSettings
      ToolRendererPackSettings
```

Use shadcn/ui primitives for buttons, inputs, menus, dialogs, sheets, tabs,
tooltips, toasts, scroll areas, command palette, and form controls. Feature
components own product layout and state; generated primitives remain small and
replaceable.

## UI acceptance criteria

The UI is ready for MVP beta when:

1. A new user can understand the active project, workspace, branch, location,
   Git state, and agent/terminal activity by scanning the header and sidebar.
2. Returning to a workspace returns to its canvas and most relevant agent
   without leaking inspector tabs from a different worktree.
3. A detailed agent trace is transparent without making the final answer hard
   to read; Concise mode reduces sequential activity without hiding errors.
4. A tool row is useful before expansion and renders custom/unknown tools
   gracefully.
5. File/diff previews explain an agent action inline, while live terminals and
   large/interactable artifacts open in the correct dedicated surface.
6. Users can arrange agents, terminals, editors, and diffs through direct drag,
   with context-menu and keyboard alternatives.
7. Background activity is noticeable but never steals current focus.
8. The same workspace is practical on a phone: chat is immediate, navigation is
   drawer-based, and terminal/file/diff work happens in explicit full-screen
   destinations.
9. Light, dark, font, density, and per-workspace surface overrides apply
   predictably across UI, editor, diff, and terminal; per-agent tool-detail
   choices remain agent/session-local.
