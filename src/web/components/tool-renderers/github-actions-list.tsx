import { parseGithubActionsRuns } from "../../lib/extra-tool-renderers.ts";
import type { ToolSummary } from "./types.ts";
import { InputShell, Param, RendererShell } from "./shared.tsx";

export function summary(input: Record<string, unknown>): ToolSummary {
  return {
    icon: "list",
    title: "Actions runs",
    subtitle: `${String(input.owner ?? "")}/${String(input.repo ?? "")}`,
  };
}

export function handlesResult(result: string): boolean {
  return parseGithubActionsRuns(result) !== null;
}

export function InputBlock({ input }: { input: Record<string, unknown> }) {
  return (
    <InputShell
      label="Workflow"
      copyText={JSON.stringify(input, null, 2)}
      copyTitle="Copy input"
    >
      {input.method ? <Param name="method" value={String(input.method)} /> : null}
      <Param value={`${String(input.owner ?? "")}/${String(input.repo ?? "")}`} />
      {input.resource_id !== undefined ? <Param name="run" value={String(input.resource_id)} /> : null}
    </InputShell>
  );
}

export function OutputView({ result }: { result: string }) {
  const data = parseGithubActionsRuns(result);
  if (!data) return null;
  return (
    <RendererShell
      label={`Runs · ${data.totalCount}`}
      text={result}
      copyTitle="Copy runs"
      viewLabel="Workflow runs view"
    >
      <div className="tool-grep-results">
        {data.runs.map((run) => (
          <div key={run.id} className="grep-file-group">
            <div className="grep-file-header">
              <span className="grep-file-path">#{run.runNumber} {run.name}</span>
              <span className="grep-line-badge">{run.status}</span>
            </div>
            <div className="grep-match-row">
              <span className="grep-match-content">{run.displayTitle}</span>
            </div>
          </div>
        ))}
      </div>
    </RendererShell>
  );
}
