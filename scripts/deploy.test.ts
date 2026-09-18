import { describe, expect, it } from "bun:test";
import {
  beginHeldDrain,
  cancelDrain,
  commitShutdown,
  resolveDeployPort,
  waitForReady,
  type FetchJson,
} from "./deploy.ts";

function fakeFetch(responses: Array<{ ok: boolean; status?: number; body?: unknown }>): { fetchJson: FetchJson; calls: Array<{ url: string; init?: RequestInit }> } {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  let index = 0;
  const fetchJson: FetchJson = async (url, init) => {
    calls.push({ url, init });
    const response = responses[Math.min(index, responses.length - 1)];
    index += 1;
    return { ok: response.ok, status: response.status ?? (response.ok ? 200 : 500), body: response.body };
  };
  return { fetchJson, calls };
}

describe("resolveDeployPort", () => {
  it("prefers PASSAGE_DEPLOY_PORT, then PORT, then PASEO_PORT", () => {
    expect(resolveDeployPort({ PASSAGE_DEPLOY_PORT: "6666", PORT: "3000", PASEO_PORT: "4000" })).toBe(6666);
    expect(resolveDeployPort({ PORT: "3000", PASEO_PORT: "4000" })).toBe(3000);
    expect(resolveDeployPort({ PASEO_PORT: "4000" })).toBe(4000);
  });

  it("refuses to guess when nothing is set or the value is invalid", () => {
    expect(resolveDeployPort({})).toBeNull();
    expect(resolveDeployPort({ PORT: "not-a-number" })).toBeNull();
    expect(resolveDeployPort({ PORT: "0" })).toBeNull();
    expect(resolveDeployPort({ PORT: "70000" })).toBeNull();
  });
});

describe("beginHeldDrain", () => {
  it("returns the identity on success", async () => {
    const { fetchJson } = fakeFetch([{ ok: true, body: { phase: "draining", instanceId: "i-1", drainId: "d-1" } }]);
    expect(await beginHeldDrain("http://127.0.0.1:6666", fetchJson)).toEqual({ instanceId: "i-1", drainId: "d-1" });
  });

  it("returns null on an HTTP-level failure or a malformed body, without throwing", async () => {
    const failed = fakeFetch([{ ok: false, status: 502 }]);
    expect(await beginHeldDrain("http://127.0.0.1:6666", failed.fetchJson)).toBeNull();
    const malformed = fakeFetch([{ ok: true, body: { phase: "draining" } }]);
    expect(await beginHeldDrain("http://127.0.0.1:6666", malformed.fetchJson)).toBeNull();
  });
});

describe("waitForReady", () => {
  const identity = { instanceId: "i-1", drainId: "d-1" };
  const noopLog = () => {};
  const noopSleep = async () => {};

  it("resolves ready once the snapshot reports phase ready under the same identity", async () => {
    const { fetchJson } = fakeFetch([
      { ok: true, body: { instanceId: "i-1", drainId: "d-1", phase: "draining", blockedCount: 1 } },
      { ok: true, body: { instanceId: "i-1", drainId: "d-1", phase: "ready", readinessRevision: 3, blockedCount: 0 } },
    ]);
    const result = await waitForReady("http://127.0.0.1:6666", identity, 5000, fetchJson, noopSleep, noopLog);
    expect(result).toEqual({ outcome: "ready", readinessRevision: 3 });
  });

  it("reports cancelled when the phase returns to running", async () => {
    const { fetchJson } = fakeFetch([{ ok: true, body: { instanceId: "i-1", drainId: "d-1", phase: "running" } }]);
    expect(await waitForReady("http://127.0.0.1:6666", identity, 5000, fetchJson, noopSleep, noopLog)).toEqual({ outcome: "cancelled" });
  });

  it("reports superseded when a different drainId or instanceId is observed, without waiting on someone else's drain", async () => {
    const differentDrain = fakeFetch([{ ok: true, body: { instanceId: "i-1", drainId: "d-2", phase: "draining" } }]);
    expect(await waitForReady("http://127.0.0.1:6666", identity, 5000, differentDrain.fetchJson, noopSleep, noopLog)).toEqual({ outcome: "superseded" });
    const differentInstance = fakeFetch([{ ok: true, body: { instanceId: "i-2", drainId: "d-1", phase: "draining" } }]);
    expect(await waitForReady("http://127.0.0.1:6666", identity, 5000, differentInstance.fetchJson, noopSleep, noopLog)).toEqual({ outcome: "superseded" });
  });

  it("reports unreachable on an HTTP-level failure", async () => {
    const { fetchJson } = fakeFetch([{ ok: false, status: 503 }]);
    expect(await waitForReady("http://127.0.0.1:6666", identity, 5000, fetchJson, noopSleep, noopLog)).toEqual({ outcome: "unreachable" });
  });

  it("reports timeout without ever escalating on its own -- no automatic kill deadline on the daemon side to race", async () => {
    const { fetchJson } = fakeFetch([{ ok: true, body: { instanceId: "i-1", drainId: "d-1", phase: "draining", blockedCount: 2 } }]);
    let sleeps = 0;
    const result = await waitForReady("http://127.0.0.1:6666", identity, 5, fetchJson, async () => { sleeps += 1; }, noopLog);
    expect(result).toEqual({ outcome: "timeout" });
    expect(sleeps).toBeGreaterThan(0);
  });
});

describe("commitShutdown", () => {
  it("sends the exact identity and reports whether the daemon accepted it", async () => {
    const accepted = fakeFetch([{ ok: true, body: { ok: true, accepted: true } }]);
    const identity = { instanceId: "i-1", drainId: "d-1", readinessRevision: 3 };
    expect(await commitShutdown("http://127.0.0.1:6666", identity, accepted.fetchJson)).toBe(true);
    expect(JSON.parse(String(accepted.calls[0].init?.body))).toEqual(identity);
    expect(accepted.calls[0].url).toBe("http://127.0.0.1:6666/api/daemon/shutdown");

    const stale = fakeFetch([{ ok: false, status: 409, body: { ok: false, error: "stale" } }]);
    expect(await commitShutdown("http://127.0.0.1:6666", identity, stale.fetchJson)).toBe(false);
  });
});

describe("cancelDrain", () => {
  it("issues a DELETE and never throws even if the request fails", async () => {
    const { fetchJson, calls } = fakeFetch([{ ok: true, body: { phase: "running" } }]);
    await cancelDrain("http://127.0.0.1:6666", fetchJson);
    expect(calls[0]).toMatchObject({ url: "http://127.0.0.1:6666/api/daemon/drain", init: { method: "DELETE" } });

    const throwing: FetchJson = async () => { throw new Error("network down"); };
    await expect(cancelDrain("http://127.0.0.1:6666", throwing)).resolves.toBeUndefined();
  });
});
