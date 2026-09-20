import { expect, test, afterEach, describe } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { MetadataStore } from "../metadata/database.ts";
import { MetadataRepositories, type Workspace } from "../metadata/repositories.ts";
import { AgentService, CONTINUATION_MESSAGE, DEFAULT_AUTO_CONTINUE_WINDOW_MS, collectTitleSources, isGitCommitToolEvent, resolveAutoContinueWindowMs } from "./service.ts";
import { PiRpcManager } from "./rpc/index.ts";

const script = `process.stdin.on('data',d=>{for(const l of d.toString().split('\\n')){if(!l)continue;const r=JSON.parse(l);if(r.type==='prompt'||r.type==='steer'||r.type==='follow_up')process.stdout.write(JSON.stringify({type:'agent_settled'})+'\\n');const data=r.type==='get_available_models'?{models:[{provider:'test',id:'model',name:'Model',api:'test',input:['text'],authenticated:true,supportedThinkingLevels:['medium','high']}]}:r.type==='get_available_thinking_levels'?{levels:['medium','high']}:{};process.stdout.write(JSON.stringify({type:'response',id:r.id,success:true,data})+'\\n')}})`;
const roots: string[] = [];
const make = async (limit = 10, executableArgs?: string[], autoContinueWindowMs?: number, admissionGate?: () => boolean) => {
  const root = await mkdtemp(join("/tmp", "passage-agent-")); roots.push(root);
  const store = new MetadataStore(":memory:"); const repos = new MetadataRepositories(store.db);
  repos.projects.save({ id: "p", configuredRootPath: root, canonicalRootPath: root, displayLabel: "p", archivedAt: null });
  const workspace: Workspace = { id: "w", projectId: "p", kind: "directory", cwd: root, checkoutRoot: root, mainRepositoryRoot: root, branchRef: null, displayLabel: "w", locationId: null, ownershipState: "not-owned", archivedAt: null }; repos.workspaces.save(workspace);
  const manager = new PiRpcManager(4); const service = new AgentService(repos, { sessionsRoot: join(root, "sessions"), manager, listLimit: limit, pi: { executable: process.execPath, executableArgs: executableArgs ?? ["-e", script] }, titleSuggester: { suggestTitle: async () => null }, ...(autoContinueWindowMs === undefined ? {} : { autoContinueWindowMs }), ...(admissionGate === undefined ? {} : { admissionGate }) });
  return { root, store, repos, manager, service };
};
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });

/** Re-runs an assertion block until it passes or the timeout elapses. The
 *  suite drives real subprocesses (mock Pi over RPC), so asserting on async
 *  side-effects after a fixed sleep flakes under load; polling keeps the
 *  same assertions deterministic. */
const pollExpect = async <T>(check: () => T | Promise<T>, timeoutMs = 4000): Promise<T> => {
  const start = Date.now();
  for (;;) {
    try {
      return await check();
    } catch (error) {
      if (Date.now() - start > timeoutMs) throw error;
      await Bun.sleep(10);
    }
  }
};
const waitForIdle = async (service: AgentService, agentId: string, timeoutMs = 4000) => {
  const start = Date.now();
  for (;;) {
    if (service.snapshot(agentId).lastKnownStatus === "idle") return;
    if (Date.now() - start > timeoutMs) throw new Error("timed out waiting for idle");
    await Bun.sleep(10);
  }
};

test("creates and immediately persists an agent, and supports admission/settlement", async () => {
  const f = await make(); const events: string[] = []; f.service.subscribe(e => events.push(e.type));
  const agent = await f.service.create("w", "one"); expect(agent.piSessionId).toStartWith("pi_"); expect(agent.piSessionPath).toBeNull();
  await f.service.prompt(agent.id, "hello");
  await pollExpect(() => expect(events).toContain("settled"));
  await f.service.shutdown(); f.store.close();
});

test("isolates agents, prevents duplicate subscriptions, and bounds listing", async () => {
  const f = await make(2); const a = await f.service.create("w"); const b = await f.service.create("w"); await f.service.start(a.id); await f.service.start(b.id); expect(f.service.list("w", 2)).toHaveLength(2); expect(() => f.service.list("w", 3)).toThrow(); await f.service.shutdown(); f.store.close();
});

test("distinguishes steering and follow-up commands and returns unpersisted history", async () => {
  const f = await make(); const a = await f.service.create("w"); expect(await f.service.history(a.id)).toEqual({ unpersisted: true, history: null }); await f.service.steer(a.id, "now"); await f.service.followUp(a.id, "later"); await f.service.shutdown(); f.store.close();
});

test("archives separately and rejects archived agents", async () => {
  const f = await make(); const a = await f.service.create("w"); await f.service.archive(a.id); expect(f.repos.agents.get(a.id)?.lastKnownStatus).toBe("archived"); expect(() => f.service.snapshot(a.id)).toThrow("archived"); f.store.close();
});

test("lists archived agents and reopens them back to active", async () => {
  const f = await make();
  const a = await f.service.create("w", "keep");
  const b = await f.service.create("w", "restore-me");
  await f.service.archive(b.id);
  expect(f.service.list("w").map((agent) => agent.id)).toEqual([a.id]);
  const archived = f.service.listArchived("w");
  expect(archived.map((agent) => agent.id)).toEqual([b.id]);
  expect(archived[0]?.persisted).toBe(false);
  const reopened = await f.service.reopen(b.id);
  expect(reopened.lastKnownStatus).toBe("idle");
  expect(f.repos.agents.get(b.id)?.archivedAt).toBeNull();
  expect(f.service.list("w").map((agent) => agent.id).sort()).toEqual([a.id, b.id].sort());
  expect(f.service.listArchived("w")).toHaveLength(0);
  // The restored session accepts new work again.
  await f.service.prompt(b.id, "hello again");
  await expect(f.service.reopen(a.id)).rejects.toMatchObject({ code: "invalid-input" });
  await f.service.shutdown();
  f.store.close();
});

test("listener failures do not break service operation", async () => {
  const f = await make(); f.service.subscribe(() => { throw new Error("listener"); }); const a = await f.service.create("w"); expect(a.id).toStartWith("agt_"); await f.service.shutdown(); f.store.close();
});

test("validates Pi model capabilities before persisting preferences", async () => {
  const f = await make();
  const agent = await f.service.create("w");
  expect(await f.service.capabilities(agent.id)).toMatchObject({
    models: [{ provider: "test", id: "model" }],
    thinkingLevels: ["medium", "high"],
    skillsAvailable: false,
    skillsSupported: true,
  });
  await f.service.model(agent.id, "test", "model");
  await f.service.thinking(agent.id, "high");
  expect(f.repos.agents.get(agent.id)).toMatchObject({ modelPreference: "test/model", thinkingPreference: "high" });
  await expect(f.service.model(agent.id, "test", "missing")).rejects.toMatchObject({ code: "invalid-input" });
  f.store.close();
});

test("capabilities carry live Pi model defaults for brand-new sessions", async () => {
  const f = await make();
  const liveScript = `process.stdin.on('data',d=>{for(const l of d.toString().split('\\n')){if(!l)continue;const r=JSON.parse(l);const data=r.type==='get_available_models'?{models:[{provider:'test',id:'model',name:'Model',api:'test',input:['text'],authenticated:true,supportedThinkingLevels:['medium']}]}:r.type==='get_available_thinking_levels'?{levels:['medium']}:r.type==='get_state'?{model:{provider:'test',id:'model'},thinkingLevel:'medium',isStreaming:false}:{};process.stdout.write(JSON.stringify({type:'response',id:r.id,success:true,data})+'\\n')}})`;
  const service = new AgentService(f.repos, {
    sessionsRoot: join(f.root, "live-default-sessions"),
    manager: new PiRpcManager(1),
    pi: { executable: process.execPath, executableArgs: ["-e", liveScript] },
  });
  const agent = await service.create("w");
  // create() returns before the background boot persists anything.
  expect(f.repos.agents.get(agent.id)?.modelPreference).toBeNull();
  const capabilities = await service.capabilities(agent.id);
  expect(capabilities.currentModel).toEqual({ provider: "test", modelId: "model" });
  expect(capabilities.currentThinkingLevel).toBe("medium");
  // Live defaults are persisted so a later summary fetch agrees.
  expect(f.repos.agents.get(agent.id)).toMatchObject({ modelPreference: "test/model", thinkingPreference: "medium" });
  await service.shutdown();
  await f.service.shutdown();
  f.store.close();
});

test("requires explicit steering or follow-up while an agent is running", async () => {
  const f = await make();
  const agent = await f.service.create("w");
  f.repos.agents.updateStatus(agent.id, "running");
  await expect(f.service.prompt(agent.id, "new prompt")).rejects.toMatchObject({ code: "invalid-input" });
  await f.service.steer(agent.id, "steer instead");
  await f.service.followUp(agent.id, "follow up instead");
  await f.service.shutdown();
  f.store.close();
});

test("recovers a stale running status left behind by a daemon restart", async () => {
  const f = await make();
  const agent = await f.service.create("w");
  // Wait out create()'s background boot so no start is pending, then drop
  // the live process to simulate a daemon restart (in-memory run state is
  // gone but the DB still says `running`).
  await f.service.capabilities(agent.id);
  await f.service.stop(agent.id);
  f.repos.agents.updateStatus(agent.id, "running");
  // Reads report (and persist) the dedicated `interrupted` state -- Pi
  // reported nothing wrong, so this is not `error`; interrupted work must
  // not look idle (invented completion) or still active (stale spinner)
  // either -- so the UI stops showing "generation in flight" on
  // reload/new systems.
  expect(f.service.snapshot(agent.id).lastKnownStatus).toBe("interrupted");
  expect(f.repos.agents.get(agent.id)?.lastKnownStatus).toBe("interrupted");
  // Regression: an interrupted agent's diagnostic placeholder must never
  // surface as `generation: 0` -- the public AgentSummary schema requires
  // `generation` to be a positive integer when present, so it must be
  // omitted entirely here, not defaulted to 0.
  expect(f.service.snapshot(agent.id).generation).toBeUndefined();
  // A stale `running` with no live process must not force the client onto
  // `steer` (a silent no-op when idle); `prompt` starts a fresh run.
  f.repos.agents.updateStatus(agent.id, "running");
  await f.service.prompt(agent.id, "hello after restart");
  await pollExpect(() => expect(f.service.snapshot(agent.id).lastKnownStatus).toBe("idle"));
  await f.service.shutdown();
  f.store.close();
});

test("normalizes every stale-active status left behind by a daemon restart, not just running", async () => {
  const f = await make();
  const agent = await f.service.create("w");
  await f.service.capabilities(agent.id);
  await f.service.stop(agent.id);
  for (const status of ["initializing", "stopping", "needs-attention"] as const) {
    f.repos.agents.updateStatus(agent.id, status);
    expect(f.service.snapshot(agent.id).lastKnownStatus).toBe("interrupted");
    expect(f.repos.agents.get(agent.id)?.lastKnownStatus).toBe("interrupted");
  }
  // list() applies the same correction as snapshot().
  f.repos.agents.updateStatus(agent.id, "running");
  expect(f.service.list("w").find((row) => row.id === agent.id)?.lastKnownStatus).toBe("interrupted");
  await f.service.shutdown();
  f.store.close();
});

test("reconcileAfterRestart normalizes stale-active agents on boot without touching idle/archived ones", async () => {
  const f = await make();
  const active = await f.service.create("w");
  const idle = await f.service.create("w");
  const archived = await f.service.create("w");
  // Spawning the mock-Pi child is an environmental resource: under parallel
  // load a spawn can transiently fail, so retry setup spawns but never the
  // assertions below (a persistent failure still fails the test).
  for (const id of [active.id, idle.id, archived.id]) {
    for (let attempt = 0; ; attempt++) {
      try {
        await f.service.capabilities(id);
        break;
      } catch (error) {
        if ((error as { code?: string })?.code !== "not-running" || attempt >= 2) throw error;
        await Bun.sleep(50);
      }
    }
  }
  await f.service.stop(active.id);
  await f.service.stop(idle.id);
  await f.service.archive(archived.id);
  f.repos.agents.updateStatus(active.id, "running");
  f.repos.agents.updateStatus(idle.id, "idle");
  // Fresh service instance: same DB, no in-memory runtime state -- this is
  // what a real daemon restart looks like.
  const restarted = new AgentService(f.repos, { sessionsRoot: join(f.root, "sessions"), manager: new PiRpcManager(4), pi: { executable: process.execPath, executableArgs: ["-e", script] } });
  const result = await restarted.reconcileAfterRestart();
  expect(result.interrupted).toEqual([active.id]);
  expect(f.repos.agents.get(active.id)?.lastKnownStatus).toBe("interrupted");
  expect(f.repos.agents.get(idle.id)?.lastKnownStatus).toBe("idle");
  expect(f.repos.agents.get(archived.id)?.lastKnownStatus).toBe("archived");
  await restarted.shutdown();
  await f.service.shutdown();
  f.store.close();
});

test("restart-interrupted agents flag the cause and roll up grey, not red", async () => {
  const f = await make();
  const agent = await f.service.create("w");
  await f.service.capabilities(agent.id);
  await f.service.stop(agent.id);
  f.repos.agents.updateStatus(agent.id, "running");
  // Fresh service instance: same DB, no in-memory runtime state -- this is
  // what a real daemon restart looks like.
  const restarted = new AgentService(f.repos, { sessionsRoot: join(f.root, "sessions"), manager: new PiRpcManager(4), pi: { executable: process.execPath, executableArgs: ["-e", script] } });
  const result = await restarted.reconcileAfterRestart();
  expect(result.interrupted).toEqual([agent.id]);
  expect(restarted.snapshot(agent.id).interruptedByRestart).toBe(true);
  expect(restarted.list("w").find((row) => row.id === agent.id)?.interruptedByRestart).toBe(true);
  expect(restarted.statusByWorkspace()["w"]).toBe("empty");
  await restarted.shutdown();
  await f.service.shutdown();
  f.store.close();
});

test("genuine mid-life interruptions keep the red attention rollup", async () => {
  const f = await make();
  const agent = await f.service.create("w");
  await f.service.capabilities(agent.id);
  await f.service.stop(agent.id);
  // `interrupted` persisted without any boot sweep (a process lost while
  // the daemon was up) carries no restart attribution.
  f.repos.agents.updateStatus(agent.id, "interrupted");
  expect(f.service.snapshot(agent.id).interruptedByRestart).toBeUndefined();
  expect(f.service.list("w").find((row) => row.id === agent.id)?.interruptedByRestart).toBeUndefined();
  expect(f.service.statusByWorkspace()["w"]).toBe("attention");
  await f.service.shutdown();
  f.store.close();
});

test("retrying a restart-interrupted agent clears the restart attribution", async () => {
  const f = await make();
  const agent = await f.service.create("w");
  await f.service.capabilities(agent.id);
  await f.service.stop(agent.id);
  f.repos.agents.updateStatus(agent.id, "running");
  const restarted = new AgentService(f.repos, { sessionsRoot: join(f.root, "sessions"), manager: new PiRpcManager(4), pi: { executable: process.execPath, executableArgs: ["-e", script] } });
  await restarted.reconcileAfterRestart();
  expect(restarted.snapshot(agent.id).interruptedByRestart).toBe(true);
  await restarted.prompt(agent.id, "hello again");
  await pollExpect(() => {
    expect(restarted.snapshot(agent.id).interruptedByRestart).toBeUndefined();
    expect(["running", "idle"]).toContain(restarted.snapshot(agent.id).lastKnownStatus);
  });
  await restarted.shutdown();
  await f.service.shutdown();
  f.store.close();
});

test("auto-continues a mid-run crash with a canned follow-up, once per intent", async () => {
  const f = await make();
  const agent = await f.service.create("w");
  await f.service.capabilities(agent.id);
  const cannedCount = async () => {
    const result = await f.service.history(agent.id);
    if ("unpersisted" in result) return 0;
    return result.history.timeline.filter((row) => row.kind === "user" && row.text === CONTINUATION_MESSAGE).length;
  };
  // Simulate a crash while a run is in flight: DB says running, process dies.
  f.repos.agents.updateStatus(agent.id, "running");
  f.manager.get(agent.id)?.child.kill();
  await pollExpect(async () => {
    expect(await cannedCount()).toBe(1);
    expect(f.service.snapshot(agent.id).lastKnownStatus).toBe("idle");
  });
  // A second crash with no user intent in between must not retry again --
  // but it records its reason, so the next boot resumes from the recorded
  // fact even though no live status implies work anymore.
  f.repos.agents.updateStatus(agent.id, "running");
  f.manager.get(agent.id)?.child.kill();
  await pollExpect(() => expect(f.service.snapshot(agent.id).lastKnownStatus).toBe("error"));
  await Bun.sleep(250);
  expect(await cannedCount()).toBe(1);
  expect(f.repos.agents.get(agent.id)?.stopReason).toBe("crash");
  const rebooted = new AgentService(f.repos, { sessionsRoot: join(f.root, "sessions"), manager: new PiRpcManager(4), pi: { executable: process.execPath, executableArgs: ["-e", script] } });
  expect((await rebooted.warmAfterRestart()).continued).toEqual([agent.id]);
  await pollExpect(async () => {
    const history = await rebooted.history(agent.id);
    expect("unpersisted" in history ? [] : history.history.timeline.filter((row) => row.kind === "user" && row.text === CONTINUATION_MESSAGE)).toHaveLength(1);
    expect(rebooted.snapshot(agent.id).lastKnownStatus).toBe("idle");
  });
  expect(f.repos.agents.get(agent.id)?.stopReason).toBeNull();
  await rebooted.shutdown();
  // Fresh user intent restores the budget: the next mid-run crash continues.
  await f.service.prompt(agent.id, "keep going");
  await waitForIdle(f.service, agent.id);
  f.repos.agents.updateStatus(agent.id, "running");
  f.manager.get(agent.id)?.child.kill();
  await pollExpect(async () => {
    expect(await cannedCount()).toBe(2);
    expect(f.service.snapshot(agent.id).lastKnownStatus).toBe("idle");
  });
  await f.service.shutdown();
  f.store.close();
});

test("leaves an idle crash as a plain error with no continuation", async () => {
  const f = await make();
  const agent = await f.service.create("w");
  await f.service.prompt(agent.id, "hello");
  await waitForIdle(f.service, agent.id);
  f.manager.get(agent.id)?.child.kill();
  await pollExpect(() => expect(f.service.snapshot(agent.id).lastKnownStatus).toBe("error"));
  // No respawn, no canned follow-up: manual retry owns the recovery.
  expect(f.manager.get(agent.id)).toBeUndefined();
  const result = await f.service.history(agent.id);
  expect("unpersisted" in result ? [] : result.history.timeline.filter((row) => row.kind === "user" && row.text === CONTINUATION_MESSAGE)).toHaveLength(0);
  await f.service.shutdown();
  f.store.close();
});

test("warmAfterRestart warms interrupted agents and continues mid-run ones", async () => {
  const f = await make();
  const active = await f.service.create("w");
  const idle = await f.service.create("w");
  const booting = await f.service.create("w");
  for (const id of [active.id, idle.id, booting.id]) {
    for (let attempt = 0; ; attempt++) {
      try {
        await f.service.capabilities(id);
        break;
      } catch (error) {
        if ((error as { code?: string })?.code !== "not-running" || attempt >= 2) throw error;
        await Bun.sleep(50);
      }
    }
  }
  await f.service.stop(active.id);
  await f.service.stop(idle.id);
  await f.service.stop(booting.id);
  f.repos.agents.updateStatus(active.id, "running");
  f.repos.agents.updateStatus(idle.id, "idle");
  f.repos.agents.updateStatus(booting.id, "initializing");
  // Fresh service instance: same DB, no in-memory runtime state -- this is
  // what a real daemon restart looks like.
  const restarted = new AgentService(f.repos, { sessionsRoot: join(f.root, "sessions"), manager: new PiRpcManager(4), pi: { executable: process.execPath, executableArgs: ["-e", script] } });
  const result = await restarted.warmAfterRestart();
  expect(result.warmed.sort()).toEqual([active.id, booting.id].sort());
  expect(result.continued).toEqual([active.id]);
  expect(result.failed).toEqual([]);
  // Mid-run agent settled back to idle with the canned resume in its transcript.
  await pollExpect(() => expect(restarted.snapshot(active.id).lastKnownStatus).toBe("idle"));
  const resumed = await restarted.history(active.id);
  expect("unpersisted" in resumed ? [] : resumed.history.timeline.filter((row) => row.kind === "user" && row.text === CONTINUATION_MESSAGE)).toHaveLength(1);
  // Initializing agent warmed to idle with no continuation message.
  await pollExpect(() => expect(restarted.snapshot(booting.id).lastKnownStatus).toBe("idle"));
  const warmedOnly = await restarted.history(booting.id);
  expect("unpersisted" in warmedOnly ? [] : warmedOnly.history.timeline.filter((row) => row.kind === "user" && row.text === CONTINUATION_MESSAGE)).toHaveLength(0);
  // Idle agent untouched: no process spawned for it.
  expect(f.repos.agents.get(idle.id)?.lastKnownStatus).toBe("idle");
  expect(restarted.snapshot(idle.id).lastKnownStatus).toBe("idle");
  await restarted.shutdown();
  await f.service.shutdown();
  f.store.close();
});

test("resolveAutoContinueWindowMs defaults to one hour with env override", () => {
  expect(DEFAULT_AUTO_CONTINUE_WINDOW_MS).toBe(60 * 60_000);
  expect(resolveAutoContinueWindowMs({})).toBe(60 * 60_000);
  expect(resolveAutoContinueWindowMs({ PASSAGE_AUTO_CONTINUE_WINDOW_MINUTES: "30" })).toBe(30 * 60_000);
  expect(resolveAutoContinueWindowMs({ PASSAGE_AUTO_CONTINUE_WINDOW_MINUTES: "" })).toBe(60 * 60_000);
  // Invalid values warn and fall back instead of disabling retries or
  // pinning them spent forever.
  expect(resolveAutoContinueWindowMs({ PASSAGE_AUTO_CONTINUE_WINDOW_MINUTES: "bogus" })).toBe(60 * 60_000);
  expect(resolveAutoContinueWindowMs({ PASSAGE_AUTO_CONTINUE_WINDOW_MINUTES: "-5" })).toBe(60 * 60_000);
  expect(resolveAutoContinueWindowMs({ PASSAGE_AUTO_CONTINUE_WINDOW_MINUTES: "0" })).toBe(60 * 60_000);
});

test("rejects a non-positive auto-continue window option", async () => {
  const f = await make();
  expect(() => new AgentService(f.repos, { sessionsRoot: join(f.root, "sessions"), autoContinueWindowMs: -1 })).toThrow("invalid auto-continue window");
  await f.service.shutdown();
  f.store.close();
});

test("auto-continue budget regenerates after the window", async () => {
  const f = await make(10, undefined, 50);
  const agent = await f.service.create("w");
  await f.service.capabilities(agent.id);
  const cannedCount = async () => {
    const result = await f.service.history(agent.id);
    if ("unpersisted" in result) return 0;
    return result.history.timeline.filter((row) => row.kind === "user" && row.text === CONTINUATION_MESSAGE).length;
  };
  const crashWhileRunning = () => {
    f.repos.agents.updateStatus(agent.id, "running");
    f.manager.get(agent.id)?.child.kill();
  };
  crashWhileRunning();
  await pollExpect(async () => {
    expect(await cannedCount()).toBe(1);
    expect(f.service.snapshot(agent.id).lastKnownStatus).toBe("idle");
  });
  // Inside the window a second crash stays a plain error.
  crashWhileRunning();
  await pollExpect(() => expect(f.service.snapshot(agent.id).lastKnownStatus).toBe("error"));
  await Bun.sleep(25);
  expect(await cannedCount()).toBe(1);
  // Past the window the budget regenerated: the next crash continues again.
  // (capabilities() respawns the dead process without touching the budget,
  // so there is something live to kill -- unlike prompt(), which would also
  // restore the budget manually and confound the assertion.)
  await Bun.sleep(100);
  await f.service.capabilities(agent.id);
  crashWhileRunning();
  await pollExpect(async () => {
    expect(await cannedCount()).toBe(2);
    expect(f.service.snapshot(agent.id).lastKnownStatus).toBe("idle");
  });
  await f.service.shutdown();
  f.store.close();
});

test("leaves a drain-killed run for boot recovery, surviving later reads", async () => {
  let admitted = true;
  const f = await make(10, undefined, undefined, () => admitted);
  const agent = await f.service.create("w");
  await f.service.capabilities(agent.id);
  const cannedCount = async () => {
    const result = await f.service.history(agent.id);
    if ("unpersisted" in result) return 0;
    return result.history.timeline.filter((row) => row.kind === "user" && row.text === CONTINUATION_MESSAGE).length;
  };
  // Deploy SIGTERMs the process group mid-drain: the exit lands with the
  // gate already closed, so no auto-continue is attempted and no `error`
  // is persisted -- but the shutdown stop reason is recorded.
  f.repos.agents.updateStatus(agent.id, "running");
  admitted = false;
  f.manager.get(agent.id)?.child.kill();
  await pollExpect(async () => {
    expect(f.manager.get(agent.id)).toBeUndefined();
    expect(f.repos.agents.get(agent.id)?.lastKnownStatus).toBe("running");
    expect(f.repos.agents.get(agent.id)?.stopReason).toBe("shutdown");
  });
  await Bun.sleep(100);
  // A polling client normalizes the preserved status (first to interrupted
  // via a status read, then to error via a history reconcile) -- the reason
  // survives both, so the next boot still resumes the run. (Each read below
  // performs the normalization it names; the canned-count read comes last
  // because history() itself reconciles.)
  expect(f.service.snapshot(agent.id).lastKnownStatus).toBe("interrupted");
  expect(f.repos.agents.get(agent.id)?.stopReason).toBe("shutdown");
  await f.service.history(agent.id);
  expect(f.repos.agents.get(agent.id)?.lastKnownStatus).toBe("error");
  expect(f.repos.agents.get(agent.id)?.stopReason).toBe("shutdown");
  expect(await cannedCount()).toBe(0);
  // Next boot (fresh runtime state, gate open) warms, continues, and
  // clears the reason -- a second boot finds nothing left to do.
  admitted = true;
  const restarted = new AgentService(f.repos, { sessionsRoot: join(f.root, "sessions"), manager: new PiRpcManager(4), pi: { executable: process.execPath, executableArgs: ["-e", script] } });
  const recovery = await restarted.warmAfterRestart();
  expect(recovery.continued).toEqual([agent.id]);
  await pollExpect(async () => {
    // The continuation row lives in the rebooted daemon's transcript state
    // (user rows are in-memory projections, not pi session-file entries),
    // so it is read back through the restarted service.
    const resumed = await restarted.history(agent.id);
    expect("unpersisted" in resumed ? [] : resumed.history.timeline.filter((row) => row.kind === "user" && row.text === CONTINUATION_MESSAGE)).toHaveLength(1);
    expect(restarted.snapshot(agent.id).lastKnownStatus).toBe("idle");
  });
  expect(f.repos.agents.get(agent.id)?.stopReason).toBeNull();
  const again = await restarted.warmAfterRestart();
  expect(again).toEqual({ warmed: [], continued: [], failed: [] });
  await restarted.shutdown();
  await f.service.shutdown();
  f.store.close();
});

test("anchors an active run to one stable start timestamp and clears it on settlement", async () => {
  const f = await make();
  const runSpanScript = `let streaming=false;process.stdin.on('data',d=>{for(const l of d.toString().split('\\n')){if(!l)continue;const r=JSON.parse(l);if(r.type==='prompt'){streaming=true;process.stdout.write(JSON.stringify({type:'agent_start'})+'\\n');setTimeout(()=>{streaming=false;process.stdout.write(JSON.stringify({type:'agent_settled'})+'\\n')},40)}const data=r.type==='get_state'?{isStreaming:streaming,sessionFile:null}:r.type==='get_entries'?{leafId:null}:{};process.stdout.write(JSON.stringify({type:'response',id:r.id,success:true,data})+'\\n')}})`;
  const service = new AgentService(f.repos, {
    sessionsRoot: join(f.root, "run-span-sessions"),
    manager: new PiRpcManager(1),
    pi: { executable: process.execPath, executableArgs: ["-e", runSpanScript] },
  });
  const agent = await service.create("w");
  const events: Array<{ type: string; runStartedAt?: number }> = [];
  service.subscribe((event) => events.push({ type: event.type, runStartedAt: event.payload?.runStartedAt as number | undefined }));

  await service.prompt(agent.id, "long run");
  const started = service.snapshot(agent.id).runStartedAt;
  expect(typeof started).toBe("number");
  expect(service.list("w")[0]?.runStartedAt).toBe(started);

  await pollExpect(() => {
    // Client reloads and re-anchors from the same authoritative run start.
    expect(service.snapshot(agent.id).runStartedAt).toBe(started);
    expect(events.some((event) => event.type === "status" && event.runStartedAt === started)).toBe(true);
  });

  await pollExpect(() => {
    expect(service.snapshot(agent.id).lastKnownStatus).toBe("idle");
    expect(service.snapshot(agent.id).runStartedAt).toBeUndefined();
  });
  await service.shutdown();
  f.store.close();
});

test("keeps an agent stopping until Pi confirms cancellation", async () => {
  const f = await make();
  const abortScript = `let streaming=false;process.stdin.on('data',d=>{for(const l of d.toString().split('\\n')){if(!l)continue;const r=JSON.parse(l);if(r.type==='prompt'){streaming=true;process.stdout.write(JSON.stringify({type:'agent_start'})+'\\n')}const data=r.type==='get_state'?{isStreaming:streaming,sessionFile:null}:r.type==='get_entries'?{leafId:null}:{};if(r.type==='abort')setTimeout(()=>{streaming=false;process.stdout.write(JSON.stringify({type:'agent_settled'})+'\\n');process.stdout.write(JSON.stringify({type:'response',id:r.id,success:true,data:{}})+'\\n')},20);else process.stdout.write(JSON.stringify({type:'response',id:r.id,success:true,data})+'\\n')}})`;
  const service = new AgentService(f.repos, {
    sessionsRoot: join(f.root, "abort-sessions"),
    manager: new PiRpcManager(1),
    abortTimeoutMs: 100,
    pi: { executable: process.execPath, executableArgs: ["-e", abortScript] },
  });
  const agent = await service.create("w");
  await service.prompt(agent.id, "keep running");
  await pollExpect(() => expect(service.snapshot(agent.id).lastKnownStatus).toBe("running"));

  await service.abort(agent.id);
  expect(service.snapshot(agent.id).lastKnownStatus).toBe("stopping");
  await expect(service.prompt(agent.id, "racing prompt")).rejects.toMatchObject({ code: "invalid-input" });

  await pollExpect(() => expect(service.snapshot(agent.id).lastKnownStatus).toBe("idle"));
  await service.shutdown();
  f.store.close();
});

test("aborted runs still invalidate workspace Git views", async () => {
  const f = await make();
  // No `agent_settled` is emitted here at all: the abort handshake alone
  // settles the run, so without an explicit invalidation the Git views
  // would keep rendering their stale clean snapshot (hiding the commit
  // affordance) even though the interrupted run may have left a dirty tree.
  const abortOnlyScript = `let streaming=true;process.stdin.on('data',d=>{for(const l of d.toString().split('\\n')){if(!l)continue;const r=JSON.parse(l);if(r.type==='prompt'){streaming=true;process.stdout.write(JSON.stringify({type:'agent_start'})+'\\n')}const data=r.type==='get_state'?{isStreaming:streaming,sessionFile:null}:r.type==='get_entries'?{leafId:null}:{};if(r.type==='abort'){streaming=false;process.stdout.write(JSON.stringify({type:'response',id:r.id,success:true,data:{}})+'\\n');continue}process.stdout.write(JSON.stringify({type:'response',id:r.id,success:true,data})+'\\n')}})`;
  const invalidated: string[] = [];
  const service = new AgentService(f.repos, {
    sessionsRoot: join(f.root, "abort-git-sessions"),
    manager: new PiRpcManager(1),
    abortTimeoutMs: 100,
    pi: { executable: process.execPath, executableArgs: ["-e", abortOnlyScript] },
    onWorkspaceGitChanged: (workspaceId) => invalidated.push(workspaceId),
  });
  const agent = await service.create("w");
  await service.prompt(agent.id, "keep running");
  await pollExpect(() => {
    expect(service.snapshot(agent.id).lastKnownStatus).toBe("running");
    expect(invalidated).toEqual([]);
  });

  await service.abort(agent.id);
  await pollExpect(() => {
    expect(service.snapshot(agent.id).lastKnownStatus).toBe("idle");
    expect(invalidated).toEqual(["w"]);
  });
  await service.shutdown();
  f.store.close();
});

test("tolerates abort_bash rejection when no bash command is running", async () => {
  const f = await make();
  const abortScript = `let streaming=false;process.stdin.on('data',d=>{for(const l of d.toString().split('\\n')){if(!l)continue;const r=JSON.parse(l);if(r.type==='prompt'){streaming=true;process.stdout.write(JSON.stringify({type:'agent_start'})+'\\n')}const data=r.type==='get_state'?{isStreaming:streaming,sessionFile:null}:r.type==='get_entries'?{leafId:null}:{};if(r.type==='abort')setTimeout(()=>{streaming=false;process.stdout.write(JSON.stringify({type:'agent_settled'})+'\\n');process.stdout.write(JSON.stringify({type:'response',id:r.id,success:true,data:{}})+'\\n')},20);else if(r.type==='abort_bash')process.stdout.write(JSON.stringify({type:'response',id:r.id,success:false,error:'No bash command is running'})+'\\n');else process.stdout.write(JSON.stringify({type:'response',id:r.id,success:true,data})+'\\n')}})`;
  const service = new AgentService(f.repos, {
    sessionsRoot: join(f.root, "abort-bash-rejected-sessions"),
    manager: new PiRpcManager(1),
    abortTimeoutMs: 100,
    pi: { executable: process.execPath, executableArgs: ["-e", abortScript] },
  });
  const agent = await service.create("w");
  await service.prompt(agent.id, "keep running");
  await pollExpect(() => expect(service.snapshot(agent.id).lastKnownStatus).toBe("running"));

  await service.abort(agent.id);
  expect(service.snapshot(agent.id).lastKnownStatus).toBe("stopping");

  await pollExpect(() => expect(service.snapshot(agent.id).lastKnownStatus).toBe("idle"));
  await service.shutdown();
  f.store.close();
});

test("frees a run stuck in a bash tool call via abort_bash", async () => {
  const f = await make();
  // `abort` acknowledges but never settles the turn (the foreground bash
  // child holds it); only `abort_bash` frees it. Without that request this
  // would escalate to a process kill and land on error, as in the
  // hanging-abort test below.
  const stuckBashScript = `let streaming=false;process.stdin.on('data',d=>{for(const l of d.toString().split('\\n')){if(!l)continue;const r=JSON.parse(l);if(r.type==='prompt'){streaming=true;process.stdout.write(JSON.stringify({type:'agent_start'})+'\\n')}const data=r.type==='get_state'?{isStreaming:streaming,sessionFile:null}:r.type==='get_entries'?{leafId:null}:{};if(r.type==='abort'){process.stdout.write(JSON.stringify({type:'response',id:r.id,success:true,data:{}})+'\\n');continue}if(r.type==='abort_bash'){streaming=false;process.stdout.write(JSON.stringify({type:'agent_settled'})+'\\n');process.stdout.write(JSON.stringify({type:'response',id:r.id,success:true,data:{}})+'\\n');continue}process.stdout.write(JSON.stringify({type:'response',id:r.id,success:true,data})+'\\n')}})`;
  const service = new AgentService(f.repos, {
    sessionsRoot: join(f.root, "stuck-bash-sessions"),
    manager: new PiRpcManager(1),
    abortTimeoutMs: 100,
    pi: { executable: process.execPath, executableArgs: ["-e", stuckBashScript] },
  });
  const agent = await service.create("w");
  await service.prompt(agent.id, "run a foreground daemon");
  await pollExpect(() => expect(service.snapshot(agent.id).lastKnownStatus).toBe("running"));

  await service.abort(agent.id);
  expect(service.snapshot(agent.id).lastKnownStatus).toBe("stopping");

  await pollExpect(() => expect(service.snapshot(agent.id).lastKnownStatus).toBe("idle"));
  await service.shutdown();
  f.store.close();
});

test("treats Pi's already-streaming prompt rejection as a recoverable conflict, not a crash", async () => {
  const f = await make();
  const alreadyStreamingScript = `process.stdin.on('data',d=>{for(const l of d.toString().split('\\n')){if(!l)continue;const r=JSON.parse(l);if(r.type==='prompt'){process.stdout.write(JSON.stringify({type:'response',id:r.id,success:false,error:"Agent is already processing. Specify streamingBehavior ('steer' or 'followUp') to queue the message."})+'\\n');continue}const data=r.type==='get_state'?{isStreaming:true,sessionFile:null}:r.type==='get_entries'?{leafId:null}:{};process.stdout.write(JSON.stringify({type:'response',id:r.id,success:true,data})+'\\n')}})`;
  const service = new AgentService(f.repos, {
    sessionsRoot: join(f.root, "already-streaming-sessions"),
    manager: new PiRpcManager(1),
    pi: { executable: process.execPath, executableArgs: ["-e", alreadyStreamingScript] },
  });
  const agent = await service.create("w");
  await expect(service.prompt(agent.id, "stale-client race")).rejects.toMatchObject({ code: "invalid-input" });
  // Not a fatal crash: status stays running (matches the synchronous
  // busy-guard rejection), and the agent keeps working -- it needs no
  // "hit an error and stopped responding" banner or manual retry.
  expect(service.snapshot(agent.id).lastKnownStatus).toBe("running");
  await service.shutdown();
  f.store.close();
});

test("reports cancellation failure without claiming an agent is idle", async () => {
  const f = await make();
  const hangingAbortScript = `let streaming=false;process.stdin.on('data',d=>{for(const l of d.toString().split('\\n')){if(!l)continue;const r=JSON.parse(l);if(r.type==='prompt'){streaming=true;process.stdout.write(JSON.stringify({type:'agent_start'})+'\\n')}if(r.type==='abort')continue;const data=r.type==='get_state'?{isStreaming:streaming,sessionFile:null}:r.type==='get_entries'?{leafId:null}:{};process.stdout.write(JSON.stringify({type:'response',id:r.id,success:true,data})+'\\n')}})`;
  const service = new AgentService(f.repos, {
    sessionsRoot: join(f.root, "hanging-abort-sessions"),
    manager: new PiRpcManager(1),
    abortTimeoutMs: 20,
    pi: { executable: process.execPath, executableArgs: ["-e", hangingAbortScript] },
  });
  const agent = await service.create("w");
  await service.prompt(agent.id, "keep running");
  await service.abort(agent.id);
  expect(service.snapshot(agent.id).lastKnownStatus).toBe("stopping");

  await pollExpect(() => expect(service.snapshot(agent.id)).toMatchObject({ lastKnownStatus: "error", live: false }));
  await service.shutdown();
  f.store.close();
});

test("retains bounded diagnostics after an unexpected process exit", async () => {
  const f = await make();
  const crashingScript = `process.stdin.on('data',d=>{for(const l of d.toString().split('\\n')){if(!l)continue;const r=JSON.parse(l);process.stdout.write(JSON.stringify({type:'response',id:r.id,success:true,data:{}})+'\\n');if(r.type==='get_entries')setTimeout(()=>{console.error('crash-marker');process.exit(7)},5)}})`;
  const service = new AgentService(f.repos, {
    sessionsRoot: join(f.root, "crash-sessions"),
    manager: new PiRpcManager(1),
    pi: { executable: process.execPath, executableArgs: ["-e", crashingScript] },
  });
  const agent = await service.create("w");
  const snapshot = await pollExpect(() => {
    const snap = service.snapshot(agent.id);
    expect(snap).toMatchObject({
      live: false,
      lastKnownStatus: "error",
      exitStatus: "crashed (7)",
    });
    expect(snap.stderr?.join("")).toContain("crash-marker");
    return snap;
  });
  await service.shutdown();
  f.store.close();
});

test("projects Pi's native dialog request to attention state and responds", async () => {
  const f = await make();
  const attentionScript = `process.stdin.on('data',d=>{for(const l of d.toString().split('\\n')){if(!l)continue;const r=JSON.parse(l);process.stdout.write(JSON.stringify({type:'response',id:r.id,success:true,data:{}})+'\\n');if(r.type==='get_entries')setTimeout(()=>process.stdout.write(JSON.stringify({type:'extension_ui_request',id:'prompt-1',method:'select',title:'Pick',options:['One','Two']})+'\\n'),5)}})`;
  const service = new AgentService(f.repos, {
    sessionsRoot: join(f.root, "attention-sessions"),
    manager: new PiRpcManager(1),
    pi: { executable: process.execPath, executableArgs: ["-e", attentionScript] },
  });
  const agent = await service.create("w");
  const snap = await pollExpect(() => {
    const s = service.snapshot(agent.id);
    expect(s.lastKnownStatus).toBe("needs-attention");
    expect(s.pendingUiRequest?.id).toBe("prompt-1");
    expect(s.pendingUiRequest?.title).toBe("Pick");
    expect(s.pendingUiRequest?.options).toEqual(["One", "Two"]);
    return s;
  });

  await service.respondExtensionUi(agent.id, { id: "prompt-1", value: "Option 1" });
  expect(service.snapshot(agent.id).lastKnownStatus).toBe("running");
  expect(service.snapshot(agent.id).pendingUiRequest).toBeUndefined();

  await service.shutdown();
  f.store.close();
});

// Mirrors ask_user_question's RPC fallback: the select rows carry a "Type
// something." escape, and picking it re-prompts with `input`. Any other value
// parses as "nothing selected" there and declines the whole questionnaire, so
// the daemon has to answer with the row and pass the text to the follow-up.
const DIALOG_ROWS = ["1. Pepperoni \u2014 classic", "2. Pineapple \u2014 sweet", "3. Type something."];
const dialogScript = (logPath: string, followUp: boolean) => [
  `const fs=require('fs'),rows=${JSON.stringify(DIALOG_ROWS)};let asked=false;`,
  `process.stdin.on('data',d=>{for(const l of d.toString().split('\\n')){if(!l)continue;const r=JSON.parse(l);`,
  `if(r.type==='extension_ui_response'){fs.appendFileSync(${JSON.stringify(logPath)},JSON.stringify({id:r.id,value:r.value})+'\\n');`,
  followUp
    ? `if(r.value===rows[2])process.stdout.write(JSON.stringify({type:'extension_ui_request',id:'prompt-2',method:'input',title:'Type your answer:'})+'\\n');`
    : "",
  `continue}process.stdout.write(JSON.stringify({type:'response',id:r.id,success:true,data:{}})+'\\n');`,
  `if(r.type==='get_entries'&&!asked){asked=true;setTimeout(()=>process.stdout.write(JSON.stringify({type:'extension_ui_request',id:'prompt-1',method:'select',title:'[Pizza] Favorite topping?',options:rows})+'\\n'),5)}}})`,
].join("");
const readUiResponses = async (logPath: string) =>
  (await Bun.file(logPath).text()).split("\n").flatMap((line) => (line ? [JSON.parse(line)] : []));

test("a typed answer takes the select dialog's free-text row and auto-answers the follow-up prompt", async () => {
  const f = await make();
  const log = join(f.root, "ui-responses.jsonl");
  const service = new AgentService(f.repos, {
    sessionsRoot: join(f.root, "question-sessions"),
    manager: new PiRpcManager(1),
    pi: { executable: process.execPath, executableArgs: ["-e", dialogScript(log, true)] },
  });
  const agent = await service.create("w");
  await pollExpect(() => expect(service.snapshot(agent.id).pendingUiRequest?.id).toBe("prompt-1"));

  await service.respondExtensionUi(agent.id, { id: "prompt-1", value: "anchovies and honey", custom: true });

  // Contract: the select was answered with the escape row and the typed text
  // reached the input follow-up Pi opened for it, with no second card.
  // (Agent status here is mock-deep -- no run ever starts -- so it is
  // deliberately not asserted.)
  await pollExpect(async () => {
    expect(await readUiResponses(log)).toEqual([
      { id: "prompt-1", value: DIALOG_ROWS[2] },
      { id: "prompt-2", value: "anchovies and honey" },
    ]);
    expect(service.snapshot(agent.id).pendingUiRequest).toBeUndefined();
  });

  await service.shutdown();
  f.store.close();
});

test("a picked option still resolves to the row Pi offered", async () => {
  const f = await make();
  const log = join(f.root, "ui-responses.jsonl");
  const service = new AgentService(f.repos, {
    sessionsRoot: join(f.root, "pick-sessions"),
    manager: new PiRpcManager(1),
    pi: { executable: process.execPath, executableArgs: ["-e", dialogScript(log, false)] },
  });
  const agent = await service.create("w");
  await pollExpect(() => expect(service.snapshot(agent.id).pendingUiRequest?.id).toBe("prompt-1"));
  // The card shows bare labels; Pi needs the numbered row back.
  await service.respondExtensionUi(agent.id, { id: "prompt-1", value: "Pineapple" });
  await pollExpect(async () => expect(await readUiResponses(log)).toEqual([{ id: "prompt-1", value: DIALOG_ROWS[1] }]));
  await service.shutdown();
  f.store.close();
});

test("a late dialog event for an already-answered card does not re-animate it", async () => {
  const f = await make();
  const log = join(f.root, "ui-responses.jsonl");
  const manager = new PiRpcManager(1);
  const service = new AgentService(f.repos, {
    sessionsRoot: join(f.root, "stale-card-sessions"),
    manager,
    pi: { executable: process.execPath, executableArgs: ["-e", dialogScript(log, true)] },
  });
  const agent = await service.create("w");
  await pollExpect(() => expect(service.snapshot(agent.id).pendingUiRequest?.id).toBe("prompt-1"));
  await service.respondExtensionUi(agent.id, { id: "prompt-1", value: "anchovies and honey", custom: true });
  // Both hops answered (select escape row + auto-answered input follow-up).
  await pollExpect(async () => {
    expect(await readUiResponses(log)).toEqual([
      { id: "prompt-1", value: DIALOG_ROWS[2] },
      { id: "prompt-2", value: "anchovies and honey" },
    ]);
    expect(service.snapshot(agent.id).pendingUiRequest).toBeUndefined();
  });
  // Replaying the original prompt-1 request -- as a queue-delayed event
  // arriving after the answer -- must not resurrect the card or flip the
  // agent back to needs-attention.
  const generation = manager.get(agent.id)?.generation;
  expect(generation).toBeDefined();
  await (service as unknown as { onEvent(agentId: string, event: Record<string, unknown>): Promise<void> }).onEvent(agent.id, {
    type: "extension_ui_request",
    id: "prompt-1",
    method: "select",
    title: "[Pizza] Favorite topping?",
    options: DIALOG_ROWS,
    generation,
  });
  expect(service.snapshot(agent.id).pendingUiRequest).toBeUndefined();
  // The replayed event runs the full onEvent path (including reconcile,
  // which settles the never-prompted agent to idle); what must not happen
  // is the answered card coming back or status flipping to needs-attention.
  expect(service.snapshot(agent.id).lastKnownStatus).not.toBe("needs-attention");
  await service.shutdown();
  f.store.close();
});

describe("transcript row ordering (regression: reorder/duplicate chat rows)", () => {
  test("concurrent tool calls stay in start order with no duplication, and the user row lands before them", async () => {
    const f = await make();
    // Two tools start back-to-back, then finish in the OPPOSITE order --
    // the scenario that used to hijack rows via the "last running tool"
    // fallback and made the transcript re-sort/duplicate mid-stream.
    const concurrentScript = `process.stdin.on('data',d=>{for(const l of d.toString().split('\\n')){if(!l)continue;const r=JSON.parse(l);process.stdout.write(JSON.stringify({type:'response',id:r.id,success:true,data:{}})+'\\n');if(r.type==='prompt'){process.stdout.write(JSON.stringify({type:'tool_call',toolCallId:'a',toolName:'bash',args:{command:'one'}})+'\\n');process.stdout.write(JSON.stringify({type:'tool_call',toolCallId:'b',toolName:'bash',args:{command:'two'}})+'\\n');process.stdout.write(JSON.stringify({type:'tool_execution_end',toolCallId:'b',result:'b-done',isError:false})+'\\n');process.stdout.write(JSON.stringify({type:'tool_execution_end',toolCallId:'a',result:'a-done',isError:false})+'\\n');process.stdout.write(JSON.stringify({type:'agent_settled'})+'\\n')}}})`;
    const service = new AgentService(f.repos, {
      sessionsRoot: join(f.root, "order-sessions"),
      manager: new PiRpcManager(1),
      pi: { executable: process.execPath, executableArgs: ["-e", concurrentScript] },
    });
    const rowEvents: Array<{ id: string; kind: string }> = [];
    service.subscribe((event) => {
      if (event.type !== "row_upsert") return;
      const row = (event.payload as { row?: { id: string; kind: string } } | undefined)?.row;
      if (row) rowEvents.push({ id: row.id, kind: row.kind });
    });
    const agent = await service.create("w");
    await service.prompt(agent.id, "run two commands");

    const result = await pollExpect(async () => {
      const probe = await service.history(agent.id);
      if ("unpersisted" in probe) throw new Error("expected a persisted transcript");
      expect(probe.history.timeline.map((item) => item.kind)).toEqual(["user", "tool", "tool"]);
      return probe.history;
    });
    const [, toolA, toolB] = result.timeline as Array<{ id: string; result?: string; status: string }>;
    expect(toolA).toMatchObject({ id: "a", result: "a-done", status: "complete" });
    expect(toolB).toMatchObject({ id: "b", result: "b-done", status: "complete" });

    // The user row was pushed (and its row_upsert emitted) before either tool
    // call landed -- ordering by first-sighted time, not by settle order.
    const firstUserIndex = rowEvents.findIndex((e) => e.kind === "user");
    const firstToolIndex = rowEvents.findIndex((e) => e.kind === "tool");
    expect(firstUserIndex).toBeGreaterThanOrEqual(0);
    expect(firstUserIndex).toBeLessThan(firstToolIndex);

    // No row was ever emitted under the wrong id (no hijacking): every "a"
    // upsert stayed an "a", every "b" upsert stayed a "b".
    const idsSeen = new Set(rowEvents.filter((e) => e.kind === "tool").map((e) => e.id));
    expect(idsSeen).toEqual(new Set(["a", "b"]));

    // Fetching history again returns the identical epoch and an unchanged
    // timeline shape -- a reload never re-sorts or duplicates rows.
    const again = await service.history(agent.id);
    if ("unpersisted" in again) throw new Error("expected a persisted transcript");
    expect(again.history.transcriptEpoch).toBe(result.transcriptEpoch);
    expect(again.history.timeline.map((item) => item.kind)).toEqual(["user", "tool", "tool"]);

    await service.shutdown();
    f.store.close();
  });

  test("an unexpected process exit appends a chronological error row instead of only flipping status", async () => {
    const f = await make();
    const crashingScript = `process.stdin.on('data',d=>{for(const l of d.toString().split('\\n')){if(!l)continue;const r=JSON.parse(l);process.stdout.write(JSON.stringify({type:'response',id:r.id,success:true,data:{}})+'\\n');if(r.type==='get_entries')setTimeout(()=>process.exit(7),5)}})`;
    const service = new AgentService(f.repos, {
      sessionsRoot: join(f.root, "crash-row-sessions"),
      manager: new PiRpcManager(1),
      pi: { executable: process.execPath, executableArgs: ["-e", crashingScript] },
    });
    const agent = await service.create("w");

    const errorText = await pollExpect(async () => {
      const probe = await service.history(agent.id);
      if ("unpersisted" in probe) throw new Error("expected a persisted transcript");
      const errorRow = probe.history.timeline.find((item) => item.kind === "error");
      expect(errorRow).toBeTruthy();
      return (errorRow as { text: string }).text;
    });
    expect(errorText).toContain("Pi process exited (7)");

    await service.shutdown();
    f.store.close();
  });
});

describe("agent-side git invalidations (merge button freshness)", () => {
  test("isGitCommitToolEvent matches completed commits only", () => {
    const commit = { toolCallId: "t", toolName: "bash", args: { command: "git commit -m test" } };
    expect(isGitCommitToolEvent("tool_execution_end", { ...commit, isError: false })).toBe(true);
    expect(isGitCommitToolEvent("tool_execution_end", { toolCallId: "t", result: "  [main abc123] commit via script\n 1 file changed" })).toBe(false);
    expect(isGitCommitToolEvent("tool_execution_end", { toolCallId: "t", args: { command: "git -C /repo commit -m test" }, isError: false })).toBe(true);
    expect(isGitCommitToolEvent("tool_execution_end", { toolCallId: "t", args: { command: "cd /repo && git commit -m test" }, isError: false })).toBe(true);
    // Not a completion: the commit has not happened yet at call time.
    expect(isGitCommitToolEvent("tool_call", { ...commit })).toBe(false);
    expect(isGitCommitToolEvent("tool_execution_start", { ...commit })).toBe(false);
    // Failed calls mutated nothing.
    expect(isGitCommitToolEvent("tool_execution_end", { ...commit, isError: true })).toBe(false);
    // Unrelated commands stay silent.
    expect(isGitCommitToolEvent("tool_execution_end", { toolCallId: "t", args: { command: "git status" }, isError: false })).toBe(false);
    expect(isGitCommitToolEvent("tool_execution_end", { toolCallId: "t", args: { command: "ls -la" }, isError: false })).toBe(false);
    expect(isGitCommitToolEvent("tool_execution_end", { toolCallId: "t", isError: false })).toBe(false);
  });

  test("a completed agent-side git commit invalidates mid-run, before settlement", async () => {
    const f = await make();
    // Emits a git-commit tool completion but never settles: proves the
    // invalidation comes from commit detection, not the settle backstop.
    const commitScript = `let streaming=true;process.stdin.on('data',d=>{for(const l of d.toString().split('\\n')){if(!l)continue;const r=JSON.parse(l);if(r.type==='prompt'){process.stdout.write(JSON.stringify({type:'agent_start'})+'\\n');process.stdout.write(JSON.stringify({type:'tool_execution_end',toolCallId:'t1',toolName:'bash',args:{command:'git commit -m test'},isError:false})+'\\n')}const data=r.type==='get_state'?{isStreaming:streaming,sessionFile:null}:r.type==='get_entries'?{leafId:null}:{};process.stdout.write(JSON.stringify({type:'response',id:r.id,success:true,data})+'\\n')}})`;
    const invalidated: string[] = [];
    const service = new AgentService(f.repos, {
      sessionsRoot: join(f.root, "git-commit-sessions"),
      manager: new PiRpcManager(1),
      pi: { executable: process.execPath, executableArgs: ["-e", commitScript] },
      onWorkspaceGitChanged: (workspaceId) => invalidated.push(workspaceId),
    });
    const agent = await service.create("w");
    await service.prompt(agent.id, "commit the work");
    await pollExpect(() => {
      expect(service.snapshot(agent.id).lastKnownStatus).toBe("running");
      expect(invalidated).toEqual(["w"]);
    });
    await service.shutdown();
    f.store.close();
  });

  test("non-git tool output stays silent mid-run; settlement still invalidates", async () => {
    const f = await make();
    const settleScript = `let streaming=false;process.stdin.on('data',d=>{for(const l of d.toString().split('\\n')){if(!l)continue;const r=JSON.parse(l);if(r.type==='prompt'){streaming=true;process.stdout.write(JSON.stringify({type:'agent_start'})+'\\n');process.stdout.write(JSON.stringify({type:'tool_execution_end',toolCallId:'t1',toolName:'bash',args:{command:'ls -la'},result:'total 0',isError:false})+'\\n')}if(r.type==='steer'){streaming=false;process.stdout.write(JSON.stringify({type:'agent_settled'})+'\\n')}const data=r.type==='get_state'?{isStreaming:streaming,sessionFile:null}:r.type==='get_entries'?{leafId:null}:{};process.stdout.write(JSON.stringify({type:'response',id:r.id,success:true,data})+'\\n')}})`;
    const invalidated: string[] = [];
    const service = new AgentService(f.repos, {
      sessionsRoot: join(f.root, "git-settle-sessions"),
      manager: new PiRpcManager(1),
      pi: { executable: process.execPath, executableArgs: ["-e", settleScript] },
      onWorkspaceGitChanged: (workspaceId) => invalidated.push(workspaceId),
    });
    const agent = await service.create("w");
    await service.prompt(agent.id, "list files");
    await pollExpect(() => {
      expect(service.snapshot(agent.id).lastKnownStatus).toBe("running");
      expect(invalidated).toEqual([]);
    });
    await service.steer(agent.id, "wrap up");
    await pollExpect(() => {
      expect(service.snapshot(agent.id).lastKnownStatus).toBe("idle");
      expect(invalidated).toEqual(["w"]);
    });
    await service.shutdown();
    f.store.close();
  });

  test("a throwing git listener never breaks the agent event chain", async () => {
    const f = await make();
    const events: string[] = [];
    const service = new AgentService(f.repos, {
      sessionsRoot: join(f.root, "git-throw-sessions"),
      manager: new PiRpcManager(1),
      pi: { executable: process.execPath, executableArgs: ["-e", "process.stdin.on('data',d=>{for(const l of d.toString().split('\\n')){if(!l)continue;const r=JSON.parse(l);if(r.type==='prompt'){process.stdout.write(JSON.stringify({type:'agent_start'})+'\\n');process.stdout.write(JSON.stringify({type:'tool_execution_end',toolCallId:'t1',args:{command:'git commit -m x'},isError:false})+'\\n');process.stdout.write(JSON.stringify({type:'agent_settled'})+'\\n')}const data=r.type==='get_state'?{isStreaming:false,sessionFile:null}:r.type==='get_entries'?{leafId:null}:{};process.stdout.write(JSON.stringify({type:'response',id:r.id,success:true,data})+'\\n')}})"] },
      onWorkspaceGitChanged: () => { throw new Error("listener boom"); },
    });
    service.subscribe((event) => events.push(event.type));
    const agent = await service.create("w");
    await service.prompt(agent.id, "commit");
    await pollExpect(() => {
      expect(events).toContain("settled");
      expect(service.snapshot(agent.id).lastKnownStatus).toBe("idle");
    });
    await service.shutdown();
    f.store.close();
  });

  test("compact reports token counts from the Pi response", async () => {
    const compactScript = `process.stdin.on('data',d=>{for(const l of d.toString().split('\\n')){if(!l)continue;const r=JSON.parse(l);const data=r.type==='compact'?{summary:'S',firstKeptEntryId:'k',tokensBefore:115972,estimatedTokensAfter:19181}:{};process.stdout.write(JSON.stringify({type:'response',id:r.id,command:r.type,success:true,data})+'\\n')}})`;
    const f = await make(10, ["-e", compactScript]);
    const agent = await f.service.create("w");
    await expect(f.service.compact(agent.id)).resolves.toEqual({ compacted: true, tokensBefore: 115972 });
    await f.service.shutdown();
    f.store.close();
  });

  test("compact maps benign Pi refusals to reasons instead of throwing", async () => {
    const refusalScript = (message: string) => ["-e", `process.stdin.on('data',d=>{for(const l of d.toString().split('\\n')){if(!l)continue;const r=JSON.parse(l);if(r.type==='compact'){process.stdout.write(JSON.stringify({type:'response',id:r.id,command:r.type,success:false,error:${JSON.stringify(message)}})+'\\n')}else{process.stdout.write(JSON.stringify({type:'response',id:r.id,command:r.type,success:true,data:{}})+'\\n')}}})`];
    const short = await make(10, refusalScript("Nothing to compact (session too small)"));
    const shortAgent = await short.service.create("w");
    await expect(short.service.compact(shortAgent.id)).resolves.toEqual({ compacted: false, reason: "session-too-short" });
    await short.service.shutdown();
    short.store.close();
    const done = await make(10, refusalScript("Already compacted"));
    const doneAgent = await done.service.create("w");
    await expect(done.service.compact(doneAgent.id)).resolves.toEqual({ compacted: false, reason: "already-compacted" });
    await done.service.shutdown();
    done.store.close();
  });

  test("compact rethrows genuine Pi failures", async () => {
    const failingScript = ["-e", `process.stdin.on('data',d=>{for(const l of d.toString().split('\\n')){if(!l)continue;const r=JSON.parse(l);if(r.type==='compact'){process.stdout.write(JSON.stringify({type:'response',id:r.id,command:r.type,success:false,error:'Request aborted'})+'\\n')}else{process.stdout.write(JSON.stringify({type:'response',id:r.id,command:r.type,success:true,data:{}})+'\\n')}}})`];
    const f = await make(10, failingScript);
    const agent = await f.service.create("w");
    await expect(f.service.compact(agent.id)).rejects.toThrow("Request aborted");
    await f.service.shutdown();
    f.store.close();
  });
});

describe("admission gate", () => {
  test("closing admission refuses new agent work but keeps abort, question answers, and resource-close working", async () => {
    const root = await mkdtemp(join("/tmp", "passage-agent-"));
    roots.push(root);
    const store = new MetadataStore(":memory:");
    const repos = new MetadataRepositories(store.db);
    repos.projects.save({ id: "p", configuredRootPath: root, canonicalRootPath: root, displayLabel: "p", archivedAt: null });
    const workspace: Workspace = { id: "w", projectId: "p", kind: "directory", cwd: root, checkoutRoot: root, mainRepositoryRoot: root, branchRef: null, displayLabel: "w", locationId: null, ownershipState: "not-owned", archivedAt: null };
    repos.workspaces.save(workspace);
    let open = true;
    const service = new AgentService(repos, {
      sessionsRoot: join(root, "sessions"),
      manager: new PiRpcManager(4),
      pi: { executable: process.execPath, executableArgs: ["-e", script] },
      admissionGate: () => open,
    });
    const agent = await service.create("w");
    await service.capabilities(agent.id);

    open = false;
    await expect(service.create("w")).rejects.toMatchObject({ code: "draining" });
    await expect(service.prompt(agent.id, "hi")).rejects.toMatchObject({ code: "draining" });
    await expect(service.steer(agent.id, "hi")).rejects.toMatchObject({ code: "draining" });
    await expect(service.followUp(agent.id, "hi")).rejects.toMatchObject({ code: "draining" });
    await expect(service.compact(agent.id)).rejects.toMatchObject({ code: "draining" });
    await expect(service.model(agent.id, "test", "model")).rejects.toMatchObject({ code: "draining" });
    await expect(service.thinking(agent.id, "medium")).rejects.toMatchObject({ code: "draining" });

    open = true;
    await service.stop(agent.id);
    open = false;
    // Explicit resume (new work) is refused...
    await expect(service.start(agent.id)).rejects.toMatchObject({ code: "draining" });
    // ...and so is a read that would need to lazily spawn a fresh process.
    await expect(service.capabilities(agent.id)).rejects.toMatchObject({ code: "draining" });

    // Abort, question answers, and resource-close controls stay usable
    // while closed -- they let admitted work settle or the resource
    // close, neither of which is new work.
    await expect(service.abort(agent.id)).resolves.toBeUndefined();
    await expect(service.archive(agent.id)).resolves.toBeUndefined();

    await service.shutdown();
    store.close();
  });

  test("shutdown cancels an in-flight run, then preserves it for boot recovery", async () => {
    const f = await make();
    const idleAgent = await f.service.create("w");
    await f.service.prompt(idleAgent.id, "hi");
    await pollExpect(() => expect(f.service.snapshot(idleAgent.id).lastKnownStatus).toBe("idle"));
    await f.service.shutdown();
    expect(f.repos.agents.get(idleAgent.id)?.lastKnownStatus).toBe("idle");
    f.store.close();

    const runningScript = `process.stdin.on('data',d=>{for(const l of d.toString().split('\\n')){if(!l)continue;const r=JSON.parse(l);const data=r.type==='get_state'?{isStreaming:true}:{};if(r.type==='prompt')process.stdout.write(JSON.stringify({type:'agent_start'})+'\\n');process.stdout.write(JSON.stringify({type:'response',id:r.id,success:true,data})+'\\n')}})`;
    const g = await make(10, ["-e", runningScript]);
    const agent = await g.service.create("w");
    await g.service.prompt(agent.id, "keep going");
    await pollExpect(() => expect(g.service.snapshot(agent.id).lastKnownStatus).toBe("running"));
    // The shutdown cancel (clear_queue + abort + abort_bash) is issued and
    // confirmed; this mock keeps streaming, so the kill lands the shutdown
    // branch: no `error` for a kill the daemon itself ordered, the pre-kill
    // status is preserved, and the shutdown reason is recorded for the
    // next boot sweep.
    await g.service.shutdown();
    expect(g.repos.agents.get(agent.id)?.lastKnownStatus).toBe("stopping");
    expect(g.repos.agents.get(agent.id)?.stopReason).toBe("shutdown");
    g.store.close();
  });

  test("shutdown-aborted runs resume on boot even when the cancel confirmed", async () => {
    const f = await make();
    const agent = await f.service.create("w");
    await f.service.prompt(agent.id, "hi");
    await waitForIdle(f.service, agent.id);
    // Shutdown races a live run: the cancel confirms (settles idle), but
    // Passage stopped the run itself, so it still owes the resume nudge.
    f.repos.agents.updateStatus(agent.id, "running");
    await f.service.shutdown();
    expect(f.repos.agents.get(agent.id)?.lastKnownStatus).toBe("idle");
    expect(f.repos.agents.get(agent.id)?.stopReason).toBe("shutdown");
    const restarted = new AgentService(f.repos, { sessionsRoot: join(f.root, "sessions"), manager: new PiRpcManager(4), pi: { executable: process.execPath, executableArgs: ["-e", script] } });
    const recovery = await restarted.warmAfterRestart();
    expect(recovery.continued).toEqual([agent.id]);
    await pollExpect(async () => {
      const resumed = await restarted.history(agent.id);
      expect("unpersisted" in resumed ? [] : resumed.history.timeline.filter((row) => row.kind === "user" && row.text === CONTINUATION_MESSAGE)).toHaveLength(1);
      expect(restarted.snapshot(agent.id).lastKnownStatus).toBe("idle");
    });
    expect(f.repos.agents.get(agent.id)?.stopReason).toBeNull();
    await restarted.shutdown();
    await f.service.shutdown();
    f.store.close();
  });

  test("an explicit user abort records its reason and is never resumed", async () => {
    const f = await make();
    const agent = await f.service.create("w");
    await f.service.prompt(agent.id, "hi");
    await waitForIdle(f.service, agent.id);
    f.repos.agents.updateStatus(agent.id, "running");
    await f.service.abort(agent.id);
    // Recorded at cancel time, before the abort even settles.
    expect(f.repos.agents.get(agent.id)?.stopReason).toBe("user_abort");
    await pollExpect(() => expect(f.service.snapshot(agent.id).lastKnownStatus).toBe("idle"));
    // A later boot sees the recorded user stop and leaves it alone.
    const restarted = new AgentService(f.repos, { sessionsRoot: join(f.root, "sessions"), manager: new PiRpcManager(4), pi: { executable: process.execPath, executableArgs: ["-e", script] } });
    expect(await restarted.warmAfterRestart()).toEqual({ warmed: [], continued: [], failed: [] });
    expect(f.repos.agents.get(agent.id)?.stopReason).toBe("user_abort");
    await restarted.shutdown();
    await f.service.shutdown();
    f.store.close();
  });

  test("shutdown does not resume a run the user already cancelled", async () => {
    const f = await make();
    const agent = await f.service.create("w");
    await f.service.prompt(agent.id, "hi");
    await waitForIdle(f.service, agent.id);
    // A live run the user stopped: reason recorded, process still briefly
    // alive while the cancel settles.
    f.repos.agents.updateStatus(agent.id, "running");
    await f.service.abort(agent.id);
    expect(f.repos.agents.get(agent.id)?.stopReason).toBe("user_abort");
    // Shutdown kills the settling process but must not override the
    // recorded user stop with its own shutdown reason, nor continue it.
    await f.service.shutdown();
    expect(f.repos.agents.get(agent.id)?.stopReason).toBe("user_abort");
    const restarted = new AgentService(f.repos, { sessionsRoot: join(f.root, "sessions"), manager: new PiRpcManager(4), pi: { executable: process.execPath, executableArgs: ["-e", script] } });
    // Warming still respawns the process (uniform for all non-idle rows)
    // but the recorded user stop vetoes the continuation.
    expect(await restarted.warmAfterRestart()).toEqual({ warmed: [agent.id], continued: [], failed: [] });
    expect(f.repos.agents.get(agent.id)?.stopReason).toBe("user_abort");
    await restarted.shutdown();
    await f.service.shutdown();
    f.store.close();
  });

  test("reports needs-attention for an outstanding extension question", async () => {
    const attentionScript = `process.stdin.on('data',d=>{for(const l of d.toString().split('\\n')){if(!l)continue;const r=JSON.parse(l);process.stdout.write(JSON.stringify({type:'response',id:r.id,success:true,data:{}})+'\\n');if(r.type==='get_entries')setTimeout(()=>process.stdout.write(JSON.stringify({type:'extension_ui_request',id:'q-1',method:'select',title:'Pick',options:['One','Two']})+'\\n'),5)}})`;
    const f = await make(10, ["-e", attentionScript]);
    const agent = await f.service.create("w");
    await pollExpect(() => {
      expect(f.service.snapshot(agent.id).lastKnownStatus).toBe("needs-attention");
    });
    await f.service.shutdown();
    f.store.close();
  });
});

describe("agent auto-titles (after the first agent response)", () => {
  const makeWithTitles = async (suggestTitle: (messages: string[], cwd?: string, model?: string, thinkingLevel?: string) => Promise<string | null>, suggestModel = "test/model", suggestThinkingLevel = "high") => {
    const root = await mkdtemp(join("/tmp", "passage-agent-"));
    roots.push(root);
    const store = new MetadataStore(":memory:");
    const repos = new MetadataRepositories(store.db);
    repos.projects.save({ id: "p", configuredRootPath: root, canonicalRootPath: root, displayLabel: "p", archivedAt: null });
    const workspace: Workspace = { id: "w", projectId: "p", kind: "directory", cwd: root, checkoutRoot: root, mainRepositoryRoot: root, branchRef: null, displayLabel: "w", locationId: null, ownershipState: "not-owned", archivedAt: null };
    repos.workspaces.save(workspace);
    const calls: { messages: string[]; cwd?: string; model?: string; thinkingLevel?: string }[] = [];
    const service = new AgentService(repos, {
      sessionsRoot: join(root, "sessions"),
      manager: new PiRpcManager(4),
      pi: { executable: process.execPath, executableArgs: ["-e", script] },
      titleSuggester: {
        suggestTitle: async (messages, cwd, model, thinkingLevel) => {
          calls.push({ messages, cwd, model, thinkingLevel });
          return suggestTitle(messages, cwd, model, thinkingLevel);
        },
      },
      getSuggestConfig: () => ({ model: suggestModel, thinkingLevel: suggestThinkingLevel }),
    });
    return { root, store, repos, service, calls };
  };
  const waitForTitle = async (repos: MetadataRepositories, agentId: string, timeoutMs = 2000) => {
    const start = Date.now();
    for (;;) {
      const title = repos.agents.get(agentId)?.title;
      if (title && title !== "Agent") return title;
      if (Date.now() - start > timeoutMs) throw new Error("timed out waiting for auto-title");
      await Bun.sleep(10);
    }
  };
  const settlePrompt = async (service: AgentService, agentId: string, text: string) => {
    await service.prompt(agentId, text);
    const start = Date.now();
    for (;;) {
      if (service.snapshot(agentId).lastKnownStatus === "idle") return;
      if (Date.now() - start > 2000) throw new Error("timed out waiting for idle");
      await Bun.sleep(10);
    }
  };

  test("titles the agent after the first agent response and emits a title event", async () => {
    const f = await makeWithTitles(async () => "Fix login retry bug");
    const seen: { type: string; title?: string }[] = [];
    f.service.subscribe((event) => {
      if (event.type === "title") seen.push({ type: event.type, title: (event.payload as { title?: string } | undefined)?.title });
    });
    const agent = await f.service.create("w");
    await settlePrompt(f.service, agent.id, "the login retry is broken");
    // The mock Pi settles with no assistant text, so the sources fall back
    // to just the first user message.
    expect(await waitForTitle(f.repos, agent.id)).toBe("Fix login retry bug");
    expect(f.calls).toHaveLength(1);
    expect(f.calls[0]?.messages).toEqual(["the login retry is broken"]);
    expect(f.calls[0]?.model).toBe("test/model");
    expect(f.calls[0]?.thinkingLevel).toBe("high");
    expect(seen).toEqual([{ type: "title", title: "Fix login retry bug" }]);
    // A second message does not retitle.
    await settlePrompt(f.service, agent.id, "it fails after three attempts");
    await Bun.sleep(30);
    expect(f.calls).toHaveLength(1);
    expect(f.repos.agents.get(agent.id)?.title).toBe("Fix login retry bug");
    await f.service.shutdown();
    f.store.close();
  });

  test("does not retitle on steer after a title is applied", async () => {
    const f = await makeWithTitles(async () => "Steered session title");
    const agent = await f.service.create("w");
    await settlePrompt(f.service, agent.id, "first");
    expect(await waitForTitle(f.repos, agent.id)).toBe("Steered session title");
    await f.service.steer(agent.id, "second via steer");
    await Bun.sleep(30);
    expect(f.calls).toHaveLength(1);
    expect(f.repos.agents.get(agent.id)?.title).toBe("Steered session title");
    await f.service.shutdown();
    f.store.close();
  });

  test("skips agents with a custom create-time title", async () => {
    const f = await makeWithTitles(async () => "Should never apply");
    const agent = await f.service.create("w", "My Title");
    await settlePrompt(f.service, agent.id, "first");
    await settlePrompt(f.service, agent.id, "second");
    await Bun.sleep(50);
    expect(f.calls).toHaveLength(0);
    expect(f.repos.agents.get(agent.id)?.title).toBe("My Title");
    await f.service.shutdown();
    f.store.close();
  });

  test("a null suggestion keeps the placeholder and retries on the next message", async () => {
    let attempts = 0;
    const f = await makeWithTitles(async () => (++attempts === 1 ? null : "Second try title"));
    const agent = await f.service.create("w");
    await settlePrompt(f.service, agent.id, "first");
    await Bun.sleep(50);
    expect(f.repos.agents.get(agent.id)?.title).toBe("Agent");
    await settlePrompt(f.service, agent.id, "second");
    expect(await waitForTitle(f.repos, agent.id)).toBe("Second try title");
    expect(attempts).toBe(2);
    await f.service.shutdown();
    f.store.close();
  });
});

describe("collectTitleSources", () => {
  test("uses the first user message plus the first response thinking/assistant text", () => {
    expect(collectTitleSources([
      { kind: "user", id: "u1", text: "the login retry is broken" },
      { kind: "thinking", id: "t1", text: "considering retry logic" },
      { kind: "assistant", id: "a1", text: "I will fix the retry loop" },
    ])).toEqual(["the login retry is broken", "considering retry logic", "I will fix the retry loop"]);
  });

  test("stops at the second user message and ignores tool rows", () => {
    expect(collectTitleSources([
      { kind: "user", id: "u1", text: "first" },
      { kind: "assistant", id: "a1", text: "first response" },
      { kind: "tool", id: "tool1", name: "bash", input: null, status: "complete" },
      { kind: "user", id: "u2", text: "second" },
      { kind: "assistant", id: "a2", text: "second response" },
    ])).toEqual(["first", "first response"]);
  });

  test("returns just the user message when the response has no text yet", () => {
    expect(collectTitleSources([{ kind: "user", id: "u1", text: "hello" }])).toEqual(["hello"]);
    expect(collectTitleSources([])).toEqual([]);
  });
});

describe("getCommitConversation", () => {
  test("returns workspace user messages without spawning or throwing", async () => {
    const f = await make();
    const agent = await f.service.create("w", "one");
    await f.service.prompt(agent.id, "Add retries to fetch");
    await waitForIdle(f.service, agent.id);
    await f.service.steer(agent.id, "Also coach: keep it small");
    const convo = await f.service.getCommitConversation("w");
    expect(convo.userMessages).toEqual(["Add retries to fetch", "Also coach: keep it small"]);
    expect(convo.finalAssistantMessages).toEqual([]);
    // Scoped to a single agent, and safe on unknown workspaces/agents.
    expect(await f.service.getCommitConversation("w", agent.id)).toEqual(convo);
    expect(await f.service.getCommitConversation("missing")).toEqual({ userMessages: [], finalAssistantMessages: [] });
    expect(await f.service.getCommitConversation("w", "agt_missing")).toEqual({ userMessages: [], finalAssistantMessages: [] });
    await f.service.shutdown();
    f.store.close();
  });
});
