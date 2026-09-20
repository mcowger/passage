import { expect, test } from "bun:test";
import { resolveVerifyPort, verifyRestarted } from "./deploy.ts";

test("resolveVerifyPort defaults, accepts valid ports, and rejects garbage", () => {
  expect(resolveVerifyPort({})).toBe(6666);
  expect(resolveVerifyPort({ PASSAGE_DEPLOY_PORT: "7777" })).toBe(7777);
  expect(resolveVerifyPort({ PASSAGE_DEPLOY_PORT: "bogus" })).toBeNull();
  expect(resolveVerifyPort({ PASSAGE_DEPLOY_PORT: "0" })).toBeNull();
});

function stubHealth(commit: string | undefined, status = 200) {
  return Bun.serve({
    port: 0,
    fetch: () => status === 200
      ? Response.json({ ok: true, build: { commit } })
      : new Response("down", { status }),
  });
}

test("verifyRestarted accepts a build matching HEAD on the first poll", async () => {
  const server = stubHealth("abc1234");
  try {
    expect(await verifyRestarted(server.port, "old9999", "abc1234", 5000, 10)).toBe("abc1234");
  } finally {
    server.stop(true);
  }
});

test("verifyRestarted accepts any real commit differing from the old build", async () => {
  const server = stubHealth("new5555");
  try {
    expect(await verifyRestarted(server.port, "old9999", undefined, 5000, 10)).toBe("new5555");
  } finally {
    server.stop(true);
  }
});

test("verifyRestarted ignores placeholder commits and unreachable servers", async () => {
  const dev = stubHealth("dev");
  const unknown = stubHealth("unknown");
  try {
    expect(await verifyRestarted(dev.port, "old9999", "abc1234", 100, 10)).toBeUndefined();
    expect(await verifyRestarted(unknown.port, undefined, undefined, 100, 10)).toBeUndefined();
    expect(await verifyRestarted(1, "old9999", "abc1234", 100, 10)).toBeUndefined();
  } finally {
    dev.stop(true);
    unknown.stop(true);
  }
});
