import { describe, expect, test } from "bun:test";
import {
  identifyExtraTool,
  guessExtraToolFromName,
  describeProcessAction,
  parseExaSearchOutput,
  parseExaFetchOutput,
  parseGithubDirListing,
  parseGithubCodeSearch,
  parseGithubRepoSearch,
  parseGithubActionsRun,
  parseGithubActionsRuns,
  parseGithubPr,
  parseRecallOutput,
} from "./extra-tool-renderers.ts";

describe("identifyExtraTool matches on substring + input shape", () => {
  test("matches exact names", () => {
    expect(identifyExtraTool("exa_web_search_exa", { query: "q" })).toBe("exa-search");
    expect(identifyExtraTool("exa_web_fetch_exa", { urls: ["https://a"] })).toBe("exa-fetch");
    expect(identifyExtraTool("exa_agent_run", { query: "q" })).toBe("exa-agent");
    expect(identifyExtraTool("github_get_file_contents", { owner: "o", repo: "r", path: "/" })).toBe("github-file");
    expect(identifyExtraTool("github_search_code", { query: "q" })).toBe("github-code");
    expect(identifyExtraTool("github_search_repositories", { query: "q" })).toBe("github-repos");
    expect(identifyExtraTool("github_actions_get", { method: "get_workflow_run", owner: "o", repo: "r", resource_id: "1" })).toBe("gh-actions-get");
    expect(identifyExtraTool("github_actions_list", { method: "list_workflow_runs", owner: "o", repo: "r" })).toBe("gh-actions-list");
    expect(identifyExtraTool("github_pull_request_read", { method: "get", owner: "o", repo: "r", pullNumber: 1 })).toBe("github-pr");
    expect(identifyExtraTool("github_actions_run_trigger", { method: "run_workflow", owner: "o", repo: "r", workflow_id: "ci.yml", ref: "main", inputs: {} })).toBe("gh-actions-trigger");
    expect(identifyExtraTool("vcc_recall", { query: "q", scope: "all" })).toBe("recall");
    expect(identifyExtraTool("process", { action: "start" })).toBe("process");
  });

  test("tolerates vendor prefixes on the name", () => {
    expect(identifyExtraTool("mcp_exa_web_search_exa", { query: "q" })).toBe("exa-search");
    expect(identifyExtraTool("ns_github_search_code", { query: "q" })).toBe("github-code");
    expect(identifyExtraTool("prefix_github_pull_request_read_suffix", { method: "get", owner: "o", repo: "r", pullNumber: 5 })).toBe("github-pr");
    expect(identifyExtraTool("my-process-v2", { action: "list" })).toBe("process");
  });

  test("rejects when the input shape does not confirm", () => {
    // Search name but fetch shape (urls) must not match search.
    expect(identifyExtraTool("exa_web_search_exa", { urls: ["https://a"] })).toBeUndefined();
    // File shape needs all three keys.
    expect(identifyExtraTool("github_get_file_contents", { owner: "o", repo: "r" })).toBeUndefined();
    // Actions get vs list distinguished by method/shape.
    expect(identifyExtraTool("github_actions_get", { method: "list_workflow_runs", owner: "o", repo: "r" })).toBe("gh-actions-list");
    // Unknown tools stay generic.
    expect(identifyExtraTool("bash", { command: "ls" })).toBeUndefined();
    expect(identifyExtraTool("subagent", { task: "x" })).toBeUndefined();
  });

  test("recall accepts touched mode without a query", () => {
    expect(identifyExtraTool("vcc_recall", { mode: "touched" })).toBe("recall");
  });
});

describe("guessExtraToolFromName is name-only for streaming labels", () => {
  test("guesses the common families", () => {
    expect(guessExtraToolFromName("exa_web_search_exa")).toBe("exa-search");
    expect(guessExtraToolFromName("github_pull_request_read")).toBe("github-pr");
    expect(guessExtraToolFromName("process")).toBe("process");
    expect(guessExtraToolFromName("bash")).toBeUndefined();
  });
});

describe("describeProcessAction", () => {
  test("combines action with name or id", () => {
    expect(describeProcessAction({ action: "start", name: "llama-persist" })).toBe("start llama-persist");
    expect(describeProcessAction({ action: "output", id: "proc_000f" })).toBe("output proc_000f");
    expect(describeProcessAction({ action: "list" })).toBe("list");
  });
});

describe("output parsers use real session shapes", () => {
  test("parses exa search Title/URL blocks", () => {
    const out = [
      "Title: frp | URL: https://github.com/fatedier/frp | Published: N/A | Author: N/A | Highlights:",
      "some body",
      "---",
      "Title: Other | URL: https://example.com/x | Published: 2026-01-01 | Author: Jane | Highlights:",
      "more",
    ].join("\n");
    const items = parseExaSearchOutput(out);
    expect(items?.length).toBe(2);
    expect(items?.[0]?.url).toBe("https://github.com/fatedier/frp");
    expect(items?.[1]?.author).toBe("Jane");
  });

  test("parses exa fetch docs and error lines", () => {
    const out = [
      "# GitHub - fatedier/frp",
      "URL: https://github.com/fatedier/frp",
      "Author: fatedier",
      "",
      "body text",
      "Error: Error fetching URL(s): https://x/: CRAWL_NOT_FOUND",
    ].join("\n");
    const parsed = parseExaFetchOutput(out);
    expect(parsed?.docs.length).toBe(1);
    expect(parsed?.docs[0]?.heading).toContain("fatedier/frp");
    expect(parsed?.errors.length).toBe(1);
  });

  test("parses github dir listings and rejects file text", () => {
    const dir = JSON.stringify([
      { type: "dir", size: 0, name: ".github", path: ".github" },
      { type: "file", size: 324, name: ".gitignore", path: ".gitignore" },
    ]);
    expect(parseGithubDirListing(dir)?.length).toBe(2);
    expect(parseGithubDirListing("successfully downloaded text file (SHA: abc)\ncode")).toBeNull();
  });

  test("parses code search with fragments", () => {
    const out = JSON.stringify({
      total_count: 1,
      incomplete_results: false,
      items: [{
        name: "flags.go", path: "pkg/config/flags.go", repository: "fatedier/frp",
        text_matches: [{ fragment: "func RegisterProxyFlags(cmd", matches: [] }],
      }],
    });
    const parsed = parseGithubCodeSearch(out);
    expect(parsed?.totalCount).toBe(1);
    expect(parsed?.items[0]?.fragment).toContain("RegisterProxyFlags");
  });

  test("repo search requires full_name items", () => {
    const repos = JSON.stringify({
      total_count: 1,
      items: [{ full_name: "getpaseo/paseo", description: "Orchestrate", language: "TypeScript", stargazers_count: 17147 }],
    });
    expect(parseGithubRepoSearch(repos)?.items[0]?.stars).toBe(17147);
    const code = JSON.stringify({ total_count: 1, items: [{ name: "a", path: "b" }] });
    expect(parseGithubRepoSearch(code)).toBeNull();
  });

  test("actions run vs runs list distinguished by workflow_runs key", () => {
    const run = JSON.stringify({ id: 1, name: "CI", display_title: "fix", status: "completed", conclusion: "success", head_branch: "main", run_number: 40, event: "push" });
    expect(parseGithubActionsRun(run)?.runNumber).toBe(40);
    expect(parseGithubActionsRuns(run)).toBeNull();
    const list = JSON.stringify({ total_count: 1, workflow_runs: [JSON.parse(run)] });
    expect(parseGithubActionsRuns(list)?.runs.length).toBe(1);
    expect(parseGithubActionsRun(list)).toBeNull();
  });

  test("PR shapes: object, comments array, error", () => {
    expect(parseGithubPr(JSON.stringify({ number: 29602, title: "Flatten namespace tools" }))?.shape).toBe("pr");
    expect(parseGithubPr(JSON.stringify([{ id: 1 }]))?.shape).toBe("comments");
    expect(parseGithubPr("Error: failed to get pull request: 404")?.shape).toBe("error");
    expect(parseGithubPr("plain text")).toBeNull();
  });

  test("recall parses page header and #id entries", () => {
    const out = [
      'Page 1/8 (40 total matches (scope: all)) for "q":',
      "",
      "#393 [tool_result] some preview text",
      "#392 [assistant] other preview",
    ].join("\n");
    const parsed = parseRecallOutput(out);
    expect(parsed?.totalMatches).toBe(40);
    expect(parsed?.pageInfo).toBe("Page 1/8");
    expect(parsed?.entries.length).toBe(2);
    expect(parsed?.entries[0]?.kind).toBe("tool_result");
  });
});
