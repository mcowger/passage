# Virtualized agent timeline with React Virtuoso

Status: design for the durable follow-up to [PR 1](mem.md).

## Decision

Use the MIT-licensed core `react-virtuoso` package and its flat `Virtuoso`
component for the agent timeline. Do not use the separately licensed
`@virtuoso.dev/message-list` package.

`Virtuoso` fits Passage because transcript rows have genuinely variable height:
assistant prose, streamed tool output, syntax highlighting, images, question
cards, and disclosures can all change after their first render. It measures
rows with `ResizeObserver`, supports prepending older items, and exposes the
scroll controls needed for a live agent transcript.

## Excluded alternative: Virtuoso Message List

`@virtuoso.dev/message-list` is a higher-level chat virtualizer with APIs for
prepend, append, row-growth, and scroll anchoring. It would reduce some of the
scroll-management code described below, and its ability to render generic data
would accommodate Passage's heterogeneous timeline items.

It is nevertheless excluded: its commercial license and EULA are not
acceptable for Passage. Do not add it as a dependency, use its trial, or plan
a proof of concept around it. The MIT-licensed core package is the supported
Virtuoso option.

## Terms

React's **virtual DOM** is React's in-memory tree and reconciliation process.
It does not prevent React from mounting every transcript row into the browser
DOM.

**DOM virtualization** is the relevant fix here. `Virtuoso` mounts only the
viewport's rows plus a small overscan area, then replaces rows as the user
scrolls. React still reconciles the visible items normally.

Virtualization bounds rendered DOM, layout work, and mounted component state.
It does **not** bound `AgentHistory.timeline` strings or other client data.
That needs separate daemon-backed paging and a bounded foreground cache.

## Current state

`AgentSessionPanel` loads the newest 20 timeline rows, prepends older pages
through `nextBefore`, and keeps Pi JSONL as the canonical history.
`AgentPanel` currently renders every loaded row with `visibleTimeline.map(...)`
inside `.timeline`. It also owns:

- pinned-tail and touch-scroll behavior;
- scroll-near-top history backfill;
- manual scroll-height compensation after a prepend;
- per-session expansion state keyed by timeline item ID.

PR 1 removes hidden expanded tool bodies, but a long session can still mount
every loaded timeline row. This document replaces that render path without
changing transcript semantics.

## Invariants

The virtualizer must preserve these contracts:

1. **Pi JSONL remains authoritative.** Virtuoso is only a browser rendering
   layer. It does not merge, reorder, summarize, or persist history.
2. **Timeline IDs are React keys.** `TimelineItem.id` is stable across live
   `row_upsert`, history reconciliation, and older-page prepends. Never key a
   row by its rendered array index.
3. **Chronology remains exact.** Tool boundaries, daemon errors, compaction
   dividers, user messages, and assistant messages remain separate rows.
4. **Reading wins over live follow.** A user who scrolls up must not be pulled
   back to the tail by new tokens or changing row height.
5. **The composer stays outside the list.** It remains sticky at the bottom of
   `AgentPanel`; it is not a virtual-list footer.
6. **Transient row state may reset.** Rows leave the DOM when scrolled away.
   Durable UI state, such as manual expansion, must remain keyed by timeline
   ID above the virtualized row. Local states such as an expanded shell-output
   preview can reset when their row unmounts, just as PR 1 intentionally resets
   a closed tool body.

## Proposed component boundary

Introduce a `TimelineViewport` owned by `AgentPanel`.

```text
AgentSessionPanel
  └─ AgentPanel
       ├─ TimelineViewport      ← Virtuoso owns the scrolling list
       │   └─ TimelineRow       ← existing renderer, still memoized
       └─ AgentComposer         ← sticky sibling, not a virtualized item
```

`TimelineViewport` receives the already-normalized `TimelineItem[]`, current
expansion settings, manual toggles, paging callbacks, and the pinned-tail
controller. `TimelineRow` remains the single renderer for actual transcript
items.

Question cards are not Pi timeline rows. Build a small presentation union so a
pending question is appended as a stable virtual item without mutating
`AgentHistory.timeline`:

```ts
type TimelineViewItem =
  | { key: `row:${string}`; kind: "row"; item: TimelineItem }
  | { key: `question:${string}`; kind: "question"; request: QuestionRequest };
```

The view builder continues to hide the matching running
`ask_user_question` tool while its native question card is active.

## Virtuoso integration

The initial implementation uses `Virtuoso<TimelineViewItem>`, not a grouped,
grid, table, or window-scrolling variant.

```tsx
<Virtuoso
  ref={virtuosoRef}
  data={viewItems}
  firstItemIndex={firstItemIndex}
  computeItemKey={(_index, item) => item.key}
  itemContent={renderTimelineItem}
  startReached={loadOlder}
  followOutput={() => pinnedRef.current && !userTouchingRef.current ? "auto" : false}
  atBottomStateChange={handleBottomStateChange}
  components={{ Header: TimelineHistoryLoadingIndicator }}
/>
```

The real component should keep these callbacks stable with `useCallback` and
the current settings/context in refs. Do not declare renderer components
inline, which causes unnecessary remounts while the list scrolls.

On an initial agent-panel mount, position the list at the newest loaded item
(or a valid restored item-ID anchor). Use `initialTopMostItemIndex` for the
mount-only case, then the Virtuoso handle for later changes. Do not use
`initialScrollTop`: it first renders the top window, which can trigger an
unwanted older-history fetch before the transcript reaches its intended tail.

### Stable keys

`computeItemKey` must return the item ID-based `key`, never Virtuoso's index.
The question card uses `question:${request.id}`. This preserves tool
disclosures and prevents a recycled row from displaying state from a different
timeline item.

### Variable heights and layout

Do not set `fixedItemHeight`. Tool rows, prose, images, and streaming output
are not fixed height. Let Virtuoso observe height changes.

Virtuoso measures item boxes, not margins that escape those boxes. Before the
migration, move vertical spacing from direct timeline row margins into a
virtual-item wrapper or item padding. In particular, audit `.tool-row` and
every direct row root so no top/bottom margin collapses outside the measured
item.

Use a deliberately small, measured `increaseViewportBy`/overscan budget. Large
overscan recreates the very DOM growth this work is meant to remove. Tune it
against rapid desktop and iPad scrolling after the first implementation; do
not guess a large default.

### Older history

`startReached` replaces the raw `scrollTop <= 120` trigger. It calls the
existing guarded older-page fetch only when `nextBefore` exists and a request
is not already in flight.

Virtuoso's `firstItemIndex` handles visual prepend compensation. Track the
absolute index of the first loaded canonical row beside `nextBefore`:

```text
canonical rows:        0 … 79 | 80 … 99 | 100 … 119
initial loaded page:                    100 … 119
firstItemIndex:                         100
prepend page:                  80 … 99
next firstItemIndex:                     80
```

For the initial page, the daemon's `nextBefore` supplies the source start
position (`0` when absent). For each prepend, decrement `firstItemIndex` by
the number of rows actually inserted after `prependOlderHistory` deduplicates
the page. Virtuoso requires that delta to equal the number of prepended items;
blindly assigning a cursor after an overlap race can make the viewport jump.
On a history replacement or transcript-epoch change, reset the loaded page and
its absolute first index together. Do not derive the index from a display array
that may temporarily filter a blocking tool or append a question card.

With correct `firstItemIndex` updates, remove the manual
`scrollHeight`/`scrollTop` prepend compensation in `AgentPanel`. Virtuoso
performs the compensation as part of the prepend mutation.

### Live tail behavior

Use `followOutput` only for append mutations, and only while Passage's
existing pinned-tail state is true. Return `false` while the user is reading
earlier output.

Streaming can grow the final row without changing item count. Keep a narrowly
scoped tail reassertion for that case, but route it through the Virtuoso handle
(`scrollToIndex` or `scrollIntoView`) rather than assigning `scrollTop`.
Continue to suppress it during a touch gesture.

Keep the current hysteresis policy: a small upward movement unpins and a
return near the bottom re-pins. `scrollerRef` can attach the existing passive
scroll/touch listeners to Virtuoso's scroller for that policy; Virtuoso owns
positioning, while Passage decides whether following is allowed.

### Reload and panel switching

The first pass can restore the tail or an item-ID anchor with
`scrollToIndex`. If retaining measured heights becomes useful, store a
Virtuoso `StateSnapshot` in the in-memory keep-alive record and pass it back
through `restoreStateFrom` only when the agent, transcript epoch, and loaded
data range still match. Never persist that snapshot as transcript data.

## What virtualization does not solve

Virtuoso bounds mounted DOM, but the current client still accumulates every
page a user has visited in `AgentHistory.timeline`. It cannot make a long
session's result strings, parsed data, or React state disappear on its own.

The next phase is a bounded foreground page cache:

- retain the visible page plus a small number of adjacent pages;
- discard distant pages from browser memory, never from Pi JSONL;
- refetch discarded ranges from the daemon when the user returns;
- extend the history API with an explicit range/newer-page cursor if the
  existing older-only cursor is insufficient for bidirectional refill;
- keep enough item-ID and cursor metadata to maintain a stable anchor while
  a page is swapped back in.

Do not implement arbitrary client-side row eviction before that paging contract
exists. A gap in a transcript is worse than a temporarily larger client cache.

## Accessibility and product behavior

- Preserve the existing `aria-label` and semantic row markup inside each
  virtual item.
- Keep a focused control mounted while it is in use. Test keyboard disclosure,
  copy buttons, native question cards, and lightboxes while scrolling.
- Browser find and screen-reader traversal naturally cover mounted rows, not
  an entire virtualized transcript. A durable transcript search/jump feature
  is the right answer if full-history discovery becomes a product requirement.
- Validate iPad touch scrolling, viewport resize, keyboard appearance, and
  PWA suspend/resume. Dynamic item measurement is essential on this path.

## Delivery plan

1. Add a React 19-compatible `react-virtuoso` release and introduce
   `TimelineViewport` without changing daemon history APIs.
2. Move row spacing into measured item boxes, replace the direct `.map`, and
   move scroll ownership from `.timeline` to Virtuoso.
3. Preserve prepend, pinned-tail, question-card, reconnect, and expansion
   behavior with focused tests.
4. Measure DOM count, heap, and scroll latency on varied large tool output.
5. Design and ship the separate bounded page cache only after the virtualized
   DOM path is stable.

## Acceptance checks

- A 60-row varied-output replay keeps mounted timeline rows proportional to
  viewport plus overscan, not total loaded rows.
- Prepending a page leaves the same message under the reader's eye with no
  visible jump.
- Live output follows only while pinned; an upward scroll or touch drag wins.
- Opening/closing a tool, late Shiki highlighting, image load, and a native
  question card do not create blank space or lose the active target.
- Desktop and iPad/mobile PWA checks show no console measurement errors,
  broken focus order, or reconnect regressions.
- Heap does not grow linearly from mounted transcript DOM. Any remaining
  growth from loaded client history is tracked separately by the page-cache
  follow-up.

## References

- [React Virtuoso overview](https://virtuoso.dev/react-virtuoso/)
- [Virtuoso scroll-to-index API](https://virtuoso.dev/react-virtuoso/virtuoso/scroll-to-index)
- [Virtuoso initial-index guidance](https://virtuoso.dev/react-virtuoso/virtuoso/initial-index)
- [React Virtuoso changelog](https://virtuoso.dev/react-virtuoso/changelog)
