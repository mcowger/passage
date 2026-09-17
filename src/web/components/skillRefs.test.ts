import { describe, expect, test } from "bun:test";
import { countSkillRefs, splitSkillRefs } from "./skillRefs.ts";

describe("splitSkillRefs", () => {
  test("splits skill tokens out of plain text", () => {
    expect(splitSkillRefs("use /skill:gh-cli please")).toEqual([
      "use ",
      { skill: "/skill:gh-cli" },
      " please",
    ]);
  });

  test("returns plain text untouched when there are no refs", () => {
    expect(splitSkillRefs("hello world")).toEqual(["hello world"]);
  });

  test("ignores non-skill slash commands", () => {
    expect(splitSkillRefs("run /compact now")).toEqual(["run /compact now"]);
    expect(splitSkillRefs("run /unknown-command now")).toEqual(["run /unknown-command now"]);
  });

  test("trims trailing sentence punctuation off the token", () => {
    expect(splitSkillRefs("try /skill:gh-cli.")).toEqual(["try ", { skill: "/skill:gh-cli" }, "."]);
    expect(splitSkillRefs("(/skill:gh-cli), ok")).toEqual(["(", { skill: "/skill:gh-cli" }, "), ok"]);
  });

  test("requires a boundary before the token", () => {
    expect(splitSkillRefs("see http://skill:x here")).toEqual(["see http://skill:x here"]);
    expect(splitSkillRefs("a/skill:gh-cli")).toEqual(["a/skill:gh-cli"]);
  });

  test("handles multiple refs and start-of-text refs", () => {
    expect(splitSkillRefs("/skill:a and /skill:b")).toEqual([
      { skill: "/skill:a" },
      " and ",
      { skill: "/skill:b" },
    ]);
  });
});

describe("countSkillRefs", () => {
  test("counts skill tokens", () => {
    expect(countSkillRefs("no refs")).toBe(0);
    expect(countSkillRefs("/skill:a plus /skill:b")).toBe(2);
    expect(countSkillRefs("/compact")).toBe(0);
  });
});
