import { memo, useMemo, useState } from "react";
import type { TimelineItem } from "../../shared/domain/agents.ts";
import { FileTypeIcon } from "./FileTypeIcon.tsx";
import { HighlightedCode, getLanguageFromPath } from "./HighlightedCode.tsx";
import { CopyButton } from "./CopyButton.tsx";
import {
  renderTerminalOutput,
  tryParseJson,
  formatJsonPretty,
  parseGrepOutput,
  parseGlobOutput,
  parseReadToolOutput,
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
} from "lucide-react";

export const MAX_INLINE_DIFF_LINES = 120;

export type ToolIconKind = "read" | "edit" | "write" | "command" | "search" | "other";

export type ToolSummary = {
  icon: ToolIconKind;
  title: string;
  subtitle: string;
  isPath?: boolean;
};

export function getToolSummary(item: Extract<TimelineItem, { kind: "tool" }>): ToolSummary {
  const input = (item.input ?? {}) as Record<string, unknown>;
  switch (item.name) {
    case "read":
    case "readFile":
      return fileToolSummary("read", "Read File", input);
    case "edit":
    case "editFile":
    case "multiedit":
    case "apply_patch":
      return fileToolSummary("edit", "Edit File", input);
    case "write":
    case "writeFile":
      return fileToolSummary("write", "Write File", input);
    case "bash":
      return { icon: "command", title: "Shell Command", subtitle: String(input.command ?? "") };
    case "glob":
    case "ls":
    case "list":
    case "list_dir":
      return {
        icon: "search",
        title: item.name === "glob" ? "Find Files" : "List Directory",
        subtitle: String(input.pattern ?? input.path ?? ""),
        isPath: !input.pattern && Boolean(input.path),
      };
    case "grep":
      return { icon: "search", title: "Search Files", subtitle: String(input.pattern ?? "") };
    default:
      return { icon: "other", title: item.name, subtitle: "" };
  }
}

function fileToolSummary(icon: ToolIconKind, title: string, input: Record<string, unknown>): ToolSummary {
  const path = String(input.path ?? input.filePath ?? input.filename ?? "");
  return { icon, title, subtitle: path, isPath: Boolean(path) };
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

export function renderPathWithIcon(path: string, showFileIcon = true) {
  if (!path) return null;
  const lastSlash = path.lastIndexOf("/");
  if (lastSlash === -1) {
    return (
      <span className="tool-path-wrap" title={path}>
        {showFileIcon && <FileTypeIcon path={path} size={13} />}
        <span className="tool-path-name">{path}</span>
      </span>
    );
  }
  const dir = path.slice(0, lastSlash);
  const name = path.slice(lastSlash + 1);
  return (
    <span className="tool-path-wrap" title={path}>
      {showFileIcon && <FileTypeIcon path={path} size={13} />}
      <span className="tool-path-dir">{dir}/</span>
      <span className="tool-path-name">{name}</span>
    </span>
  );
}

function ToolDiffPreviewInner({ diff }: { diff: ToolDiff }) {
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
    <div className="tool-diff-card" aria-label={`Inline diff for ${diff.path || "changed file"}`}>
      <div className="tool-diff-header">
        <div className="tool-diff-file">
          {renderPathWithIcon(diff.path || "Changed content")}
        </div>
        <div className="tool-diff-actions">
          <span className="tool-diff-stats">
            <span className="tool-diff-stat-add">+{diff.additions}</span>
            <span className="tool-diff-stat-sep">/</span>
            <span className="tool-diff-stat-del">-{diff.deletions}</span>
          </span>
          <span className="tool-diff-context">{diff.contextLines} unmodified lines</span>
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
}: {
  content: string;
  filePath?: string;
}) {
  const parsed = useMemo(() => parseReadToolOutput(content), [content]);
  const codeText = useMemo(() => parsed.lines.map((l) => l.text).join("\n"), [parsed]);
  const hasLineNumbers = parsed.lines.some((l) => l.lineNumber !== null);
  const totalLines = parsed.lines.length;
  const lang = getLanguageFromPath(filePath);

  return (
    <div className="tool-read-card">
      <div className="tool-read-header">
        <div className="tool-read-file-info">
          {renderPathWithIcon(filePath || "file")}
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

function ToolOutputDisplay({
  item,
  filePath,
}: {
  item: Extract<TimelineItem, { kind: "tool" }>;
  filePath?: string;
}) {
  const result = item.result ?? "";
  const isBash = item.name === "bash";
  const isRead = item.name === "read" || item.name === "readFile";
  const isGlobLike = item.name === "glob" || item.name === "ls" || item.name === "list" || item.name === "list_dir";
  const normalizedBash = useMemo(() => (isBash ? renderTerminalOutput(result) : result), [isBash, result]);
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
        <ReadFileView content={result} filePath={filePath} />
      </div>
    );
  }

  if (grepData) {
    return (
      <div className="tool-output-wrap">
        <div className="tool-section-header">
          <span className="tool-section-label">Matches</span>
          <div className="tool-section-actions">
            <button
              type="button"
              className={`tool-view-toggle-btn ${viewMode === "structured" ? "active" : ""}`}
              onClick={() => setViewMode("structured")}
            >
              Structured
            </button>
            <button
              type="button"
              className={`tool-view-toggle-btn ${viewMode === "raw" ? "active" : ""}`}
              onClick={() => setViewMode("raw")}
            >
              Raw
            </button>
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
            <button
              type="button"
              className={`tool-view-toggle-btn ${viewMode === "structured" ? "active" : ""}`}
              onClick={() => setViewMode("structured")}
            >
              Grid
            </button>
            <button
              type="button"
              className={`tool-view-toggle-btn ${viewMode === "raw" ? "active" : ""}`}
              onClick={() => setViewMode("raw")}
            >
              Raw
            </button>
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
            <button
              type="button"
              className={`tool-view-toggle-btn ${viewMode === "formatted" ? "active" : ""}`}
              onClick={() => setViewMode("formatted")}
            >
              Formatted
            </button>
            <button
              type="button"
              className={`tool-view-toggle-btn ${viewMode === "raw" ? "active" : ""}`}
              onClick={() => setViewMode("raw")}
            >
              Raw
            </button>
            <CopyButton
              text={viewMode === "formatted" ? formattedJson : normalizedBash}
              title="Copy output"
            />
          </div>
        </div>
        {viewMode === "formatted" ? (
          <HighlightedCode code={formattedJson} language="json" className="tool-output-pre" />
        ) : (
          <HighlightedCode code={normalizedBash} language={isBash ? "bash" : "text"} className="tool-output-pre" />
        )}
      </div>
    );
  }

  return (
    <div className="tool-output-wrap">
      <HighlightedCode
        code={normalizedBash}
        language={isBash ? "bash" : undefined}
        filePath={isBash ? undefined : filePath}
        className="tool-output-pre"
      />
      <div className="tool-floating-copy">
        <CopyButton text={normalizedBash} title="Copy output" />
      </div>
    </div>
  );
}

function ToolExpandedBodyInner({
  item,
  diff,
  filePath,
}: {
  item: Extract<TimelineItem, { kind: "tool" }>;
  diff?: ToolDiff | null;
  filePath?: string;
}) {
  const input = (item.input ?? {}) as Record<string, unknown>;
  const isBash = item.name === "bash";
  const isRead = item.name === "read" || item.name === "readFile";
  const isSearchLike = item.name === "grep" || item.name === "glob" || item.name === "ls" || item.name === "list";
  const command = isBash
    ? typeof input.command === "string"
      ? input.command
      : typeof item.input === "string"
      ? item.input
      : ""
    : "";

  return (
    <div className="tool-expanded-body">
      {diff ? (
        <ToolDiffPreview diff={diff} />
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
              text={typeof item.input === "string" ? item.input : JSON.stringify(item.input, null, 2)}
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
      ) : item.input && !isRead && !isSearchLike ? (
        <div className="tool-input-wrap">
          <div className="tool-section-header">
            <span className="tool-section-label">Input</span>
            <CopyButton
              text={typeof item.input === "string" ? item.input : JSON.stringify(item.input, null, 2)}
              title="Copy input"
            />
          </div>
          <HighlightedCode
            code={typeof item.input === "string" ? item.input : JSON.stringify(item.input, null, 2)}
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
      ) : item.result ? (
        <ToolOutputDisplay item={item} filePath={filePath} />
      ) : null}
    </div>
  );
}

export const ToolExpandedBody = memo(ToolExpandedBodyInner);

function isGlobLikeSearch(name: string): boolean {
  return name === "glob" || name === "ls" || name === "list" || name === "list_dir";
}

function ToolRowInner({ item, conciseBadge }: { item: Extract<TimelineItem, { kind: "tool" }>; conciseBadge?: boolean }) {
  const { icon, title, subtitle, isPath } = getToolSummary(item);
  const diff = getToolDiff(item);
  const filePath = subtitle || (item.input && typeof item.input === "object" ? String((item.input as Record<string, unknown>).path ?? (item.input as Record<string, unknown>).filePath ?? "") : undefined);

  if (conciseBadge) {
    return (
      <details className={`tool-row concise ${item.status}`}>
        <summary className="timeline-concise-badge" title={`${title}${subtitle ? ` ${subtitle}` : ""} — expand for details`}>
          <span className="timeline-concise-title"><ToolIcon kind={icon} /> {title}</span>
          {subtitle && isPath ? renderPathWithIcon(subtitle) : subtitle ? <code title={subtitle}>{subtitle}</code> : null}
          {diff && (diff.additions > 0 || diff.deletions > 0) && (
            <span className="tool-diff-stats" aria-label={`${diff.additions} additions, ${diff.deletions} deletions`}>
              <span className="tool-diff-stat-add">+{diff.additions}</span>
              <span className="tool-diff-stat-sep">/</span>
              <span className="tool-diff-stat-del">-{diff.deletions}</span>
            </span>
          )}
        </summary>
        <ToolExpandedBody item={item} diff={diff} filePath={filePath} />
      </details>
    );
  }

  return (
    <details className={`tool-row ${item.status}`} open={item.status === "error"}>
      <summary className="tool-row-summary">
        <span className="tool-row-left">
          <span className="tool-row-icon"><ToolIcon kind={icon} /></span>
          <span className="tool-row-title">{title}</span>
          {subtitle && isPath ? (
            renderPathWithIcon(subtitle)
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
          <span className={`tool-badge ${item.status}`}>{item.status}</span>
        </span>
      </summary>
      <ToolExpandedBody item={item} diff={diff} filePath={filePath} />
    </details>
  );
}

export const ToolRow = memo(ToolRowInner);
