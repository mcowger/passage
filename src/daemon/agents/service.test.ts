import { expect, test, afterEach } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { MetadataStore } from "../metadata/database.ts";
import { MetadataRepositories, type Workspace } from "../metadata/repositories.ts";
import { AgentService } from "./service.ts";
import { PiRpcManager } from "./rpc/index.ts";

const script = `process.stdin.on('data',d=>{for(const l of d.toString().split('\\n')){if(!l)continue;const r=JSON.parse(l);if(r.type==='prompt'||r.type==='steer'||r.type==='follow_up')process.stdout.write(JSON.stringify({type:'agent_settled'})+'\\n');const data=r.type==='get_available_models'?{models:[{provider:'test',id:'model',name:'Model',api:'test',input:['text'],authenticated:true,supportedThinkingLevels:['medium','high']}]}:r.type==='get_available_thinking_levels'?{levels:['medium','high']}:{};process.stdout.write(JSON.stringify({type:'response',id:r.id,success:true,data})+'\\n')}})`;
const roots: string[] = [];
const make = async (limit = 10) => {
  const root = await mkdtemp(join("/tmp", "passage-agent-")); roots.push(root);
  const store = new MetadataStore(join(root, "meta.sqlite")); const repos = new MetadataRepositories(store.db);
  repos.projects.save({ id: "p", configuredRootPath: root, canonicalRootPath: root, displayLabel: "p", archivedAt: null });
  const workspace: Workspace = { id: "w", projectId: "p", kind: "directory", cwd: root, checkoutRoot: root, mainRepositoryRoot: root, branchRef: null, displayLabel: "w", locationId: null, ownershipState: "not-owned", archivedAt: null }; repos.workspaces.save(workspace);
  const manager = new PiRpcManager(4); const service = new AgentService(repos, { sessionsRoot: join(root, "sessions"), manager, listLimit: limit, pi: { executable: process.execPath, executableArgs: ["-e", script] } });
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

test("listener failures do not break service operation", async () => {
  const f = await make(); f.service.subscribe(() => { throw new Error("listener"); }); const a = await f.service.create("w"); expect(a.id).toStartWith("agt_"); await f.service.shutdown(); f.store.close();
});

test("validates Pi model capabilities before persisting preferences", async () => {
  const f = await make();
  const agent = await f.service.create("w");
  expect(await f.service.capabilities(agent.id)).toMatchObject({
    models: [{ provider: "test", id: "model" }],
    thinkingLevels: ["medium", "high"],
  });
  await f.service.model(agent.id, "test", "model");
  await f.service.thinking(agent.id, "high");
  expect(f.repos.agents.get(agent.id)).toMatchObject({ modelPreference: "test/model", thinkingPreference: "high" });
  await expect(f.service.model(agent.id, "test", "missing")).rejects.toMatchObject({ code: "invalid-input" });
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

test("maps Pi extension UI requests to an attention state and responds", async () => {
  const f = await make();
  const attentionScript = `process.stdin.on('data',d=>{for(const l of d.toString().split('\\n')){if(!l)continue;const r=JSON.parse(l);process.stdout.write(JSON.stringify({type:'response',id:r.id,success:true,data:{}})+'\\n');if(r.type==='get_entries')setTimeout(()=>process.stdout.write(JSON.stringify({type:'extension_ui_request',id:'prompt-1',method:'select',title:'Pick'})+'\\n'),5)}})`;
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

  await service.respondExtensionUi(agent.id, { id: "prompt-1", value: "Option 1" });
  expect(service.snapshot(agent.id).lastKnownStatus).toBe("running");
  expect(service.snapshot(agent.id).pendingUiRequest).toBeUndefined();

  await service.shutdown();
  f.store.close();
});
