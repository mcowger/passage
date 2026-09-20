import { parseExaSearchOutput } from "../../lib/extra-tool-renderers.ts";
import type { ToolSummary } from "./types.ts";
import { InputShell, Param, RendererShell } from "./shared.tsx";

export function summary(input: Record<string, unknown>): ToolSummary {
  return { icon: "web", title: "Web search", subtitle: String(input.query ?? input.objective ?? "") };
}

export function handlesResult(result: string): boolean {
  return parseExaSearchOutput(result) !== null;
}

export function InputBlock({ input }: { input: Record<string, unknown> }) {
  return (
    <InputShell
      label="Search Query"
      copyText={String(input.query ?? input.objective ?? "")}
      copyTitle="Copy query"
    >
      {input.query ? <Param name="query" value={String(input.query)} /> : null}
      {input.objective && input.objective !== input.query ? (
        <Param name="objective" value={String(input.objective)} />
      ) : null}
    </InputShell>
  );
}

export function OutputView({ result }: { result: string }) {
  const data = parseExaSearchOutput(result);
  if (!data) return null;
  return (
    <RendererShell
      label={`Results · ${data.length}`}
      text={result}
      copyTitle="Copy results"
      viewLabel="Web search result view"
    >
      <div className="tool-grep-results">
        {data.map((hit) => (
          <div key={hit.url} className="grep-file-group">
            <div className="grep-file-header">
              <span className="grep-file-path">{hit.title}</span>
            </div>
            <div className="grep-match-row">
              <span className="grep-match-content">{hit.url}</span>
            </div>
            {(hit.published !== "N/A" && hit.published) || (hit.author !== "N/A" && hit.author) ? (
              <div className="grep-match-row">
                <span className="grep-match-content">{[hit.author, hit.published].filter((p) => p && p !== "N/A").join(" · ")}</span>
              </div>
            ) : null}
          </div>
        ))}
      </div>
    </RendererShell>
  );
}
