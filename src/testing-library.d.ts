import type { TestingLibraryMatchers } from "@testing-library/jest-dom/matchers";
import type { expect } from "bun:test";

// jest-dom matchers registered on bun:test expect at runtime via
// testing-library.ts preload. Mirrors Bun's Testing Library guide.
declare module "bun:test" {
  interface Matchers<T> extends TestingLibraryMatchers<ReturnType<typeof expect.stringContaining>, T> {}
}
