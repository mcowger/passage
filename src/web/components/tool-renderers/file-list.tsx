import { Folder } from "lucide-react";
import type { GlobParsedResult } from "../../lib/tool-display.ts";
import type { ToolSummary } from "./types.ts";
import { FileTypeIcon } from "../FileTypeIcon.tsx";
import { InputShell, Param, RendererShell } from "./shared.tsx";

export function isGlobLikeSearch(name: string): boolean {
  return name === "find" || name === "glob" || name === "ls" || name === "list" || name === "list_dir";
}

export function summary(name: string, input: Record<string, unknown>): ToolSummary {
  return {
    icon: "search",
    title: name === "glob" || name === "find" ? "Find" : "List",
    subtitle: String(input.pattern ?? input.path ?? ""),
    isPath: !input.pattern && Boolean(input.path),
  };
}

export function InputBlock({ input }: { input: Record<string, unknown> }) {
  return (
    <InputShell
      label="Pattern"
      copyText={String(input.pattern ?? input.path ?? "")}
      copyTitle="Copy pattern"
    >
      {input.pattern ? <Param name="pattern" value={String(input.pattern)} /> : null}
      {input.path ? <Param name="path" value={String(input.path)} /> : null}
    </InputShell>
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

export function OutputView({ result, data }: { result: string; data: GlobParsedResult }) {
  return (
    <RendererShell
      label="Files"
      text={result}
      copyTitle="Copy file list"
      viewLabel="File list view"
      structuredLabel="Grid"
    >
      <GlobResultView data={data} />
    </RendererShell>
  );
}
