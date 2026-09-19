import { describe, expect, test } from "bun:test";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { assertBalancedBraces } from "./css-syntax.ts";

const stylesDir = import.meta.dir;
const webDir = resolve(stylesDir, "..");

function listFirstPartyCss(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    const st = statSync(full);
    if (st.isDirectory()) listFirstPartyCss(full, out);
    else if (entry.endsWith(".css")) out.push(full);
  }
  return out.sort();
}

const cssFiles = listFirstPartyCss(stylesDir).filter((f) => f.endsWith(".css"));
// Also cover the entry that @imports this directory.
const entryCss = join(webDir, "styles.css");
const allFiles = (existsSync(entryCss) ? [entryCss] : []).concat(
  cssFiles.filter((f) => resolve(f) !== resolve(entryCss)),
);

describe("web css syntax", () => {
  test("entry styles.css exists", () => {
    expect(existsSync(entryCss)).toBe(true);
  });

  for (const file of allFiles) {
    test(`balanced braces in ${file.slice(resolve(stylesDir, "..", "..", "..").length + 1)}`, () => {
      const raw = readFileSync(file, "utf8");
      expect(() => assertBalancedBraces(file, raw)).not.toThrow();
    });
  }

  test("@import targets in styles.css resolve to real files", () => {
    const raw = readFileSync(entryCss, "utf8");
    const imports = [...raw.matchAll(/@import\s+["']([^"']+)["']/g)].map((m) => m[1]);
    expect(imports.length).toBeGreaterThan(0);
    for (const spec of imports) {
      if (spec === "tailwindcss" || spec.startsWith("tailwindcss/")) continue;
      if (spec.startsWith(".") || spec.startsWith("/")) {
        const target = resolve(dirname(entryCss), spec);
        expect(`${spec} resolves to ${target}: ${existsSync(target)}`).toBe(
          `${spec} resolves to ${target}: true`,
        );
      }
    }
  });
});
