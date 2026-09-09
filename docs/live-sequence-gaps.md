# Live sequence gaps

Run date: 2026-09-09

Viewport: 1024 x 460

Evidence screenshots: `/tmp/opencode/passage-*.png`

## Sequence completed

I ran this sequence against the live Passage daemon:

1. Registered `Live Gaps Project` at `/tmp/passage-live-gap-project`.
2. Created an initial empty Git commit so the repository could supply a worktree base.
3. Tried to create a worktree from the UI.
4. Configured a global worktree location through the API after the UI reported that none existed. There is no UI for this configuration.
5. Tried the requested new branch name. Passage returned `git-failed`.
6. Created that branch outside Passage, retried the same UI flow, and created `UI lifecycle audit`.
7. Started an agent session and sent a request to edit `LIVE_SEQUENCE.md` and run commands.
8. Ran the file creation and command through Passage's terminal because the offline NullModel response did not produce tool calls.
9. Opened Changes, opened the file editor, opened the diff view, closed the views, and reopened Terminal and Changes.
10. Archived the worktree, reopened it from Discover & Import, and force-deleted the dirty worktree.

The final Git worktree list contained only the main checkout. The registered test project remains in Passage so the run can be inspected after the fact.

## Live-model verification addendum

I repeated the agent portion with the live `plexus/muse-spark-1.3` model after receiving explicit authorization to use live models.

The agent completed the requested work itself:

- `write` created `LIVE_MODEL_SEQUENCE.md`.
- `bash` ran `printf 'live agent command complete\\n' && git status --short`.
- `read` verified the file.
- The final response reported the file contents and command output.

I then opened Changes and the file editor, closed the views, archived the worktree, reopened it through Discover & Import, and force-deleted the dirty worktree. The Git worktree list again contained only the main checkout.

Evidence: `passage-live-15-agent-tool-results.png`, `passage-live-16-live-changes.png`, `passage-live-17-live-file-editor.png`, `passage-live-23-reimported.png`, `passage-live-25-deleted.png`

## What worked

- Project registration was clear and the form fit the viewport.
- Worktree discovery showed the archived worktree with a distinct `Reopen` action.
- Terminal state survived closing and reopening. The PTY remained marked `running` with an active lease.
- Changes listed both the Passage marker file and `LIVE_SEQUENCE.md`.
- The editor displayed the created file correctly and kept Save disabled when there were no editor changes.
- The delete flow clearly warned that it would remove the path from disk and required an explicit force checkbox for dirty content.
- The browser accessibility tree exposed useful names for the major controls, dialogs, tabs, and textboxes.

## Gaps

### 1. Worktree creation is blocked until a location is configured outside the UI

Severity: high

The first Create New dialog showed:

> No configured locations found. A global or project location must be configured.

There is no settings screen or form that can configure one. I had to call `POST /api/worktree-locations` manually before the flow could continue.

The error banner after the first submit said `Please fill in all required fields.` even though every visible required field was filled. The missing location was not presented as an actionable field.

Evidence: `passage-05-new-worktree-dialog.png`, `passage-08-worktree-created.png`, `passage-11-worktree-location-available.png`

Suggested fix: add global and project location management to Settings or the worktree dialog. If no location exists, provide a direct setup action and name the missing requirement in the validation message.

### 2. The UI suggests new branch names but the backend only accepts existing refs

Severity: high

The form placeholder and default value suggest values such as `feature/worktree`. Entering the new branch `feature/ui-lifecycle-audit` returned only `git-failed`.

The UI succeeded only after I created the branch outside Passage. The current behavior treats the field as an existing Git ref. It does not create a new branch from the selected base commit.

Suggested fix: either add an explicit “Create new branch” mode with a base-ref selector, or make the current field semantics clear and validate the ref before submission. The default should not look like a ready-to-use new branch if it cannot work as one.

### 3. Git errors are too opaque to recover from

Severity: high

The failed create operation showed `git-failed` with no explanation, command context, or suggested correction. This left the user to infer that the branch did not exist.

Suggested fix: return a safe, human-readable error such as “Branch or ref `feature/ui-lifecycle-audit` was not found. Create it first or choose an existing ref.” Keep raw command details out of the browser, but preserve useful recovery guidance.

Evidence: `passage-12-worktree-created.png`

### 4. Untracked files appear in Changes but their Diff view is empty

Severity: medium-high

Changes listed `LIVE_SEQUENCE.md` as a working-tree change and offered a `Diff` button. Opening that diff produced:

> No changes found in working tree.

That is technically consistent with `git diff` not showing untracked files, but it is confusing in the UI. The user has just been told that the file changed and then sees an empty diff.

Suggested fix: render an untracked-file diff as an add-only diff, or replace the Diff action with an editor/open action until the file is staged.

Evidence: `passage-24-changes-open.png`, `passage-25-diff-open.png`

### 5. Archiving leaves the details modal open on a different workspace

Severity: medium-high

After clicking `Archive Worktree` for `UI lifecycle audit`, the selected workspace changed to the unrelated `/tmp` directory workspace `W`, while the details modal remained open and changed its heading to `W`.

This makes it look as if the archive action acted on the wrong workspace. It is especially risky for destructive or state-changing actions.

Suggested fix: close the modal after a successful archive, show a success state for the archived item, and then select a fallback workspace outside the modal lifecycle.

Evidence: `passage-31-worktree-details.png`, `passage-32-worktree-archived.png`

### 6. Long names and paths lose too much context in the default layout

Severity: medium

The 192px sidebar wrapped `Live Gaps Project` across three lines and truncated the worktree label to `UI lifecyc...`. The top breadcrumb wrapped the branch and truncated the worktree path. The metadata dialog also broke long paths at arbitrary points.

The text remained mostly readable at this viewport, and I did not see an overlap. Still, the default view makes it hard to distinguish similarly named worktrees or verify the exact path.

Suggested fix: add reliable tooltips or copy controls for truncated labels and paths. Keep the visible label short, but make the full value one action away. Consider reserving a little more width for the selected workspace context.

Evidence: `passage-04-project-created.png`, `passage-13-worktree-created-retry.png`, `passage-31-worktree-details.png`

### 7. Offline agent verification did not exercise tool execution

Severity: test coverage gap, not a confirmed production defect

The first pass used the repository's local NullModel configuration. The prompt asking the agent to create a file and run commands produced the unrelated response `Try JSON.parse() with a try-catch wrapper.` It emitted no visible tool activity and did not edit the file.

The follow-up live-model pass did execute the file write, shell command, and read through Pi. The NullModel limitation still matters for offline browser tests, but it is no longer an unresolved production-flow question.

Suggested fix: add a deterministic local Pi fixture that emits the same file-write, shell, read, tool-result, and settled-response sequence. Use it in a browser acceptance test without contacting an external model provider.

Evidence: `passage-16-agent-prompt.png`, `passage-17-agent-running.png`, `passage-live-05-agent-prompt.png`, `passage-live-15-agent-tool-results.png`

### 8. The live agent transcript can run underneath the composer

Severity: medium

At the tested viewport, the live agent's final response extended below the visible conversation area. The screenshot showed the opening of the fenced file contents and the changed-file summary, but the rest of the response was hidden behind the fixed composer. The accessibility text contained the full response, so this is a visual scrolling problem rather than lost history.

Suggested fix: reserve composer height in the transcript scroll region and scroll the latest assistant content fully into view after settlement. Add a browser regression test with a multi-step tool response.

Evidence: `passage-live-15-agent-tool-results.png`, `passage-live-23-reimported.png`

### 9. Inline tool output rendering needs a visual pass for every tool type

Severity: medium

The live model produced a write call, a grouped bash/read process, and completed tool results.

- The process summary initially appeared as `Process2 activities` with the individual calls collapsed.
- Expanding the process showed the Shell Command and Read File rows with `COMPLETE` badges.
- Expanding the Shell Command showed the command JSON and the `TOOL_OUTPUT_ALPHA`, `TOOL_OUTPUT_BETA`, `TOOL_OUTPUT_GAMMA`, and Git status output in a readable monospace block.
- Expanding the Read File showed the path JSON and file contents in a readable output block.
- The Write File call was present in the accessibility text and DOM, including its inline diff and success output, but its `<details>` element reported zero layout height and the write row was not visible in the captured visual transcript while the grouped process was expanded. This needs a focused browser regression test rather than an assumption that DOM presence means visual display.

Suggested follow-up: test each supported tool renderer in concise mode, expanded process mode, and expanded tool-row mode. Assert that the write diff, shell input/output, read input/output, completion status, and long output remain visible without overlapping the composer.

Evidence: `passage-inline-05-agent-complete.png`, `passage-inline-07-process-expanded.png`, `passage-inline-09-shell-output-visible.png`, `passage-inline-10-all-tools-expanded.png`, `passage-inline-12-timeline-top.png`

## Visual and accessibility review

- No modal overlap or clipped primary action was visible at the tested viewport.
- Dialog text was readable, including the delete warning and force-delete label.
- The worktree detail and delete dialogs wrapped long paths, but did not hide them completely.
- The sidebar and top breadcrumb are the main readability risks because of truncation and narrow width.
- The Changes diff empty state is visually clean but semantically misleading for an untracked file.
- Accessible names were present for the primary buttons, dialogs, tabs, agent textbox, terminal textbox, and delete checkbox.

## Suggested order of repair

1. Add worktree-location configuration to the UI.
2. Support new branch creation or change the form to accept only existing refs.
3. Replace `git-failed` with actionable errors.
4. Make untracked-file diffs show the file contents as an add.
5. Close or correctly retarget the archive details modal after success.
6. Improve full-value access for truncated labels and paths.
7. Keep the transcript clear of the fixed composer after long tool responses.
8. Verify and fix any missing visual Write File row or inline diff after the browser regression test confirms it.
9. Add a deterministic browser fixture for agent tool execution.
