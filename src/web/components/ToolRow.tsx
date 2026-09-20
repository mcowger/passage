import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { cn } from "../lib/utils.ts";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "./ui/collapsible.tsx";
import { ToggleGroup, ToggleGroupItem } from "./ui/toggle-group.tsx";
import type { TimelineItem } from "../../shared/domain/agents.ts";
import type { ShellOutputMode } from "../../shared/domain/settings.ts";
import type { WorkspaceApi } from "../api.ts";
import { GenericImageLightbox, UserImageThumb } from "./UserImages.tsx";
import { FileTypeIcon } from "./FileTypeIcon.tsx";
import { HighlightedCode, getLanguageFromPath } from "./HighlightedCode.tsx";
import { CopyButton } from "./CopyButton.tsx";
import { Spinner } from "./ui/spinner.tsx";
import { SkeletonText } from "./ui/skeleton.tsx";
import {
  renderTerminalOutput,
  tryParseJson,
  formatJsonPretty,
  parseGrepOutput,
  parseGlobOutput,
  parseReadToolOutput,
  extractToolResultText,
  type GrepParsedResult,
  type GlobParsedResult,
} from "../lib/tool-display.ts";
import { getToolDiff, type ToolDiff } from "../lib/tool-diff.ts";
import {
  FileText,
  Pencil,
  FilePlus,
  Terminal as TerminalIcon,
  Search,
  Settings,
  Folder,
  CircleCheckBig,
  CircleX,
} from "lucide-react";

export const MAX_INLINE_DIFF_LINES = 120;

/** Lines of shell output shown before the preview truncates with a
 *  "Show all" toggle. Keeps long `bash` results to roughly 4-5 lines
 *  worth of vertical space while still showing the tail (exit status and
 *  final lines) by default. */
export const SHELL_OUTPUT_PREVIEW_LINES = 5;

export type ShellOutputPreview = {
  totalLines: number;
  previewText: string;
  truncatedLines: number;
};

/** Slice shell output down to its last `maxLines` lines. A trailing newline
 *  does not count as a phantom extra line. */
export function getShellOutputPreview(text: string, maxLines = SHELL_OUTPUT_PREVIEW_LINES): ShellOutputPreview {
  const lines = text.split("\n");
  if (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
  const totalLines = lines.length;
  if (totalLines <= maxLines) return { totalLines, previewText: text, truncatedLines: 0 };
  return {
    totalLines,
    previewText: lines.slice(totalLines - maxLines).join("\n"),
    truncatedLines: totalLines - maxLines,
  };
}

/** Workspace image extensions the model can read with the `read` tool. */
const READ_IMAGE_EXTENSIONS = new Set([".png", ".jpg", ".jpeg", ".gif", ".webp"]);

/** Image path when this tool row is a model image read (`read`/`readFile` on
 *  a `.png`/`.jpg`/`.gif`/`.webp` file), else undefined. Relative paths
 *  resolve inside the workspace; absolute paths (e.g. /tmp) read directly. */
export function getReadToolImagePath(item: Extract<TimelineItem, { kind: "tool" }>): string | undefined {
  const name = item.name.toLowerCase();
  if (name !== "read" && name !== "readfile") return undefined;
  const input = getEffectiveToolInput(item);
  const raw = input.path ?? input.filePath ?? input.filename;
  if (typeof raw !== "string" || !raw.trim()) return undefined;
  const cleaned = raw.trim().replace(/\\/g, "/");
  const dot = cleaned.toLowerCase().lastIndexOf(".");
  if (dot < 0 || !READ_IMAGE_EXTENSIONS.has(cleaned.toLowerCase().slice(dot))) return undefined;
  // The raw route resolves the path inside the workspace and rejects escapes.
  if (cleaned.split("/").includes("..")) return undefined;
  return cleaned;
}

export type ToolIconKind = "read" | "edit" | "write" | "command" | "search" | "other";

export type ToolSummary = {
  icon: ToolIconKind;
  title: string;
  subtitle: string;
  isPath?: boolean;
};

/** Streaming tool args arrive as `{ rawInput: "<partial JSON>" }` until
 *  `toolcall_end` replaces them with the parsed object. Unwrap that shape so
 *  running rows can still show a path/command instead of nothing. */
export function getEffectiveToolInput(item: Extract<TimelineItem, { kind: "tool" }>): Record<string, unknown> {
  if (typeof item.input === "string") {
    const trimmed = item.input.trim();
    if (!trimmed) return {};
    // Bare-string inputs are almost always a shell command.
    return item.name === "bash" ? { command: item.input } : { text: item.input };
  }
  const input = (item.input ?? {}) as Record<string, unknown>;
  const raw = typeof input.rawInput === "string" ? input.rawInput : undefined;
  const rest = { ...input };
  delete rest.rawInput;
  const hasRealFields = Object.keys(rest).length > 0;
  if (raw === undefined || raw.trim() === "") return hasRealFields ? rest : {};
  const parsed = tryParseRawInput(raw);
  if (parsed && Object.keys(parsed).length > 0) return hasRealFields ? { ...parsed, ...rest } : parsed;
  return hasRealFields ? rest : {};
}

function tryParseRawInput(raw: string): Record<string, unknown> | undefined {
  try {
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
    return undefined;
  } catch {
    // Partial JSON while streaming -- best-effort regex for the fields the
    // summary + pending UI care about.
    const out: Record<string, unknown> = {};
    for (const key of ["path", "filePath", "filename", "command", "pattern", "include"]) {
      // Closing quote is optional so a still-streaming `"key": "partial` value matches.
      const match = new RegExp(`"${key}"\\s*:\\s*"((?:\\\\.|[^"\\\\])*)"?`).exec(raw);
      if (match) {
        try {
          out[key] = JSON.parse(`"${match[1]}"`);
        } catch {
          out[key] = match[1];
        }
      }
    }
    return Object.keys(out).length > 0 ? out : undefined;
  }
}

/** True when the tool's args are still streaming (only a `rawInput` fragment)
 *  or entirely absent -- i.e. there is nothing meaningful to render yet. */
export function isPendingToolInput(item: Extract<TimelineItem, { kind: "tool" }>): boolean {
  return Object.keys(getEffectiveToolInput(item)).length === 0;
}

export function getPendingToolLabel(name: string): string {
  const n = name.toLowerCase();
  if (n.includes("edit") || n.includes("patch")) return "Preparing edit…";
  if (n.includes("write") || n.includes("create")) return "Preparing write…";
  if (n === "read" || n === "readfile") return "Reading file…";
  if (n === "bash" || n === "command") return "Preparing command…";
  if (n === "grep") return "Searching…";
  if (n === "glob" || n === "ls" || n === "list" || n === "list_dir" || n === "find") return "Listing files…";
  return `Running ${name}…`;
}

export function getRunningToolLabel(name: string): string {
  const n = name.toLowerCase();
  if (n.includes("edit") || n.includes("patch")) return "Applying edit…";
  if (n.includes("write") || n.includes("create")) return "Writing file…";
  if (n === "read" || n === "readfile") return "Reading file…";
  if (n === "bash" || n === "command") return "Running command…";
  if (n === "grep") return "Searching…";
  if (n === "glob" || n === "ls" || n === "list" || n === "list_dir" || n === "find") return "Listing files…";
  return `Running ${name}…`;
}

/** Strip the workspace root from an absolute tool path for display.
 *  Returns the workspace-relative path when `path` is inside
 *  `workspaceRoot`, otherwise returns `path` unchanged. */
export function toWorkspaceRelativePath(path: string, workspaceRoot?: string): string {
  if (!path || !workspaceRoot) return path;
  if (!path.startsWith("/")) return path;
  const normalize = (p: string) => (p.length > 1 ? p.replace(/\/+$/, "") : p);
  const root = normalize(workspaceRoot);
  if (!root || !root.startsWith("/")) return path;
  if (path === root) return path;
  if (root === "/") return path.replace(/^\/+/, "");
  if (path.startsWith(`${root}/`)) return path.slice(root.length + 1);
  return path;
}

export function getToolSummary(item: Extract<TimelineItem, { kind: "tool" }>, workspaceRoot?: string): ToolSummary {
  const input = getEffectiveToolInput(item);
  switch (item.name) {
    case "read":
    case "readFile":
      return fileToolSummary("read", "Read", input, workspaceRoot);
    case "edit":
    case "editFile":
    case "multiedit":
    case "apply_patch":
      return fileToolSummary("edit", "Edit", input, workspaceRoot);
    case "write":
    case "writeFile":
      return fileToolSummary("write", "Write", input, workspaceRoot);
    case "bash":
      return { icon: "command", title: "Shell", subtitle: String(input.command ?? "") };
    case "find":
    case "glob":
    case "ls":
    case "list":
    case "list_dir":
      return {
        icon: "search",
        title: item.name === "glob" || item.name === "find" ? "Find" : "List",
        subtitle: String(input.pattern ?? input.path ?? ""),
        isPath: !input.pattern && Boolean(input.path),
      };
    case "grep":
      return { icon: "search", title: "Search", subtitle: String(input.pattern ?? "") };
    default:
      return { icon: "other", title: item.name, subtitle: "" };
  }
}

function fileToolSummary(icon: ToolIconKind, title: string, input: Record<string, unknown>, workspaceRoot?: string): ToolSummary {
  const path = String(input.path ?? input.filePath ?? input.filename ?? "");
  return { icon, title, subtitle: toWorkspaceRelativePath(path, workspaceRoot), isPath: Boolean(path) };
}

export function ToolIcon({ kind }: { kind: ToolIconKind }) {
  const props = { size: 13, strokeWidth: 1.8, "aria-hidden": true };
  switch (kind) {
    case "read": return <FileText {...props} />;
    case "edit": return <Pencil {...props} />;
    case "write": return <FilePlus {...props} />;
    case "command": return <TerminalIcon {...props} />;
    case "search": return <Search {...props} />;
    default: return <Settings {...props} />;
  }
}

export function renderPathWithIcon(path: string, showFileIcon = true, title?: string) {
  if (!path) return null;
  const tooltip = title ?? path;
  const lastSlash = path.lastIndexOf("/");
  if (lastSlash === -1) {
    return (
      <span className="tool-path-wrap" title={tooltip}>
        {showFileIcon && <FileTypeIcon path={path} size={13} />}
        <span className="tool-path-name">{path}</span>
      </span>
    );
  }
  const dir = path.slice(0, lastSlash);
  const name = path.slice(lastSlash + 1);
  return (
    <span className="tool-path-wrap" title={tooltip}>
      {showFileIcon && <FileTypeIcon path={path} size={13} />}
      <span className="tool-path-dir">{dir}/</span>
      <span className="tool-path-name">{name}</span>
    </span>
  );
}

function ToolDiffPreviewInner({ diff, workspaceRoot }: { diff: ToolDiff; workspaceRoot?: string }) {
  const displayPath = toWorkspaceRelativePath(diff.path, workspaceRoot);
  const visibleLines = diff.lines.slice(0, MAX_INLINE_DIFF_LINES);
  const omittedLines = diff.lines.length - visibleLines.length;
  const rawPatch = useMemo(
    () =>
      diff.lines
        .map((l) => (l.kind === "added" ? `+${l.text}` : l.kind === "removed" ? `-${l.text}` : ` ${l.text}`))
        .join("\n"),
    [diff.lines]
  );

  return (
    <div className="tool-diff-card" aria-label={`Inline diff for ${displayPath || "changed file"}`}>
      <div className="tool-diff-header">
        <div className="tool-diff-file">
          {renderPathWithIcon(displayPath || "Changed content", true, diff.path || undefined)}
        </div>
        <div className="tool-diff-actions">
          <span className="tool-diff-stats">
            <span className="tool-diff-stat-add">+{diff.additions}</span>
            <span className="tool-diff-stat-sep">/</span>
            <span className="tool-diff-stat-del">-{diff.deletions}</span>
          </span>
          <CopyButton text={rawPatch} title="Copy patch" />
        </div>
      </div>
      <div className="tool-diff-lines">
        {visibleLines.map((line, index) => (
          <div
            className={`tool-diff-line ${line.kind}`}
            key={`${line.kind}:${line.oldLine ?? ""}:${line.newLine ?? ""}:${index}`}
          >
            <span className="tool-diff-number">{line.oldLine ?? ""}</span>
            <span className="tool-diff-number">{line.newLine ?? ""}</span>
            <span className="tool-diff-marker">
              {line.kind === "added" ? "+" : line.kind === "removed" ? "-" : " "}
            </span>
            <code className="tool-diff-code">{line.text || " "}</code>
          </div>
        ))}
        {omittedLines > 0 && <div className="tool-diff-omitted">{omittedLines} more lines hidden</div>}
      </div>
    </div>
  );
}

export const ToolDiffPreview = memo(ToolDiffPreviewInner);

function ReadFileView({
  content,
  filePath,
  workspaceRoot,
}: {
  content: string;
  filePath?: string;
  workspaceRoot?: string;
}) {
  const displayPath = filePath ? toWorkspaceRelativePath(filePath, workspaceRoot) : undefined;
  const parsed = useMemo(() => parseReadToolOutput(content), [content]);
  const codeText = useMemo(() => parsed.lines.map((l) => l.text).join("\n"), [parsed]);
  const hasLineNumbers = parsed.lines.some((l) => l.lineNumber !== null);
  const totalLines = parsed.lines.length;
  const lang = getLanguageFromPath(filePath);

  return (
    <div className="tool-read-card">
      <div className="tool-read-header">
        <div className="tool-read-file-info">
          {renderPathWithIcon(displayPath || "file", true, filePath || undefined)}
          {lang && <span className="tool-read-lang-badge">{lang}</span>}
          <span className="tool-read-line-count">{totalLines} line{totalLines === 1 ? "" : "s"}</span>
        </div>
        <CopyButton text={codeText} title="Copy code" />
      </div>

      <div className="tool-read-body">
        {hasLineNumbers && (
          <div className="tool-read-gutter" aria-hidden="true">
            {parsed.lines.map((line, idx) => (
              <span key={idx} className="gutter-line-num">
                {line.lineNumber ?? ""}
              </span>
            ))}
          </div>
        )}
        <div className="tool-read-code-area">
          <HighlightedCode
            code={codeText}
            filePath={filePath}
            className="tool-read-code"
          />
        </div>
      </div>

      {parsed.truncationNotice && (
        <div className="tool-read-truncation">
          <span>{parsed.truncationNotice}</span>
        </div>
      )}
    </div>
  );
}

function GrepResultView({ data }: { data: GrepParsedResult }) {
  return (
    <div className="tool-grep-results">
      <div className="tool-search-count">
        Found {data.totalMatches} match{data.totalMatches === 1 ? "" : "es"} across {data.files.length} file{data.files.length === 1 ? "" : "s"}
      </div>
      <div className="grep-file-list">
        {data.files.map((file) => (
          <div key={file.filepath} className="grep-file-group">
            <div className="grep-file-header">
              <FileTypeIcon path={file.filepath} size={12} />
              <span className="grep-file-path">{file.filepath}</span>
            </div>
            <div className="grep-file-matches">
              {file.matches.map((m, idx) => (
                <div key={idx} className="grep-match-row">
                  {m.lineNum && <span className="grep-line-badge">Line {m.lineNum}:</span>}
                  <span className="grep-match-content">{m.content || "\u00A0"}</span>
                </div>
              ))}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

function GlobResultView({ data }: { data: GlobParsedResult }) {
  return (
    <div className="tool-glob-results">
      <div className="tool-search-count">
        Found {data.totalFiles} file{data.totalFiles === 1 ? "" : "s"} across {data.directories.length} director{data.directories.length === 1 ? "y" : "ies"}
      </div>
      <div className="glob-dir-list">
        {data.directories.map((dir) => (
          <div key={dir.directory} className="glob-dir-group">
            <div className="glob-dir-header">
              <Folder size={12} className="opacity-70 text-muted-foreground" />
              <span className="glob-dir-name">{dir.directory}/</span>
              <span className="glob-dir-badge">{dir.files.length}</span>
            </div>
            <div className="glob-dir-files-grid">
              {dir.files.map((filename) => (
                <div key={filename} className="glob-file-cell" title={`${dir.directory}/${filename}`}>
                  <FileTypeIcon path={filename} size={13} />
                  <span className="glob-file-name">{filename}</span>
                </div>
              ))}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

function ViewToggle<T extends string>({
  value,
  options,
  onChange,
  label,
}: {
  value: T;
  options: Array<{ value: T; label: string }>;
  onChange: (next: T) => void;
  label: string;
}) {
  return (
    <ToggleGroup
      type="single"
      value={value}
      onValueChange={(next) => { if (next) onChange(next as T); }}
      aria-label={label}
      size="sm"
      className="gap-1"
    >
      {options.map((option) => (
        <ToggleGroupItem
          key={option.value}
          value={option.value}
          aria-label={`Show ${option.label.toLowerCase()} view`}
          className={cn("tool-view-toggle-btn h-auto min-w-0", value === option.value && "active")}
        >
          {option.label}
        </ToggleGroupItem>
      ))}
    </ToggleGroup>
  );
}

/** Shell (`bash`) output with three display states: the row itself
 *  collapses (handled by the outer `Collapsible`), the output preview shows
 *  the last {@link SHELL_OUTPUT_PREVIEW_LINES} lines, and "Show all"
 *  expands to the full text. Preview is a tail slice so it shows the end
 *  by construction; the expanded view scrolls its `pre` to the bottom on
 *  expand and follows the tail while the command is still running (until
 *  the user scrolls up). Copy buttons elsewhere keep the full text. */
function ShellOutputCode({
  code,
  language,
  filePath,
  className,
  followTail,
  defaultShowAll,
}: {
  code: string;
  language?: string;
  filePath?: string;
  className?: string;
  followTail?: boolean;
  defaultShowAll?: boolean;
}) {
  const preview = useMemo(() => getShellOutputPreview(code), [code]);
  const needsTruncation = preview.truncatedLines > 0;
  const [showAll, setShowAll] = useState(defaultShowAll ?? false);
  const containerRef = useRef<HTMLDivElement>(null);
  // False once the user scrolls up in the expanded view -- tail-following
  // pauses until they scroll back to the bottom.
  const stickToEndRef = useRef(true);

  const scrollToEnd = useCallback(() => {
    const pre = containerRef.current?.querySelector("pre");
    if (pre && stickToEndRef.current) pre.scrollTop = pre.scrollHeight;
  }, []);

  const handleScroll = useCallback(() => {
    const pre = containerRef.current?.querySelector("pre");
    if (!pre) return;
    stickToEndRef.current = pre.scrollHeight - pre.scrollTop - pre.clientHeight < 24;
  }, []);

  // Show the end by default when expanding (covers the async syntax
  // highlighting pass, which settles just after the first paint).
  useEffect(() => {
    if (!showAll) return;
    stickToEndRef.current = true;
    scrollToEnd();
    const timer = setTimeout(scrollToEnd, 60);
    return () => clearTimeout(timer);
  }, [showAll, scrollToEnd]);

  // Follow the tail while streaming.
  useEffect(() => {
    if (showAll && followTail) scrollToEnd();
  }, [code, showAll, followTail, scrollToEnd]);

  const displayCode = needsTruncation && !showAll ? preview.previewText : code;

  return (
    <div className="shell-output-block" ref={containerRef} onScroll={handleScroll}>
      <HighlightedCode
        code={displayCode}
        language={language}
        filePath={filePath}
        className={className}
      />
      {needsTruncation && (
        <div className="shell-output-toggle-row">
          {!showAll && (
            <span className="shell-output-truncated-note">
              Showing last {SHELL_OUTPUT_PREVIEW_LINES} of {preview.totalLines} lines
            </span>
          )}
          <button
            type="button"
            className="tool-view-toggle-btn"
            aria-expanded={showAll}
            aria-label={showAll ? "Collapse shell output to preview" : `Expand shell output to all ${preview.totalLines} lines`}
            onClick={() => setShowAll((v) => !v)}
          >
            {showAll ? "Show less" : `Show all ${preview.totalLines} lines`}
          </button>
        </div>
      )}
    </div>
  );
}

function ToolOutputDisplay({
  item,
  filePath,
  workspaceRoot,
  shellOutputMode,
}: {
  item: Extract<TimelineItem, { kind: "tool" }>;
  filePath?: string;
  workspaceRoot?: string;
  shellOutputMode?: ShellOutputMode;
}) {
  const rawResult = item.result ?? "";
  const result =
    typeof rawResult === "string"
      ? rawResult === "[object Object]"
        ? ""
        : rawResult
      : extractToolResultText(rawResult) ?? "";
  const isBash = item.name === "bash";
  const isRead = item.name === "read" || item.name === "readFile";
  const isGlobLike = item.name === "find" || item.name === "glob" || item.name === "ls" || item.name === "list" || item.name === "list_dir";
  const normalizedBash = useMemo(() => (isBash ? renderTerminalOutput(result) : result), [isBash, result]);
  const followTail = item.status === "running";
  const defaultShowAll = (shellOutputMode ?? "preview") === "full";
  const jsonCheck = useMemo(() => tryParseJson(normalizedBash), [normalizedBash]);
  const grepData = useMemo(() => (item.name === "grep" ? parseGrepOutput(result) : null), [item.name, result]);
  const globData = useMemo(() => (isGlobLike ? parseGlobOutput(result) : null), [isGlobLike, result]);

  const [viewMode, setViewMode] = useState<"structured" | "formatted" | "raw">(() => {
    if (grepData || globData) return "structured";
    if (jsonCheck.isJson) return "formatted";
    return "formatted";
  });

  if (isRead) {
    return (
      <div className="tool-output-wrap">
        <ReadFileView content={result} filePath={filePath} workspaceRoot={workspaceRoot} />
      </div>
    );
  }

  if (grepData) {
    return (
      <div className="tool-output-wrap">
        <div className="tool-section-header">
          <span className="tool-section-label">Matches</span>
          <div className="tool-section-actions">
            <ViewToggle
              value={viewMode}
              onChange={setViewMode}
              label="Grep result view"
              options={[
                { value: "structured", label: "Structured" },
                { value: "raw", label: "Raw" },
              ]}
            />
            <CopyButton text={result} title="Copy matches" />
          </div>
        </div>
        {viewMode === "structured" ? (
          <GrepResultView data={grepData} />
        ) : (
          <pre className="tool-output-pre"><code>{result}</code></pre>
        )}
      </div>
    );
  }

  if (globData) {
    return (
      <div className="tool-output-wrap">
        <div className="tool-section-header">
          <span className="tool-section-label">Files</span>
          <div className="tool-section-actions">
            <ViewToggle
              value={viewMode}
              onChange={setViewMode}
              label="File list view"
              options={[
                { value: "structured", label: "Grid" },
                { value: "raw", label: "Raw" },
              ]}
            />
            <CopyButton text={result} title="Copy file list" />
          </div>
        </div>
        {viewMode === "structured" ? (
          <GlobResultView data={globData} />
        ) : (
          <pre className="tool-output-pre"><code>{result}</code></pre>
        )}
      </div>
    );
  }

  if (jsonCheck.isJson) {
    const formattedJson = formatJsonPretty(jsonCheck.data);
    return (
      <div className="tool-output-wrap">
        <div className="tool-section-header">
          <span className="tool-section-label">Output (JSON)</span>
          <div className="tool-section-actions">
            <ViewToggle
              value={viewMode}
              onChange={setViewMode}
              label="JSON output view"
              options={[
                { value: "formatted", label: "Formatted" },
                { value: "raw", label: "Raw" },
              ]}
            />
            <CopyButton
              text={viewMode === "formatted" ? formattedJson : normalizedBash}
              title="Copy output"
            />
          </div>
        </div>
        {viewMode === "formatted" ? (
          isBash ? (
            <ShellOutputCode key={`${item.id}-json-${defaultShowAll ? "full" : "preview"}`} code={formattedJson} language="json" className="tool-output-pre" followTail={followTail} defaultShowAll={defaultShowAll} />
          ) : (
            <HighlightedCode code={formattedJson} language="json" className="tool-output-pre" />
          )
        ) : isBash ? (
          <ShellOutputCode key={`${item.id}-raw-${defaultShowAll ? "full" : "preview"}`} code={normalizedBash} language="bash" className="tool-output-pre" followTail={followTail} defaultShowAll={defaultShowAll} />
        ) : (
          <HighlightedCode code={normalizedBash} language={isBash ? "bash" : "text"} className="tool-output-pre" />
        )}
      </div>
    );
  }

  return (
    <div className="tool-output-wrap">
      {isBash ? (
        <ShellOutputCode
          key={`${item.id}-${defaultShowAll ? "full" : "preview"}`}
          code={normalizedBash}
          language="bash"
          className="tool-output-pre"
          followTail={followTail}
          defaultShowAll={defaultShowAll}
        />
      ) : (
        <HighlightedCode
          code={normalizedBash}
          language={undefined}
          filePath={filePath}
          className="tool-output-pre"
        />
      )}
      <div className="tool-floating-copy">
        <CopyButton text={normalizedBash} title="Copy output" />
      </div>
    </div>
  );
}

function hasRenderableOutput(result: unknown): boolean {
  if (result === undefined || result === null) return false;
  const text = typeof result === "string" ? result : extractToolResultText(result) ?? "";
  const trimmed = text.trim();
  return trimmed !== "" && trimmed !== "[object Object]";
}

function ToolPendingBody({ item, hint }: { item: Extract<TimelineItem, { kind: "tool" }>; hint?: string }) {
  return (
    <div className="tool-pending-body" role="status" aria-label={`${getToolSummary(item).title} is running`}>
      <div className="tool-pending-status">
        <Spinner className="size-3.5 text-muted-foreground" />
        <span className="tool-pending-label">{getPendingToolLabel(item.name)}</span>
        {hint ? (
          <code className="tool-pending-hint" title={hint}>{hint}</code>
        ) : null}
      </div>
      <div className="tool-pending-skeleton" aria-hidden="true">
        <SkeletonText />
      </div>
    </div>
  );
}

function ToolRunningFooter({ item }: { item: Extract<TimelineItem, { kind: "tool" }> }) {
  return (
    <div className="tool-running-footer" role="status" aria-label={`${getToolSummary(item).title} still running`}>
      <Spinner className="size-3.5 text-muted-foreground" />
      <span className="tool-pending-label">{getRunningToolLabel(item.name)}</span>
    </div>
  );
}

function hasRenderableInput(name: string, effective: Record<string, unknown>): boolean {
  if (Object.keys(effective).length === 0) return false;
  const n = name.toLowerCase();
  if (n === "bash" || n === "command") return typeof effective.command === "string" && effective.command.trim() !== "";
  if (n === "grep") return Boolean(effective.pattern ?? effective.path ?? effective.include);
  if (n === "glob" || n === "ls" || n === "list" || n === "list_dir" || n === "find") {
    return Boolean(effective.pattern ?? effective.path);
  }
  if (n === "read" || n === "readfile") return Boolean(effective.path ?? effective.filePath ?? effective.filename);
  if (n.includes("edit") || n.includes("patch") || n.includes("write") || n.includes("create")) {
    return Boolean(
      effective.path ?? effective.filePath ?? effective.filename ??
      effective.oldString ?? effective.oldText ?? effective.newString ?? effective.newText ??
      effective.content ?? effective.text ?? effective.patch ?? effective.edits
    );
  }
  return true;
}

function ToolExpandedBodyInner({
  item,
  diff,
  filePath,
  workspaceId,
  workspaceRoot,
  api,
  shellOutputMode,
}: {
  item: Extract<TimelineItem, { kind: "tool" }>;
  diff?: ToolDiff | null;
  filePath?: string;
  workspaceId?: string;
  workspaceRoot?: string;
  api?: Pick<WorkspaceApi, "workspaceImageUrl">;
  shellOutputMode?: ShellOutputMode;
}) {
  const displayFilePath = filePath ? toWorkspaceRelativePath(filePath, workspaceRoot) : filePath;
  const input = getEffectiveToolInput(item);
  const isBash = item.name === "bash";
  const isRead = item.name === "read" || item.name === "readFile";
  const isSearchLike = item.name === "grep" || item.name === "find" || item.name === "glob" || item.name === "ls" || item.name === "list" || item.name === "list_dir";
  const isRunning = item.status === "running";
  const command = isBash && typeof input.command === "string" ? input.command : "";
  const renderable = hasRenderableInput(item.name, input);
  const imagePath = getReadToolImagePath(item);
  const hasOutput = hasRenderableOutput(item.result);

  // Args still streaming (e.g. `{ rawInput: "" }`) -- never show the raw
  // fragment, show a spinner + skeleton instead. A running command with
  // no output yet also shows the skeleton here; once partial output
  // arrives it falls through to the progressive output below.
  if (isRunning && !renderable && !hasOutput && !item.error) {
    const rawHint = String(input.path ?? input.filePath ?? input.filename ?? input.command ?? input.pattern ?? "");
    const hint = toWorkspaceRelativePath(rawHint, workspaceRoot);
    return (
      <div className="tool-expanded-body">
        <ToolPendingBody item={item} hint={hint || undefined} />
      </div>
    );
  }

  return (
    <div className="tool-expanded-body">
      {imagePath && workspaceId && api ? (
        <ReadToolImagePreview workspaceId={workspaceId} api={api} path={imagePath} />
      ) : null}
      {diff ? (
        <ToolDiffPreview diff={diff} workspaceRoot={workspaceRoot} />
      ) : isBash && command ? (
        <div className="tool-command-block">
          <HighlightedCode
            code={command}
            language="bash"
            className="tool-command-code"
          />
          <div className="tool-floating-copy">
            <CopyButton text={command} title="Copy command" />
          </div>
        </div>
      ) : item.name === "grep" && typeof input === "object" && (input.pattern || input.path || input.include) ? (
        <div className="tool-search-input-block">
          <div className="tool-section-header">
            <span className="tool-section-label">Search Query</span>
            <CopyButton
              text={JSON.stringify(input, null, 2)}
              title="Copy query"
            />
          </div>
          <div className="tool-search-params">
            {input.pattern ? (
              <span className="search-param-item">
                <span className="param-label">pattern:</span>
                <code>{String(input.pattern)}</code>
              </span>
            ) : null}
            {input.path ? (
              <span className="search-param-item">
                <span className="param-label">path:</span>
                <code>{String(input.path)}</code>
              </span>
            ) : null}
            {input.include ? (
              <span className="search-param-item">
                <span className="param-label">include:</span>
                <code>{String(input.include)}</code>
              </span>
            ) : null}
          </div>
        </div>
      ) : isGlobLikeSearch(item.name) && typeof input === "object" && (input.pattern || input.path) ? (
        <div className="tool-search-input-block">
          <div className="tool-section-header">
            <span className="tool-section-label">Pattern</span>
            <CopyButton text={String(input.pattern ?? input.path ?? "")} title="Copy pattern" />
          </div>
          <div className="tool-search-params">
            {input.pattern ? (
              <span className="search-param-item">
                <span className="param-label">pattern:</span>
                <code>{String(input.pattern)}</code>
              </span>
            ) : null}
            {input.path ? (
              <span className="search-param-item">
                <span className="param-label">path:</span>
                <code>{String(input.path)}</code>
              </span>
            ) : null}
          </div>
        </div>
      ) : renderable && !isRead && !isSearchLike && !diff && !(isBash && command) ? (
        <div className="tool-input-wrap">
          <div className="tool-section-header">
            <span className="tool-section-label">Input</span>
            <CopyButton
              text={JSON.stringify(input, null, 2)}
              title="Copy input"
            />
          </div>
          <HighlightedCode
            code={JSON.stringify(input, null, 2)}
            language="json"
            className="tool-input-pre"
          />
        </div>
      ) : null}

      {item.error ? (
        <div className="tool-output-wrap">
          <div className="tool-section-header">
            <span className="tool-section-label error">Error</span>
            <CopyButton text={item.error} title="Copy error" />
          </div>
          <pre className="tool-output-pre error"><code>{item.error}</code></pre>
        </div>
      ) : hasOutput ? (
        <>
          <ToolOutputDisplay item={item} filePath={displayFilePath} workspaceRoot={workspaceRoot} shellOutputMode={shellOutputMode} />
          {isRunning ? <ToolRunningFooter item={item} /> : null}
        </>
      ) : isRunning ? (
        <div className="tool-running-placeholder" role="status" aria-label={`${item.name} still running`}>
          <div className="tool-running-status">
            <Spinner className="size-3.5 text-muted-foreground" />
            <span className="tool-pending-label">{getRunningToolLabel(item.name)}</span>
          </div>
          <div className="tool-pending-skeleton" aria-hidden="true">
            <SkeletonText />
          </div>
        </div>
      ) : null}
    </div>
  );
}

export const ToolExpandedBody = memo(ToolExpandedBodyInner);

function isGlobLikeSearch(name: string): boolean {
  return name === "find" || name === "glob" || name === "ls" || name === "list" || name === "list_dir";
}

/** Thumbnail + lightbox for an image the model read from the workspace.
 *  Same look and behavior as user-sent image strips (click to expand,
 *  Escape/arrows/navigate, download); the bytes come from the workspace
 *  raw-file route instead of the agent attachment cache. */
export function ReadToolImagePreview({
  workspaceId,
  api,
  path,
}: {
  workspaceId: string;
  api: Pick<WorkspaceApi, "workspaceImageUrl">;
  path: string;
}) {
  const [lightbox, setLightbox] = useState(false);
  const name = path.split("/").at(-1) ?? path;
  const src = api.workspaceImageUrl(workspaceId, path);
  return (
    <>
      <div className="user-image-strip" aria-label={`Image read by the model: ${path}`}>
        <UserImageThumb
          src={src}
          name={name}
          onOpen={() => setLightbox(true)}
          expiredText={`${name} (unavailable)`}
        />
      </div>
      {lightbox && (
        <GenericImageLightbox
          images={[{ name, src }]}
          index={0}
          onClose={() => setLightbox(false)}
          onSelect={() => undefined}
          expiredLabel={(label) => `${label} could not be loaded.`}
        />
      )}
    </>
  );
}

export interface ToolRowProps {
  item: Extract<TimelineItem, { kind: "tool" }>;
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  workspaceId?: string;
  /** Absolute workspace root used to relativize absolute file paths in the row. */
  workspaceRoot?: string;
  api?: Pick<WorkspaceApi, "workspaceImageUrl">;
  /** Default shell output fullness for open bash rows. Per-row
   *  Show all/less still overrides. */
  shellOutputMode?: ShellOutputMode;
}

function ToolRowInner({ item, open, onOpenChange, workspaceId, workspaceRoot, api, shellOutputMode }: ToolRowProps) {
  const { icon, title, subtitle, isPath } = getToolSummary(item, workspaceRoot);
  const effectiveInput = getEffectiveToolInput(item);
  const diff = getToolDiff({ name: item.name, input: effectiveInput }) ?? getToolDiff(item);
  const rawPath = String(effectiveInput.path ?? effectiveInput.filePath ?? effectiveInput.filename ?? "");
  const filePath = subtitle || toWorkspaceRelativePath(rawPath, workspaceRoot) || undefined;
  const fullPathForTitle = rawPath && filePath !== rawPath ? rawPath : undefined;
  const isRunning = item.status === "running";

  return (
    <Collapsible
      className={`tool-row ${item.status}`}
      open={open}
      onOpenChange={onOpenChange}
      defaultOpen={open !== undefined ? undefined : item.status === "error"}
    >
      <CollapsibleTrigger className="tool-row-summary">
        <span className="tool-row-left">
          <span className="tool-row-icon">{isRunning ? <Spinner className="size-3.5 text-muted-foreground" /> : <ToolIcon kind={icon} />}</span>
          <span className="tool-row-title">{title}</span>
          {subtitle && isPath ? (
            renderPathWithIcon(subtitle, true, fullPathForTitle ?? subtitle)
          ) : subtitle ? (
            <span className="tool-row-target-text" title={subtitle}>{subtitle}</span>
          ) : null}
          {diff && (diff.additions > 0 || diff.deletions > 0) && (
            <span className="tool-diff-stats" aria-label={`${diff.additions} additions, ${diff.deletions} deletions`}>
              <span className="tool-diff-stat-add">+{diff.additions}</span>
              <span className="tool-diff-stat-sep">/</span>
              <span className="tool-diff-stat-del">-{diff.deletions}</span>
            </span>
          )}
        </span>
        <span className="tool-row-right">
          {item.status === "complete" ? (
            <CircleCheckBig size={15} className="tool-status-icon complete" aria-label="Complete" />
          ) : item.status === "error" ? (
            <CircleX size={15} className="tool-status-icon error" aria-label="Error" />
          ) : (
            <Spinner className="size-[15px] text-[#d97706]" aria-label="Running" />
          )}
        </span>
      </CollapsibleTrigger>
      <CollapsibleContent forceMount>
        <ToolExpandedBody item={item} diff={diff} filePath={rawPath || filePath} workspaceId={workspaceId} workspaceRoot={workspaceRoot} api={api} shellOutputMode={shellOutputMode} />
      </CollapsibleContent>
    </Collapsible>
  );
}

export const ToolRow = memo(ToolRowInner);
