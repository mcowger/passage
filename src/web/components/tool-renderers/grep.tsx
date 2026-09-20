import type { GrepParsedResult } from "../../lib/tool-display.ts";
import type { ToolSummary } from "./types.ts";
import { FileTypeIcon } from "../FileTypeIcon.tsx";
import { InputShell, Param, RendererShell } from "./shared.tsx";

export function summary(input: Record<string, unknown>): ToolSummary {
  return { icon: "search", title: "Search", subtitle: String(input.pattern ?? "") };
}

export function InputBlock({ input }: { input: Record<string, unknown> }) {
  return (
    <InputShell
      label="Search Query"
      copyText={JSON.stringify(input, null, 2)}
      copyTitle="Copy query"
    >
      {input.pattern ? <Param name="pattern" value={String(input.pattern)} /> : null}
      {input.path ? <Param name="path" value={String(input.path)} /> : null}
      {input.include ? <Param name="include" value={String(input.include)} /> : null}
    </InputShell>
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

export function OutputView({ result, data }: { result: string; data: GrepParsedResult }) {
  return (
    <RendererShell
      label="Matches"
      text={result}
      copyTitle="Copy matches"
      viewLabel="Grep result view"
    >
      <GrepResultView data={data} />
    </RendererShell>
  );
}
