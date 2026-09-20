import { useMemo, useState } from "react";
import type { TimelineItem } from "../../../shared/domain/agents.ts";
import { parseReadToolOutput } from "../../lib/tool-display.ts";
import { getLanguageFromPath, HighlightedCode } from "../HighlightedCode.tsx";
import { CopyButton } from "../CopyButton.tsx";
import { GenericImageLightbox, UserImageThumb } from "../UserImages.tsx";
import type { WorkspaceApi } from "../../api.ts";
import type { ToolSummary } from "./types.ts";
import { getEffectiveToolInput, toWorkspaceRelativePath } from "./input.ts";
import { fileToolSummary, renderPathWithIcon } from "./shared.tsx";

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

export function summary(input: Record<string, unknown>, workspaceRoot?: string): ToolSummary {
  return fileToolSummary("read", "Read", input, workspaceRoot);
}

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

export function OutputView({
  content,
  filePath,
  workspaceRoot,
}: {
  content: string;
  filePath?: string;
  workspaceRoot?: string;
}) {
  return (
    <div className="tool-output-wrap">
      <ReadFileView content={content} filePath={filePath} workspaceRoot={workspaceRoot} />
    </div>
  );
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
