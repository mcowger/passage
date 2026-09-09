export type ToolDiffLine = {
  kind: "context" | "added" | "removed";
  text: string;
  oldLine?: number;
  newLine?: number;
};

export type ToolDiff = {
  path: string;
  additions: number;
  deletions: number;
  contextLines: number;
  lines: ToolDiffLine[];
};

type ToolInput = Record<string, unknown>;
type ToolLike = { name: string; input: unknown };

const MAX_DIFF_CELLS = 250_000;

function record(value: unknown): ToolInput | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as ToolInput : undefined;
}

function text(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function lines(value: string): string[] {
  if (!value) return [];
  const result = value.replace(/\r\n/g, "\n").split("\n");
  if (result.at(-1) === "") result.pop();
  return result;
}

function pathFrom(input: ToolInput): string {
  return text(input.path) ?? text(input.filePath) ?? text(input.filename) ?? "";
}

function lineDiff(oldText: string, newText: string, path: string): ToolDiff {
  const oldLines = lines(oldText);
  const newLines = lines(newText);
  const output: ToolDiffLine[] = [];

  if (oldLines.length * newLines.length > MAX_DIFF_CELLS) {
    oldLines.forEach((line, index) => output.push({ kind: "removed", text: line, oldLine: index + 1 }));
    newLines.forEach((line, index) => output.push({ kind: "added", text: line, newLine: index + 1 }));
    return { path, additions: newLines.length, deletions: oldLines.length, contextLines: 0, lines: output };
  }

  const common = Array.from({ length: oldLines.length + 1 }, () => new Array<number>(newLines.length + 1).fill(0));
  for (let oldIndex = oldLines.length - 1; oldIndex >= 0; oldIndex -= 1) {
    for (let newIndex = newLines.length - 1; newIndex >= 0; newIndex -= 1) {
      common[oldIndex][newIndex] = oldLines[oldIndex] === newLines[newIndex]
        ? common[oldIndex + 1][newIndex + 1] + 1
        : Math.max(common[oldIndex + 1][newIndex], common[oldIndex][newIndex + 1]);
    }
  }

  let oldIndex = 0;
  let newIndex = 0;
  while (oldIndex < oldLines.length && newIndex < newLines.length) {
    if (oldLines[oldIndex] === newLines[newIndex]) {
      output.push({ kind: "context", text: oldLines[oldIndex], oldLine: oldIndex + 1, newLine: newIndex + 1 });
      oldIndex += 1;
      newIndex += 1;
    } else if (common[oldIndex + 1][newIndex] >= common[oldIndex][newIndex + 1]) {
      output.push({ kind: "removed", text: oldLines[oldIndex], oldLine: oldIndex + 1 });
      oldIndex += 1;
    } else {
      output.push({ kind: "added", text: newLines[newIndex], newLine: newIndex + 1 });
      newIndex += 1;
    }
  }
  while (oldIndex < oldLines.length) {
    output.push({ kind: "removed", text: oldLines[oldIndex], oldLine: oldIndex + 1 });
    oldIndex += 1;
  }
  while (newIndex < newLines.length) {
    output.push({ kind: "added", text: newLines[newIndex], newLine: newIndex + 1 });
    newIndex += 1;
  }

  return {
    path,
    additions: output.filter((line) => line.kind === "added").length,
    deletions: output.filter((line) => line.kind === "removed").length,
    contextLines: output.filter((line) => line.kind === "context").length,
    lines: output,
  };
}

function unifiedPatch(patch: string, fallbackPath: string): ToolDiff | undefined {
  const patchLines = patch.replace(/\r\n/g, "\n").split("\n");
  let path = fallbackPath;
  let oldLine = 0;
  let newLine = 0;
  let inHunk = false;
  const output: ToolDiffLine[] = [];

  for (const line of patchLines) {
    if (line.startsWith("+++ ") || line.startsWith("--- ")) {
      if (!path) {
        const candidate = line.slice(4).split("\t")[0].replace(/^[ab]\//, "");
        if (candidate !== "/dev/null") path = candidate;
      }
      continue;
    }
    const hunk = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line);
    if (hunk) {
      oldLine = Number(hunk[1]);
      newLine = Number(hunk[2]);
      inHunk = true;
      continue;
    }
    if (!inHunk || line === "\\ No newline at end of file") continue;
    if (line.startsWith("+")) {
      output.push({ kind: "added", text: line.slice(1), newLine });
      newLine += 1;
    } else if (line.startsWith("-")) {
      output.push({ kind: "removed", text: line.slice(1), oldLine });
      oldLine += 1;
    } else if (line.startsWith(" ")) {
      output.push({ kind: "context", text: line.slice(1), oldLine, newLine });
      oldLine += 1;
      newLine += 1;
    }
  }

  if (output.length === 0) return undefined;
  return {
    path,
    additions: output.filter((line) => line.kind === "added").length,
    deletions: output.filter((line) => line.kind === "removed").length,
    contextLines: output.filter((line) => line.kind === "context").length,
    lines: output,
  };
}

export function getToolDiff(tool: ToolLike): ToolDiff | undefined {
  const input = record(tool.input);
  if (!input) return undefined;
  const name = tool.name.toLowerCase();
  const path = pathFrom(input);
  const patch = text(input.patch) ?? text(input.patchText) ?? text(input.diff) ?? text(input.unifiedDiff);
  if (patch) return unifiedPatch(patch, path);

  const isEdit = name.includes("edit") || name.includes("patch");
  const isWrite = name.includes("write") || name.includes("create") || name === "apply_patch";
  if (!isEdit && !isWrite) return undefined;

  if (Array.isArray(input.edits) && input.edits.length > 0) {
    const allLines: ToolDiffLine[] = [];
    let totalAdditions = 0;
    let totalDeletions = 0;
    let totalContext = 0;
    for (const edit of input.edits) {
      if (typeof edit === "object" && edit !== null) {
        const eOld = text((edit as Record<string, unknown>).oldString) ?? text((edit as Record<string, unknown>).oldText) ?? "";
        const eNew = text((edit as Record<string, unknown>).newString) ?? text((edit as Record<string, unknown>).newText) ?? "";
        const d = lineDiff(eOld, eNew, path);
        allLines.push(...d.lines);
        totalAdditions += d.additions;
        totalDeletions += d.deletions;
        totalContext += d.contextLines;
      }
    }
    return {
      path,
      additions: totalAdditions,
      deletions: totalDeletions,
      contextLines: totalContext,
      lines: allLines,
    };
  }

  const oldText = text(input.oldString) ?? text(input.oldText) ?? text(input.oldContent) ?? text(input.original);
  const newText = text(input.newString) ?? text(input.newText) ?? text(input.newContent) ?? text(input.content) ?? text(input.text);
  if (oldText === undefined && newText === undefined) return undefined;
  return lineDiff(oldText ?? "", newText ?? "", path);
}
