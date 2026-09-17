import { describe, expect, test } from "bun:test";
import {
  renderTerminalOutput,
  tryParseJson,
  formatJsonPretty,
  parseGrepOutput,
  parseGlobOutput,
  parseReadToolOutput,
  extractToolResultText,
} from "./tool-display.ts";

describe("renderTerminalOutput", () => {
  test("leaves plain output untouched", () => {
    expect(renderTerminalOutput("hello world\nline 2")).toBe("hello world\nline 2");
  });

  test("strips ANSI color escapes", () => {
    expect(renderTerminalOutput("\u001B[32m✓\u001B[39m Passage")).toBe("✓ Passage");
    expect(renderTerminalOutput("\u001B[1;34mBuild succeeded\u001B[0m")).toBe("Build succeeded");
  });

  test("interprets carriage return and line clear sequences", () => {
    expect(renderTerminalOutput("Progress 10%\r\u001B[2KProgress 90%")).toBe("Progress 90%");
  });

  test("interprets backspaces", () => {
    expect(renderTerminalOutput("ab\bc")).toBe("ac");
  });
});

describe("tryParseJson and formatJsonPretty", () => {
  test("identifies valid JSON objects and arrays", () => {
    const objStr = '{"name": "passage", "version": 1}';
    const parsedObj = tryParseJson(objStr);
    expect(parsedObj.isJson).toBe(true);
    expect(parsedObj.data).toEqual({ name: "passage", version: 1 });

    const arrStr = '["a", "b", "c"]';
    const parsedArr = tryParseJson(arrStr);
    expect(parsedArr.isJson).toBe(true);
    expect(parsedArr.data).toEqual(["a", "b", "c"]);
  });

  test("rejects non-JSON strings", () => {
    expect(tryParseJson("not json").isJson).toBe(false);
    expect(tryParseJson("{ broken json").isJson).toBe(false);
    expect(tryParseJson("").isJson).toBe(false);
  });

  test("formats JSON cleanly", () => {
    const formatted = formatJsonPretty({ a: 1 });
    expect(formatted).toBe('{\n  "a": 1\n}');
  });
});

describe("parseGrepOutput", () => {
  test("parses standard grep line-numbered results", () => {
    const output = `src/index.ts:10:const a = 1;
src/index.ts:25:const b = 2;
src/utils.ts:5:export function run() {}`;
    const parsed = parseGrepOutput(output);
    expect(parsed).not.toBeNull();
    expect(parsed?.totalMatches).toBe(3);
    expect(parsed?.files.length).toBe(2);
    expect(parsed?.files[0].filepath).toBe("src/index.ts");
    expect(parsed?.files[0].matches.length).toBe(2);
    expect(parsed?.files[0].matches[0].lineNum).toBe("10");
    expect(parsed?.files[0].matches[0].content).toBe("const a = 1;");
  });

  test("returns null for non-grep text", () => {
    expect(parseGrepOutput("")).toBeNull();
  });
});

describe("parseGlobOutput", () => {
  test("parses file paths and groups by directory", () => {
    const output = `src/daemon/index.ts
src/daemon/http.ts
src/web/main.tsx
README.md`;
    const parsed = parseGlobOutput(output);
    expect(parsed).not.toBeNull();
    expect(parsed?.totalFiles).toBe(4);
    expect(parsed?.directories.length).toBe(3);
  });
});

describe("parseReadToolOutput", () => {
  test("parses numbered read lines and separates line numbers from code", () => {
    const output = `1: import React from 'react';
2: 
3: export function App() {
4:   return <div>Hello</div>;
5: }
(File has more lines. Use offset=6 to continue.)`;

    const parsed = parseReadToolOutput(output);
    expect(parsed.lines.length).toBe(5);
    expect(parsed.lines[0].lineNumber).toBe(1);
    expect(parsed.lines[0].text).toBe("import React from 'react';");
    expect(parsed.lines[3].lineNumber).toBe(4);
    expect(parsed.lines[3].text).toBe("  return <div>Hello</div>;");
    expect(parsed.truncationNotice).toContain("File has more lines");
  });
});

describe("extractToolResultText", () => {
  test("returns undefined for null and undefined", () => {
    expect(extractToolResultText(undefined)).toBeUndefined();
    expect(extractToolResultText(null)).toBeUndefined();
  });

  test("returns string inputs untouched", () => {
    expect(extractToolResultText("hello world")).toBe("hello world");
    expect(extractToolResultText("")).toBe("");
  });

  test("extracts text from Pi RPC toolResult content array format", () => {
    const piResult = {
      content: [
        { type: "text", text: "src/server.ts:1:import { foo } from 'bar';" },
      ],
      details: { truncation: null, fullOutputPath: null },
    };
    expect(extractToolResultText(piResult)).toBe("src/server.ts:1:import { foo } from 'bar';");
  });

  test("extracts text from multiple content blocks", () => {
    const multiBlock = {
      content: [
        { type: "text", text: "line 1" },
        { type: "text", text: "line 2" },
      ],
    };
    expect(extractToolResultText(multiBlock)).toBe("line 1\nline 2");
  });

  test("extracts text when content is directly a string", () => {
    expect(extractToolResultText({ content: "direct string" })).toBe("direct string");
  });

  test("extracts text from direct text property", () => {
    expect(extractToolResultText({ text: "result text" })).toBe("result text");
  });

  test("extracts stdout and stderr from process output object", () => {
    expect(extractToolResultText({ stdout: "out", stderr: "err" })).toBe("out\nerr");
    expect(extractToolResultText({ stdout: "only out" })).toBe("only out");
    expect(extractToolResultText({ stderr: "only err" })).toBe("only err");
  });

  test("extracts error or message properties", () => {
    expect(extractToolResultText({ error: "Something went wrong" })).toBe("Something went wrong");
    expect(extractToolResultText({ message: "Task completed" })).toBe("Task completed");
  });

  test("serializes generic JSON objects instead of producing [object Object]", () => {
    const genericObj = { success: true, count: 42 };
    const text = extractToolResultText(genericObj);
    expect(text).not.toContain("[object Object]");
    expect(text).toContain('"success": true');
    expect(text).toContain('"count": 42');
  });

  test("extracts from raw array of text blocks", () => {
    const rawArray = [
      { type: "text", text: "block 1" },
      { type: "text", text: "block 2" },
    ];
    expect(extractToolResultText(rawArray)).toBe("block 1\nblock 2");
  });
});

