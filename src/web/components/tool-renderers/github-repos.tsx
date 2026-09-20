import { Star } from "lucide-react";
import { parseGithubRepoSearch } from "../../lib/extra-tool-renderers.ts";
import type { ToolSummary } from "./types.ts";
import { InputShell, Param, RendererShell } from "./shared.tsx";

export function summary(input: Record<string, unknown>): ToolSummary {
  return { icon: "package", title: "Repo search", subtitle: String(input.query ?? "") };
}

export function handlesResult(result: string): boolean {
  return parseGithubRepoSearch(result) !== null;
}

export function InputBlock({ input }: { input: Record<string, unknown> }) {
  return (
    <InputShell
      label="Search Query"
      copyText={String(input.query ?? "")}
      copyTitle="Copy query"
    >
      <Param value={String(input.query ?? "")} />
    </InputShell>
  );
}

export function OutputView({ result }: { result: string }) {
  const data = parseGithubRepoSearch(result);
  if (!data) return null;
  return (
    <RendererShell
      label={`Repos · ${data.totalCount}`}
      text={result}
      copyTitle="Copy repos"
      viewLabel="Repo search view"
    >
      <div className="tool-grep-results">
        {data.items.map((repo) => (
          <div key={repo.fullName} className="grep-file-group">
            <div className="grep-file-header">
              <span className="grep-file-path">{repo.fullName}</span>
              <span className="grep-line-badge"><Star size={11} aria-hidden="true" /> {repo.stars}</span>
            </div>
            <div className="grep-match-row">
              <span className="grep-match-content">{[repo.language, repo.description].filter(Boolean).join(" · ") || " "}</span>
            </div>
          </div>
        ))}
      </div>
    </RendererShell>
  );
}
