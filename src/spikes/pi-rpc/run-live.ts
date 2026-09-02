import { runAgentServiceAcceptance } from "./agent-service-live.ts";
import { runLiveAcceptance } from "./live.ts";

await runLiveAcceptance();
await runAgentServiceAcceptance();
