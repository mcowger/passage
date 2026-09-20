import { memo, useMemo, useState, type ReactNode } from "react";
import { cn } from "../../lib/utils.ts";
import { ToggleGroup, ToggleGroupItem } from "../ui/toggle-group.tsx";
import { CopyButton } from "../CopyButton.tsx";
import { FileTypeIcon } from "../FileTypeIcon.tsx";
import type { ToolDiff } from "../../lib/tool-diff.ts";
import { toWorkspaceRelativePath } from "./input.ts";
import type { ToolIconKind, ToolSummary } from "./types.ts";

export function ViewToggle<T extends string>({
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

/** Standard output shell: section label, Structured/Raw toggle, copy button,
 *  and either the structured children or the raw text. */
export function RendererShell({
  label,
  text,
  copyTitle,
  viewLabel,
  structuredLabel = "Structured",
  rawLabel = "Raw",
  children,
}: {
  label: ReactNode;
  text: string;
  copyTitle: string;
  viewLabel: string;
  structuredLabel?: string;
  rawLabel?: string;
  children: ReactNode;
}) {
  const [mode, setMode] = useState<"structured" | "raw">("structured");
  return (
    <div className="tool-output-wrap">
      <div className="tool-section-header">
        <span className="tool-section-label">{label}</span>
        <div className="tool-section-actions">
          <ViewToggle
            value={mode}
            onChange={setMode}
            label={viewLabel}
            options={[
              { value: "structured", label: structuredLabel },
              { value: "raw", label: rawLabel },
            ]}
          />
          <CopyButton text={text} title={copyTitle} />
        </div>
      </div>
      {mode === "structured" ? (
        children
      ) : (
        <pre className="tool-output-pre"><code>{text}</code></pre>
      )}
    </div>
  );
}

/** Standard input shell: the `tool-search-input-block` with a label,
 *  copy button, and `tool-search-params` children. */
export function InputShell({
  label,
  copyText,
  copyTitle,
  children,
}: {
  label: ReactNode;
  copyText: string;
  copyTitle: string;
  children: ReactNode;
}) {
  return (
    <div className="tool-search-input-block">
      <div className="tool-section-header">
        <span className="tool-section-label">{label}</span>
        <CopyButton text={copyText} title={copyTitle} />
      </div>
      <div className="tool-search-params">{children}</div>
    </div>
  );
}

/** One `search-param-item`: optional `name:` label plus a `code` value. */
export function Param({ name, value }: { name?: string; value: string }) {
  return (
    <span className="search-param-item">
      {name ? <span className="param-label">{name}:</span> : null}
      <code>{value}</code>
    </span>
  );
}

export function fileToolSummary(icon: ToolIconKind, title: string, input: Record<string, unknown>, workspaceRoot?: string): ToolSummary {
  const path = String(input.path ?? input.filePath ?? input.filename ?? "");
  return { icon, title, subtitle: toWorkspaceRelativePath(path, workspaceRoot), isPath: Boolean(path) };
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

export const MAX_INLINE_DIFF_LINES = 120;

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
