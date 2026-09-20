import { parseExaFetchOutput } from "../../lib/extra-tool-renderers.ts";
import type { ToolSummary } from "./types.ts";
import { InputShell, Param, RendererShell } from "./shared.tsx";

export function summary(input: Record<string, unknown>): ToolSummary {
  const urls = Array.isArray(input.urls) ? (input.urls as unknown[]) : [];
  const first = typeof urls[0] === "string" ? urls[0] : "";
  const host = first.replace(/^https?:\/\//, "").split("/")[0] ?? "";
  const extra = urls.length > 1 ? ` +${urls.length - 1} more` : "";
  return { icon: "download", title: "Fetch", subtitle: `${host}${extra}`.trim() || `${urls.length} pages` };
}

export function handlesResult(result: string): boolean {
  return parseExaFetchOutput(result) !== null;
}

export function InputBlock({ input }: { input: Record<string, unknown> }) {
  const urls = Array.isArray(input.urls) ? (input.urls as unknown[]) : [];
  return (
    <InputShell
      label={`URLs · ${urls.length}`}
      copyText={urls.map(String).join("\n")}
      copyTitle="Copy URLs"
    >
      {urls.slice(0, 5).map((u) => (
        <Param key={String(u)} value={String(u)} />
      ))}
      {urls.length > 5 ? <Param value={`+${urls.length - 5} more`} /> : null}
    </InputShell>
  );
}

export function OutputView({ result }: { result: string }) {
  const data = parseExaFetchOutput(result);
  if (!data) return null;
  return (
    <RendererShell
      label={`Pages · ${data.docs.length}`}
      text={result}
      copyTitle="Copy pages"
      viewLabel="Fetched pages view"
    >
      <div className="tool-grep-results">
        {data.errors.map((err) => (
          <pre key={err.slice(0, 80)} className="tool-output-pre error"><code>{err}</code></pre>
        ))}
        {data.docs.map((doc) => (
          <div key={`${doc.url}${doc.heading}`} className="grep-file-group">
            <div className="grep-file-header">
              <span className="grep-file-path">{doc.heading}</span>
            </div>
            {doc.url ? (
              <div className="grep-match-row">
                <span className="grep-match-content">{doc.url}</span>
              </div>
            ) : null}
          </div>
        ))}
      </div>
    </RendererShell>
  );
}
