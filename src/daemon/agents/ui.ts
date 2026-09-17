import type { PiRecord } from "./rpc/index.ts";

const DIALOG_METHODS = new Set(["select", "confirm", "input", "editor"]);
const MAX_UI_TITLE_LENGTH = 16 * 1024;
const MAX_UI_OPTIONS = 64;
const MAX_UI_OPTION_LENGTH = 8 * 1024;

export type PiExtensionUiDialog = {
  id: string;
  method: "select" | "confirm" | "input" | "editor";
  title?: string;
  options?: string[];
  message?: string;
  placeholder?: string;
  prefill?: string;
};

function boundedString(value: unknown, maximum = MAX_UI_TITLE_LENGTH): string | undefined {
  return typeof value === "string" && value.length <= maximum ? value : undefined;
}

/**
 * Project Pi's documented RPC dialog request into the browser-safe shape.
 * Tool call arguments are deliberately not an input source: Pi has already
 * translated ctx.ui calls into this request/response protocol.
 */
export function parsePiExtensionUiDialog(record: PiRecord): PiExtensionUiDialog | undefined {
  if (record.type !== "extension_ui_request" || typeof record.id !== "string") return undefined;
  if (!DIALOG_METHODS.has(String(record.method))) return undefined;

  const options = Array.isArray(record.options)
    ? record.options
        .slice(0, MAX_UI_OPTIONS)
        .flatMap((option) => {
          const value = boundedString(option, MAX_UI_OPTION_LENGTH);
          return value === undefined ? [] : [value];
        })
    : undefined;

  return {
    id: record.id,
    method: record.method as PiExtensionUiDialog["method"],
    ...(boundedString(record.title) === undefined ? {} : { title: boundedString(record.title)! }),
    ...(options === undefined ? {} : { options }),
    ...(boundedString(record.message) === undefined ? {} : { message: boundedString(record.message)! }),
    ...(boundedString(record.placeholder) === undefined ? {} : { placeholder: boundedString(record.placeholder)! }),
    ...(boundedString(record.prefill) === undefined ? {} : { prefill: boundedString(record.prefill)! }),
  };
}
