/**
 * Shared `/skill:name` reference parsing for composer chips and timeline
 * rendering. Mirrors the slash-command name charset
 * (`src/shared/domain/agents.ts`), so anything the daemon can offer as a
 * skill command renders as a chip.
 */

export const SKILL_REF_PATTERN = /\/skill:[A-Za-z0-9_:.-]+/g;

const TRAILING_PUNCTUATION = /[.,!?;:)]+$/;
const REF_BOUNDARY_BEFORE = /[\s("']/;

/** A `/skill:name` token must start the text or follow whitespace/quotes/parens. */
export function isSkillRefBoundary(text: string, index: number): boolean {
  if (index <= 0) return true;
  return REF_BOUNDARY_BEFORE.test(text[index - 1]!);
}

/** Trim sentence punctuation off a raw regex match (`/skill:gh-cli.` → `/skill:gh-cli`). */
export function cleanSkillRefToken(match: string): string {
  return match.replace(TRAILING_PUNCTUATION, "");
}

export type SkillRefSegment = string | { skill: string };

/**
 * Split plain text into strings and `{ skill }` tokens. Non-boundaried
 * occurrences (e.g. inside `http://skill:x`) stay plain text.
 */
export function splitSkillRefs(text: string): SkillRefSegment[] {
  const segments: SkillRefSegment[] = [];
  let last = 0;
  let match: RegExpExecArray | null;
  SKILL_REF_PATTERN.lastIndex = 0;
  while ((match = SKILL_REF_PATTERN.exec(text)) !== null) {
    if (!isSkillRefBoundary(text, match.index)) continue;
    const token = cleanSkillRefToken(match[0]);
    const end = match.index + token.length;
    if (match.index > last) segments.push(text.slice(last, match.index));
    segments.push({ skill: token });
    last = end;
    // A trimmed match leaves punctuation behind: resume scanning after the
    // token so the tail is emitted as plain text, and reset the regex past
    // any skipped non-boundary match to avoid an infinite loop.
    SKILL_REF_PATTERN.lastIndex = end;
  }
  if (last < text.length) segments.push(text.slice(last));
  if (segments.length === 0) segments.push(text);
  return segments;
}

/** Count skill tokens in a draft (for composer mention reconciliation). */
export function countSkillRefs(value: string): number {
  return splitSkillRefs(value).filter((segment) => typeof segment !== "string").length;
}
