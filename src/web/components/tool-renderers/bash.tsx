import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { HighlightedCode } from "../HighlightedCode.tsx";
import { CopyButton } from "../CopyButton.tsx";
import type { ToolSummary } from "./types.ts";

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

export function summary(input: Record<string, unknown>): ToolSummary {
  return { icon: "command", title: "Shell", subtitle: String(input.command ?? "") };
}

export function CommandBlock({ command }: { command: string }) {
  return (
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
  );
}

/** Shell (`bash`) output with three display states: the row itself
 *  collapses (handled by the outer `Collapsible`), the output preview shows
 *  the last {@link SHELL_OUTPUT_PREVIEW_LINES} lines, and "Show all"
 *  expands to the full text. Preview is a tail slice so it shows the end
 *  by construction; the expanded view scrolls its `pre` to the bottom on
 *  expand and follows the tail while the command is still running (until
 *  the user scrolls up). Copy buttons elsewhere keep the full text. */
export function ShellOutputCode({
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
