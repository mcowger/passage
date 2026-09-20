import { parseGithubActionsRun } from "../../lib/extra-tool-renderers.ts";
import type { ToolSummary } from "./types.ts";
import { InputShell, Param, RendererShell } from "./shared.tsx";

export function summary(input: Record<string, unknown>): ToolSummary {
  return {
    icon: "activity",
    title: "Actions run",
    subtitle: `${String(input.owner ?? "")}/${String(input.repo ?? "")} #${String(input.resource_id ?? "")}`,
  };
}

export function handlesResult(result: string): boolean {
  return parseGithubActionsRun(result) !== null;
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
  const data = parseGithubActionsRun(result);
  if (!data) return null;
  return (
    <RendererShell
      label={`Run #${data.runNumber} · ${data.status}${data.conclusion ? ` · ${data.conclusion}` : ""}`}
      text={result}
      copyTitle="Copy run"
      viewLabel="Workflow run view"
    >
      <div className="tool-grep-results">
        <div className="grep-file-group">
          <div className="grep-file-header">
            <span className="grep-file-path">{data.name}</span>
          </div>
          <div className="grep-match-row">
            <span className="grep-match-content">{data.displayTitle}</span>
          </div>
          <div className="grep-match-row">
            <span className="grep-match-content">{[data.headBranch, data.event].filter(Boolean).join(" · ")}</span>
          </div>
        </div>
      </div>
    </RendererShell>
  );
}
