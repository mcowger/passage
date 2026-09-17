export const MAX_SYNTHETIC_TERMINAL_CELLS = 100_000;

interface TerminalRenderBudget {
  syntheticCells: number;
}

const ensureLine = (lines: string[][], requestedRow: number, budget: TerminalRenderBudget): number => {
  const missingRows = Math.max(0, requestedRow - lines.length + 1);
  const availableCells = MAX_SYNTHETIC_TERMINAL_CELLS - budget.syntheticCells;
  const addedRows = Math.min(missingRows, availableCells);
  const row = Math.min(requestedRow, lines.length + addedRows - 1);

  while (lines.length <= row) {
    lines.push([]);
  }
  budget.syntheticCells += addedRows;
  return row;
};

const writeTerminalCharacter = (
  lines: string[][],
  row: number,
  requestedColumn: number,
  character: string,
  budget: TerminalRenderBudget
): number => {
  const line = lines[row];
  const availableCells = MAX_SYNTHETIC_TERMINAL_CELLS - budget.syntheticCells;
  const column = Math.min(requestedColumn, line.length + availableCells);
  const padding = Math.max(0, column - line.length);
  while (line.length < column) {
    line.push(" ");
  }
  budget.syntheticCells += padding;
  line[column] = character;
  return column;
};

/**
 * Normalizes terminal output by interpreting cursor control sequences (\r, \b, erase line, cursor motion)
 * and stripping ANSI SGR color/style escapes.
 */
export function renderTerminalOutput(output: string): string {
  if (!output.includes("\u001B") && !output.includes("\r") && !output.includes("\b")) {
    return output;
  }

  const lines: string[][] = [[]];
  const budget: TerminalRenderBudget = { syntheticCells: 0 };
  let row = 0;
  let column = 0;

  for (let index = 0; index < output.length; index += 1) {
    const character = output[index];

    if (character === "\n") {
      row += 1;
      column = 0;
      lines[row] ??= [];
      continue;
    }
    if (character === "\r") {
      column = 0;
      continue;
    }
    if (character === "\b") {
      column = Math.max(0, column - 1);
      continue;
    }
    if (character !== "\u001B") {
      column = writeTerminalCharacter(lines, row, column, character, budget) + 1;
      continue;
    }

    const nextCharacter = output[index + 1];
    if (nextCharacter === "[") {
      const sequenceStart = index + 2;
      let sequenceEnd = sequenceStart;
      while (sequenceEnd < output.length && !/[\x40-\x7E]/.test(output[sequenceEnd])) {
        sequenceEnd += 1;
      }
      if (sequenceEnd === output.length) {
        break;
      }

      const command = output[sequenceEnd];
      const parameters = output
        .slice(sequenceStart, sequenceEnd)
        .split(";")
        .map((value) => Number.parseInt(value, 10) || 0);
      const count = parameters[0] || 1;

      if (command === "A") {
        row = Math.max(0, row - count);
      } else if (command === "B") {
        row = ensureLine(lines, row + count, budget);
      } else if (command === "C") {
        column += count;
      } else if (command === "D") {
        column = Math.max(0, column - count);
      } else if (command === "G") {
        column = Math.max(0, count - 1);
      } else if (command === "H" || command === "f") {
        row = ensureLine(lines, Math.max(0, (parameters[0] || 1) - 1), budget);
        column = Math.max(0, (parameters[1] || 1) - 1);
      } else if (command === "K") {
        const line = lines[row];
        const mode = parameters[0];
        if (mode === 1) {
          for (let i = 0; i <= column && i < line.length; i += 1) {
            line[i] = " ";
          }
        } else if (mode === 2) {
          lines[row] = [];
        } else {
          line.length = Math.min(line.length, column);
        }
      }
      index = sequenceEnd;
      continue;
    }

    if (nextCharacter === "]") {
      const terminator = output.indexOf("\u0007", index + 2);
      const stringTerminator = output.indexOf("\u001B\\", index + 2);
      const end =
        terminator === -1
          ? stringTerminator
          : stringTerminator === -1
          ? terminator
          : Math.min(terminator, stringTerminator);
      if (end === -1) {
        break;
      }
      index = output[end] === "\u0007" ? end : end + 1;
      continue;
    }

    index += 1;
  }

  return lines.map((line) => line.join("")).join("\n");
}

export type ParseJsonResult = {
  data: unknown;
  isJson: boolean;
};

export function tryParseJson(output: string): ParseJsonResult {
  if (!output || typeof output !== "string") {
    return { data: null, isJson: false };
  }

  const trimmed = output.trim();
  if (trimmed.length < 2) {
    return { data: null, isJson: false };
  }

  if (
    (!trimmed.startsWith("{") || !trimmed.endsWith("}")) &&
    (!trimmed.startsWith("[") || !trimmed.endsWith("]"))
  ) {
    return { data: null, isJson: false };
  }

  try {
    const parsed = JSON.parse(trimmed);
    if (parsed !== null && (typeof parsed === "object" || Array.isArray(parsed))) {
      return { data: parsed, isJson: true };
    }
    return { data: null, isJson: false };
  } catch {
    return { data: null, isJson: false };
  }
}

export function formatJsonPretty(data: unknown): string {
  try {
    return JSON.stringify(data, null, 2);
  } catch {
    return String(data);
  }
}

function extractBlockText(block: unknown): string | undefined {
  if (block === null || block === undefined) return undefined;
  if (typeof block === "string") return block;
  if (typeof block === "object") {
    const b = block as Record<string, unknown>;
    if (typeof b.text === "string") return b.text;
    if (b.content !== undefined) return extractToolResultText(b.content);
  }
  return undefined;
}

export function extractToolResultText(value: unknown): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);

  if (Array.isArray(value)) {
    const parts = value
      .map((item) => extractBlockText(item))
      .filter((t): t is string => t !== undefined && t !== "");
    return parts.join("\n");
  }

  if (typeof value === "object") {
    const obj = value as Record<string, unknown>;

    // Pi standard tool result: { content: [...] } or { content: "..." }
    if (obj.content !== undefined) {
      if (typeof obj.content === "string") return obj.content;
      if (Array.isArray(obj.content)) {
        const parts = obj.content
          .map((item) => extractBlockText(item))
          .filter((t): t is string => t !== undefined && t !== "");
        return parts.join("\n");
      }
    }

    // Direct text property: { text: "..." }
    if (typeof obj.text === "string") {
      return obj.text;
    }

    // Process output: { stdout: "...", stderr: "..." }
    if (typeof obj.stdout === "string" || typeof obj.stderr === "string") {
      const stdout = typeof obj.stdout === "string" ? obj.stdout : "";
      const stderr = typeof obj.stderr === "string" ? obj.stderr : "";
      if (stdout && stderr) return `${stdout}\n${stderr}`;
      return stdout || stderr;
    }

    // Error message: { error: "..." }
    if (typeof obj.error === "string") {
      return obj.error;
    }

    // General message: { message: "..." }
    if (typeof obj.message === "string") {
      return obj.message;
    }

    // Fallback for generic JSON objects: serialize as formatted JSON instead of "[object Object]"
    try {
      return JSON.stringify(value, null, 2);
    } catch {
      return String(value);
    }
  }

  return String(value);
}


export type GrepMatchItem = {
  lineNum?: string;
  content: string;
};

export type GrepFileGroup = {
  filepath: string;
  matches: GrepMatchItem[];
};

export type GrepParsedResult = {
  totalMatches: number;
  files: GrepFileGroup[];
};

export function parseGrepOutput(output: string): GrepParsedResult | null {
  if (!output || typeof output !== "string") return null;

  const lines = output.trim().split("\n").filter((l) => l.trim().length > 0);
  if (lines.length === 0) return null;

  const fileGroups: Record<string, GrepMatchItem[]> = {};
  let totalMatches = 0;

  for (const line of lines) {
    // Match standard grep formats: "path/to/file:123:content" or "path/to/file:content"
    const match = line.match(/^([^\s:][^:]*):(\d+):(.*)$/) || line.match(/^([^\s:][^:]*):(.*)$/);
    if (match) {
      const [, filepath, lineNumOrContent, content] = match;
      const lineNum = content !== undefined ? lineNumOrContent : undefined;
      const actualContent = content !== undefined ? content : lineNumOrContent;

      if (!fileGroups[filepath]) {
        fileGroups[filepath] = [];
      }
      fileGroups[filepath].push({ lineNum, content: actualContent });
      totalMatches += 1;
    }
  }

  if (totalMatches === 0) return null;

  const files = Object.entries(fileGroups).map(([filepath, matches]) => ({
    filepath,
    matches,
  }));

  return { totalMatches, files };
}

export type GlobDirectoryGroup = {
  directory: string;
  files: string[];
};

export type GlobParsedResult = {
  totalFiles: number;
  directories: GlobDirectoryGroup[];
};

export interface ParsedReadOutputLine {
  text: string;
  lineNumber: number | null;
  isInfo: boolean;
}

export interface ParsedReadToolOutput {
  type: "file" | "directory" | "unknown";
  lines: ParsedReadOutputLine[];
  truncationNotice?: string;
}

export function parseReadToolOutput(output: string): ParsedReadToolOutput {
  if (!output || typeof output !== "string") {
    return { type: "unknown", lines: [] };
  }

  const typeMatch = output.match(/<type>(file|directory)<\/type>/i);
  const detectedType = (typeMatch?.[1]?.toLowerCase() ?? "unknown") as ParsedReadToolOutput["type"];

  const contentMatch = output.match(/<content>([\s\S]*?)<\/content>/i);
  const rawContent = contentMatch?.[1] ?? output;
  const normalizedContent = rawContent.replace(/\r\n/g, "\n");
  const rawLines = normalizedContent.split("\n");

  const isTruncationNotice = (text: string): boolean => {
    return (
      /\(\s*File has more lines\..*offset.*\)/i.test(text.trim()) ||
      /^\.{3}\s*\[output filtered/i.test(text.trim())
    );
  };

  let truncationNotice: string | undefined = undefined;

  const parsedLines = rawLines.map((line): ParsedReadOutputLine => {
    const trimmed = line.trim();
    if (isTruncationNotice(trimmed)) {
      truncationNotice = trimmed;
      return { lineNumber: null, text: trimmed, isInfo: true };
    }

    if (detectedType !== "directory") {
      const numberedMatch = line.match(/^(\d+):\s?(.*)$/);
      if (numberedMatch) {
        const numberedText = numberedMatch[2];
        const numTrimmed = numberedText.trim();
        const numberedIsInfo = isTruncationNotice(numTrimmed);
        if (numberedIsInfo) {
          truncationNotice = numTrimmed;
        }
        return {
          lineNumber: numberedIsInfo ? null : Number(numberedMatch[1]),
          text: numberedText,
          isInfo: numberedIsInfo,
        };
      }
    }

    return {
      lineNumber: null,
      text: line,
      isInfo: false,
    };
  });

  const lines = parsedLines.filter((l) => !l.isInfo);
  return {
    type: detectedType,
    lines,
    truncationNotice,
  };
}

export function parseGlobOutput(output: string): GlobParsedResult | null {
  if (!output || typeof output !== "string") return null;

  const lines = output
    .trim()
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.length > 0 && !l.startsWith("[") && !l.endsWith("]"));

  if (lines.length === 0) return null;

  const dirMap: Record<string, string[]> = {};
  let count = 0;

  for (const line of lines) {
    const cleanPath = line.replace(/^[,"']+|[,"']+$/g, "");
    if (!cleanPath) continue;

    const lastSlash = cleanPath.lastIndexOf("/");
    const directory = lastSlash > 0 ? cleanPath.substring(0, lastSlash) : lastSlash === 0 ? "/" : "./";
    const filename = lastSlash >= 0 ? cleanPath.substring(lastSlash + 1) : cleanPath;

    if (!dirMap[directory]) {
      dirMap[directory] = [];
    }
    dirMap[directory].push(filename);
    count += 1;
  }

  if (count === 0) return null;

  const directories = Object.entries(dirMap)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([directory, files]) => ({
      directory,
      files: files.sort(),
    }));

  return { totalFiles: count, directories };
}
