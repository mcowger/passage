/** Shared CSS sanity-check helpers (import-safe: no bun:test dependency). */

/** Strip /* ... *\/ comments so braces inside comments don't count. */
export function stripCssComments(css: string): string {
  return css.replace(/\/\*[\s\S]*?\*\//g, (m) => "\n".repeat(m.split("\n").length - 1));
}

/** Assert braces balance, ignoring { } inside '...' and "..." strings
 *  (e.g. content: "}"). Throws with a file:line:col message on failure. */
export function assertBalancedBraces(path: string, raw: string): void {
  const css = stripCssComments(raw);
  let depth = 0;
  let line = 1;
  let col = 0;
  let inSingle = false;
  let inDouble = false;
  let escaped = false;
  for (let i = 0; i < css.length; i++) {
    const ch = css[i];
    if (ch === "\n") {
      line++;
      col = 0;
      continue;
    }
    col++;
    if (escaped) {
      escaped = false;
      continue;
    }
    if (ch === "\\" && (inSingle || inDouble)) {
      escaped = true;
      continue;
    }
    if (ch === "'" && !inDouble) {
      inSingle = !inSingle;
      continue;
    }
    if (ch === '"' && !inSingle) {
      inDouble = !inDouble;
      continue;
    }
    if (inSingle || inDouble) continue;
    if (ch === "{") depth++;
    else if (ch === "}") {
      depth--;
      if (depth < 0) {
        throw new Error(
          `${path}:${line}:${col}: unexpected closing brace with no matching opening brace (stray "}")`,
        );
      }
    }
  }
  if (depth !== 0) {
    throw new Error(`${path}: ${depth} unclosed opening brace(s) (missing "}")`);
  }
}
