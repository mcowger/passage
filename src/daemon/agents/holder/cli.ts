/** `passage pi-holder <agentId>` entrypoint (lazy-imported from index.ts). */
import { HolderServer } from "./server.ts";
import { validateAgentId } from "./protocol.ts";

function flagValue(argv: string[], name: string): string | undefined {
  const index = argv.indexOf(name);
  return index === -1 ? undefined : argv[index + 1];
}

/** Repeatable `--pi-arg <value>` flags, in order. */
function flagValues(argv: string[], name: string): string[] {
  const values: string[] = [];
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === name && index + 1 < argv.length) values.push(argv[index + 1]);
  }
  return values;
}

export async function runHolder(argv: string[]): Promise<void> {
  const agentId = validateAgentId(argv[3] ?? "");
  const sessionDir = flagValue(argv, "--session-dir");
  const sessionId = flagValue(argv, "--session-id");
  const cwd = flagValue(argv, "--cwd");
  const socket = flagValue(argv, "--socket");
  if (!sessionDir || !sessionId || !cwd || !socket) {
    process.stderr.write("pi-holder: --session-dir, --session-id, --cwd, and --socket are required\n");
    process.exit(2);
  }
  process.title = `passage-pi-holder:${agentId}`;
  const generation = Number(flagValue(argv, "--generation") ?? "1");
  const server = new HolderServer({
    agentId,
    sessionDir,
    sessionId,
    cwd,
    socketPath: socket,
    generation: Number.isSafeInteger(generation) && generation > 0 ? generation : 1,
    executable: flagValue(argv, "--pi-path"),
    executableArgs: flagValues(argv, "--pi-arg"),
    model: flagValue(argv, "--model"),
    disableTools: argv.includes("--no-tools"),
    ...(flagValue(argv, "--max-event-bytes") ? { maxEventBytes: Number(flagValue(argv, "--max-event-bytes")) } : {}),
    ...(flagValue(argv, "--max-stderr-bytes") ? { maxStderrBytes: Number(flagValue(argv, "--max-stderr-bytes")) } : {}),
    ...(flagValue(argv, "--idle-ms") ? { idleMs: Number(flagValue(argv, "--idle-ms")) } : {}),
  });
  const onSignal = (): void => {
    void server.gracefulStop();
  };
  process.once("SIGINT", onSignal);
  process.once("SIGTERM", onSignal);
  await server.start();
  // Park: start() only boots. The holder lives until gracefulStop →
  // shutdown → process.exit (or the idle/exit-linger paths). Returning
  // here would let the event loop drain and exit 0 right after boot.
  await new Promise<never>(() => {});
}
