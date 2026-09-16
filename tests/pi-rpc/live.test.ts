import { test } from "bun:test";
import { runAgentServiceAbortAcceptance, runAgentServiceAcceptance } from "./agent-service-live.ts";
import { runAbortAcceptance, runLiveAcceptance } from "./live.ts";
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

test("Pi RPC abort settles a live generation (NullModel double)", async () => {
  if (process.env.PASSAGE_PI_LIVE === "real" || process.env.PASSAGE_PI_USE_REAL === "1") {
    await runAbortAcceptance();
  } else {
    await withNullModelHarness(() => runAbortAcceptance(), { firstTokenMs: 2_000 });
  }
}, 45_000);

test("Pi AgentService returns to idle after a confirmed cancellation (NullModel double)", async () => {
  if (process.env.PASSAGE_PI_LIVE === "real" || process.env.PASSAGE_PI_USE_REAL === "1") {
    await runAgentServiceAbortAcceptance();
  } else {
    await withNullModelHarness(() => runAgentServiceAbortAcceptance(), { persona: "verbose", perTokenMs: 100 });
  }
}, 45_000);
