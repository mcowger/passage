import { describe, expect, test } from "bun:test";
import { prefillFromGoal, randomFolderSuffix, slugifyGoal, titleCaseGoal } from "./NewWorktreeModal.tsx";

describe("worktree live pre-fill", () => {
  test("title-cases the label", () => {
    expect(titleCaseGoal("add paste support")).toBe("Add Paste Support");
  });

  test("slugifies the branch with no prefix", () => {
    expect(slugifyGoal("add paste support")).toBe("add-paste-support");
    expect(slugifyGoal("  Add_PASTE!! support  ")).toBe("add-paste-support");
  });

  test("prefills label, branch, and folder from the goal", () => {
    const prefill = prefillFromGoal("add paste support", "abcd");
    expect(prefill).toEqual({
      label: "Add Paste Support",
      branch: "add-paste-support",
      folder: "add-paste-support--wk_abcd",
    });
  });

  test("returns empty prefill for a blank goal", () => {
    expect(prefillFromGoal("   ", "abcd")).toEqual({ label: "", branch: "", folder: "" });
  });

  test("generates a stable-shape 4-letter suffix", () => {
    expect(randomFolderSuffix()).toMatch(/^[a-z]{4}$/);
  });
});
