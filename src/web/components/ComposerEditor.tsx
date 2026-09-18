import {
  forwardRef,
  useEffect,
  useImperativeHandle,
  useLayoutEffect,
  useRef,
} from "react";
import type { ClipboardEvent, KeyboardEvent, ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { GraduationCap } from "lucide-react";
import { FileTypeIcon } from "./FileTypeIcon.tsx";
import { cleanSkillRefToken, countSkillRefs, isSkillRefBoundary, splitSkillRefs } from "./skillRefs.ts";

const FILE_REF_PATTERN = /@`([^`\n]{1,4096})`/g;
const BLOCK_ELEMENTS = new Set(["DIV", "P", "LI"]);

/** Narrow-viewport breakpoint matching the app shell's mobile layout (`src/web/main.tsx`). */
export const MOBILE_COMPOSER_WIDTH_PX = 768;

export function isMobileComposerViewport(viewportWidth: number, coarsePointer: boolean): boolean {
  return viewportWidth < MOBILE_COMPOSER_WIDTH_PX || coarsePointer;
}

export function currentViewportIsMobileComposer(): boolean {
  if (typeof window === "undefined") return false;
  let coarsePointer = false;
  try {
    coarsePointer = window.matchMedia?.("(pointer: coarse)").matches ?? false;
  } catch {
    coarsePointer = false;
  }
  return isMobileComposerViewport(window.innerWidth, coarsePointer);
}

/**
 * Desktop submits on Enter (Shift+Enter is the newline escape hatch).
 * Mobile virtual keyboards expose Enter as the newline key, so plain Enter
 * inserts a newline and only Cmd/Ctrl+Enter (hardware keyboard) submits.
 */
export function shouldSubmitOnEnter(
  event: { shiftKey: boolean; metaKey?: boolean; ctrlKey?: boolean },
  isMobile: boolean,
): boolean {
  if (event.shiftKey) return false;
  if (isMobile) return event.metaKey === true || event.ctrlKey === true;
  return true;
}

export type ComposerEditorHandle = {
  focus: () => void;
  setCaret: (position: number) => void;
};

type ComposerEditorProps = {
  value: string;
  placeholder: string;
  disabled?: boolean;
  ariaExpanded: boolean;
  ariaControls?: string;
  ariaActivedescendant?: string;
  onChange: (value: string) => void;
  onCaretChange: (position: number) => void;
  onKeyDown: (event: KeyboardEvent<HTMLDivElement>) => void;
};

function directoryHint(path: string): string {
  const slash = path.lastIndexOf("/");
  if (slash <= 0) return "";
  const dir = path.slice(0, slash);
  return dir.length > 48 ? `…${dir.slice(dir.length - 47)}` : dir;
}

function fileName(path: string): string {
  return path.split("/").at(-1) ?? path;
}

function renderFileMention(path: string, key: string): ReactNode {
  return (
    <span
      key={key}
      className="composer-file-mention"
      data-composer-raw={`@\`${path}\``}
      contentEditable={false}
      title={path}
      aria-label={`File mention ${path}`}
    >
      <FileTypeIcon path={path} size={13} />
      <span className="composer-file-mention-path">
        <span className="tool-path-wrap">
          <span className="tool-path-dir">{directoryHint(path) ? `${directoryHint(path)}/` : ""}</span>
          <span className="tool-path-name">{fileName(path)}</span>
        </span>
      </span>
    </span>
  );
}

export function renderComposerDraft(value: string): ReactNode[] {
  const nodes: ReactNode[] = [];
  let last = 0;
  let match: RegExpExecArray | null;
  let key = 0;
  const pushText = (text: string) => {
    for (const segment of splitSkillRefs(text)) {
      nodes.push(typeof segment === "string" ? segment : renderSkillMention(segment.skill, `composer-skill-${key++}`));
    }
  };
  FILE_REF_PATTERN.lastIndex = 0;
  while ((match = FILE_REF_PATTERN.exec(value)) !== null) {
    if (match.index > last) pushText(value.slice(last, match.index));
    nodes.push(renderFileMention(match[1]!, `composer-file-${key++}`));
    last = match.index + match[0].length;
  }
  if (last < value.length) pushText(value.slice(last));
  return nodes;
}

function renderSkillMention(token: string, key: string): ReactNode {
  return (
    <span
      key={key}
      className="composer-skill-mention"
      data-composer-raw={token}
      contentEditable={false}
      title={token}
      aria-label={`Skill command ${token}`}
    >
      <GraduationCap size={13} />
      <code className="composer-skill-name">{token}</code>
    </span>
  );
}
function buildComposerDom(value: string): DocumentFragment {
  const fragment = document.createDocumentFragment();
  const appendText = (text: string) => {
    for (const segment of splitSkillRefs(text)) {
      if (typeof segment === "string") fragment.append(document.createTextNode(segment));
      else appendSkillMention(fragment, segment.skill);
    }
  };
  let last = 0;
  let match: RegExpExecArray | null;
  FILE_REF_PATTERN.lastIndex = 0;
  while ((match = FILE_REF_PATTERN.exec(value)) !== null) {
    if (match.index > last) appendText(value.slice(last, match.index));
    const path = match[1]!;
    const mention = document.createElement("span");
    mention.className = "composer-file-mention";
    mention.dataset.composerRaw = match[0];
    mention.contentEditable = "false";
    mention.title = path;
    mention.ariaLabel = `File mention ${path}`;

    const icon = document.createElement("span");
    icon.className = "composer-file-mention-icon";
    icon.setAttribute("aria-hidden", "true");
    mention.append(icon);

    const pathElement = document.createElement("span");
    pathElement.className = "composer-file-mention-path";
    const pathWrap = document.createElement("span");
    pathWrap.className = "tool-path-wrap";
    const directory = directoryHint(path);
    if (directory) {
      const directoryElement = document.createElement("span");
      directoryElement.className = "tool-path-dir";
      directoryElement.textContent = `${directory}/`;
      pathWrap.append(directoryElement);
    }
    const name = document.createElement("span");
    name.className = "tool-path-name";
    name.textContent = fileName(path);
    pathWrap.append(name);
    pathElement.append(pathWrap);
    mention.append(pathElement);
    fragment.append(mention);
    last = match.index + match[0].length;
  }
  if (last < value.length) appendText(value.slice(last));
  return fragment;
}

function appendSkillMention(parent: DocumentFragment, token: string): void {
  const mention = document.createElement("span");
  mention.className = "composer-skill-mention";
  mention.dataset.composerRaw = token;
  mention.contentEditable = "false";
  mention.title = token;
  mention.ariaLabel = `Skill command ${token}`;

  const icon = document.createElement("span");
  icon.className = "composer-skill-mention-icon";
  icon.setAttribute("aria-hidden", "true");
  mention.append(icon);

  const name = document.createElement("span");
  name.className = "composer-skill-name";
  name.textContent = token;
  mention.append(name);
  parent.append(mention);
}

function mountComposerIcons(editor: HTMLElement, roots: Root[]): void {
  editor.querySelectorAll<HTMLElement>(".composer-file-mention-icon").forEach((icon) => {
    const mention = icon.parentElement;
    const raw = mention?.dataset.composerRaw ?? "";
    const path = raw.startsWith("@`") && raw.endsWith("`") ? raw.slice(2, -1) : "";
    if (!path) return;
    const root = createRoot(icon);
    roots.push(root);
    root.render(<FileTypeIcon path={path} size={13} />);
  });
  editor.querySelectorAll<HTMLElement>(".composer-skill-mention-icon").forEach((icon) => {
    const root = createRoot(icon);
    roots.push(root);
    root.render(<GraduationCap size={13} />);
  });
}

function isMention(node: Node): node is HTMLElement {
  return node.nodeType === Node.ELEMENT_NODE && (node as HTMLElement).dataset.composerRaw !== undefined;
}

function isBlock(node: Node): node is HTMLElement {
  return node instanceof HTMLElement && BLOCK_ELEMENTS.has(node.tagName);
}

/**
 * Block-level children (real editor lines) versus inline content. Mentions
 * are inline atomic chips even though they are elements; any other
 * element-shaped node that is not a known block tag is treated as an
 * inline wrapper and read through transparently.
 */
function isBlockLevel(node: Node): boolean {
  return !isMention(node) && isBlock(node);
}

/**
 * Whether reading `prev` then `next` as siblings crosses a line boundary. A
 * block opens a new line after anything, and anything after a block is on a
 * new (anonymous-block) line -- `<div>a</div>b` renders `b` below `a`.
 */
function childBoundaryBefore(prev: Node | null, next: Node): boolean {
  if (prev === null) return false;
  return isBlockLevel(prev) || isBlockLevel(next);
}

/**
 * contentEditable marks an otherwise-empty line with a lone `<br>`
 * (`<div><br></div>`); the surrounding block boundary already accounts for
 * that line, so the `<br>` itself contributes nothing. Any other `<br>` is
 * a genuine line break. The same rule covers a lone top-level `<br>`, which
 * is the empty-editor state.
 */
function isPlaceholderBreak(node: Node, parent: Node): boolean {
  return node.nodeName === "BR" && parent.childNodes.length === 1;
}

function readChildNode(node: Node, parent: Node): string {
  if (isMention(node)) return node.dataset.composerRaw!;
  if (node.nodeType === Node.TEXT_NODE) return node.nodeValue ?? "";
  if (node.nodeName === "BR") return isPlaceholderBreak(node, parent) ? "" : "\n";
  if (node instanceof HTMLElement) return readChildList(node);
  return "";
}

function readChildList(parent: Node): string {
  let value = "";
  let prev: Node | null = null;
  parent.childNodes.forEach((child) => {
    if (childBoundaryBefore(prev, child)) value += "\n";
    value += readChildNode(child, parent);
    prev = child;
  });
  return value;
}

/**
 * Reads the editor's plain text back out of the contentEditable DOM.
 * Boundaries are recognized at every depth -- not just between top-level
 * children -- because Shift+Enter/paste inside an existing line nests new
 * blocks (`<div><div>a</div><div>b</div></div>`) instead of splitting the
 * top level. The old top-level-only reader silently fused those lines, so
 * the composer displayed line breaks that never reached the sent message.
 */
export function readComposerDraft(editor: HTMLElement): string {
  return readChildList(editor);
}

/**
 * Raw-draft length of one child, mirroring `readChildNode` exactly: caret
 * math and readers must agree, or selections drift from the text they
 * describe. `parent` is required so lone-`<br>` placeholders measure zero.
 */
function childLength(node: Node, parent: Node): number {
  if (isMention(node)) return node.dataset.composerRaw!.length;
  if (node.nodeType === Node.TEXT_NODE) return node.nodeValue?.length ?? 0;
  if (node.nodeName === "BR") return isPlaceholderBreak(node, parent) ? 0 : 1;
  if (node instanceof HTMLElement) {
    let length = 0;
    let prev: Node | null = null;
    node.childNodes.forEach((child) => {
      if (childBoundaryBefore(prev, child)) length += 1;
      length += childLength(child, node);
      prev = child;
    });
    return length;
  }
  return 0;
}

/**
 * Maps a DOM selection point to a raw-draft offset. Element anchors carry a
 * child index (not a character offset), so they are measured directly;
 * text anchors carry the character offset. Block boundaries crossed while
 * walking up to the root each contribute one newline, matching
 * `readComposerDraft`.
 */
export function offsetFromPoint(root: HTMLElement, node: Node, offset: number): number | null {
  if (!root.contains(node) && node !== root) return null;
  if (isMention(node)) {
    const start = rawOffsetBefore(root, node);
    return offset <= 0 ? start : start + childLength(node, node.parentNode ?? root);
  }

  let base: number;
  if (node.nodeType === Node.TEXT_NODE) {
    base = Math.max(0, Math.min(offset, node.nodeValue?.length ?? 0));
  } else {
    const children = Array.from(node.childNodes);
    const upto = Math.max(0, Math.min(offset, children.length));
    base = 0;
    let prev: Node | null = null;
    for (let index = 0; index < upto; index += 1) {
      const child = children[index]!;
      if (childBoundaryBefore(prev, child)) base += 1;
      base += childLength(child, node);
      prev = child;
    }
  }

  let current: Node = node;
  let result = base;
  while (current !== root) {
    const parent = current.parentNode;
    if (!parent) return null;
    const siblings = Array.from(parent.childNodes);
    const index = siblings.indexOf(current as ChildNode);
    if (index < 0) return null;
    let prev: Node | null = null;
    for (let siblingIndex = 0; siblingIndex < index; siblingIndex += 1) {
      const sibling = siblings[siblingIndex]!;
      if (childBoundaryBefore(prev, sibling)) result += 1;
      result += childLength(sibling, parent);
      prev = sibling;
    }
    if (childBoundaryBefore(prev, current)) result += 1;
    current = parent;
    if (isMention(current)) {
      const start = rawOffsetBefore(root, current);
      return offset <= 0 ? start : start + childLength(current, current.parentNode ?? root);
    }
  }
  return result;
}

function rawOffsetBefore(root: HTMLElement, target: Node): number {
  let current: Node = target;
  let result = 0;
  while (current !== root) {
    const parent = current.parentNode;
    if (!parent) return result;
    const siblings = Array.from(parent.childNodes);
    const index = siblings.indexOf(current as ChildNode);
    if (index < 0) return result;
    let prev: Node | null = null;
    for (let siblingIndex = 0; siblingIndex < index; siblingIndex += 1) {
      const sibling = siblings[siblingIndex]!;
      if (childBoundaryBefore(prev, sibling)) result += 1;
      result += childLength(sibling, parent);
      prev = sibling;
    }
    if (childBoundaryBefore(prev, current)) result += 1;
    current = parent;
  }
  return result;
}

function selectionOffsets(root: HTMLElement): { start: number; end: number } | null {
  const selection = window.getSelection();
  if (!selection || selection.rangeCount === 0) return null;
  const range = selection.getRangeAt(0);
  const anchor = offsetFromPoint(root, selection.anchorNode!, selection.anchorOffset);
  const focus = offsetFromPoint(root, selection.focusNode!, selection.focusOffset);
  if (anchor === null || focus === null) return null;
  return {
    start: Math.min(anchor, focus),
    end: Math.max(anchor, focus),
  };
}

/**
 * Inverse of `offsetFromPoint`: maps a raw-draft offset to a DOM caret
 * point. Block boundaries consume one offset each (again matching the
 * reader); a caret landing exactly on a boundary anchors between the two
 * lines, otherwise it resolves inside the surrounding text or past a chip.
 */
export function pointAtOffset(root: HTMLElement, target: number): { node: Node; offset: number } {
  let remaining = Math.max(0, target);

  const visit = (parent: Node): { node: Node; offset: number } => {
    const children = Array.from(parent.childNodes);
    let prev: Node | null = null;
    for (let index = 0; index < children.length; index += 1) {
      const child = children[index]!;
      if (childBoundaryBefore(prev, child)) {
        if (remaining <= 0) return { node: parent, offset: index };
        remaining -= 1;
      }
      prev = child;
      if (isMention(child)) {
        const length = childLength(child, parent);
        if (remaining <= 0) return { node: parent, offset: index };
        if (remaining <= length) return { node: parent, offset: index + 1 };
        remaining -= length;
        continue;
      }
      if (child.nodeType === Node.TEXT_NODE) {
        const length = childLength(child, parent);
        if (remaining <= length) return { node: child, offset: remaining };
        remaining -= length;
        continue;
      }
      if (child.nodeName === "BR") {
        if (childLength(child, parent) === 0) continue;
        if (remaining <= 0) return { node: parent, offset: index };
        if (remaining === 1) return { node: parent, offset: index + 1 };
        remaining -= 1;
        continue;
      }
      const length = childLength(child, parent);
      if (remaining <= length) return visit(child);
      remaining -= length;
    }
    return { node: parent, offset: children.length };
  };

  return visit(root);
}

function clampPointOffset(point: { node: Node; offset: number }): number {
  const max = point.node.nodeType === Node.TEXT_NODE
    ? point.node.nodeValue?.length ?? 0
    : point.node.childNodes.length;
  return Math.max(0, Math.min(point.offset, max));
}

function selectRawRange(root: HTMLElement, start: number, end: number): boolean {
  const selection = window.getSelection();
  if (!selection) return false;
  try {
    const anchor = pointAtOffset(root, start);
    const focus = pointAtOffset(root, end);
    const range = document.createRange();
    range.setStart(anchor.node, clampPointOffset(anchor));
    range.setEnd(focus.node, clampPointOffset(focus));
    selection.removeAllRanges();
    selection.addRange(range);
    return true;
  } catch {
    return false;
  }
}

/**
 * Programmatic edits applied as string splices + replaceChildren bypass the
 * browser's native undo stack — the edit never lands on it, and the DOM
 * replacement wipes whatever was there (paste-then-Cmd+Z-does-nothing).
 * Routing the same edit through execCommand keeps it on the native stack so
 * undo/redo keep working. Returns true when the browser performed the edit;
 * the resulting input event then flows through onInput -> onChange as usual,
 * so callers must not apply a manual update on success.
 */
function editWithNativeUndo(editor: HTMLElement, start: number, end: number, text: string): boolean {
  if (typeof document.execCommand !== "function") return false;
  try {
    if (document.activeElement !== editor) editor.focus();
    if (!selectRawRange(editor, start, end)) return false;
    const applied = text === ""
      ? document.execCommand("delete")
      : document.execCommand("insertText", false, text);
    return applied !== false;
  } catch {
    return false;
  }
}

function setSelectionOffset(root: HTMLElement, position: number): void {
  if (!selectRawRange(root, position, position)) return;
}

export const ComposerEditor = forwardRef<ComposerEditorHandle, ComposerEditorProps>(function ComposerEditor(
  {
    value,
    placeholder,
    disabled = false,
    ariaExpanded,
    ariaControls,
    ariaActivedescendant,
    onChange,
    onCaretChange,
    onKeyDown,
  },
  ref,
) {
  const editorRef = useRef<HTMLDivElement>(null);
  const pendingCaretRef = useRef<number | null>(null);
  const iconRootsRef = useRef<Root[]>([]);

  const replaceEditorContent = (editor: HTMLElement) => {
    iconRootsRef.current.forEach((root) => root.unmount());
    iconRootsRef.current = [];
    editor.replaceChildren(buildComposerDom(value));
    mountComposerIcons(editor, iconRootsRef.current);
  };

  const updateSelection = (position: number) => {
    pendingCaretRef.current = position;
    const editor = editorRef.current;
    if (editor && document.activeElement === editor) setSelectionOffset(editor, position);
  };

  useImperativeHandle(ref, () => ({
    focus: () => editorRef.current?.focus(),
    setCaret: updateSelection,
  }), []);

  useLayoutEffect(() => {
    const editor = editorRef.current;
    if (!editor) return;
    const expectedMentions = [...value.matchAll(FILE_REF_PATTERN)].length + countSkillRefs(value);
    const actualMentions = editor.querySelectorAll("[data-composer-raw]").length;
    if (readComposerDraft(editor) !== value || actualMentions !== expectedMentions) {
      replaceEditorContent(editor);
    }
    const position = pendingCaretRef.current;
    if (position !== null && document.activeElement === editor) {
      // Re-setting an identical collapsed selection splits the browser's
      // typing coalescing, degrading native undo to char-by-char. Only move
      // the caret when it isn't already where we want it.
      const current = selectionOffsets(editor);
      if (!current || current.start !== position || current.end !== position) {
        setSelectionOffset(editor, position);
      }
    }
  }, [value]);

  useEffect(() => {
    return () => {
      iconRootsRef.current.forEach((root) => root.unmount());
      iconRootsRef.current = [];
    };
  }, []);

  const reportCaret = () => {
    const editor = editorRef.current;
    if (!editor) return;
    const offsets = selectionOffsets(editor);
    if (offsets) {
      pendingCaretRef.current = offsets.end;
      onCaretChange(offsets.end);
    }
  };

  const replaceRange = (start: number, end: number, text: string, event?: ClipboardEvent<HTMLDivElement>) => {
    event?.preventDefault();
    const editor = editorRef.current;
    // Prefer the native undo stack; fall back to a manual splice (which the
    // layout effect reconciles into the DOM) when execCommand is unavailable.
    if (editor && editWithNativeUndo(editor, start, end, text)) return;
    const next = value.slice(0, start) + text + value.slice(end);
    const caret = start + text.length;
    pendingCaretRef.current = caret;
    onChange(next);
    onCaretChange(caret);
  };

  const replaceSelection = (text: string, event?: ClipboardEvent<HTMLDivElement>) => {
    const editor = editorRef.current;
    if (!editor) return;
    const offsets = selectionOffsets(editor);
    if (!offsets) return;
    replaceRange(offsets.start, offsets.end, text, event);
  };

  const handlePaste = (event: ClipboardEvent<HTMLDivElement>) => {
    replaceSelection(event.clipboardData.getData("text/plain"), event);
  };

  const handleCopy = (event: ClipboardEvent<HTMLDivElement>) => {
    const editor = editorRef.current;
    if (!editor) return;
    const offsets = selectionOffsets(editor);
    if (!offsets || offsets.start === offsets.end) return;
    event.preventDefault();
    event.clipboardData.setData("text/plain", value.slice(offsets.start, offsets.end));
  };

  const handleCut = (event: ClipboardEvent<HTMLDivElement>) => {
    const editor = editorRef.current;
    if (!editor) return;
    const offsets = selectionOffsets(editor);
    if (!offsets || offsets.start === offsets.end) return;
    event.clipboardData.setData("text/plain", value.slice(offsets.start, offsets.end));
    replaceSelection("", event);
  };

  const handleKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const editor = editorRef.current;
    const offsets = editor ? selectionOffsets(editor) : null;
    if (offsets && offsets.start === offsets.end && event.key === "Backspace") {
      const match = value.slice(0, offsets.start).match(/@`[^`\n]{1,4096}`$/);
      if (match) {
        event.preventDefault();
        replaceRange(offsets.start - match[0].length, offsets.end, "");
        return;
      }
      // Skill chips delete atomically too; trailing punctuation belongs to
      // the surrounding text, so only a token flush against the caret counts.
      const skill = value.slice(0, offsets.start).match(/(?:^|[\s("'])(\/skill:[A-Za-z0-9_:.-]+)$/);
      if (skill) {
        const token = cleanSkillRefToken(skill[1]!);
        if (value.slice(0, offsets.start).endsWith(token)) {
          event.preventDefault();
          replaceRange(offsets.start - token.length, offsets.end, "");
          return;
        }
      }
    }
    if (offsets && offsets.start === offsets.end && event.key === "Delete") {
      const match = value.slice(offsets.start).match(/^@`[^`\n]{1,4096}`/);
      if (match) {
        event.preventDefault();
        replaceRange(offsets.start, offsets.end + match[0].length, "");
        return;
      }
      const ahead = value.slice(offsets.start).match(/^\/skill:[A-Za-z0-9_:.-]+/);
      if (ahead && isSkillRefBoundary(value, offsets.start)) {
        const token = cleanSkillRefToken(ahead[0]);
        event.preventDefault();
        replaceRange(offsets.start, offsets.start + token.length, "");
        return;
      }
    }
    if (event.key === "Enter" && event.shiftKey) {
      event.preventDefault();
      replaceSelection("\n");
      return;
    }
    if (
      event.key === "Enter"
      && !event.metaKey
      && !event.ctrlKey
      && !shouldSubmitOnEnter(event, currentViewportIsMobileComposer())
    ) {
      // Mobile plain-Enter inserts a newline instead of submitting.
      // (Desktop plain-Enter still falls through to onKeyDown to submit.)
      event.preventDefault();
      replaceSelection("\n");
      return;
    }
    onKeyDown(event);
  };

  return (
    <div
      ref={editorRef}
      className="composer-editor"
      contentEditable={!disabled}
      suppressContentEditableWarning
      data-placeholder={placeholder}
      role="combobox"
      aria-label="Agent message"
      aria-expanded={ariaExpanded}
      aria-controls={ariaControls}
      aria-activedescendant={ariaActivedescendant}
      aria-multiline="true"
      aria-disabled={disabled || undefined}
      onInput={(event) => {
        const editor = event.currentTarget;
        const next = readComposerDraft(editor);
        const offsets = selectionOffsets(editor);
        pendingCaretRef.current = offsets?.end ?? null;
        onChange(next);
        if (offsets) onCaretChange(offsets.end);
      }}
      onSelect={reportCaret}
      onKeyUp={reportCaret}
      onClick={reportCaret}
      onPaste={handlePaste}
      onCopy={handleCopy}
      onCut={handleCut}
      onKeyDown={handleKeyDown}
    />
  );
});

ComposerEditor.displayName = "ComposerEditor";
