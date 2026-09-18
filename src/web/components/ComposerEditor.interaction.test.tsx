import { describe, expect, test } from "bun:test";
import React, { createRef } from "react";
import { render } from "@testing-library/react";
import { ComposerEditor, type ComposerEditorHandle } from "./ComposerEditor.tsx";
import { setupDomTests } from "../test-utils/dom.ts";

// Client-rendered proof of the editor handle's blur: the composer holds
// focus through pointerdown (so the first tap sends) and blurs after
// dispatch to restore the familiar post-send keyboard dismissal.
setupDomTests();

describe("ComposerEditor handle", () => {
  test("blur() releases editor focus so the keyboard can dismiss after send", () => {
    const ref = createRef<ComposerEditorHandle>();
    const { container } = render(
      <ComposerEditor
        ref={ref}
        value="hello"
        placeholder="Type a message"
        ariaExpanded={false}
        onChange={() => {}}
        onCaretChange={() => {}}
        onKeyDown={() => {}}
      />,
    );
    const editor = container.querySelector(".composer-editor") as HTMLElement;
    expect(editor).not.toBeNull();

    ref.current?.focus();
    expect(document.activeElement).toBe(editor);

    ref.current?.blur();
    expect(document.activeElement).not.toBe(editor);
  });
});
