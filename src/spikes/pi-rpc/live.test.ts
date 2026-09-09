import { test } from "bun:test";
import { runAgentServiceAcceptance } from "./agent-service-live.ts";
import { runLiveAcceptance } from "./live.ts";
import { withNullModelHarness } from "./nullmodel-harness.ts";

test("Pi RPC acceptance gate (NullModel double)", async () => {
  if (process.env.PASSAGE_PI_LIVE === "real" || process.env.PASSAGE_PI_USE_REAL === "1") {
    await runLiveAcceptance();
  } else {
    await withNullModelHarness(() => runLiveAcceptance());
  }
}, 45_000);

test("Pi AgentService acceptance gate (NullModel double)", async () => {
  if (process.env.PASSAGE_PI_LIVE === "real" || process.env.PASSAGE_PI_USE_REAL === "1") {
    await runAgentServiceAcceptance();
  } else {
    await withNullModelHarness(() => runAgentServiceAcceptance());
  }
}, 45_000);
