#!/usr/bin/env bun
// FRP tunnel sidecar for the Passage dev service.
//
// Paseo manages this as a separate `service` script (see `tunnel` in
// paseo.json) alongside the `dev` service. It forwards the dev service's
// local port to the configured FRP server so the worktree is reachable
// outside the LAN.
//
// Configuration (same names as solar):
// - FRPC_SERVER_ADDR / FRPC_AUTH_TOKEN (required; otherwise the tunnel
//   stays disabled and this script exits 0 so Paseo reports a clean stop)
// - FRPC_SERVER_PORT (optional FRP control port, defaults to 7000)
// - FRPC_SUBDOMAIN_HOST (optional public hostname suffix)
//
// The tunneled target port resolves from PASEO_SERVICE_DEV_PORT (the dev
// peer service's port, injected by Paseo), then the stable worktree port
// selected by scripts/dev-port.ts for manual runs. The generic PORT variable
// is deliberately ignored so an inherited value from another worktree cannot
// point the tunnel at the wrong dev server.

import { basename } from "node:path";
import { spawn } from "node:child_process";
import {
	buildFrpcArgs,
	buildFrpcEndpoint,
	DEFAULT_FRPC_SERVER_PORT,
	getRepositoryName,
	isFrpcAvailable,
} from "./frpc";
import { stableBasePort, worktreeRoot } from "./dev-port";

export function resolveWorktreeDir(
	env: Record<string, string | undefined>,
	cwd: string,
): string {
	return env.PASEO_WORKTREE_PATH?.trim() || cwd;
}

export function resolveLocalPort(
	env: Record<string, string | undefined>,
	cwd = process.cwd(),
): { port: number } | { error: string } {
	const raw = env.PASEO_SERVICE_DEV_PORT?.trim();
	if (raw !== undefined && raw !== "") {
		const parsed = Number(raw);
		if (Number.isInteger(parsed) && parsed > 0 && parsed < 65536) {
			return { port: parsed };
		}
		return { error: `invalid PASEO_SERVICE_DEV_PORT=${JSON.stringify(raw)}` };
	}
	return { port: stableBasePort(worktreeRoot(resolveWorktreeDir(env, cwd))) };
}

if (import.meta.main) {
	if (!isFrpcAvailable()) {
		console.log("[frpc] Tunnel disabled: frpc is not available on PATH.");
		process.exit(0);
	}

	const serverAddr = process.env.FRPC_SERVER_ADDR;
	const token = process.env.FRPC_AUTH_TOKEN;
	if (!serverAddr && !token) {
		console.log(
			"[frpc] Tunnel disabled: FRPC_SERVER_ADDR and FRPC_AUTH_TOKEN are not set.",
		);
		process.exit(0);
	}
	if (!serverAddr || !token) {
		console.warn(
			"[frpc] Tunnel disabled: set both FRPC_SERVER_ADDR and FRPC_AUTH_TOKEN.",
		);
		process.exit(0);
	}

	const serverPort = Number(
		process.env.FRPC_SERVER_PORT ?? DEFAULT_FRPC_SERVER_PORT,
	);
	if (!Number.isInteger(serverPort) || serverPort < 1 || serverPort > 65535) {
		console.error(
			`[frpc] Tunnel disabled: invalid FRPC_SERVER_PORT "${process.env.FRPC_SERVER_PORT}".`,
		);
		process.exit(0);
	}

	const worktreeDir = resolveWorktreeDir(process.env, process.cwd());
	const resolved = resolveLocalPort(process.env, worktreeDir);
	if ("error" in resolved) {
		console.error(`[frpc] Tunnel disabled: ${resolved.error}.`);
		process.exit(1);
	}

	const repositoryName = getRepositoryName(worktreeDir);
	const worktreeName = basename(worktreeDir);
	const { subdomain, url } = buildFrpcEndpoint(
		repositoryName,
		worktreeName,
		process.env.FRPC_SUBDOMAIN_HOST,
	);
	const args = buildFrpcArgs({
		serverAddr,
		serverPort,
		token,
		proxyName: subdomain,
		localPort: resolved.port,
		subdomain,
	});

	console.log(`[frpc] Starting tunnel for subdomain: ${subdomain}`);
	console.log(
		`[frpc] ${url ? `URL=${url}` : `Subdomain=${subdomain}`} -> 127.0.0.1:${resolved.port}`,
	);

	const child = spawn("frpc", args, {
		cwd: process.cwd(),
		env: { ...process.env },
		stdio: "inherit",
	});

	let stopping = false;
	function stop(signal: NodeJS.Signals) {
		if (stopping) return;
		stopping = true;
		child.kill(signal);
	}

	process.on("SIGINT", () => stop("SIGINT"));
	process.on("SIGTERM", () => stop("SIGTERM"));
	process.on("SIGHUP", () => stop("SIGHUP"));

	child.on("error", (error) => {
		console.error(`[frpc] ${error.message}`);
		process.exitCode = 1;
	});
	child.on("exit", (code, signal) => {
		if (!stopping && code !== 0) {
			console.error(
				`[frpc] Tunnel exited with ${signal ? `signal ${signal}` : `code ${code}`}.`,
			);
		}
		process.exitCode = code ?? 1;
	});
}
