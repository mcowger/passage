import { runAgentServiceAcceptance, runAgentServiceRestartRecoveryAcceptance } from "./agent-service-live.ts";
import { runLiveAcceptance } from "./live.ts";
import { withNullModelHarness } from "./nullmodel-harness.ts";

if (process.env.PASSAGE_PI_LIVE === "real" || process.env.PASSAGE_PI_USE_REAL === "1") {
  await runLiveAcceptance();
  await runAgentServiceAcceptance();
  await runAgentServiceRestartRecoveryAcceptance();
} else {
  await withNullModelHarness(async () => {
    await runLiveAcceptance();
    await runAgentServiceAcceptance();
    await runAgentServiceRestartRecoveryAcceptance();
  });
}
