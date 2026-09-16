import { describe, expect, test } from "bun:test";
import { fnv1a32, portScriptWorktreePath, resolveStart, stableBasePort } from "./dev-port.ts";

describe("dev-port", () => {
  test("fnv1a32 matches the standard empty-string vector", () => {
    expect(fnv1a32("")).toBe(0x811c9dc5);
  });

  test("stableBasePort is deterministic and inside 3000-3999", () => {
    const first = stableBasePort("/home/user/workspace/passage");
    const second = stableBasePort("/home/user/workspace/passage");
    expect(first).toBe(second);
    expect(first).toBeGreaterThanOrEqual(3000);
    expect(first).toBeLessThanOrEqual(3999);
  });

  test("distinct worktree paths map to distinct ports", () => {
    expect(stableBasePort("/home/user/workspace/passage")).not.toBe(
      stableBasePort("/home/user/workspace/paseo-worktrees/abc123/special-spider"),
    );
  });

  test("explicit PORT wins over PASEO_PORT, PASEO_PORT wins over hash", () => {
    expect(resolveStart({ PORT: "3333", PASEO_PORT: "3456" })).toEqual({ start: 3333, wrap: true });
    expect(resolveStart({ PASEO_PORT: "3456" })).toEqual({ start: 3456, wrap: true });
    expect(resolveStart({ PORT: "9999" })).toEqual({ start: 9999, wrap: false });
  });

  test("invalid PORT falls through to PASEO_PORT, then hash", () => {
    expect(resolveStart({ PORT: "nope", PASEO_PORT: "3456" })).toEqual({ start: 3456, wrap: true });
    const fallback = resolveStart({});
    expect(fallback.wrap).toBe(true);
    expect(fallback.start).toBeGreaterThanOrEqual(3000);
    expect(fallback.start).toBeLessThanOrEqual(3999);
  });

  test("portScript mode triggers on positional args, prefers PASEO_WORKTREE_PATH", () => {
    const argv = ["/bin/bun", "scripts/dev-port.ts", "dev", "ws1", "main", "/wt/a"];
    expect(portScriptWorktreePath(argv, {})).toBe("/wt/a");
    expect(portScriptWorktreePath(argv, { PASEO_WORKTREE_PATH: "/wt/b" })).toBe("/wt/b");
    expect(portScriptWorktreePath(["/bin/bun", "scripts/dev-port.ts"], {})).toBeNull();
    expect(portScriptWorktreePath(["/bin/bun", "scripts/dev-port.ts"], { PASEO_WORKTREE_PATH: "/wt/b" })).toBeNull();
  });
});
