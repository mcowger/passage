import { beforeEach, afterEach, describe, expect, test } from "bun:test";
import React from "react";
import ReactDOMServer from "react-dom/server";
import { isMobileComposerViewport, offsetFromPoint, pointAtOffset, readComposerDraft, renderComposerDraft, shouldSubmitOnEnter } from "./ComposerEditor.tsx";

describe("renderComposerDraft", () => {
  const html = (text: string) =>
    ReactDOMServer.renderToStaticMarkup(React.createElement("div", null, ...renderComposerDraft(text)));

  test("renders file refs as atomic composer mentions", () => {
    const out = html("Review @`src/index.ts` before sending");
    expect(out).toContain("composer-file-mention");
    expect(out).toContain("data-composer-raw=\"@`src/index.ts`\"");
    expect(out).toContain("file-type-icon");
    expect(out).toContain("src/index.ts");
  });

  test("renders skill refs as atomic composer mentions with a cap icon", () => {
    const out = html("Try /skill:gh-cli for this");
    expect(out).toContain("composer-skill-mention");
    expect(out).toContain("data-composer-raw=\"/skill:gh-cli\"");
    expect(out).toContain("<svg");
    expect(out).toContain("/skill:gh-cli");
  });

  test("keeps ordinary draft text ordinary", () => {
    expect(html("hello world")).toBe("<div>hello world</div>");
  });
});

describe("isMobileComposerViewport", () => {
  test("treats narrow viewports as mobile", () => {
    expect(isMobileComposerViewport(767, false)).toBe(true);
    expect(isMobileComposerViewport(768, false)).toBe(false);
  });

  test("treats coarse pointers as mobile even on wide viewports", () => {
    expect(isMobileComposerViewport(1280, true)).toBe(true);
    expect(isMobileComposerViewport(1280, false)).toBe(false);
  });
});

describe("shouldSubmitOnEnter", () => {
  test("desktop plain Enter submits", () => {
    expect(shouldSubmitOnEnter({ shiftKey: false }, false)).toBe(true);
  });

  test("Shift+Enter never submits", () => {
    expect(shouldSubmitOnEnter({ shiftKey: true }, false)).toBe(false);
    expect(shouldSubmitOnEnter({ shiftKey: true }, true)).toBe(false);
  });

  test("mobile plain Enter does not submit", () => {
    expect(shouldSubmitOnEnter({ shiftKey: false }, true)).toBe(false);
  });

  test("mobile Cmd/Ctrl+Enter still submits for hardware keyboards", () => {
    expect(shouldSubmitOnEnter({ shiftKey: false, metaKey: true }, true)).toBe(true);
    expect(shouldSubmitOnEnter({ shiftKey: false, ctrlKey: true }, true)).toBe(true);
  });
});

/**
 * Minimal fake DOM for the composer plaintext layer. `readComposerDraft`,
 * `offsetFromPoint`, and `pointAtOffset` only touch `nodeType`, `nodeName`,
 * `nodeValue`, `childNodes`, `dataset`, `tagName`, `parentNode`, and
 * `contains`, plus `instanceof HTMLElement` for block detection -- so a tiny
 * structural fake exercises the real joining/boundary logic, including the
 * nested-block shapes real contentEditable editing produces.
 */
class FakeTextNode {
  readonly nodeType = 3;
  readonly nodeName = "#text";
  readonly childNodes: Array<FakeElement | FakeTextNode> = [];
  parentNode: FakeElement | null = null;
  constructor(public nodeValue: string) {}
}

class FakeElement {
  readonly nodeType = 1;
  readonly nodeName: string;
  readonly childNodes: Array<FakeElement | FakeTextNode> = [];
  parentNode: FakeElement | null = null;
  dataset: Record<string, string> = {};
  constructor(
    readonly tagName: string,
    dataset?: Record<string, string>,
  ) {
    this.nodeName = tagName;
    if (dataset) this.dataset = { ...dataset };
  }
  append(...kids: Array<FakeElement | FakeTextNode>): void {
    for (const kid of kids) {
      kid.parentNode = this;
      this.childNodes.push(kid);
    }
  }
  contains(node: FakeElement | FakeTextNode | null): boolean {
    if (node === null) return false;
    if (node === (this as unknown as FakeElement | FakeTextNode)) return true;
    return this.childNodes.some(
      (child) => child === node || (child instanceof FakeElement && child.contains(node)),
    );
  }
}

type FakeNode = FakeElement | FakeTextNode;

function t(text: string): FakeTextNode {
  return new FakeTextNode(text);
}

function el(tag: string, ...kids: Array<FakeNode | string>): FakeElement {
  const node = new FakeElement(tag);
  node.append(...kids.map((kid) => (typeof kid === "string" ? t(kid) : kid)));
  return node;
}

const div = (...kids: Array<FakeNode | string>): FakeElement => el("DIV", ...kids);
const br = (): FakeElement => el("BR");

function chip(token: string): FakeElement {
  return new FakeElement("SPAN", { composerRaw: token });
}

function editor(...kids: Array<FakeNode | string>): FakeElement {
  return el("DIV", ...kids);
}

function asHtml(node: FakeElement): HTMLElement {
  return node as unknown as HTMLElement;
}

function asNode(node: FakeNode): Node {
  return node as unknown as Node;
}

describe("readComposerDraft", () => {
  const globals = globalThis as unknown as Record<string, unknown>;
  let prevNode: unknown;
  let prevHTMLElement: unknown;

  beforeEach(() => {
    prevNode = globals.Node;
    prevHTMLElement = globals.HTMLElement;
    globals.Node = { ELEMENT_NODE: 1, TEXT_NODE: 3 };
    globals.HTMLElement = FakeElement;
  });

  afterEach(() => {
    if (prevNode === undefined) delete globals.Node;
    else globals.Node = prevNode;
    if (prevHTMLElement === undefined) delete globals.HTMLElement;
    else globals.HTMLElement = prevHTMLElement;
  });

  test("keeps top-level lines and blank lines", () => {
    const root = editor(
      div("OK lets adjust."),
      div(br()),
      div("active: slow pulsing muted orange"),
      div("idle: bright blue"),
      div("attention: pulsing red"),
    );
    expect(readComposerDraft(asHtml(root))).toBe(
      "OK lets adjust.\n\nactive: slow pulsing muted orange\nidle: bright blue\nattention: pulsing red",
    );
  });

  test("keeps lines nested inside an existing block", () => {
    // contentEditable nests new blocks when multi-line text lands inside an
    // existing line instead of splitting the top level; the old reader fused
    // these into one line while the composer still displayed them as lines.
    const root = editor(div(div("active: slow pulsing muted orange"), div("idle: bright blue")));
    expect(readComposerDraft(asHtml(root))).toBe("active: slow pulsing muted orange\nidle: bright blue");
  });

  test("treats bare text after a block as its own line", () => {
    const root = editor(div("a"), t("b"));
    expect(readComposerDraft(asHtml(root))).toBe("a\nb");
  });

  test("keeps literal newlines in a plain text node", () => {
    const root = editor(t("a\nb\nc"));
    expect(readComposerDraft(asHtml(root))).toBe("a\nb\nc");
  });

  test("reads a br as a line break inside a line", () => {
    const root = editor(div(t("a"), br(), t("b")));
    expect(readComposerDraft(asHtml(root))).toBe("a\nb");
  });

  test("reads mention chips as their raw tokens", () => {
    const root = editor(t("see "), chip("@`src/index.ts`"), t(" now"));
    expect(readComposerDraft(asHtml(root))).toBe("see @`src/index.ts` now");
  });

  test("treats a lone br as the empty editor", () => {
    expect(readComposerDraft(asHtml(editor(br())))).toBe("");
    expect(readComposerDraft(asHtml(editor()))).toBe("");
  });

  test("caret mapping round-trips every offset", () => {
    const cases: FakeElement[] = [
      editor(div("ab"), div("cd")),
      editor(div(div("a"), div("bcd")), div("e")),
      editor(t("hi"), div("there"), t("!")),
      editor(div(t("a"), br(), t("b"))),
      editor(t("see "), chip("@`x.ts`"), t(" end")),
    ];
    for (const root of cases) {
      const text = readComposerDraft(asHtml(root));
      for (let offset = 0; offset <= text.length; offset += 1) {
        // Offsets strictly inside a chip are atomic: the caret snaps past it.
        const point = pointAtOffset(asHtml(root), offset);
        const back = offsetFromPoint(asHtml(root), asNode(point.node as unknown as FakeNode), point.offset);
        const inChip = text.includes("@`x.ts`") && offset > 4 && offset < 4 + "@`x.ts`".length;
        expect(back).toBe(inChip ? 4 + "@`x.ts`".length : offset);
      }
    }
  });

  test("element anchors measure child indexes, not characters", () => {
    const inner = t("hello");
    const root = editor(div(inner), div("next"));
    expect(readComposerDraft(asHtml(root))).toBe("hello\nnext");
    // Caret at the end of the first line's text.
    expect(offsetFromPoint(asHtml(root), asNode(inner), 5)).toBe(5);
    // Caret at the start of the second line resolves past the boundary.
    const point = pointAtOffset(asHtml(root), 6);
    expect(offsetFromPoint(asHtml(root), asNode(point.node as unknown as FakeNode), point.offset)).toBe(6);
  });
});
