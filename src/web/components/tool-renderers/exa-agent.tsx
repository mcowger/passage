import { tryParseJson } from "../../lib/tool-display.ts";
import type { ToolSummary } from "./types.ts";
import { CopyButton } from "../CopyButton.tsx";
import { InputShell, Param } from "./shared.tsx";

export function summary(input: Record<string, unknown>): ToolSummary {
  const effort = typeof input.effort === "string" ? ` · ${input.effort}` : "";
  return { icon: "agent", title: "Research", subtitle: `${String(input.query ?? "")}${effort}` };
}

/** JSON-schema runs render in the generic JSON view; text reports get the Report card. */
export function handlesResult(result: string): boolean {
  return !tryParseJson(result).isJson;
}

export function InputBlock({ input }: { input: Record<string, unknown> }) {
  const query = String(input.query ?? "");
  return (
    <InputShell
      label="Research Task"
      copyText={query}
      copyTitle="Copy task"
    >
      <Param value={`${query.slice(0, 300)}${query.length > 300 ? "…" : ""}`} />
      {input.effort ? <Param name="effort" value={String(input.effort)} /> : null}
    </InputShell>
  );
}

export function OutputView({ result }: { result: string }) {
  return (
    <div className="tool-output-wrap">
      <div className="tool-section-header">
        <span className="tool-section-label">Report</span>
        <div className="tool-section-actions">
          <CopyButton text={result} title="Copy report" />
        </div>
      </div>
      <pre className="tool-output-pre"><code>{result}</code></pre>
    </div>
  );
}
