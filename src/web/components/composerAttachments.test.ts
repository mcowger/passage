import { describe, expect, test } from "bun:test";
import { extractPastedFiles, withPastedFileNames } from "./composerAttachments.ts";

function fakeFile(name: string, type: string): File {
  return new File(["bytes"], name, { type });
}

describe("withPastedFileNames", () => {
  test("leaves named files untouched", () => {
    const file = fakeFile("photo.png", "image/png");
    expect(withPastedFileNames([file])[0]).toBe(file);
  });

  test("names a nameless pasted image with a matching extension", () => {
    const [renamed] = withPastedFileNames([fakeFile("", "image/png")]);
    expect(renamed?.name).toBe("pasted-image-1.png");
    expect(renamed?.type).toBe("image/png");
  });

  test("normalizes image/jpg before naming", () => {
    const [renamed] = withPastedFileNames([fakeFile("", "image/jpg")]);
    expect(renamed?.name).toBe("pasted-image-1.jpg");
    expect(renamed?.type).toBe("image/jpg");
  });

  test("names nameless non-images as generic files", () => {
    const [renamed] = withPastedFileNames([fakeFile("", "application/pdf")]);
    expect(renamed?.name).toBe("pasted-file-1.pdf");
  });
});

describe("extractPastedFiles", () => {
  test("returns [] for text-only pastes", () => {
    expect(extractPastedFiles({ files: [], items: [] })).toEqual([]);
    expect(extractPastedFiles(null)).toEqual([]);
    expect(extractPastedFiles(undefined)).toEqual([]);
  });

  test("prefers clipboardData.files for copied files/screenshots", () => {
    const image = fakeFile("screenshot.png", "image/png");
    expect(extractPastedFiles({ files: [image], items: [] })).toEqual([image]);
  });

  test("falls back to clipboardData.items when files is empty", () => {
    const image = fakeFile("image.png", "image/png");
    const items = [{ kind: "file", getAsFile: () => image }];
    expect(extractPastedFiles({ files: [], items })).toEqual([image]);
  });

  test("skips non-file items", () => {
    const items = [{ kind: "string", getAsFile: () => null }];
    expect(extractPastedFiles({ files: [], items })).toEqual([]);
  });

  test("gives nameless pasted images a usable name", () => {
    const image = fakeFile("", "image/png");
    const [renamed] = extractPastedFiles({ files: [image], items: [] });
    expect(renamed?.name).toBe("pasted-image-1.png");
  });
});
