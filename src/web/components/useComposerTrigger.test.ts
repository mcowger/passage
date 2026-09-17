import { describe, expect, test } from "bun:test";
import {
  applyFileInsert,
  applySlashInsert,
  detectTrigger,
  filterSlashCommands,
} from "./useComposerTrigger.ts";
import { getSlashCommands } from "../../daemon/agents/slash-commands.ts";

describe("detectTrigger", () => {
  test("fires at start of draft", () => {
    expect(detectTrigger("@rea", 4)).toMatchObject({ kind: "@", query: "rea", start: 0, end: 4 });
    expect(detectTrigger("/comp", 5)).toMatchObject({ kind: "/", query: "comp", start: 0, end: 5 });
  });

  test("fires after whitespace anywhere in the draft", () => {
    expect(detectTrigger("please check this /compact and", 26)).toMatchObject({
      kind: "/",
      query: "compact",
      start: 18,
      end: 26,
    });
    expect(detectTrigger("see @src/index.ts now", 17)).toMatchObject({
      kind: "@",
      query: "src/index.ts",
      start: 4,
      end: 17,
    });
  });

  test("fires at start-of-line after a newline", () => {
    expect(detectTrigger("hello\n@fi", 9)).toMatchObject({ kind: "@", query: "fi", start: 6, end: 9 });
  });

  test("empty trigger shows the unfiltered list", () => {
    expect(detectTrigger("@", 1)).toMatchObject({ kind: "@", query: "", start: 0, end: 1 });
    expect(detectTrigger("check /", 7)).toMatchObject({ kind: "/", query: "", start: 6, end: 7 });
  });

  test("space after an empty trigger keeps the unfiltered list", () => {
    expect(detectTrigger("@ ", 2)).toMatchObject({ kind: "@", query: "", start: 0, end: 2 });
    expect(detectTrigger("see @ now", 5)).toMatchObject({ kind: "@", query: "", start: 4, end: 5 });
  });

  test("ignores email addresses", () => {
    expect(detectTrigger("user@example.com", 16)).toBeNull();
    expect(detectTrigger("mail me at bob@host and see", 19)).toBeNull();
  });

  test("ignores code spans", () => {
    expect(detectTrigger("`@foo`", 5)).toBeNull();
    expect(detectTrigger("run `@bar and see", 9)).toBeNull();
  });

  test("rejects tokens longer than 64 chars", () => {
    expect(detectTrigger(`@${"a".repeat(64)}`, 65)?.query).toHaveLength(64);
    expect(detectTrigger(`@${"a".repeat(65)}`, 66)).toBeNull();
  });

  test("handles multi-byte caret offsets", () => {
    const draft = "🎉 @fi";
    expect(detectTrigger(draft, draft.length)).toMatchObject({ kind: "@", query: "fi", start: 3, end: 6 });
  });

  test("returns null for plain text and out-of-range carets", () => {
    expect(detectTrigger("hello world", 5)).toBeNull();
    expect(detectTrigger("@a", 99)).toBeNull();
    expect(detectTrigger("@a", -1)).toBeNull();
  });
});

describe("applyFileInsert", () => {
  test("replaces the token with a backticked ref plus trailing space", () => {
    const draft = "see @src/in and more";
    const trigger = detectTrigger(draft, 11)!;
    expect(trigger).toMatchObject({ kind: "@", query: "src/in", start: 4, end: 11 });
    const next = applyFileInsert(draft, trigger, "src/index.ts");
    expect(next.value).toBe("see @`src/index.ts`  and more");
    expect(next.caret).toBe("see @`src/index.ts` ".length);
  });

  test("preserves surrounding text at the caret", () => {
    const draft = "a @b c";
    const trigger = detectTrigger(draft, 4)!;
    expect(applyFileInsert(draft, trigger, "b.ts")).toEqual({ value: "a @`b.ts`  c", caret: 10 });
  });
});

describe("applySlashInsert", () => {
  test("inserts the template mid-draft preserving surroundings", () => {
    const draft = "please check this /comp and then continue";
    const trigger = detectTrigger(draft, 23)!;
    expect(trigger).toMatchObject({ kind: "/", query: "comp", start: 18, end: 23 });
    const next = applySlashInsert(draft, trigger, "/compact");
    expect(next.value).toBe("please check this /compact  and then continue");
    expect(next.caret).toBe("please check this /compact ".length);
  });
});

describe("filterSlashCommands", () => {
  const commands = getSlashCommands();
  test("empty query returns the full allowlist", () => {
    expect(filterSlashCommands(commands, "")).toHaveLength(commands.length);
  });
  test("filters case-insensitively over name and description", () => {
    expect(filterSlashCommands(commands, "COMP").map((c) => c.name)).toContain("compact");
    expect(filterSlashCommands(commands, "context").map((c) => c.name)).toContain("compact");
    expect(filterSlashCommands(commands, "nope")).toHaveLength(0);
  });
});
