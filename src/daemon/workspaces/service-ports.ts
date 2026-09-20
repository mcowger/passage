import net from "node:net";
import { realpath } from "node:fs/promises";
import type { PaseoServicePortAllocation } from "./paseo-config.ts";
import { sanitizedSubprocessEnv } from "../env.ts";

const PORT_SCRIPT_TIMEOUT_MS = 10_000;
const PORT_SCRIPT_MAX_OUTPUT_BYTES = 1024;

export function normalizeServiceEnvName(scriptName: string): string {
  return scriptName
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
}

export function assertNoServiceEnvNameCollisions(scriptNames: readonly string[]): void {
  const byEnvName = new Map<string, string[]>();
  for (const name of scriptNames) {
    const envName = normalizeServiceEnvName(name);
    const list = byEnvName.get(envName) ?? [];
    list.push(name);
    byEnvName.set(envName, list);
  }
  const collisions: string[] = [];
  for (const [envName, names] of byEnvName) {
    if (names.length > 1) collisions.push(`Service env name collision for ${envName}: ${names.join(", ")}`);
  }
  if (collisions.length > 0) throw new Error(collisions.join("; "));
}

export function isValidTcpPort(port: number): boolean {
  return Number.isInteger(port) && port >= 1 && port <= 65535;
}

function parsePortRange(value: string): { start: number; end: number } {
  const [start, end] = value.split("-").map(Number);
  if (!isValidTcpPort(start) || !isValidTcpPort(end) || start > end) {
    throw new Error(`Invalid service port range '${value}'`);
  }
  return { start, end };
}

function isPortAvailable(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.once("error", () => resolve(false));
    server.once("listening", () => {
      server.close(() => resolve(true));
    });
    server.listen(port, "0.0.0.0");
  });
}

/** Display-only liveness probe: does something accept TCP on `port` at
 *  loopback right now? Short timeout, never throws (false on any failure).
 *  Used for service health display; the supervisor takes no action on the
 *  result. */
export function isPortOpen(port: number, timeoutMs = 300): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = net.createConnection({ host: "127.0.0.1", port });
    const done = (open: boolean) => {
      clearTimeout(timer);
      try {
        socket.destroy();
      } catch {}
      resolve(open);
    };
    const timer = setTimeout(() => done(false), timeoutMs);
    socket.once("connect", () => done(true));
    socket.once("error", () => done(false));
  });
}

async function allocatePortFromScript(options: {
  cwd: string;
  command: string;
  scriptName: string;
  workspaceId: string;
  branchName: string | null;
}): Promise<number> {
  const resolvedCwd = await realpath(options.cwd).catch(() => options.cwd);
  const proc = Bun.spawn([options.command, options.scriptName, options.workspaceId, options.branchName ?? "", resolvedCwd], {
    cwd: resolvedCwd,
    env: sanitizedSubprocessEnv({
      PASEO_SCRIPTNAME: options.scriptName,
      PASEO_WORKSPACE_ID: options.workspaceId,
      PASEO_BRANCH_NAME: options.branchName ?? "",
      PASEO_WORKTREE_PATH: resolvedCwd,
    }),
    stdout: "pipe",
    stderr: "pipe",
  });
  const timeout = setTimeout(() => {
    try {
      proc.kill();
    } catch {}
  }, PORT_SCRIPT_TIMEOUT_MS);
  try {
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(proc.stdout).text().catch(() => ""),
      new Response(proc.stderr).text().catch(() => ""),
      proc.exited,
    ]);
    if (exitCode !== 0) {
      throw new Error(`Service port script '${options.command}' exited with code ${exitCode}: ${stderr.slice(0, 512)}`);
    }
    const output = stdout.trim().split(/\s+/)[0] ?? "";
    if (!/^\d+$/.test(output)) {
      throw new Error(`Service port script '${options.command}' must print exactly one TCP port`);
    }
    const port = Number(output);
    if (!isValidTcpPort(port)) {
      throw new Error(`Service port script '${options.command}' returned invalid TCP port '${output}'`);
    }
    // Trusted blindly by design (matches paseo): the returned port may
    // already be bound — e.g. dev-port.ts reprints the live server's port.
    void PORT_SCRIPT_MAX_OUTPUT_BYTES;
    return port;
  } finally {
    clearTimeout(timeout);
  }
}

async function allocatePortFromRange(
  range: { start: number; end: number },
  reservedPorts: ReadonlySet<number>,
): Promise<number> {
  const count = range.end - range.start + 1;
  const startOffset = Math.floor(Math.random() * count);
  for (let offset = 0; offset < count; offset += 1) {
    const port = range.start + ((startOffset + offset) % count);
    if (reservedPorts.has(port)) continue;
    if (await isPortAvailable(port)) return port;
  }
  throw new Error(`No available service port in configured range ${range.start}-${range.end}`);
}

export type AllocateServicePortOptions = {
  allocation: PaseoServicePortAllocation | undefined;
  cwd: string;
  scriptName: string;
  workspaceId: string;
  branchName: string | null;
  reservedPorts?: ReadonlySet<number>;
};

/** Allocate a port for one service. Precedence: explicit port is handled by
 *  the caller (it always wins); here `portScript` wins over `range`, and an
 *  empty allocation falls back to an OS-assigned ephemeral port. */
export async function allocateWorkspaceServicePort(
  options: AllocateServicePortOptions,
): Promise<number> {
  if (options.allocation?.portScript) {
    return allocatePortFromScript({
      cwd: options.cwd,
      command: options.allocation.portScript,
      scriptName: options.scriptName,
      workspaceId: options.workspaceId,
      branchName: options.branchName,
    });
  }
  if (options.allocation?.range) {
    return allocatePortFromRange(parsePortRange(options.allocation.range), options.reservedPorts ?? new Set());
  }
  // Ephemeral default: bind 0 and report the assigned port.
  const port = await new Promise<number>((resolve, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.once("listening", () => {
      const address = server.address();
      const picked = typeof address === "object" && address ? address.port : 0;
      server.close((err) => {
        if (err) reject(err);
        else resolve(picked);
      });
    });
    server.listen(0, "0.0.0.0");
  });
  if (!isValidTcpPort(port)) throw new Error("Could not allocate an ephemeral service port");
  return port;
}

export type ServicePeer = { scriptName: string; port: number };

/** Build the service env for one script. `PASEO_PORT` is self;
 *  `PASEO_SERVICE_<NAME>_PORT` covers every known peer; `_URL` vars use the
 *  direct `http://127.0.0.1:<port>` form (no reverse proxy in v1). `HOST`
 *  is `0.0.0.0` — the Passage daemon is LAN-accessible by design. */
export function buildWorkspaceServiceEnv(options: {
  scriptName: string;
  peers: readonly ServicePeer[];
}): Record<string, string> {
  assertNoServiceEnvNameCollisions(options.peers.map((peer) => peer.scriptName));
  const self = options.peers.find((peer) => peer.scriptName === options.scriptName);
  if (!self) throw new Error(`Service '${options.scriptName}' is missing from workspace service peers`);
  const env: Record<string, string> = {
    HOST: "0.0.0.0",
    PASEO_PORT: String(self.port),
    PASEO_URL: `http://127.0.0.1:${self.port}`,
  };
  for (const peer of options.peers) {
    const envName = normalizeServiceEnvName(peer.scriptName);
    env[`PASEO_SERVICE_${envName}_PORT`] = String(peer.port);
    env[`PASEO_SERVICE_${envName}_URL`] = `http://127.0.0.1:${peer.port}`;
  }
  return env;
}
