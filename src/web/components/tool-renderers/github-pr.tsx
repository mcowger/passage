import { parseGithubPr } from "../../lib/extra-tool-renderers.ts";
import type { ToolSummary } from "./types.ts";
import { CopyButton } from "../CopyButton.tsx";
import { InputShell, Param } from "./shared.tsx";

export function summary(input: Record<string, unknown>): ToolSummary {
  return {
    icon: "pr",
    title: `PR #${String(input.pullNumber ?? "")}`,
    subtitle: `${String(input.owner ?? "")}/${String(input.repo ?? "")} · ${String(input.method ?? "")}`,
  };
}

export function handlesResult(result: string): boolean {
  return parseGithubPr(result) !== null;
}

export function InputBlock({ input }: { input: Record<string, unknown> }) {
  return (
    <InputShell
      label="Pull Request"
      copyText={`${String(input.owner ?? "")}/${String(input.repo ?? "")}#${String(input.pullNumber)}`}
      copyTitle="Copy ref"
    >
      <Param value={`${String(input.owner ?? "")}/${String(input.repo ?? "")}#${String(input.pullNumber)}`} />
      {input.method ? <Param name="method" value={String(input.method)} /> : null}
    </InputShell>
  );
}

export function OutputView({ result }: { result: string }) {
  const data = parseGithubPr(result);
  if (!data) return null;
  return (
    <div className="tool-output-wrap">
      <div className="tool-section-header">
        <span className="tool-section-label">
          {data.shape === "pr" ? `PR #${data.number}` : data.shape === "comments" ? `Comments · ${data.count}` : "Error"}
        </span>
        <div className="tool-section-actions">
          <CopyButton text={result} title="Copy PR" />
        </div>
      </div>
      {data.shape === "pr" ? (
        <div className="tool-grep-results">
          <div className="grep-file-group">
            <div className="grep-file-header">
              <span className="grep-file-path">#{data.number}</span>
            </div>
            <div className="grep-match-row">
              <span className="grep-match-content">{data.title}</span>
            </div>
          </div>
        </div>
      ) : data.shape === "comments" ? (
        <div className="tool-search-count">{data.count} comment{data.count === 1 ? "" : "s"} — see raw output</div>
      ) : (
        <pre className="tool-output-pre error"><code>{result}</code></pre>
      )}
    </div>
  );
}
