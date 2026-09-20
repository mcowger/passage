import { describeProcessAction } from "../../lib/extra-tool-renderers.ts";
import type { ToolSummary } from "./types.ts";
import { CopyButton } from "../CopyButton.tsx";
import { InputShell, Param } from "./shared.tsx";

export function summary(input: Record<string, unknown>): ToolSummary {
  return { icon: "system", title: "Process", subtitle: describeProcessAction(input) };
}

export function handlesResult(_result: string): boolean {
  return true;
}

export function InputBlock({ input }: { input: Record<string, unknown> }) {
  const command = typeof input.command === "string" ? input.command : "";
  return (
    <InputShell
      label={`Action · ${String(input.action ?? "")}`}
      copyText={JSON.stringify(input, null, 2)}
      copyTitle="Copy input"
    >
      {typeof input.name === "string" && input.name ? <Param name="name" value={input.name} /> : null}
      {typeof input.id === "string" && input.id ? <Param name="id" value={input.id} /> : null}
      {command ? <Param value={`${command.slice(0, 160)}${command.length > 160 ? "…" : ""}`} /> : null}
    </InputShell>
  );
}

export function OutputView({ result }: { result: string }) {
  return (
    <div className="tool-output-wrap">
      <div className="tool-section-header">
        <span className="tool-section-label">Status</span>
        <div className="tool-section-actions">
          <CopyButton text={result} title="Copy status" />
        </div>
      </div>
      <pre className="tool-output-pre"><code>{result}</code></pre>
    </div>
  );
}
