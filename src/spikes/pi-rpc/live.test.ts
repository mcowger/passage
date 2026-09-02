import { test } from "bun:test";
import { runLiveAcceptance } from "./live.ts";

const live = process.env.PASSAGE_PI_LIVE === "1" ? test : test.skip;

if (process.env.PASSAGE_PI_LIVE !== "1") console.info("SKIP: PASSAGE_PI_LIVE is not 1; live Pi acceptance gate was not run");

live("LIVE Pi RPC acceptance gate (opt-in)", async () => {
  await runLiveAcceptance();
});
