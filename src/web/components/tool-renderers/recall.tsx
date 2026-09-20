import { parseRecallOutput } from "../../lib/extra-tool-renderers.ts";
import type { ToolSummary } from "./types.ts";
import { InputShell, Param, RendererShell } from "./shared.tsx";

export function summary(input: Record<string, unknown>): ToolSummary {
  if (typeof input.mode === "string" && input.mode) return { icon: "recall", title: "Recall", subtitle: input.mode };
  return { icon: "recall", title: "Recall", subtitle: String(input.query ?? "") };
}

export function handlesResult(result: string): boolean {
  return parseRecallOutput(result) !== null;
}

export function InputBlock({ input }: { input: Record<string, unknown> }) {
  const query = String(input.query ?? input.mode ?? input.scope ?? "");
  return (
    <InputShell
      label="Recall Query"
      copyText={query}
      copyTitle="Copy query"
    >
      <Param value={query} />
      {input.scope ? <Param name="scope" value={String(input.scope)} /> : null}
    </InputShell>
  );
}

export function OutputView({ result }: { result: string }) {
  const data = parseRecallOutput(result);
  if (!data) return null;
  return (
    <RendererShell
      label={<>Recall{data.pageInfo ? ` · ${data.pageInfo}` : ""} · {data.totalMatches} matches</>}
      text={result}
      copyTitle="Copy recall"
      viewLabel="Recall view"
    >
      <div className="tool-grep-results">
        {data.entries.map((entry) => (
          <div key={`${entry.id}${entry.kind}`} className="grep-file-group">
            <div className="grep-file-header">
              <span className="grep-file-path">#{entry.id}</span>
              <span className="grep-line-badge">{entry.kind}</span>
            </div>
            {entry.preview ? (
              <div className="grep-match-row">
                <span className="grep-match-content">{entry.preview}</span>
              </div>
            ) : null}
          </div>
        ))}
      </div>
    </RendererShell>
  );
}
