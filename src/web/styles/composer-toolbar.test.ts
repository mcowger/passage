import { describe, expect, test } from "bun:test";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

const stylesDir = import.meta.dir;

function listCss(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) listCss(full, out);
    else if (entry.endsWith(".css")) out.push(full);
  }
  return out.sort();
}

const stripComments = (raw: string): string => raw.replace(/\/\*[\s\S]*?\*\//g, "");

/** Every `selector { decls }` rule, including ones nested inside @media. */
function eachRule(raw: string, visit: (selector: string, decls: string) => void): void {
  const ruleRe = /([^{}]+)\{([^{}]*)\}/g;
  let match: RegExpExecArray | null;
  while ((match = ruleRe.exec(raw)) !== null) {
    visit(match[1].trim(), match[2]);
  }
}

const toolbarSelector = /(^|[\s,>+~])\.composer-toolbar(-left|-right)?(?![\w-])/;
const buttonClass = /^\.(composer-action-btn|send-btn|stop-btn|composer-attach-btn|composer-chip-btn)$/;

describe("composer toolbar never wraps", () => {
  for (const file of listCss(stylesDir)) {
    const short = file.slice(stylesDir.length + 1);
    test(`no wrapping composer toolbar in ${short}`, () => {
      const raw = stripComments(readFileSync(file, "utf8"));
      eachRule(raw, (selector, decls) => {
        if (!toolbarSelector.test(selector)) return;
        for (const wrap of decls.matchAll(/flex-wrap\s*:\s*([^;!]+)/g)) {
          expect(`${short} :: ${selector} :: flex-wrap: ${wrap[1].trim()}`).toBe(
            `${short} :: ${selector} :: flex-wrap: nowrap`,
          );
        }
      });
    });

    test(`composer buttons never wrap or shrink in ${short}`, () => {
      const raw = stripComments(readFileSync(file, "utf8"));
      const whiteSpaceByClass = new Map<string, string[]>();
      eachRule(raw, (selector, decls) => {
        for (const part of selector.split(",").map((p) => p.trim())) {
          const exact = part.match(buttonClass);
          if (!exact) continue;
          const values = [...decls.matchAll(/white-space\s*:\s*([^;!]+)/g)].map((m) => m[1].trim());
          if (!whiteSpaceByClass.has(exact[1])) whiteSpaceByClass.set(exact[1], []);
          whiteSpaceByClass.get(exact[1])!.push(...values);
        }
      });
      for (const [cls, values] of whiteSpaceByClass) {
        expect(values.length, `${short} :: .${cls} declares white-space`).toBeGreaterThan(0);
        for (const value of values) expect(value).toBe("nowrap");
      }
    });
  }

  test("model chip is the shrinking item with an ellipsis", () => {
    const files = listCss(stylesDir);
    const seen = { chip: false, container: false };
    for (const file of files) {
      const raw = stripComments(readFileSync(file, "utf8"));
      eachRule(raw, (selector, decls) => {
        if (selector.includes(".composer-chip-btn") && selector.includes(".chip-label")) {
          seen.chip = true;
          expect(decls).toContain("text-overflow: ellipsis");
          expect(decls).toContain("white-space: nowrap");
        }
        if (selector.trim() === ".model-picker-container") {
          seen.container = true;
          expect(decls).toContain("min-width: 0");
        }
      });
    }
    expect(seen.chip).toBe(true);
    expect(seen.container).toBe(true);
  });
});
