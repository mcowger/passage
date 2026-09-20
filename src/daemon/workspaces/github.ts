import { errorFields, logger } from "../logging.ts";
import { sanitizedSubprocessEnv } from "../env.ts";

const DEFAULT_TIMEOUT = 30_000;
const NETWORK_TIMEOUT = 60_000;
const MAX_CONCURRENCY = 2;
const MAX_OUTPUT = 256 * 1024;
const encoder = new TextEncoder();

type Options = { signal?: AbortSignal; timeoutMs?: number; maxOutputBytes?: number; allowExitCodes?: number[] };
type Result = { stdout: string; stderr: string; code: number; truncated: boolean };

export class GhError extends Error {
  constructor(message: string, public readonly stderr = "", public readonly code = -1) {
    super(message);
    this.name = "GhError";
  }
}

/** First meaningful line from a failed `gh` invocation, for curated errors. */
const ghDetail = (cause: unknown): string => {
  const text = cause instanceof GhError ? cause.stderr || cause.message : "";
  return (text.split("\n")[0] ?? "").trim().replace(/^(failed|error):\s*/i, "").replace(/\.$/, "");
};

export type GhPr = {
  number: number;
  url: string;
  title: string;
  state: string;
  base: string;
  head: string;
  isDraft: boolean;
};

export type GhRepo = { nameWithOwner: string; defaultBranch: string };

/** Parse one `gh pr view --json ...` record into a GhPr. Returns null when
 *  the shape is unusable (so callers fall back instead of throwing). */
export function parsePrJson(raw: unknown): GhPr | null {
  if (typeof raw !== "object" || raw === null) return null;
  const r = raw as Record<string, unknown>;
  if (typeof r.number !== "number" || typeof r.url !== "string") return null;
  return {
    number: r.number,
    url: r.url,
    title: typeof r.title === "string" ? r.title : "",
    state: typeof r.state === "string" ? r.state : "",
    base: typeof r.baseRefName === "string" ? r.baseRefName : "",
    head: typeof r.headRefName === "string" ? r.headRefName : "",
    isDraft: r.isDraft === true,
  };
}

/** Parse one `gh repo view --json nameWithOwner,defaultBranchRef` record. */
export function parseRepoJson(raw: unknown): GhRepo | null {
  if (typeof raw !== "object" || raw === null) return null;
  const r = raw as Record<string, unknown>;
  if (typeof r.nameWithOwner !== "string") return null;
  const ref = r.defaultBranchRef;
  const defaultBranch =
    typeof ref === "object" && ref !== null && typeof (ref as Record<string, unknown>).name === "string"
      ? String((ref as Record<string, unknown>).name)
      : "main";
  return { nameWithOwner: r.nameWithOwner, defaultBranch };
}

/**
 * GitHub access through the `gh` CLI (assumed installed and configured).
 * Fixed argv only, no shell strings — same rule as GitService. Every method
 * that needs the network uses a 60s timeout; local auth checks use 30s.
 * A missing/unusable `gh` never throws from `available()`/`prForBranch()`:
 * those resolve to false/null so the UI can disable PR commands.
 */
export class GhService {
  private active = 0;
  private waiting: (() => void)[] = [];
  constructor(
    private readonly limit = MAX_CONCURRENCY,
    private readonly executable = process.env.PASSAGE_GH_BIN?.trim() || "gh",
  ) {
    if (limit < 1) throw new RangeError("invalid concurrency");
  }

  private async slot() {
    if (this.active >= this.limit) await new Promise<void>((r) => this.waiting.push(r));
    this.active++;
    return () => {
      this.active--;
      this.waiting.shift()?.();
    };
  }

  private async run(cwd: string, args: string[], options: Options = {}): Promise<Result> {
    const startedAt = performance.now();
    const operation = args[0] ?? "unknown";
    const release = await this.slot();
    const max = options.maxOutputBytes ?? MAX_OUTPUT;
    const timeout = options.timeoutMs ?? DEFAULT_TIMEOUT;
    let p: Bun.Subprocess;
    try {
      p = Bun.spawn([this.executable, ...args], {
        cwd,
        env: sanitizedSubprocessEnv({ LC_ALL: "C", CLICOLOR: "0", GH_PAGER: "" }),
        stdout: "pipe",
        stderr: "pipe",
      });
    } catch (error) {
      release();
      logger("gh").error("gh process could not start", {
        event: "gh.start_failed",
        operation,
        durationMs: performance.now() - startedAt,
        ...errorFields(error),
      });
      throw new GhError("The `gh` CLI is not installed or cannot start", String(error));
    }
    let stopped = false;
    const kill = () => {
      if (p.exitCode === null) {
        stopped = true;
        p.kill();
      }
    };
    const timer = setTimeout(kill, timeout);
    const abort = () => kill();
    options.signal?.addEventListener("abort", abort, { once: true });
    const read = async (stream: ReadableStream<Uint8Array>) => {
      const reader = stream.getReader();
      const chunks: Uint8Array[] = [];
      let size = 0;
      let truncated = false;
      try {
        while (true) {
          const x = await reader.read();
          if (x.done) break;
          if (size < max) {
            const part = x.value.slice(0, max - size);
            chunks.push(part);
            size += part.length;
            if (part.length < x.value.length) truncated = true;
          } else truncated = true;
        }
      } finally {
        reader.releaseLock();
      }
      return { text: new TextDecoder().decode(Buffer.concat(chunks)), truncated };
    };
    try {
      const [out, err, code] = await Promise.all([
        read(p.stdout as ReadableStream<Uint8Array>),
        read(p.stderr as ReadableStream<Uint8Array>),
        p.exited,
      ]);
      const durationMs = performance.now() - startedAt;
      if (stopped || options.signal?.aborted) {
        logger("gh").warn("gh operation did not complete", {
          event: options.signal?.aborted ? "gh.cancelled" : "gh.timed_out",
          operation,
          durationMs,
        });
        throw new GhError(options.signal?.aborted ? "gh operation cancelled" : "gh operation timed out");
      }
      if (code !== 0 && !options.allowExitCodes?.includes(code)) {
        logger("gh").warn("gh operation failed", {
          event: "gh.failed",
          operation,
          durationMs,
          exitCode: code,
          stderrBytes: encoder.encode(err.text).byteLength,
          truncated: out.truncated || err.truncated,
        });
        throw new GhError("gh command failed", err.text, code);
      }
      logger("gh").debug("gh operation completed", {
        event: "gh.completed",
        operation,
        durationMs,
        exitCode: code,
        truncated: out.truncated || err.truncated,
      });
      return { stdout: out.text, stderr: err.text, code, truncated: out.truncated || err.truncated };
    } finally {
      clearTimeout(timer);
      options.signal?.removeEventListener("abort", abort);
      if (p.exitCode === null) p.kill();
      await p.exited.catch(() => {});
      release();
    }
  }

  /** True when the `gh` binary exists (regardless of auth). */
  async installed(cwd: string, options?: Options): Promise<boolean> {
    try {
      await this.run(cwd, ["--version"], options);
      return true;
    } catch {
      return false;
    }
  }

  /** True when `gh` is authenticated and can reach an account. */
  async available(cwd: string, options?: Options): Promise<boolean> {
    try {
      await this.run(cwd, ["auth", "status"], options);
      return true;
    } catch {
      return false;
    }
  }

  /** Repository identity for the checkout's remote. Null when the checkout
   *  has no GitHub remote or the lookup fails. */
  async repoInfo(cwd: string, options?: Options): Promise<GhRepo | null> {
    try {
      const out = await this.run(cwd, ["repo", "view", "--json", "nameWithOwner,defaultBranchRef"], {
        timeoutMs: NETWORK_TIMEOUT,
        ...options,
      });
      return parseRepoJson(JSON.parse(out.stdout));
    } catch {
      return null;
    }
  }

  /** Open PR for the checkout's branch (or the given branch). Null when
   *  there is none. Throws GhError on auth/network failures so callers can
   *  distinguish "no PR" from "cannot reach GitHub". */
  async prForBranch(cwd: string, branch?: string, options?: Options): Promise<GhPr | null> {
    const target = branch?.trim();
    const args = target
      ? ["pr", "view", target, "--json", "number,url,title,state,baseRefName,headRefName,isDraft"]
      : ["pr", "view", "--json", "number,url,title,state,baseRefName,headRefName,isDraft"];
    try {
      const out = await this.run(cwd, args, { timeoutMs: NETWORK_TIMEOUT, ...options });
      return parsePrJson(JSON.parse(out.stdout));
    } catch (cause) {
      const stderr = cause instanceof GhError ? cause.stderr : "";
      // Canonical "no PR" signals: resolve to null instead of failing.
      if (/no pull requests found|no pull request found|not found|could not resolve to a pull request/i.test(stderr)) {
        return null;
      }
      throw cause instanceof GhError ? cause : new GhError("Could not check for a pull request", String(cause));
    }
  }

  /** Create a PR for the checkout's branch. Returns the created record
   *  (re-read via `pr view` so the caller gets number/url/state). */
  async createPr(
    cwd: string,
    input: { title: string; body: string; base?: string; draft?: boolean },
    options?: Options,
  ): Promise<GhPr> {
    const title = input.title.trim();
    if (!title) throw new GhError("PR title is empty");
    const base = input.base?.trim();
    const args = ["pr", "create", "--title", title, "--body", input.body];
    if (base) args.push("--base", base);
    if (input.draft) args.push("--draft");
    try {
      await this.run(cwd, args, { timeoutMs: NETWORK_TIMEOUT, ...options });
    } catch (cause) {
      const detail = ghDetail(cause);
      if (/already exists|already a pull request|a pull request already exists/i.test(cause instanceof GhError ? cause.stderr : "")) {
        const existing = await this.prForBranch(cwd, undefined, options).catch(() => null);
        if (existing) return existing;
      }
      throw new GhError(`Could not create the pull request${detail ? `: ${detail}` : ""}`);
    }
    const created = await this.prForBranch(cwd, undefined, options).catch(() => null);
    if (!created) throw new GhError("The pull request was created but could not be read back");
    return created;
  }
}
