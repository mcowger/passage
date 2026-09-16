# Embedded web preview

Authority: `docs/DESIGN.md` (architecture and security) > `docs/UI.md`
(interaction) > this document > `docs/WS.md` (current transport standard) >
`PI.md` (Pi boundary).

Status: proposed design. The transport described here requires matching changes
to `docs/DESIGN.md` and `docs/WS.md` before implementation. In particular, the
current two-socket rule does not allow the bounded preview stream this design
needs.

## 1. Decision

Passage will run a server-side Chromium session through
[`agent-browser`](https://github.com/vercel-labs/agent-browser) for each live
preview.

```text
Passage web app
  └── PreviewPanel (canvas + controls)
       ├── HTTP → Passage preview snapshots and commands
       └── WS   → bounded frame/input relay
                    └── agent-browser stream on 127.0.0.1
                          └── Chrome/CDP
                                └── http://localhost:3000
```

Chrome runs on the Passage host. `localhost` therefore means the same host as
the workspace and its development server, even when the Passage UI is open on
another machine.

Use the current native agent-browser implementation, not its removed
Node/Playwright implementation. Pin an exact release and verify it before an
upgrade. The release reviewed for this design is `v0.38.1`, which is Apache
2.0 licensed and ships a Linux x64 native binary. Chrome remains a separate
runtime dependency.

Passage uses agent-browser as an executable with a narrow command allowlist. It
does not import agent-browser as a library, expose its raw command protocol to
the web app, embed its dashboard, or add a generic browser-provider layer.

## 2. Why this approach

Agent-browser already has the pieces that would otherwise be expensive to
build and maintain:

- a native Rust daemon that owns Chrome through CDP;
- isolated named sessions;
- live JPEG frames over WebSocket;
- mouse, keyboard, touch, URL, status, and console messages;
- latest-frame-wins delivery, client FPS limits, and acknowledgement pacing;
- accessibility snapshots with durable `@eN` refs for surviving elements;
- screenshots, annotated screenshots, network inspection, and React inspection.

Passage still owns product lifecycle, access control, UI, persistence, and the
composer attachment format. The agent-browser dashboard is useful reference
code, but it includes session creation, providers, and optional AI chat that do
not belong in Passage.

## 3. Scope

The first version includes:

- a `preview` pane beside agents, terminals, editors, and diffs;
- manual URLs such as `http://localhost:3000`;
- detected loopback development-server candidates;
- back, forward, reload, address, viewport, and take-control actions;
- live mouse, keyboard, scroll, and touch input;
- desktop split-pane and mobile full-screen presentation;
- element selection and bounded composer context;
- one Chrome/agent-browser session per live preview.

The first version does not include:

- arbitrary remote browsing or a general-purpose hosted browser;
- browser profiles, restored login state, or credential storage;
- Firefox, Safari, or multiple browser providers;
- full Chrome DevTools embedded in Passage;
- video recording or durable console/network archives;
- framebuffer/VNC fallback;
- automatic execution of a development-server command.

## 4. Product model

A preview belongs to one workspace. It is a workspace resource, not an agent
resource or terminal child.

```ts
type WebPreview = {
  id: string;
  workspaceId: string;
  label: string;
  targetUrl: string;
  viewport: { width: number; height: number; deviceScaleFactor: number };
  createdAt: string;
  updatedAt: string;
};
```

SQLite stores this Passage metadata. Runtime status, stream ports, PIDs, CDP
targets, current frames, console messages, refs, and input leases stay in
daemon memory.

The saved `targetUrl` is a convenience, not network authority. Every launch and
navigation validates it again. Agent-browser session names derive from opaque
preview IDs and use a Passage-specific namespace so Passage never adopts or
closes a user's unrelated agent-browser session.

### Lifecycle

```text
stopped → starting → ready ⇄ disconnected
              └──→ error
ready/disconnected → stopping → stopped
```

- Opening a stopped preview starts its session and navigates to `targetUrl`.
- Closing a pane closes only the view. It does not stop Chrome.
- Browser disconnect or mobile suspension does not stop the preview.
- `Stop preview` explicitly closes only that preview's agent-browser session.
- Archiving a workspace stops its previews before archival completes.
- Passage closes known preview sessions during clean daemon shutdown.
- After a Passage crash, startup reconciles only sessions in Passage's own
  namespace. It may reattach or close them based on their durable preview
  record.
- Browser state is disposable. Passage does not use agent-browser `--restore`,
  `--state`, or persistent Chrome profiles in this version.

Agent-browser's idle timeout remains a leak backstop. Passage should configure
and document the chosen timeout rather than disable it. Stream input counts as
activity. If agent-browser exits while idle, the next preview open starts a new
browser and returns to the saved target URL.

`WebPreviewManager` is the sole Passage owner of preview lifecycle. It invokes
the pinned binary with fixed argument arrays, validates JSON responses, keeps
bounded stderr/diagnostics, discovers the loopback stream port, and serializes
mutating commands per preview. Browser HTTP handlers must not spawn or control
agent-browser directly.

## 5. Finding a development server

Manual entry is always available. Passage accepts an HTTP or HTTPS URL whose
host is `localhost`, `127.0.0.1`, or `[::1]` and whose port is explicit and
valid. Bare port input such as `5173` becomes `http://localhost:5173`.

Automatic discovery suggests candidates; it does not expose every listening
service or silently navigate to an uncertain match.

On Linux, Passage can map listening TCP sockets to PIDs through `/proc`, then
read bounded process metadata. A candidate is workspace-related when its
process cwd is inside the registered canonical workspace root or the process is
a descendant of a workspace terminal process. This follows the process-based
port discovery used by VS Code Remote.

Discovery runs at bounded product events rather than on a permanent polling
loop:

1. preview creation or explicit refresh;
2. workspace terminal start/exit;
3. a bounded URL match in new terminal output, such as
   `http://localhost:5173`.

Passage excludes its own ports and known non-HTTP services. It labels uncertain
candidates instead of probing them with a state-changing request. If exactly
one high-confidence candidate exists, the UI may preselect it; the user still
confirms creation.

The browser always navigates to the loopback URL. "Bind port" in the UI means
selecting a target for the server-side browser. Passage does not rebind the
development server or expose that port on the LAN.

## 6. Preview UI

Add `preview` to the pane-kind and layout schemas. A preview tab uses the same
close, move, split, persistence, and accessibility rules as other workspace
panes.

The panel has one compact toolbar:

```text
[Back] [Forward] [Reload] [http://localhost:5173             ]
[Viewport] [Pick element] [Take control] [More]
```

The body renders the newest JPEG frame to a canvas. The viewer preserves the
remote viewport's aspect ratio and maps pointer coordinates back to CSS-pixel
coordinates using frame metadata. It must not stretch coordinates when the
pane is resized.

Required states are `starting`, `connecting`, `ready`, `view only`, `stopped`,
`target unavailable`, `browser crashed`, and `reconnecting`. A stream freeze
must not leave stale pixels looking live; show connection state over the last
frame.

Only one attached client holds the preview input and viewport lease. Other
clients are view-only. Focus alone does not steal the lease from another
client; `Take control` does. This prevents a phone from changing the viewport
or typing into a preview being used on desktop.

On viewports below 640px, preview opens as one full-screen workspace panel. The
toolbar keeps Back, Reload, address/status, Pick element, and Take control
reachable with touch. Pointer input maps to touch where appropriate, and the
software keyboard must not cover the active page input.

## 7. Transport

Agent-browser binds each session stream to loopback. Passage must not expose
that port or the CDP URL to the browser. `WebPreviewManager` discovers the port
with `agent-browser stream status --json` and relays it through the configured
Passage origin.

### Control and snapshots

Use bounded HTTP for preview records and infrequent actions:

- list/get/create/update/stop preview;
- list current port candidates;
- navigate, back, forward, reload, and set viewport;
- select an element and capture a screenshot;
- fetch current runtime status after reconnect.

Mutations return a fresh preview snapshot inline and emit the normal workspace
invalidation after commit. Browser requests contain only opaque workspace and
preview IDs plus validated action fields. There is no raw agent-browser or CDP
command endpoint.

### Live stream

Add one purpose-specific endpoint:

```text
GET /api/previews/:previewId/ws
```

The browser-to-Passage connection and Passage-to-agent-browser connection are
both bounded WebSockets. The relay passes only the agent-browser message types
Passage supports. It validates `Host` and `Origin`, verifies preview ownership,
caps frame and input sizes, and closes slow or malformed clients.

This stream is explicitly outside the invalidation-only `/ws` envelope. It is
high-volume disposable content, like PTY bytes, and must not enter
`WorkspaceEventHub`, replay buffers, SQLite, or Pi history. `docs/WS.md` must be
updated with this narrow third-socket exception before implementation.

Start the upstream stream with acknowledgement pacing and a bounded FPS, for
example `?pacing=ack&maxFps=15`. Forward the renderer's frame acknowledgement
to agent-browser only after the browser has decoded and drawn that frame. Do
not acknowledge when the Passage relay merely receives it. This preserves
latest-frame-wins behavior across both hops and prevents stale frames from
building up after a mobile suspension.

Frames are not replayed. After reconnect, agent-browser sends the newest frame
and status. Console and URL messages are live diagnostics, not a durable audit
log. Navigation state is reconciled through the HTTP runtime snapshot when the
socket reconnects or the page becomes visible.

## 8. Element context for the composer

`Pick element` changes the next pointer action from page input to inspection.
The canvas sends the mapped page coordinate to a typed HTTP action. Passage
uses the preview's page-level CDP connection for a bounded read:

1. `DOM.getNodeForLocation` identifies the rendered node.
2. DOM and Accessibility calls collect tag, attributes, accessible role/name,
   text, ancestry, and bounds.
3. Passage builds a best-effort CSS selector and captures a bounded screenshot
   crop.
4. Agent-browser takes a fresh accessibility snapshot. If the selected node can
   be matched unambiguously, Passage includes its current `@eN` ref.

The ref is useful but not permanent. Agent-browser preserves refs for surviving
same-document nodes, invalidates replaced nodes and documents, and reports
removed refs. The attachment therefore also includes semantic and DOM context.

```ts
type PreviewElementContext = {
  previewId: string;
  url: string;
  title?: string;
  ref?: string;
  selector?: string;
  tagName: string;
  role?: string;
  accessibleName?: string;
  text?: string;
  attributes: Record<string, string>;
  bounds: { x: number; y: number; width: number; height: number };
  outerHtml?: string;
  screenshotId?: string;
  capturedAt: string;
};
```

All strings, attribute counts, HTML, text, dimensions, and screenshot bytes are
bounded. Secret-bearing attributes and form values are omitted. The UI shows a
removable attachment chip before send and a short preview in the user message.

At prompt admission, Passage turns the context into readable text and, when
selected, a Pi image attachment. Pi JSONL then remains the authority for what
was actually sent. SQLite does not store copied element context or screenshots.
Unsent context stays with the disposable browser draft.

Example prompt context:

```text
Web preview element
URL: http://localhost:5173/settings
Element: button "Save changes" (@e17)
Selector: form[aria-label="Profile"] button[type="submit"]
Bounds: x=812 y=644 width=124 height=32
HTML: <button type="submit">Save changes</button>
```

React source information is optional follow-up work. Agent-browser can install
the React DevTools hook before page code and inspect fibers, but reliably
mapping an arbitrary DOM click to a source file needs more proof. The first
version must not invent a component/file mapping when none is verified.

## 9. Security

A web preview renders workspace-controlled code with access to services on the
Passage host. Treat that as code execution adjacent to the existing terminal
and agent risks, not as passive file viewing.

- Default navigation is limited to HTTP(S) loopback URLs.
- Launch agent-browser with an allowlist for `localhost`, `127.0.0.1`, and
  `::1`; deny raw `eval` actions from the Passage UI.
- Do not use profiles, restored state, saved credentials, or arbitrary Chrome
  arguments.
- Never expose CDP, the agent-browser daemon socket, or per-session stream ports
  beyond loopback.
- Validate Passage `Host` and WebSocket `Origin` on every preview request.
- Keep navigation and port selection typed. Browser input cannot choose a new
  host without passing HTTP validation.
- Bound uploads, screenshots, DOM text, HTML, console entries, stderr, frame
  dimensions, FPS, and WebSocket queues.
- Stop all known preview sessions before removing a Passage-owned worktree.
- Project-controlled agent-browser extensions or init scripts require the same
  explicit workspace trust decision as other executable project resources and
  are out of scope for the first version.

Agent-browser's domain allowlist matches hostnames, not ports. A page allowed to
load from `localhost:5173` may attempt requests to another loopback port. The
browser same-origin policy limits reading many responses but does not prevent
all writes or WebSocket attempts. This is a known first-version limitation on
the existing trusted-host model. Stronger isolation would require a per-preview
network namespace or an enforcing local proxy and is separate work.

Passage still has no application authentication. Anyone who can use Passage on
the trusted LAN can view and control previews unless an upstream authenticated
proxy or VPN protects the deployment.

## 10. Packaging and compatibility

- Pin agent-browser by version and checksum for Linux x64.
- Install or package a compatible Chrome for Testing build. Do not download an
  unpinned browser during normal daemon startup.
- Keep agent-browser outside the Bun dependency graph. Bun starts its CLI with
  fixed arguments and parses bounded JSON output.
- Headless Chrome is the default. Xvfb is optional and only needed for a proved
  headed-mode compatibility case.
- Production build and package smoke tests must verify binary discovery,
  executable permissions, Chrome launch, loopback navigation, stream startup,
  input, and cleanup.
- An agent-browser upgrade requires protocol fixtures and the live acceptance
  tests below. Do not rely on `latest` documentation or private daemon APIs.

## 11. Delivery plan

### Phase 0: compatibility spike

1. Start two isolated named sessions from Bun.
2. Open separate loopback apps and prove cookies, redirects, fetch, WebSocket,
   and HMR behavior.
3. Relay frames through Passage with ack pacing and inject mouse, keyboard, and
   touch input.
4. Kill Chrome, agent-browser, Passage, and the client independently; verify
   bounded cleanup and recovery.
5. Prove coordinate mapping and bounded DOM/accessibility context.
6. Measure CPU, memory, frame age, and bandwidth at desktop and mobile sizes.

Failure of the spike blocks the feature. It must not trigger a Node sidecar or
a hand-built browser automation stack.

### Phase 1: preview resource and panel

- Add preview metadata, `WebPreviewManager`, typed HTTP routes, layout schema,
  port candidates, canvas viewer, controls, lease, and runtime states.
- Amend `docs/DESIGN.md`, `docs/UI.md`, and `docs/WS.md` with the accepted
  runtime and transport rules.

### Phase 2: composer context

- Add pick mode, CDP hit testing, context schema, screenshot crop, attachment
  chip, prompt serialization, and stale-ref handling.
- Add optional annotated screenshots after the basic picker is reliable.

## 12. Acceptance criteria

- A remote desktop or phone can interact with an app bound only to
  `127.0.0.1:3000` on the Passage host.
- Vite/Bun-style HMR, application WebSockets, redirects, cookies, forms,
  clipboard-safe text entry, and file upload work in the tested scope.
- Two previews in one workspace cannot cross browser sessions, frames, input,
  cookies, CDP targets, or cleanup.
- Closing a pane leaves its preview running; explicit stop closes only that
  preview.
- A slow or suspended client resumes at the newest frame without replaying a
  stale frame backlog.
- A second client is view-only until it explicitly takes the input lease.
- Port suggestions include workspace development servers and exclude unrelated
  Passage services in the test fixtures.
- Picking an element adds bounded URL, semantic, DOM, bounds, and optional image
  context to the composer. Replaced elements fail cleanly rather than pointing
  at a different node.
- Desktop split-pane and mobile full-screen flows are keyboard and touch
  accessible.
- Origin rejection, malformed input, oversized frames/context, browser crash,
  target exit, and daemon restart all have tested visible states.

Use `agent-browser` for the Passage UI verification as required by
`AGENTS.md`; use a separate session from the preview under test. Run
`bun run typecheck`, `bun test`, and `bun run test:gate` with NullModel.

## 13. References

- [agent-browser repository](https://github.com/vercel-labs/agent-browser)
- [agent-browser streaming protocol](https://agent-browser.dev/streaming)
- [agent-browser snapshots and refs](https://agent-browser.dev/snapshots)
- [agent-browser dashboard architecture](https://agent-browser.dev/dashboard)
- [agent-browser security controls](https://agent-browser.dev/security)
- [agent-browser sessions](https://agent-browser.dev/sessions)
- [Chrome DevTools Protocol: Page](https://chromedevtools.github.io/devtools-protocol/tot/Page/)
- [Chrome DevTools Protocol: DOM](https://chromedevtools.github.io/devtools-protocol/tot/DOM/)
- [Chrome DevTools Protocol: Accessibility](https://chromedevtools.github.io/devtools-protocol/tot/Accessibility/)
- [Chrome DevTools Protocol: Input](https://chromedevtools.github.io/devtools-protocol/tot/Input/)
- [VS Code Remote process-based port discovery](https://github.com/microsoft/vscode/blob/main/src/vs/workbench/api/node/extHostTunnelService.ts)
