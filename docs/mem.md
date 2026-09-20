# PR 1: collapse tool renderer memory

## Intent

Prevent completed tool rows from permanently retaining their rendered output in
the browser. This is an immediate mitigation for the long-session renderer
growth reproduced in production-like replay: collapsed tool rows retained
their full React, Shiki, and DOM subtrees even though only their compact
headers were visible.

Pi JSONL history and the Passage daemon remain the source of truth. Browser
rendering is disposable.

## Scope

- Unmount a tool row's expanded body when the row is closed. Its header,
  status, path, and diff summary remain visible.
- Recreate the body from the existing timeline item when the user opens the
  row again.
- Bound Shiki's token cache to 500 LRU entries and 4 MiB of serialized token
  data. A token payload too large for the budget is rendered but not retained
  in the cache.
- Cover the collapsed-body contract with SSR and browser-DOM regression tests.

## Expected result

Closed rows no longer retain syntax-highlight spans, `<pre>` elements, copy
controls, parsed output views, or image previews. A long agent session can
still retain its timeline data, but its hidden DOM should not grow with every
completed tool call.

## Deliberate non-goals

This PR does not virtualize the timeline, page historical transcript data, or
bound the browser's timeline-item state. Those are the durable follow-up:
render a small visible window and load older history from the daemon on
demand. This PR is intentionally safe to ship first because it changes only
the lifetime of closed presentation subtrees.
