import { tryParseJson } from "../../lib/tool-display.ts";
import type { ToolSummary } from "./types.ts";
import { CopyButton } from "../CopyButton.tsx";
import { InputShell, Param } from "./shared.tsx";

export function summary(input: Record<string, unknown>): ToolSummary {
  return {
    icon: "trigger",
    title: "Trigger",
    subtitle: `${String(input.workflow_id ?? "")} @ ${String(input.ref ?? "")}`,
  };
}

export function handlesResult(_result: string): boolean {
  return true;
}

export function InputBlock({ input }: { input: Record<string, unknown> }) {
  return (
    <InputShell
      label="Trigger"
      copyText={JSON.stringify(input, null, 2)}
      copyTitle="Copy input"
    >
      {input.workflow_id ? <Param name="workflow" value={String(input.workflow_id)} /> : null}
      {input.ref ? <Param name="ref" value={String(input.ref)} /> : null}
    </InputShell>
  );
}

export function OutputView({ result }: { result: string }) {
  const parsed = tryParseJson(result);
  const message = parsed.isJson && typeof parsed.data === "object" && parsed.data !== null
    ? String((parsed.data as Record<string, unknown>).message ?? "")
    : "";
  return (
    <div className="tool-output-wrap">
      <div className="tool-section-header">
        <span className="tool-section-label">Triggered</span>
        <div className="tool-section-actions">
          <CopyButton text={result} title="Copy result" />
        </div>
      </div>
      {message ? (
        <div className="tool-search-count">{message}</div>
      ) : (
        <pre className="tool-output-pre"><code>{result}</code></pre>
      )}
    </div>
  );
}
