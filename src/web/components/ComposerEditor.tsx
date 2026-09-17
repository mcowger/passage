import {
  forwardRef,
  useEffect,
  useImperativeHandle,
  useLayoutEffect,
  useRef,
} from "react";
import type { ClipboardEvent, KeyboardEvent, ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { FileTypeIcon } from "./FileTypeIcon.tsx";

const FILE_REF_PATTERN = /@`([^`\n]{1,4096})`/g;
const BLOCK_ELEMENTS = new Set(["DIV", "P", "LI"]);

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
  FILE_REF_PATTERN.lastIndex = 0;
  while ((match = FILE_REF_PATTERN.exec(value)) !== null) {
    if (match.index > last) nodes.push(value.slice(last, match.index));
    nodes.push(renderFileMention(match[1]!, `composer-file-${key++}`));
    last = match.index + match[0].length;
  }
  if (last < value.length) nodes.push(value.slice(last));
  return nodes;
}

function buildComposerDom(value: string): DocumentFragment {
  const fragment = document.createDocumentFragment();
  let last = 0;
  let match: RegExpExecArray | null;
  FILE_REF_PATTERN.lastIndex = 0;
  while ((match = FILE_REF_PATTERN.exec(value)) !== null) {
    if (match.index > last) fragment.append(document.createTextNode(value.slice(last, match.index)));
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
  if (last < value.length) fragment.append(document.createTextNode(value.slice(last)));
  return fragment;
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
}

function isMention(node: Node): node is HTMLElement {
  return node.nodeType === Node.ELEMENT_NODE && (node as HTMLElement).dataset.composerRaw !== undefined;
}

function rawLength(node: Node): number {
  if (isMention(node)) return node.dataset.composerRaw!.length;
  if (node.nodeType === Node.TEXT_NODE) return node.nodeValue?.length ?? 0;
  if (node.nodeName === "BR") return 1;
  let length = 0;
  node.childNodes.forEach((child) => {
    length += rawLength(child);
  });
  return length;
}

function isBlock(node: Node): node is HTMLElement {
  return node instanceof HTMLElement && BLOCK_ELEMENTS.has(node.tagName);
}

function readNode(node: Node): string {
  if (isMention(node)) return node.dataset.composerRaw!;
  if (node.nodeType === Node.TEXT_NODE) return node.nodeValue ?? "";
  if (node.nodeName === "BR") return "\n";
  let value = "";
  node.childNodes.forEach((child) => { value += readNode(child); });
  return value;
}

export function readComposerDraft(editor: HTMLElement): string {
  let value = "";
  editor.childNodes.forEach((child, index) => {
    if (index > 0 && isBlock(child)) {
      value += "\n";
    }
    value += readNode(child);
  });
  return value;
}

function offsetFromPoint(root: HTMLElement, node: Node, offset: number): number | null {
  if (!root.contains(node) && node !== root) return null;
  if (isMention(node)) return offset <= 0 ? rawOffsetBefore(root, node) : rawOffsetBefore(root, node) + rawLength(node);

  let current: Node = node;
  let result = Math.max(0, offset);
  while (current !== root) {
    const parent = current.parentNode;
    if (!parent) return null;
    let prefix = 0;
    for (const sibling of Array.from(parent.childNodes)) {
      if (sibling === current) break;
      prefix += rawLength(sibling);
    }
    result += prefix;
    current = parent;
    if (isMention(current)) {
      const start = rawOffsetBefore(root, current);
      return offset <= 0 ? start : start + rawLength(current);
    }
  }
  if (node === root) {
    result = 0;
    for (const child of Array.from(root.childNodes).slice(0, offset)) {
      result += rawLength(child);
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
    for (const sibling of Array.from(parent.childNodes)) {
      if (sibling === current) break;
      result += rawLength(sibling);
    }
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

function pointAtOffset(root: HTMLElement, target: number): { node: Node; offset: number } {
  let remaining = Math.max(0, target);

  const visit = (parent: Node): { node: Node; offset: number } => {
    const children = Array.from(parent.childNodes);
    for (let index = 0; index < children.length; index += 1) {
      const child = children[index]!;
      const length = rawLength(child);
      if (isMention(child)) {
        if (remaining <= 0) return { node: parent, offset: index };
        if (remaining <= length) return { node: parent, offset: index + 1 };
        remaining -= length;
        continue;
      }
      if (child.nodeType === Node.TEXT_NODE) {
        if (remaining <= length) return { node: child, offset: remaining };
        remaining -= length;
        continue;
      }
      if (child.nodeName === "BR") {
        if (remaining <= 0) return { node: parent, offset: index };
        if (remaining === 1) return { node: parent, offset: index + 1 };
        remaining -= 1;
        continue;
      }
      if (remaining <= length) return visit(child);
      remaining -= length;
    }
    return { node: parent, offset: children.length };
  };

  return visit(root) ?? { node: root, offset: root.childNodes.length };
}

function setSelectionOffset(root: HTMLElement, position: number): void {
  const point = pointAtOffset(root, position);
  const selection = window.getSelection();
  if (!selection) return;
  const range = document.createRange();
  range.setStart(point.node, Math.min(point.offset, point.node.nodeType === Node.TEXT_NODE ? point.node.nodeValue?.length ?? 0 : point.node.childNodes.length));
  range.collapse(true);
  selection.removeAllRanges();
  selection.addRange(range);
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
    const expectedMentions = [...value.matchAll(FILE_REF_PATTERN)].length;
    const actualMentions = editor.querySelectorAll("[data-composer-raw]").length;
    if (readComposerDraft(editor) !== value || actualMentions !== expectedMentions) {
      replaceEditorContent(editor);
    }
    const position = pendingCaretRef.current;
    if (position !== null && document.activeElement === editor) setSelectionOffset(editor, position);
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
    }
    if (offsets && offsets.start === offsets.end && event.key === "Delete") {
      const match = value.slice(offsets.start).match(/^@`[^`\n]{1,4096}`/);
      if (match) {
        event.preventDefault();
        replaceRange(offsets.start, offsets.end + match[0].length, "");
        return;
      }
    }
    if (event.key === "Enter" && event.shiftKey) {
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
