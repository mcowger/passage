import { parseGithubDirListing } from "../../lib/extra-tool-renderers.ts";
import type { ToolSummary } from "./types.ts";
import { FileTypeIcon } from "../FileTypeIcon.tsx";
import { InputShell, Param, RendererShell } from "./shared.tsx";

export function summary(input: Record<string, unknown>): ToolSummary {
  return {
    icon: "filecode",
    title: "GitHub file",
    subtitle: `${String(input.owner ?? "")}/${String(input.repo ?? "")} ${String(input.path ?? "")}`.trim(),
    isPath: true,
  };
}

export function handlesResult(result: string): boolean {
  return parseGithubDirListing(result) !== null;
}

export function InputBlock({ input }: { input: Record<string, unknown> }) {
  return (
    <InputShell
      label="File"
      copyText={`${String(input.owner ?? "")}/${String(input.repo ?? "")} ${String(input.path ?? "")}`.trim()}
      copyTitle="Copy path"
    >
      <Param value={`${String(input.owner ?? "")}/${String(input.repo ?? "")}`} />
      {input.path ? <Param name="path" value={String(input.path)} /> : null}
      {input.ref ? <Param name="ref" value={String(input.ref)} /> : null}
    </InputShell>
  );
}

export function OutputView({ result }: { result: string }) {
  const data = parseGithubDirListing(result);
  if (!data) return null;
  const dirs = data.filter((e) => e.entryType === "dir").length;
  const files = data.length - dirs;
  return (
    <RendererShell
      label={`Contents · ${files} files, ${dirs} dirs`}
      text={result}
      copyTitle="Copy listing"
      viewLabel="Directory listing view"
    >
      <div className="tool-grep-results">
        {data.map((entry) => (
          <div key={entry.path} className="grep-file-group">
            <div className="grep-file-header">
              <FileTypeIcon path={entry.name} size={12} />
              <span className="grep-file-path">{entry.path}</span>
            </div>
          </div>
        ))}
      </div>
    </RendererShell>
  );
}
