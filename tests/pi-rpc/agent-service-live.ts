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
    // create() returns before the Pi boot finishes (so the New Agent pane
    // can open immediately); wait for both boots before asserting liveness.
    // capabilities() waits on the pending boot via ensureProcess, so it
    // doubles as the boot barrier.
    await Promise.all([service.capabilities(first.id), service.capabilities(second.id)]);
    const firstLive = service.snapshot(first.id);
    const secondLive = service.snapshot(second.id);
    if (!firstLive.live || !secondLive.live || first.piSessionId === second.piSessionId) {
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

export async function runAgentServiceAbortAcceptance(): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), "passage-agent-service-abort-live-"));
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
    const agent = await service.create("workspace-live", "Live cancellation agent");
    await service.prompt(agent.id, "Give a detailed explanation of distributed systems and include many examples.");
    const runningDeadline = Date.now() + SETTLEMENT_TIMEOUT_MS;
    while (Date.now() < runningDeadline && service.snapshot(agent.id).lastKnownStatus !== "running") {
      await Bun.sleep(POLL_INTERVAL_MS);
    }
    if (service.snapshot(agent.id).lastKnownStatus !== "running") {
      throw new Error("Pi agent did not begin streaming before cancellation");
    }
    await service.abort(agent.id);
    if (service.snapshot(agent.id).lastKnownStatus !== "stopping") {
      throw new Error("Pi agent did not enter stopping state after cancellation request");
    }
    await waitForSettled(service, agent.id);
    if (service.snapshot(agent.id).lastKnownStatus !== "idle") {
      throw new Error("Pi agent did not return to idle after confirmed cancellation");
    }
  } finally {
    await service.shutdown();
    store.close();
    await rm(root, { recursive: true, force: true });
  }
}
