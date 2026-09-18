import { afterAll, afterEach, beforeAll, expect } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { cleanup } from "@testing-library/react";
import * as matchers from "@testing-library/jest-dom/matchers";

// Opt-in DOM environment for client-rendered component tests.
//
// Why scoped instead of a global bunfig.toml [test] preload: this repo's
// existing tests depend on Bun's bare environment. GlobalRegistrator
// defines document/window/navigator as readonly globals, which breaks the
// hand-rolled fake-global socket tests (they assign globalThis.document),
// and it replaces Request/Response, which breaks daemon origin-policy
// tests. Registering per-file keeps daemon tests pristine regardless of
// file order — afterAll unregisters and restores the original globals.
//
// Usage (one line at the top of a *.interaction.test.tsx file):
//
//   import { setupDomTests } from "../test-utils/dom.ts";
//   setupDomTests();
//
// Caveat: use render-bound queries (const { getByRole } = render(...)),
// never the `screen` global — screen binds to document at import time,
// before the beforeAll below registers happy-dom.
export function setupDomTests() {
  expect.extend(matchers);

  beforeAll(() => {
    GlobalRegistrator.register({
      url: "http://localhost/",
      width: 1280,
      height: 800,
    });

    // happy-dom omits a few browser APIs Passage touches. Minimal no-op
    // shims so tests don't need per-file boilerplate.
    if (typeof globalThis.ResizeObserver === "undefined") {
      globalThis.ResizeObserver = class ResizeObserver {
        observe() {}
        unobserve() {}
        disconnect() {}
      } as unknown as typeof globalThis.ResizeObserver;
    }

    if (typeof globalThis.IntersectionObserver === "undefined") {
      globalThis.IntersectionObserver = class IntersectionObserver {
        constructor(
          private callback: IntersectionObserverCallback,
          private options?: IntersectionObserverInit,
        ) {
          void this.callback;
          void this.options;
        }
        observe() {}
        unobserve() {}
        disconnect() {}
        takeRecords(): IntersectionObserverEntry[] {
          return [];
        }
      } as unknown as typeof globalThis.IntersectionObserver;
    }

    if (typeof window !== "undefined" && typeof window.matchMedia === "undefined") {
      Object.defineProperty(window, "matchMedia", {
        writable: true,
        value: (query: string) => ({
          matches: false,
          media: query,
          onchange: null,
          addListener: () => {},
          removeListener: () => {},
          addEventListener: () => {},
          removeEventListener: () => {},
          dispatchEvent: () => false,
        }),
      });
    }

    // happy-dom's Element lacks scrollIntoView (used by DirectoryPicker).
    if (
      typeof Element !== "undefined" &&
      typeof (Element.prototype as { scrollIntoView?: unknown }).scrollIntoView === "undefined"
    ) {
      (Element.prototype as { scrollIntoView: () => void }).scrollIntoView = () => {};
    }
  });

  afterEach(() => {
    cleanup();
    document.body.innerHTML = "";
    localStorage.clear();
  });

  afterAll(async () => {
    await GlobalRegistrator.unregister();
  });
}
