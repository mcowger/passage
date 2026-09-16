import { describe, expect, test } from "bun:test";
import { EditorState } from "@codemirror/state";
import { getLanguageExtensionForPath } from "./editorLanguages.ts";

const supportedCases: Array<[string, string]> = [
  ["main.py", "Python"],
  ["main.go", "Go"],
  ["main.rs", "Rust"],
  ["main.c", "C"],
  ["main.h", "C header"],
  ["main.cpp", "C++"],
  ["index.html", "HTML"],
  ["styles.css", "CSS"],
  ["run.sh", "Shell"],
  ["run.bash", "Bash"],
  ["config.yaml", "YAML"],
  ["config.yml", "YAML"],
  ["config.toml", "TOML"],
  ["schema.sql", "SQL"],
  ["Dockerfile", "Dockerfile"],
  ["Dockerfile.dev", "Dockerfile variant"],
  ["app.dockerfile", "Dockerfile suffix"],
  // pre-existing support must keep working
  ["index.ts", "TypeScript"],
  ["app.jsx", "JavaScript"],
  ["data.json", "JSON"],
  ["README.md", "Markdown"],
];

describe("getLanguageExtensionForPath", () => {
  for (const [path, label] of supportedCases) {
    test(`supports ${label} (${path})`, () => {
      const ext = getLanguageExtensionForPath(path);
      expect(ext).not.toEqual([]);
    });
  }

  test("builds a valid EditorState for every supported language", () => {
    for (const [path] of supportedCases) {
      const state = EditorState.create({
        doc: "placeholder",
        extensions: [getLanguageExtensionForPath(path)],
      });
      expect(state.doc.toString()).toBe("placeholder");
    }
  });

  test("falls back to plain text for unknown extensions", () => {
    expect(getLanguageExtensionForPath("notes.xyz123")).toEqual([]);
    expect(getLanguageExtensionForPath("")).toEqual([]);
  });
});
