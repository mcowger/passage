import { parseGithubCodeSearch } from "../../lib/extra-tool-renderers.ts";
import type { ToolSummary } from "./types.ts";
import { FileTypeIcon } from "../FileTypeIcon.tsx";
import { InputShell, Param, RendererShell } from "./shared.tsx";

export function summary(input: Record<string, unknown>): ToolSummary {
  return { icon: "codesearch", title: "Code search", subtitle: String(input.query ?? "") };
}

export function handlesResult(result: string): boolean {
  return parseGithubCodeSearch(result) !== null;
}

export function InputBlock({ input }: { input: Record<string, unknown> }) {
  return (
    <InputShell
      label="Search Query"
      copyText={String(input.query ?? "")}
      copyTitle="Copy query"
    >
      <Param value={String(input.query ?? "")} />
    </InputShell>
  );
}

export function OutputView({ result }: { result: string }) {
  const data = parseGithubCodeSearch(result);
  if (!data) return null;
  return (
    <RendererShell
      label={`Matches · ${data.totalCount}`}
      text={result}
      copyTitle="Copy matches"
      viewLabel="Code search view"
    >
      <div className="tool-grep-results">
        <div className="tool-search-count">
          Found {data.totalCount} match{data.totalCount === 1 ? "" : "es"}
        </div>
        {data.items.map((match) => (
          <div key={`${match.repository}${match.path}${match.name}`} className="grep-file-group">
            <div className="grep-file-header">
              <FileTypeIcon path={match.name} size={12} />
              <span className="grep-file-path">{match.repository ? `${match.repository} · ` : ""}{match.path}</span>
            </div>
            {match.fragment ? (
              <div className="grep-match-row">
                <span className="grep-match-content">{match.fragment}</span>
              </div>
            ) : null}
          </div>
        ))}
      </div>
    </RendererShell>
  );
}
