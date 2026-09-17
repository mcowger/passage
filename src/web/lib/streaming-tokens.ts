import type { TimelineItem } from "../../shared/domain/agents.ts";

const CJK_PATTERN = /[\u3000-\u30ff\u3400-\u9fff\uf900-\ufaff\u{20000}-\u{2fa1f}\uac00-\ud7af]/u;

export type TokenEstimateCacheEntry = {
  text: string;
  tokens: number;
};

export function estimateTokens(text: string): number {
  let cjk = 0;
  let rest = 0;
  for (const character of text) {
    if (CJK_PATTERN.test(character)) cjk += 1;
    else rest += 1;
  }
  return cjk + rest / 4;
}

function isHighSurrogate(codeUnit: number): boolean {
  return codeUnit >= 0xd800 && codeUnit <= 0xdbff;
}

function isLowSurrogate(codeUnit: number): boolean {
  return codeUnit >= 0xdc00 && codeUnit <= 0xdfff;
}

export function estimateUpdatedTokens(previous: TokenEstimateCacheEntry | undefined, text: string): number {
  if (!previous || !text.startsWith(previous.text)) return estimateTokens(text);

  let baseTokens = previous.tokens;
  let suffixStart = previous.text.length;
  if (
    suffixStart > 0
    && suffixStart < text.length
    && isHighSurrogate(previous.text.charCodeAt(suffixStart - 1))
    && isLowSurrogate(text.charCodeAt(suffixStart))
  ) {
    baseTokens -= 1 / 4;
    suffixStart -= 1;
  }
  return baseTokens + estimateTokens(text.slice(suffixStart));
}

function toolInputText(input: unknown): string {
  if (typeof input === "string") return input;
  if (input && typeof input === "object" && !Array.isArray(input)) {
    const rawInput = (input as { rawInput?: unknown }).rawInput;
    if (typeof rawInput === "string") return rawInput;
  }
  const serialized = JSON.stringify(input ?? {});
  return serialized ?? "";
}

function timelineItemText(item: TimelineItem): string[] {
  if (item.kind === "assistant" || item.kind === "thinking") return [item.text];
  if (item.kind === "tool") return [toolInputText(item.input)];
  return [];
}

export function getStreamingTokenText(timeline: TimelineItem[]): string {
  let lastUserIndex = -1;
  for (let index = timeline.length - 1; index >= 0; index -= 1) {
    if (timeline[index]?.kind === "user") {
      lastUserIndex = index;
      break;
    }
  }
  return timeline.slice(lastUserIndex + 1).flatMap(timelineItemText).join("\n");
}
