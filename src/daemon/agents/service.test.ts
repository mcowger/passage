import { expect, test, afterEach, describe } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { MetadataStore } from "../metadata/database.ts";
import { MetadataRepositories, type Workspace } from "../metadata/repositories.ts";
import { AgentService, collectTitleSources, isGitCommitToolEvent } from "./service.ts";
import { PiRpcManager } from "./rpc/index.ts";

const script = `process.stdin.on('data',d=>{for(const l of d.toString().split('\\n')){if(!l)continue;const r=JSON.parse(l);if(r.type==='prompt'||r.type==='steer'||r.type==='follow_up')process.stdout.write(JSON.stringify({type:'agent_settled'})+'\\n');const data=r.type==='get_available_models'?{models:[{provider:'test',id:'model',name:'Model',api:'test',input:['text'],authenticated:true,supportedThinkingLevels:['medium','high']}]}:r.type==='get_available_thinking_levels'?{levels:['medium','high']}:{};process.stdout.write(JSON.stringify({type:'response',id:r.id,success:true,data})+'\\n')}})`;
const roots: string[] = [];
const make = async (limit = 10, executableArgs?: string[]) => {
  const root = await mkdtemp(join("/tmp", "passage-agent-")); roots.push(root);
  const store = new MetadataStore(join(root, "meta.sqlite")); const repos = new MetadataRepositories(store.db);
  repos.projects.save({ id: "p", configuredRootPath: root, canonicalRootPath: root, displayLabel: "p", archivedAt: null });
  const workspace: Workspace = { id: "w", projectId: "p", kind: "directory", cwd: root, checkoutRoot: root, mainRepositoryRoot: root, branchRef: null, displayLabel: "w", locationId: null, ownershipState: "not-owned", archivedAt: null }; repos.workspaces.save(workspace);
  const manager = new PiRpcManager(4); const service = new AgentService(repos, { sessionsRoot: join(root, "sessions"), manager, listLimit: limit, pi: { executable: process.execPath, executableArgs: executableArgs ?? ["-e", script] }, titleSuggester: { suggestTitle: async () => null } });
  return { root, store, repos, manager, service };
};
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });

test("creates and immediately persists an agent, and supports admission/settlement", async () => {
  const f = await make(); const events: string[] = []; f.service.subscribe(e => events.push(e.type));
  const agent = await f.service.create("w", "one"); expect(agent.piSessionId).toStartWith("pi_"); expect(agent.piSessionPath).toBeNull();
  await f.service.prompt(agent.id, "hello"); await Bun.sleep(20); expect(events).toContain("settled"); await f.service.shutdown(); f.store.close();
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
  await Bun.sleep(20);
  expect(f.service.snapshot(agent.id).lastKnownStatus).toBe("idle");
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
  await f.service.capabilities(active.id);
  await f.service.capabilities(idle.id);
  await f.service.capabilities(archived.id);
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

  await Bun.sleep(15);
  // Client reloads and re-anchors from the same authoritative run start.
  expect(service.snapshot(agent.id).runStartedAt).toBe(started);
  expect(events.some((event) => event.type === "status" && event.runStartedAt === started)).toBe(true);

  await Bun.sleep(60);
  expect(service.snapshot(agent.id).lastKnownStatus).toBe("idle");
  expect(service.snapshot(agent.id).runStartedAt).toBeUndefined();
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
  await Bun.sleep(10);
  expect(service.snapshot(agent.id).lastKnownStatus).toBe("running");

  await service.abort(agent.id);
  expect(service.snapshot(agent.id).lastKnownStatus).toBe("stopping");
  await expect(service.prompt(agent.id, "racing prompt")).rejects.toMatchObject({ code: "invalid-input" });

  await Bun.sleep(100);
  expect(service.snapshot(agent.id).lastKnownStatus).toBe("idle");
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
  await Bun.sleep(10);
  expect(service.snapshot(agent.id).lastKnownStatus).toBe("running");
  expect(invalidated).toEqual([]);

  await service.abort(agent.id);
  await Bun.sleep(100);
  expect(service.snapshot(agent.id).lastKnownStatus).toBe("idle");
  expect(invalidated).toEqual(["w"]);
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
  await Bun.sleep(10);
  expect(service.snapshot(agent.id).lastKnownStatus).toBe("running");

  await service.abort(agent.id);
  expect(service.snapshot(agent.id).lastKnownStatus).toBe("stopping");

  await Bun.sleep(100);
  expect(service.snapshot(agent.id).lastKnownStatus).toBe("idle");
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
  await Bun.sleep(10);
  expect(service.snapshot(agent.id).lastKnownStatus).toBe("running");

  await service.abort(agent.id);
  expect(service.snapshot(agent.id).lastKnownStatus).toBe("stopping");

  await Bun.sleep(150);
  expect(service.snapshot(agent.id).lastKnownStatus).toBe("idle");
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

  await Bun.sleep(60);
  expect(service.snapshot(agent.id)).toMatchObject({ lastKnownStatus: "error", live: false });
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
  await Bun.sleep(30);
  const snapshot = service.snapshot(agent.id);
  expect(snapshot).toMatchObject({
    live: false,
    lastKnownStatus: "error",
    exitStatus: "crashed (7)",
  });
  expect(snapshot.stderr?.join("")).toContain("crash-marker");
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
  await Bun.sleep(30);
  const snap = service.snapshot(agent.id);
  expect(snap.lastKnownStatus).toBe("needs-attention");
  expect(snap.pendingUiRequest?.id).toBe("prompt-1");
  expect(snap.pendingUiRequest?.title).toBe("Pick");
  expect(snap.pendingUiRequest?.options).toEqual(["One", "Two"]);

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
  await Bun.sleep(30);
  expect(service.snapshot(agent.id).pendingUiRequest?.id).toBe("prompt-1");

  await service.respondExtensionUi(agent.id, { id: "prompt-1", value: "anchovies and honey", custom: true });
  await Bun.sleep(60);

  // The select was answered with the escape row, then the typed text went to
  // the input follow-up Pi opened for it.
  expect(await readUiResponses(log)).toEqual([
    { id: "prompt-1", value: DIALOG_ROWS[2] },
    { id: "prompt-2", value: "anchovies and honey" },
  ]);
  // The follow-up never surfaced as a second card.
  const snap = service.snapshot(agent.id);
  expect(snap.pendingUiRequest).toBeUndefined();
  expect(snap.lastKnownStatus).toBe("running");

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
  await Bun.sleep(30);
  // The card shows bare labels; Pi needs the numbered row back.
  await service.respondExtensionUi(agent.id, { id: "prompt-1", value: "Pineapple" });
  await Bun.sleep(60);
  expect(await readUiResponses(log)).toEqual([{ id: "prompt-1", value: DIALOG_ROWS[1] }]);
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
    await Bun.sleep(30);

    const result = await service.history(agent.id);
    if ("unpersisted" in result) throw new Error("expected a persisted transcript");
    const kinds = result.history.timeline.map((item) => item.kind);
    expect(kinds).toEqual(["user", "tool", "tool"]);
    const [, toolA, toolB] = result.history.timeline as Array<{ id: string; result?: string; status: string }>;
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
    expect(again.history.transcriptEpoch).toBe(result.history.transcriptEpoch);
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
    await Bun.sleep(30);

    const result = await service.history(agent.id);
    if ("unpersisted" in result) throw new Error("expected a persisted transcript");
    const errorRow = result.history.timeline.find((item) => item.kind === "error");
    expect(errorRow).toBeTruthy();
    expect((errorRow as { text: string }).text).toContain("Pi process exited (7)");

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
    await Bun.sleep(50);
    expect(service.snapshot(agent.id).lastKnownStatus).toBe("running");
    expect(invalidated).toEqual(["w"]);
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
    await Bun.sleep(50);
    expect(service.snapshot(agent.id).lastKnownStatus).toBe("running");
    expect(invalidated).toEqual([]);
    await service.steer(agent.id, "wrap up");
    await Bun.sleep(50);
    expect(service.snapshot(agent.id).lastKnownStatus).toBe("idle");
    expect(invalidated).toEqual(["w"]);
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
    await Bun.sleep(50);
    expect(events).toContain("settled");
    expect(service.snapshot(agent.id).lastKnownStatus).toBe("idle");
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

describe("drain admission gate (docs/BACKTOSQUAREONE.md step 5)", () => {
  test("closing admission refuses new agent work but keeps abort, question answers, and resource-close working", async () => {
    const root = await mkdtemp(join("/tmp", "passage-agent-"));
    roots.push(root);
    const store = new MetadataStore(join(root, "meta.sqlite"));
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
    // while draining -- they let admitted work settle or the resource
    // close, neither of which is new work.
    await expect(service.abort(agent.id)).resolves.toBeUndefined();
    await expect(service.archive(agent.id)).resolves.toBeUndefined();

    await service.shutdown();
    store.close();
  });

  test("listQuickBlockers and listBlockers reflect live agent activity, not persisted status alone", async () => {
    const f = await make();
    const idleAgent = await f.service.create("w");
    await f.service.capabilities(idleAgent.id);
    expect(f.service.listQuickBlockers()).toEqual([]);
    expect(await f.service.listBlockers()).toEqual([]);

    const runningScript = `process.stdin.on('data',d=>{for(const l of d.toString().split('\\n')){if(!l)continue;const r=JSON.parse(l);const data=r.type==='get_state'?{isStreaming:true}:{};if(r.type==='prompt')process.stdout.write(JSON.stringify({type:'agent_start'})+'\\n');process.stdout.write(JSON.stringify({type:'response',id:r.id,success:true,data})+'\\n')}})`;
    const g = await make(10, ["-e", runningScript]);
    const runningAgent = await g.service.create("w");
    await g.service.prompt(runningAgent.id, "keep going");
    await Bun.sleep(20);
    expect(g.service.listQuickBlockers()).toContainEqual({ agentId: runningAgent.id, reason: "running" });
    expect(await g.service.listBlockers()).toContainEqual({ agentId: runningAgent.id, reason: "running" });

    await f.service.shutdown();
    await g.service.shutdown();
    f.store.close();
    g.store.close();
  });

  test("interrupted shutdown reports a forced stop honestly; safe shutdown leaves an already-idle agent alone", async () => {
    const f = await make();
    const idleAgent = await f.service.create("w");
    await f.service.prompt(idleAgent.id, "hi");
    await Bun.sleep(20);
    expect(f.service.snapshot(idleAgent.id).lastKnownStatus).toBe("idle");
    await f.service.shutdown();
    expect(f.repos.agents.get(idleAgent.id)?.lastKnownStatus).toBe("idle");
    f.store.close();

    const runningScript = `process.stdin.on('data',d=>{for(const l of d.toString().split('\\n')){if(!l)continue;const r=JSON.parse(l);const data=r.type==='get_state'?{isStreaming:true}:{};if(r.type==='prompt')process.stdout.write(JSON.stringify({type:'agent_start'})+'\\n');process.stdout.write(JSON.stringify({type:'response',id:r.id,success:true,data})+'\\n')}})`;
    const g = await make(10, ["-e", runningScript]);
    const agent = await g.service.create("w");
    await g.service.prompt(agent.id, "keep going");
    await Bun.sleep(20);
    expect(g.service.snapshot(agent.id).lastKnownStatus).toBe("running");
    // Interrupted: the forced stop's lifecycle event is still observed
    // (not silently dropped by an early detach) and honestly reported.
    await g.service.shutdown({ interrupted: true });
    expect(g.repos.agents.get(agent.id)?.lastKnownStatus).toBe("error");
    g.store.close();
  });

  test("listQuickBlockers reports needs-attention for an outstanding extension question", async () => {
    const attentionScript = `process.stdin.on('data',d=>{for(const l of d.toString().split('\\n')){if(!l)continue;const r=JSON.parse(l);process.stdout.write(JSON.stringify({type:'response',id:r.id,success:true,data:{}})+'\\n');if(r.type==='get_entries')setTimeout(()=>process.stdout.write(JSON.stringify({type:'extension_ui_request',id:'q-1',method:'select',title:'Pick',options:['One','Two']})+'\\n'),5)}})`;
    const f = await make(10, ["-e", attentionScript]);
    const agent = await f.service.create("w");
    await Bun.sleep(30);
    expect(f.service.snapshot(agent.id).lastKnownStatus).toBe("needs-attention");
    expect(f.service.listQuickBlockers()).toContainEqual({ agentId: agent.id, reason: "needs-attention" });
    await f.service.shutdown();
    f.store.close();
  });

  test("listBlockers treats a get_state probe failure as an unknown blocker, not idle", async () => {
    // Handshake (manager.start) and the post-boot reconcile() each issue one
    // get_state; only the third (the drain probe) fails, so this exercises
    // the probe's own error path without the process ever failing to start.
    const failScript = `let n=0;process.stdin.on('data',d=>{for(const l of d.toString().split('\\n')){if(!l)continue;const r=JSON.parse(l);if(r.type==='get_state'){n++;if(n<=2){process.stdout.write(JSON.stringify({type:'response',id:r.id,success:true,data:{isStreaming:false}})+'\\n')}else{process.stdout.write(JSON.stringify({type:'response',id:r.id,success:false,error:'boom'})+'\\n')}}else{process.stdout.write(JSON.stringify({type:'response',id:r.id,success:true,data:{}})+'\\n')}}})`;
    const f = await make(10, ["-e", failScript]);
    const agent = await f.service.create("w");
    await Bun.sleep(20);
    expect(f.service.listQuickBlockers()).toEqual([]);
    expect(await f.service.listBlockers()).toContainEqual({ agentId: agent.id, reason: "unknown" });
    await f.service.shutdown();
    f.store.close();
  });
});

describe("agent auto-titles (after the first agent response)", () => {
  const makeWithTitles = async (suggestTitle: (messages: string[], cwd?: string, model?: string, thinkingLevel?: string) => Promise<string | null>, suggestModel = "test/model", suggestThinkingLevel = "high") => {
    const root = await mkdtemp(join("/tmp", "passage-agent-"));
    roots.push(root);
    const store = new MetadataStore(join(root, "meta.sqlite"));
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
    await Bun.sleep(50);
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
