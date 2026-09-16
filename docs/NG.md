# Next-Generation Features for Daily Driving Passage

This document outlines high-impact features and enhancements required for Passage to serve as a primary, daily-driven web coding environment, categorized by capability area.

---

## 1. File Management & Project Search

### File Operations in Explorer (`📁 Files`)
Currently, the File Explorer is read-only (browsing and opening files into editor tabs). Daily driving requires:
- **New File / New Folder**: Creating new files and directories directly from the file tree toolbar or context menu without dropping to the terminal.
- **Context Actions**: Right-click or hover action menu for:
  - Rename file/directory.
  - Delete file/directory (with confirmation).
  - Duplicate file.
  - Copy relative/absolute path.

### Global Search / Find in Files (`Cmd+Shift+F`)
- A dedicated Search panel or Command Palette mode for workspace-wide full-text search.
- Supports case sensitivity, whole word, and regex search.
- Interactive results list jumping directly to matching lines in CodeMirror editor tabs.

### Quick File Picker (`Cmd+P` / `Cmd+O`)
- Fast fuzzy-file navigation across the active workspace.
- Integrates with or extends the Command Palette (`Cmd+K`) to jump directly to any file in the workspace repository.

---

## 2. Code Editor Enhancements (CodeMirror)

### In-Editor Find & Replace (`Cmd+F` / `Cmd+H`)
- Integrate `@codemirror/search` to provide in-editor search, match highlighting, next/previous navigation (`Enter` / `Shift+Enter`), and regex find/replace.

### Expanded Syntax Highlighting
Expand beyond the current basic set (`JS/TS`, `JSON`, `Markdown`) to support common development languages:
- **Languages**: Python, Go, Rust, C/C++, HTML/CSS, Shell/Bash, YAML, TOML, SQL, and Dockerfile.

### Configurable Editor Settings
- Word wrap toggle (soft wrap vs horizontal scroll).
- Indentation settings (tab width: 2 vs 4 spaces, spaces vs tabs).
- Independent editor font size configuration in Workspace Settings.

---

## 3. Git & Version Control Workflows (`± Changes`)

### Interactive Staging & Discarding
- **Stage / Unstage**: One-click `[+] Stage` and `[-] Unstage` buttons next to changed files in the working tree and staged lists.
- **Stage All / Unstage All**: Batch staging controls in the panel header.
- **Discard Changes**: Safe, single-click file revert (`git checkout -- <file>` or removing untracked files).

### Integrated Commit Composer
- Commit message input field and `Commit` button located directly inside the `± Changes` view.
- Supports `Cmd+Enter` shortcut to commit staged changes without opening a terminal shell.

### Fast Branch Management & Remotes
- Branch switcher popup to checkout existing local branches or create branches on directory workspaces.
- One-click `Pull` / `Fetch` action to update against upstream remotes.

---

## 4. Pi Agent Enhancements

### Interactive Autocomplete Triggers (`@`, `/`, `!`, `#`)
- **`@` Mention**: Opens a searchable popup of workspace files and active agent sessions to insert path references into the prompt.
- **`/` Slash Commands**: Lists available Pi built-in commands and skills.
- **`!` Shell Escape / `#` Snippets**: Autocompletion and syntax helpers for shell commands and reusable prompt templates.

### Session Branching & History Navigation
- Visual representation of Pi's underlying JSONL session tree.
- Checkpoint / message rewind button to branch a conversation from an earlier turn or retry with a different model/strategy.

### Transcript Export & Sharing
- One-click "Copy Transcript as Markdown" or "Export Session" button to share agent reasoning and solution summaries.

---

## 5. Developer Ergonomics & Web Preview

### Embedded Web Preview Panel
- An iframe-based preview tab for full-stack and web app development.
- Automatic or manual port binding (e.g. `localhost:3000`, `localhost:5173`) to test web apps side-by-side with code and agent interactions.

### Terminal Tab Customization
- Double-click or context menu to rename terminal tabs (e.g., `Dev Server`, `Unit Tests`, `Build Watcher`).
- Ability to split terminals within the same tab group.

### Canvas Tab Drag-and-Drop
- Dragging tabs across split panes to visually reorganize layouts and move editors, diffs, terminals, and agent views between panes.
