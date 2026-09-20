import type { ReactNode } from "react";
import type { ExtraToolKind } from "../../lib/extra-tool-renderers.ts";
import type { ToolSummary } from "./types.ts";
import * as exaSearch from "./exa-search.tsx";
import * as exaFetch from "./exa-fetch.tsx";
import * as exaAgent from "./exa-agent.tsx";
import * as githubFile from "./github-file.tsx";
import * as githubCode from "./github-code.tsx";
import * as githubRepos from "./github-repos.tsx";
import * as githubActionsGet from "./github-actions-get.tsx";
import * as githubActionsList from "./github-actions-list.tsx";
import * as githubActionsTrigger from "./github-actions-trigger.tsx";
import * as githubPr from "./github-pr.tsx";
import * as recall from "./recall.tsx";
import * as processRenderer from "./process.tsx";

export type ExtraRenderer = {
  summary: (input: Record<string, unknown>) => ToolSummary;
  /** False when the result shape belongs to a generic view (e.g. JSON). */
  handlesResult: (result: string) => boolean;
  OutputView: (props: { result: string }) => ReactNode;
  InputBlock: (props: { input: Record<string, unknown> }) => ReactNode;
};

export const EXTRA_RENDERERS: Record<ExtraToolKind, ExtraRenderer> = {
  "exa-search": exaSearch,
  "exa-fetch": exaFetch,
  "exa-agent": exaAgent,
  "github-file": githubFile,
  "github-code": githubCode,
  "github-repos": githubRepos,
  "gh-actions-get": githubActionsGet,
  "gh-actions-list": githubActionsList,
  "gh-actions-trigger": githubActionsTrigger,
  "github-pr": githubPr,
  recall,
  process: processRenderer,
};

export function getExtraToolSummary(kind: ExtraToolKind, input: Record<string, unknown>): ToolSummary {
  return EXTRA_RENDERERS[kind].summary(input);
}

/** Stable-identity dispatchers so per-module toggle state survives re-renders. */
export function ExtraOutputView({ kind, result }: { kind: ExtraToolKind; result: string }) {
  const View = EXTRA_RENDERERS[kind].OutputView;
  return <View result={result} />;
}

export function ExtraInputBlock({ kind, input }: { kind: ExtraToolKind; input: Record<string, unknown> }) {
  const Block = EXTRA_RENDERERS[kind].InputBlock;
  return <Block input={input} />;
}
