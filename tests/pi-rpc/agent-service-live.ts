import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AgentService } from "../../src/daemon/agents/service.ts";
import { MetadataRepositories, MetadataStore } from "../../src/daemon/metadata/index.ts";

const SETTLEMENT_TIMEOUT_MS = 90_000;
const POLL_INTERVAL_MS = 100;

async function waitForSettled(service: AgentService, agentId: string): Promise<void> {
  const deadline = Date.now() + SETTLEMENT_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const snapshot = service.snapshot(agentId);
    if (snapshot.persisted && ["idle", "error", "needs-attention"].includes(snapshot.lastKnownStatus)) return;
    if (snapshot.lastKnownStatus === "error" || snapshot.lastKnownStatus === "needs-attention") {
      throw new Error(`Pi agent ${agentId} requires attention before session persistence`);
    }
    await Bun.sleep(POLL_INTERVAL_MS);
  }
  throw new Error(`Pi agent ${agentId} did not settle before timeout`);
}

export async function runAgentServiceAcceptance(): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), "passage-agent-service-live-"));
  const store = new MetadataStore(join(root, "metadata.sqlite"));
  const repositories = new MetadataRepositories(store.db);
  repositories.projects.save({
    id: "project-live",
    configuredRootPath: root,
    canonicalRootPath: root,
    displayLabel: "Live Pi project",
    archivedAt: null,
  });
  repositories.workspaces.save({
    id: "workspace-live",
    projectId: "project-live",
    kind: "directory",
    cwd: root,
    checkoutRoot: root,
    mainRepositoryRoot: null,
    branchRef: null,
    displayLabel: "Live Pi workspace",
    locationId: null,
    ownershipState: "not-owned",
    archivedAt: null,
  });
  const service = new AgentService(repositories, { sessionsRoot: join(root, "sessions") });

  try {
    const [first, second] = await Promise.all([
      service.create("workspace-live", "Live agent one"),
      service.create("workspace-live", "Live agent two"),
    ]);
    if (!first.live || !second.live || first.piSessionId === second.piSessionId) {
      throw new Error("Pi agents did not start as isolated live processes");
    }
    await service.capabilities(first.id);
    await service.prompt(first.id, "Reply with exactly: PASSAGE_AGENT_ONE");
    await waitForSettled(service, first.id);
    await service.prompt(second.id, "Reply with exactly: PASSAGE_AGENT_TWO");
    await waitForSettled(service, second.id);
    const [firstHistory, secondHistory] = await Promise.all([service.history(first.id), service.history(second.id)]);
    if ("unpersisted" in firstHistory || "unpersisted" in secondHistory) {
      throw new Error("Pi agent history was not persisted after settlement");
    }
    if (!firstHistory.history.timeline.some((item) => item.kind === "user")
      || !secondHistory.history.timeline.some((item) => item.kind === "user")) {
      throw new Error("Pi JSONL history did not contain admitted user turns");
    }
    if (firstHistory.history.sessionId === secondHistory.history.sessionId) {
      throw new Error("Pi JSONL histories are not isolated");
    }
    const firstSessionPath = service.snapshot(first.id).piSessionPath;
    await service.stop(first.id);
    await service.start(first.id);
    const resumed = service.snapshot(first.id);
    if (!resumed.live || resumed.piSessionId !== first.piSessionId || resumed.piSessionPath !== firstSessionPath) {
      throw new Error("Agent service did not resume the same Pi session");
    }
  } finally {
    await service.shutdown();
    store.close();
    await rm(root, { recursive: true, force: true });
  }
}
