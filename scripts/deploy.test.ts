import { describe, expect, it } from "bun:test";
import { resolveDeployPort } from "./deploy.ts";

describe("resolveDeployPort", () => {
  it("prefers PASSAGE_DEPLOY_PORT, then PORT, then PASEO_PORT", () => {
    expect(resolveDeployPort({ PASSAGE_DEPLOY_PORT: "6666", PORT: "3000", PASEO_PORT: "4000" })).toBe(6666);
    expect(resolveDeployPort({ PORT: "3000", PASEO_PORT: "4000" })).toBe(3000);
    expect(resolveDeployPort({ PASEO_PORT: "4000" })).toBe(4000);
  });

  it("is optional: absent or invalid just means no HTTP health check, not an error", () => {
    expect(resolveDeployPort({})).toBeNull();
    expect(resolveDeployPort({ PORT: "not-a-number" })).toBeNull();
    expect(resolveDeployPort({ PORT: "0" })).toBeNull();
    expect(resolveDeployPort({ PORT: "70000" })).toBeNull();
  });
});
