import { memo, useMemo, useState } from "react";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "./ui/collapsible.tsx";
import type { TimelineItem } from "../../shared/domain/agents.ts";
import type { ShellOutputMode } from "../../shared/domain/settings.ts";
import type { WorkspaceApi } from "../api.ts";
import { HighlightedCode } from "./HighlightedCode.tsx";
import { CopyButton } from "./CopyButton.tsx";
import { Spinner } from "./ui/spinner.tsx";
import { SkeletonText } from "./ui/skeleton.tsx";
import {
  renderTerminalOutput,
  tryParseJson,
  formatJsonPretty,
  parseGrepOutput,
  parseGlobOutput,
  extractToolResultText,
} from "../lib/tool-display.ts";
import { getToolDiff, type ToolDiff } from "../lib/tool-diff.ts";
import {
  getEffectiveToolInput,
  hasRenderableInput,
  hasRenderableOutput,
  toWorkspaceRelativePath,
} from "./tool-renderers/input.ts";
import { ToolDiffPreview, renderPathWithIcon } from "./tool-renderers/shared.tsx";
import { getReadToolImagePath, ReadToolImagePreview } from "./tool-renderers/read.tsx";
import { ShellOutputCode } from "./tool-renderers/bash.tsx";
import { isGlobLikeSearch } from "./tool-renderers/file-list.tsx";
import * as ReadRenderer from "./tool-renderers/read.tsx";
import * as EditRenderer from "./tool-renderers/edit.tsx";
import * as WriteRenderer from "./tool-renderers/write.tsx";
import * as BashRenderer from "./tool-renderers/bash.tsx";
import * as FileListRenderer from "./tool-renderers/file-list.tsx";
import * as GrepRenderer from "./tool-renderers/grep.tsx";
import {
  identifyExtraTool,
  guessExtraToolFromName,
  type ExtraToolKind,
} from "../lib/extra-tool-renderers.ts";
import type { ToolIconKind, ToolSummary } from "./tool-renderers/types.ts";
import { ToolIcon } from "./tool-renderers/ToolIcon.tsx";
import { ViewToggle } from "./tool-renderers/shared.tsx";
import { EXTRA_RENDERERS, ExtraInputBlock, ExtraOutputView } from "./tool-renderers/index.tsx";
import {
  CircleCheckBig,
  CircleX,
} from "lucide-react";

export type { ToolIconKind, ToolSummary } from "./tool-renderers/types.ts";
export { getReadToolImagePath } from "./tool-renderers/read.tsx";
export {
  getShellOutputPreview,
  SHELL_OUTPUT_PREVIEW_LINES,
  type ShellOutputPreview,
} from "./tool-renderers/bash.tsx";
export { toWorkspaceRelativePath } from "./tool-renderers/input.ts";
export { MAX_INLINE_DIFF_LINES } from "./tool-renderers/shared.tsx";

export function getPendingToolLabel(name: string): string {
  const n = name.toLowerCase();
  if (n.includes("edit") || n.includes("patch")) return "Preparing edit…";
  if (n.includes("write") || n.includes("create")) return "Preparing write…";
  if (n === "read" || n === "readfile") return "Reading file…";
  if (n === "bash" || n === "command") return "Preparing command…";
  if (n === "grep") return "Searching…";
  if (n === "glob" || n === "ls" || n === "list" || n === "list_dir" || n === "find") return "Listing files…";
  switch (guessExtraToolFromName(name)) {
    case "exa-search": return "Searching the web…";
    case "exa-fetch": return "Fetching pages…";
    case "exa-agent": return "Starting research…";
    case "github-file": return "Reading GitHub file…";
    case "github-code": return "Searching code…";
    case "github-repos": return "Searching repos…";
    case "gh-actions-get": return "Loading workflow run…";
    case "gh-actions-list": return "Listing workflow runs…";
    case "github-pr": return "Loading pull request…";
    case "gh-actions-trigger": return "Triggering workflow…";
    case "recall": return "Recalling session…";
    case "process": return "Preparing process…";
    default: return `Running ${name}…`;
  }
}

export function getRunningToolLabel(name: string): string {
  const n = name.toLowerCase();
  if (n.includes("edit") || n.includes("patch")) return "Applying edit…";
  if (n.includes("write") || n.includes("create")) return "Writing file…";
  if (n === "read" || n === "readfile") return "Reading file…";
  if (n === "bash" || n === "command") return "Running command…";
  if (n === "grep") return "Searching…";
  if (n === "glob" || n === "ls" || n === "list" || n === "list_dir" || n === "find") return "Listing files…";
  switch (guessExtraToolFromName(name)) {
    case "exa-search": return "Searching the web…";
    case "exa-fetch": return "Fetching pages…";
    case "exa-agent": return "Researching…";
    case "github-file": return "Reading GitHub file…";
    case "github-code": return "Searching code…";
    case "github-repos": return "Searching repos…";
    case "gh-actions-get": return "Loading workflow run…";
    case "gh-actions-list": return "Listing workflow runs…";
    case "github-pr": return "Loading pull request…";
    case "gh-actions-trigger": return "Triggering workflow…";
    case "recall": return "Recalling session…";
    case "process": return "Managing process…";
    default: return `Running ${name}…`;
  }
}

/** Strip the workspace root from an absolute tool path for display.
 *  Returns the workspace-relative path when `path` is inside
 *  `workspaceRoot`, otherwise returns `path` unchanged. */
export function getToolSummary(item: Extract<TimelineItem, { kind: "tool" }>, workspaceRoot?: string): ToolSummary {
  const input = getEffectiveToolInput(item);
  switch (item.name) {
    case "read":
    case "readFile":
      return ReadRenderer.summary(input, workspaceRoot);
    case "edit":
    case "editFile":
    case "multiedit":
    case "apply_patch":
      return EditRenderer.summary(input, workspaceRoot);
    case "write":
    case "writeFile":
      return WriteRenderer.summary(input, workspaceRoot);
    case "bash":
      return BashRenderer.summary(input);
    case "find":
    case "glob":
    case "ls":
    case "list":
    case "list_dir":
      return FileListRenderer.summary(item.name, input);
    case "grep":
      return GrepRenderer.summary(input);
    default: {
      const extra = identifyExtraTool(item.name, input);
      if (extra) return EXTRA_RENDERERS[extra].summary(input);
      return { icon: "other", title: item.name, subtitle: "" };
    }
  }
}

export { getExtraToolSummary } from "./tool-renderers/index.tsx";

export { ToolIcon } from "./tool-renderers/ToolIcon.tsx";

export { renderPathWithIcon, ToolDiffPreview } from "./tool-renderers/shared.tsx";

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
  // Substring + shape match (never exact-name): identifies the extra families.
  const extraKind = useMemo(() => {
    try {
      return identifyExtraTool(item.name, getEffectiveToolInput(item));
    } catch {
      return undefined;
    }
  }, [item]);

  const [viewMode, setViewMode] = useState<"structured" | "formatted" | "raw">(() => {
    if (grepData || globData) return "structured";
    if (jsonCheck.isJson) return "formatted";
    return "formatted";
  });

  if (isRead) {
    return <ReadRenderer.OutputView content={result} filePath={filePath} workspaceRoot={workspaceRoot} />;
  }

  if (grepData) {
    return <GrepRenderer.OutputView result={result} data={grepData} />;
  }

  if (globData) {
    return <FileListRenderer.OutputView result={result} data={globData} />;
  }

  // Substring + shape matched families render in their own modules.
  if (extraKind && EXTRA_RENDERERS[extraKind].handlesResult(result)) {
    return <ExtraOutputView kind={extraKind} result={result} />;
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
  const extraKind = identifyExtraTool(item.name, input);
  const isExtraLike = extraKind !== undefined;
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
    const rawHint = String(
      input.path ?? input.filePath ?? input.filename ?? input.command ?? input.pattern ??
      input.query ?? input.pullNumber ?? input.workflow_id ?? input.resource_id ?? ""
    );
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
        <BashRenderer.CommandBlock command={command} />
      ) : item.name === "grep" && typeof input === "object" && (input.pattern || input.path || input.include) ? (
        <GrepRenderer.InputBlock input={input} />
      ) : isGlobLikeSearch(item.name) && typeof input === "object" && (input.pattern || input.path) ? (
        <FileListRenderer.InputBlock input={input} />
      ) : extraKind ? (
        <ExtraInputBlock kind={extraKind} input={input} />
      ) : renderable && !isRead && !isSearchLike && !isExtraLike && !diff && !(isBash && command) ? (
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



export { ReadToolImagePreview } from "./tool-renderers/read.tsx";

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
