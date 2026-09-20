import { readFileSync } from "node:fs";
import { join } from "node:path";
import { normalizeLifecycleCommands } from "./actions.ts";

export const PASEO_CONFIG_FILE_NAME = "paseo.json";
const MAX_COMMANDS = 50;
const MAX_SCRIPTS = 50;

const TCP_PORT_RANGE_PATTERN = /^(\d{1,5})-(\d{1,5})$/;

export type PaseoServicePortAllocation = {
  range?: string;
  portScript?: string;
};

export type PaseoScriptEntry = {
  name: string;
  type: "script" | "service";
  command: string;
  /** Explicit port override; null when auto-assigned. */
  port: number | null;
};

export type PaseoConfig = {
  setup: string[];
  teardown: string[];
  scripts: PaseoScriptEntry[];
  servicePorts: PaseoServicePortAllocation | undefined;
};

function isValidTcpPort(port: number): boolean {
  return Number.isInteger(port) && port >= 1 && port <= 65535;
}

function parseServicePorts(value: unknown): PaseoServicePortAllocation | undefined {
  if (!value || typeof value !== "object") return undefined;
  const record = value as Record<string, unknown>;
  let range: string | undefined;
  let portScript: string | undefined;
  if (typeof record.range === "string" && record.range.trim().length > 0) {
    const trimmed = record.range.trim();
    const match = TCP_PORT_RANGE_PATTERN.exec(trimmed);
    if (match) {
      const start = Number(match[1]);
      const end = Number(match[2]);
      if (start >= 1 && end <= 65535 && start <= end) range = trimmed;
    }
  }
  if (typeof record.portScript === "string" && record.portScript.trim().length > 0) {
    portScript = record.portScript.trim();
  }
  if (range === undefined && portScript === undefined) return undefined;
  return { ...(range !== undefined ? { range } : {}), ...(portScript !== undefined ? { portScript } : {}) };
}

function parseScripts(value: unknown): PaseoScriptEntry[] {
  if (!value || typeof value !== "object") return [];
  const entries: PaseoScriptEntry[] = [];
  for (const [name, raw] of Object.entries(value as Record<string, unknown>)) {
    if (entries.length >= MAX_SCRIPTS) break;
    if (!name || name.length > 128) continue;
    if (!raw || typeof raw !== "object") continue;
    const record = raw as Record<string, unknown>;
    if (typeof record.command !== "string" || record.command.trim().length === 0) continue;
    const type = record.type === "service" ? "service" : "script";
    let port: number | null = null;
    if (typeof record.port === "number" && isValidTcpPort(record.port)) port = record.port;
    entries.push({ name, type, command: record.command, port });
  }
  return entries;
}

/** Read the full runnable subset of `paseo.json` in a workspace directory:
 *  `worktree.setup`, `worktree.teardown`, `scripts`, and
 *  `worktree.servicePorts`. `worktree.terminals` is deliberately ignored
 *  (auto-open terminals are out of scope for v1). Missing files, invalid
 *  JSON, and unexpected shapes yield empty defaults — never a throw. */
export function readPaseoConfig(cwd: string): PaseoConfig {
  const empty: PaseoConfig = { setup: [], teardown: [], scripts: [], servicePorts: undefined };
  let json: unknown;
  try {
    json = JSON.parse(readFileSync(join(cwd, PASEO_CONFIG_FILE_NAME), "utf8"));
  } catch {
    return empty;
  }
  if (!json || typeof json !== "object") return empty;
  const root = json as Record<string, unknown>;
  const worktree =
    root.worktree && typeof root.worktree === "object"
      ? (root.worktree as Record<string, unknown>)
      : {};
  return {
    setup: normalizeLifecycleCommands(worktree.setup).slice(0, MAX_COMMANDS),
    teardown: normalizeLifecycleCommands(worktree.teardown).slice(0, MAX_COMMANDS),
    scripts: parseScripts(root.scripts),
    servicePorts: parseServicePorts(worktree.servicePorts),
  };
}
