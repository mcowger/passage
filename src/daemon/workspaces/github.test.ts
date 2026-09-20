import { describe, expect, test } from "bun:test";
import { GhError, GhService, parsePrJson, parseRepoJson } from "./github.ts";

describe("parsePrJson", () => {
  test("parses a gh pr view record", () => {
    expect(
      parsePrJson({
        number: 123,
        url: "https://github.com/o/r/pull/123",
        title: "Ship it",
        state: "OPEN",
        baseRefName: "main",
        headRefName: "feature",
        isDraft: false,
      }),
    ).toEqual({
      number: 123,
      url: "https://github.com/o/r/pull/123",
      title: "Ship it",
      state: "OPEN",
      base: "main",
      head: "feature",
      isDraft: false,
    });
  });
  test("rejects unusable shapes", () => {
    expect(parsePrJson(null)).toBeNull();
    expect(parsePrJson({})).toBeNull();
    expect(parsePrJson({ number: "123", url: "x" })).toBeNull();
  });
});

describe("parseRepoJson", () => {
  test("parses a gh repo view record", () => {
    expect(parseRepoJson({ nameWithOwner: "o/r", defaultBranchRef: { name: "main" } })).toEqual({
      nameWithOwner: "o/r",
      defaultBranch: "main",
    });
  });
  test("falls back to main without a branch ref", () => {
    expect(parseRepoJson({ nameWithOwner: "o/r" })).toEqual({ nameWithOwner: "o/r", defaultBranch: "main" });
    expect(parseRepoJson(null)).toBeNull();
  });
});

describe("GhService without a binary", () => {
  // A bogus executable exercises the spawn-failure path without touching
  // the network or requiring `gh` auth in the test environment.
  const missing = new GhService(2, "/nonexistent-gh-binary-passage-test");

  test("installed/available resolve false instead of throwing", async () => {
    expect(await missing.installed("/tmp")).toBe(false);
    expect(await missing.available("/tmp")).toBe(false);
  });

  test("repoInfo resolves null instead of throwing", async () => {
    expect(await missing.repoInfo("/tmp")).toBeNull();
  });

  test("prForBranch surfaces a GhError (not a silent null)", async () => {
    await expect(missing.prForBranch("/tmp")).rejects.toBeInstanceOf(GhError);
  });

  test("createPr rejects an empty title before spawning", async () => {
    await expect(missing.createPr("/tmp", { title: "  ", body: "" })).rejects.toBeInstanceOf(GhError);
  });
});
