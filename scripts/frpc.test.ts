import { describe, expect, it } from "bun:test";
import {
	buildFrpcArgs,
	buildFrpcEndpoint,
	buildFrpcSubdomain,
	buildFrpcUrl,
	repositoryNameFromRemote,
	sanitizeDnsLabel,
} from "./frpc";
import { resolveLocalPort, resolveWorktreeDir } from "./run-frpc";

describe("frpc helpers", () => {
	it("extracts repository names from common git remote formats", () => {
		expect(
			repositoryNameFromRemote("https://github.com/mcowger/passage.git"),
		).toBe("passage");
		expect(repositoryNameFromRemote("git@github.com:mcowger/passage.git")).toBe(
			"passage",
		);
	});

	it("creates a DNS-safe deterministic subdomain", () => {
		const subdomain = buildFrpcSubdomain("Passage", "feature/auth login");
		expect(subdomain).toBe("passage-feature-auth-login");
		expect(buildFrpcSubdomain("Passage", "feature/auth login")).toBe(subdomain);
	});

	it("keeps long subdomains within the DNS label limit", () => {
		const subdomain = buildFrpcSubdomain("passage", "a".repeat(100));
		expect(subdomain.length).toBeLessThanOrEqual(63);
		expect(subdomain).toMatch(/-[a-f0-9]{8}$/);
	});

	it("uses a fallback for labels with no DNS-safe characters", () => {
		expect(sanitizeDnsLabel("---", "fallback")).toBe("fallback");
	});

	it("builds a full URL only when the optional host is configured", () => {
		expect(buildFrpcUrl("passage-worktree", "dev.home.cowger.us")).toBe(
			"https://passage-worktree.dev.home.cowger.us",
		);
		expect(buildFrpcUrl("passage-worktree")).toBeUndefined();
	});

	it("builds the CLI proxy arguments", () => {
		expect(
			buildFrpcArgs({
				serverAddr: "192.168.0.2",
				serverPort: 7000,
				token: "secret",
				proxyName: "passage-worktree",
				localPort: 3456,
				subdomain: "passage-worktree",
			}),
		).toEqual([
			"http",
			"--server-addr",
			"192.168.0.2",
			"--server-port",
			"7000",
			"--token",
			"secret",
			"--proxy-name",
			"passage-worktree",
			"--local-ip",
			"127.0.0.1",
			"--local-port",
			"3456",
			"--sd",
			"passage-worktree",
		]);
	});

	it("builds the endpoint used by the dev lifecycle", () => {
		expect(
			buildFrpcEndpoint("Passage", "purple-turtle", "dev.home.cowger.us"),
		).toEqual({
			subdomain: "passage-purple-turtle",
			url: "https://passage-purple-turtle.dev.home.cowger.us",
		});
	});
});

describe("run-frpc port resolution", () => {
	it("prefers the Paseo dev peer port over PORT", () => {
		expect(
			resolveLocalPort({ PASEO_SERVICE_DEV_PORT: "3456", PORT: "3333" }),
		).toEqual({ port: 3456 });
		expect(resolveLocalPort({ PORT: "3333" })).toEqual({ port: 3333 });
	});

	it("rejects invalid ports and reports a missing target", () => {
		expect(resolveLocalPort({ PASEO_SERVICE_DEV_PORT: "nope" })).toEqual({
			error: 'invalid PASEO_SERVICE_DEV_PORT="nope"',
		});
		expect(resolveLocalPort({})).toEqual({
			error:
				"no local port: start the dev service first (PASEO_SERVICE_DEV_PORT) or set PORT",
		});
	});

	it("prefers PASEO_WORKTREE_PATH over cwd for naming", () => {
		expect(
			resolveWorktreeDir({ PASEO_WORKTREE_PATH: "/wt/b" }, "/wt/a"),
		).toBe("/wt/b");
		expect(resolveWorktreeDir({}, "/wt/a")).toBe("/wt/a");
	});
});
