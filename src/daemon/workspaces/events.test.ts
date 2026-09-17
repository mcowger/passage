import { describe, expect, test } from "bun:test";
import { WorkspaceEventHub } from "./events.ts";
import { WORKSPACES_SNAPSHOT_SUBJECT } from "../../shared/protocol/index.ts";
import type { FilesChangedPayload, GitStatusChangedPayload } from "../../shared/protocol/index.ts";

const payload = (workspaceId: string, extra: Partial<FilesChangedPayload> = {}): FilesChangedPayload => ({
  workspaceId,
  reason: "create",
  path: "notes.txt",
  ...extra,
});

describe("WorkspaceEventHub", () => {
  test("returns empty replay for current sequence without triggering snapshot-required", () => {
    const h = new WorkspaceEventHub();
    expect(h.subscribe("brand-new", 0, () => {}).replay).toEqual({ kind: "replay", events: [] });
    h.emit(payload("brand-new"));
    expect(h.subscribe("brand-new", 1, () => {}).replay).toEqual({ kind: "replay", events: [] });
  });
  test("emits files-changed invalidations with per-workspace sequences", () => {
    const h = new WorkspaceEventHub();
    const got: Array<{ sequence: number; type: string; payload: unknown }> = [];
    const a = h.subscribe("wsp_a", 0, (e) => got.push({ sequence: e.sequence, type: e.type, payload: e.payload }));
    const b = h.subscribe("wsp_b", 0, () => { throw new Error("listener isolation"); });
    a.activate(); b.activate();
    h.emit(payload("wsp_a", { reason: "delete", path: "old.txt" }));
    h.emit(payload("wsp_b", { reason: "create", path: "new.txt" }));
    h.emit(payload("wsp_a", { reason: "rename", path: "new.txt", previousPath: "old.txt" }));
    expect(got.map((e) => e.sequence)).toEqual([1, 2]);
    expect(got[0].type).toBe("files-changed");
    expect(got[0].payload).toMatchObject({ workspaceId: "wsp_a", reason: "delete", path: "old.txt" });
    expect(h.currentSequence("wsp_a")).toBe(2);
    expect(h.currentSequence("wsp_b")).toBe(1);
  });
  test("replays and reports eviction", () => {
    const h = new WorkspaceEventHub({ replay: { maxEntries: 2 } });
    h.emit(payload("wsp_a"));
    h.emit(payload("wsp_a"));
    h.emit(payload("wsp_a"));
    expect(h.subscribe("wsp_a", 0, () => {}).replay.kind).toBe("snapshot-required");
    expect(h.subscribe("wsp_a", 2, () => {}).replay.kind).toBe("replay");
  });
  test("buffers live events until replay is delivered", () => {
    const h = new WorkspaceEventHub();
    const received: number[] = [];
    h.emit(payload("wsp_a"));
    const subscription = h.subscribe("wsp_a", 0, (item) => received.push(item.sequence));
    h.emit(payload("wsp_a"));
    expect(received).toEqual([]);
    expect(subscription.replay.kind).toBe("replay");
    if (subscription.replay.kind !== "replay") throw new Error("expected replay");
    for (const item of subscription.replay.events) received.push(item.sequence);
    subscription.activate();
    expect(received).toEqual([1, 2]);
  });
  test("emits git-status-changed invalidations on a shared per-workspace sequence", () => {
    const h = new WorkspaceEventHub();
    const got: Array<{ sequence: number; type: string; payload: unknown }> = [];
    const sub = h.subscribe("wsp_a", 0, (e) => got.push({ sequence: e.sequence, type: e.type, payload: e.payload }));
    sub.activate();
    const git = (reason: GitStatusChangedPayload["reason"]): GitStatusChangedPayload => ({ workspaceId: "wsp_a", reason });
    h.emit(payload("wsp_a"));
    h.emitGitStatus(git("stage"));
    h.emitGitStatus(git("commit"));
    expect(got.map((e) => e.sequence)).toEqual([1, 2, 3]);
    expect(got[1].type).toBe("git-status-changed");
    expect(got[1].payload).toMatchObject({ workspaceId: "wsp_a", reason: "stage" });
    expect(h.currentSequence("wsp_a")).toBe(3);
  });
  test("emits workspaces-changed on the shared list subject", () => {
    const h = new WorkspaceEventHub();
    const got: Array<{ sequence: number; type: string; subjectId: string; payload: unknown }> = [];
    const sub = h.subscribe(WORKSPACES_SNAPSHOT_SUBJECT, 0, (e) => got.push({ sequence: e.sequence, type: e.type, subjectId: e.subjectId, payload: e.payload }));
    sub.activate();
    const event = h.emitWorkspacesChanged({ reason: "remove", workspaceId: "wsp_x" });
    expect(event?.type).toBe("workspaces-changed");
    expect(event?.subjectId).toBe(WORKSPACES_SNAPSHOT_SUBJECT);
    expect(got).toHaveLength(1);
    expect(got[0]).toMatchObject({ sequence: 1, type: "workspaces-changed", subjectId: WORKSPACES_SNAPSHOT_SUBJECT });
    // The list sequence is independent of per-workspace subjects.
    expect(h.currentSequence("wsp_x")).toBe(0);
    expect(h.currentSequence(WORKSPACES_SNAPSHOT_SUBJECT)).toBe(1);
    const replay = h.subscribe(WORKSPACES_SNAPSHOT_SUBJECT, 0, () => {}).replay;
    expect(replay.kind).toBe("replay");
  });
  test("drops invalid workspaces-changed payloads without throwing", () => {
    const h = new WorkspaceEventHub();
    expect(h.emitWorkspacesChanged({ reason: "explode" as never })).toBeNull();
    expect(h.emitWorkspacesChanged({ reason: "remove", workspaceId: "" })).toBeNull();
    expect(h.currentSequence(WORKSPACES_SNAPSHOT_SUBJECT)).toBe(0);
    expect(h.emitWorkspacesChanged({ reason: "archive", workspaceId: "wsp_a" })?.sequence).toBe(1);
  });
  test("drops invalid git payloads without throwing", () => {
    const h = new WorkspaceEventHub();
    expect(h.emitGitStatus({ workspaceId: "", reason: "stage" })).toBeNull();
    expect(h.emitGitStatus({ workspaceId: "wsp_a", reason: "explode" as never })).toBeNull();
    expect(h.currentSequence("wsp_a")).toBe(0);
    expect(h.emitGitStatus({ workspaceId: "wsp_a", reason: "fetch" })?.sequence).toBe(1);
  });
  test("drops invalid payloads without throwing and never breaks mutations", () => {
    const h = new WorkspaceEventHub();
    expect(h.emit({ workspaceId: "", reason: "create" })).toBeNull();
    expect(h.emit({ workspaceId: "wsp_a", reason: "explode" as never })).toBeNull();
    expect(h.currentSequence("wsp_a")).toBe(0);
    expect(h.emit(payload("wsp_a"))?.sequence).toBe(1);
  });
  test("enforces subject and listener caps", () => {
    const h = new WorkspaceEventHub({ maxSubjects: 1, maxListeners: 1 });
    const first = h.subscribe("wsp_a", 0, () => {});
    expect(() => h.subscribe("wsp_b", 0, () => {})).toThrow();
    expect(() => h.subscribe("wsp_a", 0, () => {})).toThrow();
    expect(first.unsubscribe()).toBe(true);
    const second = h.subscribe("wsp_a", 0, () => {});
    second.activate();
    expect(second.unsubscribe()).toBe(true);
  });
  test("disposes and only explicit removal resets sequence", () => {
    const h = new WorkspaceEventHub();
    let n = 0;
    const first = h.subscribe("wsp_a", 0, (e) => n = e.sequence);
    first.activate();
    h.emit(payload("wsp_a"));
    h.removeSubject("wsp_a");
    const second = h.subscribe("wsp_a", 0, (e) => n = e.sequence);
    second.activate();
    h.emit(payload("wsp_a"));
    expect(n).toBe(1);
    h.dispose();
    h.emit(payload("wsp_a"));
    expect(n).toBe(1);
    expect(() => h.subscribe("wsp_a", 0, () => {})).toThrow();
  });
});
