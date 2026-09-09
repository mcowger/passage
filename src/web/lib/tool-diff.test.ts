import { describe, expect, test } from "bun:test";
import { getToolDiff } from "./tool-diff.ts";

describe("getToolDiff", () => {
  test("calculates edit deltas and keeps line numbers for inline previews", () => {
    const diff = getToolDiff({
      name: "edit",
      input: { path: "tsconfig.json", oldText: '"include": ["src"]', newText: '"include": ["src", "tests"]' },
    });

    expect(diff).toMatchObject({ path: "tsconfig.json", additions: 1, deletions: 1, contextLines: 0 });
    expect(diff?.lines).toEqual([
      { kind: "removed", text: '"include": ["src"]', oldLine: 1 },
      { kind: "added", text: '"include": ["src", "tests"]', newLine: 1 },
    ]);
  });

  test("supports unified patches and write content", () => {
    const patch = getToolDiff({
      name: "apply_patch",
      input: { path: "src/app.ts", patch: "@@ -1,2 +1,3 @@\n const app = true;\n+const ready = true;\n export default app;" },
    });
    const write = getToolDiff({ name: "write", input: { path: "README.md", content: "# Passage\n\nReady" } });

    expect(patch).toMatchObject({ additions: 1, deletions: 0, contextLines: 2 });
    expect(write).toMatchObject({ path: "README.md", additions: 3, deletions: 0 });
  });
});
