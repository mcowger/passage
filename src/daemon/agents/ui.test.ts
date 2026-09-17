import { expect, test } from "bun:test";
import { parsePiExtensionUiDialog } from "./ui.ts";

test("parses Pi's documented extension UI dialogs", () => {
  expect(parsePiExtensionUiDialog({
    type: "extension_ui_request",
    id: "question-1",
    method: "editor",
    title: "Edit response",
    placeholder: "Write the details",
    prefill: "Existing text",
  })).toEqual({
    id: "question-1",
    method: "editor",
    title: "Edit response",
    placeholder: "Write the details",
    prefill: "Existing text",
  });
});

test("rejects non-dialog extension events", () => {
  expect(parsePiExtensionUiDialog({ type: "extension_ui_request", id: "notify-1", method: "notify" })).toBeUndefined();
  expect(parsePiExtensionUiDialog({ type: "tool_execution_start", id: "tool-1" })).toBeUndefined();
});
