import { expect, test, afterEach, describe } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { MetadataStore } from "../metadata/database.ts";
import { MetadataRepositories, type Workspace } from "../metadata/repositories.ts";
import { AgentService, isGitCommitToolEvent } from "./service.ts";
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
    skillsAvailable: false,
    skillsSupported: true,
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
});
