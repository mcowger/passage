import { describe, expect, test, mock } from "bun:test";
import { render, fireEvent } from "@testing-library/react";
import { ComposerEditor } from "./ComposerEditor.tsx";
import { setupDomTests } from "../test-utils/dom.ts";

// Pasting an image must attach it (via onPasteFiles) instead of dropping an
// opaque <img> into the editable DOM that the draft reader cannot serialize.
setupDomTests();

function pastedImage(name = "screenshot.png", type = "image/png"): File {
  return new File(["image-bytes"], name, { type });
}

describe("ComposerEditor image paste", () => {
  test("routes pasted image files to onPasteFiles without touching the draft", () => {
    const onChange = mock(() => {});
    const onPasteFiles = mock(() => {});
    const { container } = render(
      <ComposerEditor
        value=""
        placeholder="Type a message"
        ariaExpanded={false}
        onChange={onChange}
        onCaretChange={() => {}}
        onKeyDown={() => {}}
        onPasteFiles={onPasteFiles}
      />,
    );
    const editor = container.querySelector(".composer-editor") as HTMLElement;
    const image = pastedImage();
    fireEvent.paste(editor, {
      clipboardData: {
        files: [image],
        items: [],
        getData: () => "",
      },
    });
    expect(onPasteFiles).toHaveBeenCalledTimes(1);
    expect((onPasteFiles.mock.calls[0] as unknown as File[][])[0]).toEqual([image]);
    expect(onChange).not.toHaveBeenCalled();
  });

  test("text-only pastes still insert text and never touch onPasteFiles", () => {
    const onChange = mock((_value: string) => {});
    const onPasteFiles = mock(() => {});
    const { container } = render(
      <ComposerEditor
        value=""
        placeholder="Type a message"
        ariaExpanded={false}
        onChange={onChange}
        onCaretChange={() => {}}
        onKeyDown={() => {}}
        onPasteFiles={onPasteFiles}
      />,
    );
    const editor = container.querySelector(".composer-editor") as HTMLElement;
    editor.focus();
    // Text insertion splices at the current selection, so place an explicit
    // collapsed caret or the paste has nowhere to land.
    const range = document.createRange();
    range.selectNodeContents(editor);
    range.collapse(false);
    const selection = window.getSelection();
    selection?.removeAllRanges();
    selection?.addRange(range);
    fireEvent.paste(editor, {
      clipboardData: {
        files: [],
        items: [],
        getData: () => "hello pasted",
      },
    });
    expect(onPasteFiles).not.toHaveBeenCalled();
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange.mock.calls[0]?.[0]).toBe("hello pasted");
  });
});
