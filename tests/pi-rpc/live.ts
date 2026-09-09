import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PiRpcClient } from "./client.ts";
import { readPiJsonl } from "./history.ts";

const LIMIT = 90_000;
const waitFor = async (client: PiRpcClient, type: string) => {
  const deadline = Date.now() + LIMIT;
  while (Date.now() < deadline) {
    const event = client.events.find((item) => item.type === type);
    if (event) return event;
    await Bun.sleep(100);
  }
  throw new Error(`timed out waiting for ${type}`);
};

async function sessionFiles(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  return entries.filter((entry) => entry.isFile() && entry.name.endsWith(".jsonl")).map((entry) => join(directory, entry.name));
}

export async function runLiveAcceptance(): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), "passage-pi-live-"));
  const cwd = join(root, "workspace");
  const sessions = join(root, "sessions");
  await Bun.write(join(cwd, ".keep"), "");
  const aSessions = join(sessions, "a");
  const bSessions = join(sessions, "b");
  const a = new PiRpcClient({ cwd, sessionDir: aSessions, sessionId: "agent-a" });
  const b = new PiRpcClient({ cwd, sessionDir: bSessions, sessionId: "agent-b" });
  try {
    const [aState, bState] = await Promise.all([a.request({ type: "get_state" }), b.request({ type: "get_state" })]);
    const aData = aState.data as { sessionId?: string; sessionFile?: string };
    const bData = bState.data as { sessionId?: string; sessionFile?: string };
    if (aData.sessionId !== "agent-a" || bData.sessionId !== "agent-b") throw new Error("Pi did not create the requested sessions");
    const prompt = await a.request({ type: "prompt", message: "Reply with exactly the word PASSAGE" });
    if (prompt.success !== true) throw new Error("prompt was not admitted");
    await waitFor(a, "agent_settled");
    const secondPrompt = await b.request({ type: "prompt", message: "Reply with exactly the word ISOLATED" });
    if (secondPrompt.success !== true) throw new Error("second prompt was not admitted");
    await waitFor(b, "agent_settled");
    for (const command of ["steer", "follow_up"] as const) {
      const response = await a.request({ type: command, message: "PASSAGE" });
      if (response.success !== true) throw new Error(`${command} was not accepted`);
      await waitFor(a, "agent_settled");
    }
    const durableAState = await a.request({ type: "get_state" });
    const durableAData = durableAState.data as { sessionId?: string; sessionFile?: string };
    if (durableAData.sessionId !== aData.sessionId || !durableAData.sessionFile) {
      throw new Error("Pi did not expose a durable session path after settlement");
    }
    const resumed = new PiRpcClient({ cwd, sessionDir: aSessions, sessionId: "agent-a" });
    try {
      const resumedState = await resumed.request({ type: "get_state" });
      const resumedData = resumedState.data as { sessionId?: string; sessionFile?: string };
      if (resumedData.sessionId !== durableAData.sessionId || resumedData.sessionFile !== durableAData.sessionFile) {
        throw new Error("Pi did not resume the same durable session");
      }
    } finally { await resumed.shutdown(); }
    const files = [...await sessionFiles(aSessions), ...await sessionFiles(bSessions)];
    if (files.length < 2) throw new Error(`expected two isolated session files, found ${files.length}`);
    for (const file of files) {
      const entries = await readPiJsonl(file);
      if (!entries.some((entry) => (entry as { type?: string }).type === "session")
        || !entries.some((entry) => (entry as { type?: string }).type === "message")) {
        throw new Error("Pi session file did not retain durable session and message entries");
      }
    }
  } finally {
    await Promise.all([a.shutdown(), b.shutdown()]);
    await rm(root, { recursive: true, force: true });
  }
}

if (import.meta.main) {
  if (process.env.PASSAGE_PI_LIVE === "real" || process.env.PASSAGE_PI_USE_REAL === "1") {
    await runLiveAcceptance();
  } else {
    const { withNullModelHarness } = await import("./nullmodel-harness.ts");
    await withNullModelHarness(() => runLiveAcceptance());
  }
}
