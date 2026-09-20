/** Dedicated matchers + output parsers for the second batch of tool renderers.
 *
 *  Matching is deliberately NOT exact-name: tool names gain vendor/prefix
 *  segments over time (`exa_web_search_exa`, `mcp_...`, ...). Every matcher
 *  below requires (1) a case-insensitive substring hit on the tool name AND
 *  (2) confirmation from the input shape (expected keys present). Callers
 *  should pass the effective (streaming-unwrapped) input.
 */

export type ExtraToolKind =
  | "exa-search"
  | "exa-fetch"
  | "exa-agent"
  | "github-file"
  | "github-code"
  | "github-repos"
  | "gh-actions-get"
  | "gh-actions-list"
  | "github-pr"
  | "gh-actions-trigger"
  | "recall"
  | "process";

type Input = Record<string, unknown>;

const lower = (name: string): string => name.toLowerCase();

function includes(name: string, ...fragments: string[]): boolean {
  const n = lower(name);
  return fragments.some((f) => n.includes(f));
}

function has(input: Input, ...keys: string[]): boolean {
  return keys.some((k) => input[k] !== undefined);
}

function hasAll(input: Input, ...keys: string[]): boolean {
  return keys.every((k) => input[k] !== undefined);
}

/** Substring + input-shape identification. Returns undefined for generic tools. */
export function identifyExtraTool(name: string, input: Input): ExtraToolKind | undefined {
  const n = lower(name);

  // Exa web search: query (+ objective), never urls.
  if ((includes(n, "web_search") || (n.includes("exa") && n.includes("search"))) && has(input, "query")) {
    if (input.urls === undefined) return "exa-search";
  }
  // Exa fetch: urls array.
  if (includes(n, "web_fetch") || (n.includes("exa") && n.includes("fetch"))) {
    if (Array.isArray(input.urls)) return "exa-fetch";
  }
  // Exa agent research: query + effort/outputSchema, name carries agent_run.
  if (includes(n, "agent_run") && has(input, "query")) return "exa-agent";
  // GitHub file contents: owner + repo + path.
  if (includes(n, "get_file_contents") && hasAll(input, "owner", "repo", "path")) return "github-file";
  // GitHub code search: search_code + query.
  if (includes(n, "search_code") && has(input, "query")) return "github-code";
  // GitHub repo search: search_repositor + query. Check before generic "search".
  if (includes(n, "search_repositor") && has(input, "query")) return "github-repos";
  // GitHub PR: pull_request + pullNumber + method.
  if (includes(n, "pull_request") && hasAll(input, "pullNumber", "method")) return "github-pr";
  // GitHub Actions trigger: run_workflow method OR workflow_id + ref (+ inputs).
  if (includes(n, "actions") || includes(n, "workflow")) {
    const method = typeof input.method === "string" ? input.method.toLowerCase() : "";
    if (method === "run_workflow" || (hasAll(input, "workflow_id", "ref") && has(input, "owner", "repo"))) {
      return "gh-actions-trigger";
    }
    if (method.startsWith("list_") || has(input, "perPage", "page")) {
      if (has(input, "owner", "repo")) return "gh-actions-list";
    }
    if (method.startsWith("get_") || has(input, "resource_id")) {
      if (has(input, "owner", "repo")) return "gh-actions-get";
    }
  }
  // Session recall: recall in name + (query/scope or touched mode).
  if (includes(n, "recall") && (has(input, "query", "scope") || has(input, "mode"))) return "recall";
  // Background processes: process in name + action.
  if (n === "process" || (includes(n, "process") && has(input, "action"))) return "process";

  return undefined;
}

/** Name-only fallback for streaming states where args haven't arrived yet.
 *  Used for pending/running labels only -- never for choosing a renderer. */
export function guessExtraToolFromName(name: string): ExtraToolKind | undefined {
  const n = lower(name);
  if (n.includes("web_search")) return "exa-search";
  if (n.includes("web_fetch")) return "exa-fetch";
  if (n.includes("agent_run")) return "exa-agent";
  if (n.includes("get_file_contents")) return "github-file";
  if (n.includes("search_code")) return "github-code";
  if (n.includes("search_repositor")) return "github-repos";
  if (n.includes("pull_request")) return "github-pr";
  if (n.includes("actions")) {
    if (n.includes("trigger") || n.includes("run")) return "gh-actions-trigger";
    return "gh-actions-get";
  }
  if (n.includes("recall")) return "recall";
  if (n === "process") return "process";
  return undefined;
}

// ---------------------------------------------------------------------------
// Output parsers
// ---------------------------------------------------------------------------

export type ExaSearchItem = {
  title: string;
  url: string;
  published: string;
  author: string;
};

export function parseExaSearchOutput(output: string): ExaSearchItem[] | null {
  if (!output || typeof output !== "string" || !output.includes("Title:")) return null;
  const blocks = output.split(/\n---\n/).map((b) => b.trim()).filter(Boolean);
  const items: ExaSearchItem[] = [];
  for (const block of blocks) {
    const title = /Title:\s*([^\n|]+)/.exec(block)?.[1]?.trim();
    const url = /URL:\s*(\S+)/.exec(block)?.[1]?.trim();
    if (!title || !url) continue;
    items.push({
      title,
      url,
      published: /Published:\s*([^\n|]+)/.exec(block)?.[1]?.trim() ?? "",
      author: /Author:\s*([^\n|]+)/.exec(block)?.[1]?.trim() ?? "",
    });
  }
  return items.length > 0 ? items : null;
}

export type ExaFetchDoc = {
  heading: string;
  url: string;
  author: string;
};

export type ExaFetchParsed = {
  docs: ExaFetchDoc[];
  errors: string[];
};

export function parseExaFetchOutput(output: string): ExaFetchParsed | null {
  if (!output || typeof output !== "string") return null;
  const errors = output
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => /^error:/i.test(l));
  const docs: ExaFetchDoc[] = [];
  // Docs look like "# Heading\nURL: https://...". Split on headings.
  const parts = output.split(/(?=^#\s+)/m).map((p) => p.trim()).filter(Boolean);
  for (const part of parts) {
    if (/^error:/i.test(part)) continue;
    const heading = /^#\s*([^\n]+)/.exec(part)?.[1]?.trim();
    const url = /^URL:\s*(\S+)/m.exec(part)?.[1]?.trim();
    if (!heading) continue;
    docs.push({
      heading,
      url: url ?? "",
      author: /^Author:\s*([^\n]+)/m.exec(part)?.[1]?.trim() ?? "",
    });
  }
  if (docs.length === 0 && errors.length === 0) return null;
  return { docs, errors };
}

export type GithubDirEntry = {
  name: string;
  path: string;
  entryType: string;
  size: number;
};

export function parseGithubDirListing(output: string): GithubDirEntry[] | null {
  const trimmed = output.trim();
  if (!trimmed.startsWith("[")) return null;
  try {
    const parsed: unknown = JSON.parse(trimmed);
    if (!Array.isArray(parsed)) return null;
    const entries: GithubDirEntry[] = [];
    for (const item of parsed) {
      if (typeof item !== "object" || item === null) continue;
      const rec = item as Record<string, unknown>;
      if (typeof rec.name !== "string" || typeof rec.path !== "string") continue;
      entries.push({
        name: rec.name,
        path: rec.path,
        entryType: typeof rec.type === "string" ? rec.type : "file",
        size: typeof rec.size === "number" ? rec.size : 0,
      });
    }
    return entries.length > 0 ? entries : null;
  } catch {
    return null;
  }
}

export type GithubCodeMatch = {
  name: string;
  path: string;
  repository: string;
  fragment: string;
};

export type GithubCodeSearch = {
  totalCount: number;
  items: GithubCodeMatch[];
};

export function parseGithubCodeSearch(output: string): GithubCodeSearch | null {
  const trimmed = output.trim();
  if (!trimmed.startsWith("{")) return null;
  try {
    const parsed = JSON.parse(trimmed) as Record<string, unknown>;
    if (!Array.isArray(parsed.items)) return null;
    const items: GithubCodeMatch[] = [];
    for (const raw of parsed.items) {
      if (typeof raw !== "object" || raw === null) continue;
      const rec = raw as Record<string, unknown>;
      if (typeof rec.name !== "string" || typeof rec.path !== "string") continue;
      const matches = Array.isArray(rec.text_matches) ? rec.text_matches : [];
      const fragment =
        matches
          .map((m) => (typeof m === "object" && m !== null ? String((m as Record<string, unknown>).fragment ?? "") : ""))
          .find((f) => f.trim()) ?? "";
      items.push({
        name: rec.name,
        path: rec.path,
        repository: typeof rec.repository === "string" ? rec.repository : "",
        fragment: fragment.trim().slice(0, 400),
      });
    }
    return {
      totalCount: typeof parsed.total_count === "number" ? parsed.total_count : items.length,
      items,
    };
  } catch {
    return null;
  }
}

export type GithubRepoMatch = {
  fullName: string;
  description: string;
  language: string;
  stars: number;
};

export type GithubRepoSearch = {
  totalCount: number;
  items: GithubRepoMatch[];
};

export function parseGithubRepoSearch(output: string): GithubRepoSearch | null {
  const trimmed = output.trim();
  if (!trimmed.startsWith("{")) return null;
  try {
    const parsed = JSON.parse(trimmed) as Record<string, unknown>;
    if (!Array.isArray(parsed.items)) return null;
    // Distinguish from code search: repo items carry full_name + stargazers_count.
    if (parsed.items.length > 0) {
      const first = parsed.items[0] as Record<string, unknown>;
      if (typeof first.full_name !== "string") return null;
    } else if (typeof parsed.total_count !== "number") {
      return null;
    }
    const items: GithubRepoMatch[] = [];
    for (const raw of parsed.items) {
      if (typeof raw !== "object" || raw === null) continue;
      const rec = raw as Record<string, unknown>;
      if (typeof rec.full_name !== "string") continue;
      items.push({
        fullName: rec.full_name,
        description: typeof rec.description === "string" ? rec.description : "",
        language: typeof rec.language === "string" ? rec.language : "",
        stars: typeof rec.stargazers_count === "number" ? rec.stargazers_count : 0,
      });
    }
    return {
      totalCount: typeof parsed.total_count === "number" ? parsed.total_count : items.length,
      items,
    };
  } catch {
    return null;
  }
}

export type GithubActionsRun = {
  id: number;
  name: string;
  displayTitle: string;
  status: string;
  conclusion: string;
  headBranch: string;
  runNumber: number;
  event: string;
};

export function parseGithubActionsRun(output: string): GithubActionsRun | null {
  const trimmed = output.trim();
  if (!trimmed.startsWith("{")) return null;
  try {
    const parsed = JSON.parse(trimmed) as Record<string, unknown>;
    if (typeof parsed.id !== "number" || Array.isArray(parsed.workflow_runs)) return null;
    if (typeof parsed.display_title !== "string" && typeof parsed.name !== "string") return null;
    return {
      id: parsed.id,
      name: typeof parsed.name === "string" ? parsed.name : "",
      displayTitle: typeof parsed.display_title === "string" ? parsed.display_title : "",
      status: typeof parsed.status === "string" ? parsed.status : "",
      conclusion: typeof parsed.conclusion === "string" ? parsed.conclusion : "",
      headBranch: typeof parsed.head_branch === "string" ? parsed.head_branch : "",
      runNumber: typeof parsed.run_number === "number" ? parsed.run_number : 0,
      event: typeof parsed.event === "string" ? parsed.event : "",
    };
  } catch {
    return null;
  }
}

export type GithubActionsRuns = {
  totalCount: number;
  runs: GithubActionsRun[];
};

export function parseGithubActionsRuns(output: string): GithubActionsRuns | null {
  const trimmed = output.trim();
  if (!trimmed.startsWith("{")) return null;
  try {
    const parsed = JSON.parse(trimmed) as Record<string, unknown>;
    if (!Array.isArray(parsed.workflow_runs)) return null;
    const runs: GithubActionsRun[] = [];
    for (const raw of parsed.workflow_runs) {
      if (typeof raw !== "object" || raw === null) continue;
      const rec = raw as Record<string, unknown>;
      if (typeof rec.id !== "number") continue;
      runs.push({
        id: rec.id,
        name: typeof rec.name === "string" ? rec.name : "",
        displayTitle: typeof rec.display_title === "string" ? rec.display_title : "",
        status: typeof rec.status === "string" ? rec.status : "",
        conclusion: typeof rec.conclusion === "string" ? rec.conclusion : "",
        headBranch: typeof rec.head_branch === "string" ? rec.head_branch : "",
        runNumber: typeof rec.run_number === "number" ? rec.run_number : 0,
        event: typeof rec.event === "string" ? rec.event : "",
      });
    }
    return {
      totalCount: typeof parsed.total_count === "number" ? parsed.total_count : runs.length,
      runs,
    };
  } catch {
    return null;
  }
}

export type GithubPr =
  | { shape: "pr"; number: number; title: string; stateHint: string }
  | { shape: "comments"; count: number }
  | { shape: "error" };

export function parseGithubPr(output: string): GithubPr | null {
  const trimmed = output.trim();
  if (trimmed.startsWith("{")) {
    try {
      const parsed = JSON.parse(trimmed) as Record<string, unknown>;
      if (typeof parsed.number === "number" && typeof parsed.title === "string") {
        return {
          shape: "pr",
          number: parsed.number,
          title: parsed.title,
          stateHint: typeof parsed.state === "string" ? parsed.state : "",
        };
      }
    } catch {
      return null;
    }
    return null;
  }
  if (trimmed.startsWith("[")) {
    try {
      const parsed: unknown = JSON.parse(trimmed);
      if (Array.isArray(parsed)) return { shape: "comments", count: parsed.length };
    } catch {
      return null;
    }
    return null;
  }
  if (/^error:/i.test(trimmed)) return { shape: "error" };
  return null;
}

export type RecallEntry = {
  id: string;
  kind: string;
  preview: string;
};

export type RecallParsed = {
  pageInfo: string;
  totalMatches: number;
  entries: RecallEntry[];
};

export function parseRecallOutput(output: string): RecallParsed | null {
  if (!output || typeof output !== "string") return null;
  const firstLine = output.split("\n")[0] ?? "";
  const pageMatch = /Page\s+(\d+)\/(\d+)\s+\((\d+)[^)]*\)/.exec(firstLine);
  if (!pageMatch && !output.includes("#")) return null;
  const entries: RecallEntry[] = [];
  for (const line of output.split("\n")) {
    const m = /^#(\S+)\s+\[([^\]]+)\]\s*(.*)$/.exec(line.trim());
    if (!m) continue;
    entries.push({ id: m[1] ?? "", kind: m[2] ?? "", preview: (m[3] ?? "").slice(0, 220) });
  }
  return {
    pageInfo: pageMatch ? `Page ${pageMatch[1]}/${pageMatch[2]}` : "",
    totalMatches: pageMatch ? Number(pageMatch[3]) : entries.length,
    entries,
  };
}

/** Short human label for a process action + target, e.g. `start llama-persist`. */
export function describeProcessAction(input: Input): string {
  const action = typeof input.action === "string" ? input.action : "";
  const target =
    typeof input.name === "string" && input.name
      ? input.name
      : typeof input.id === "string" && input.id
        ? input.id
        : "";
  return target ? `${action} ${target}` : action;
}
