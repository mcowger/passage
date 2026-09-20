#!/usr/bin/env bun
/** Dev server launcher: scrub inherited production env, set explicit
 *  worktree-local data paths, resolve this checkout's dedicated port, and
 *  spawn the watched daemon.
 *
 *  Never run `src/daemon/index.ts` directly from a shell that may descend
 *  from staging: inherited `PASSAGE_DB_PATH` would point the worktree
 *  daemon at production sqlite. This wrapper (via `scripts/dev-env.ts`)
 *  is the only supported `bun run dev` path, including the `dev` service
 *  in paseo.json.
 */

import { join } from "node:path";
import { worktreeRoot } from "./dev-port.ts";
import { buildDevEnv } from "./dev-env.ts";

if (import.meta.main) {
  const root = worktreeRoot();
  const env = buildDevEnv(process.env, root);

  // This worktree's dedicated port, resolved the same way `bun run dev`
  // always has (recorded port -> live pid's listener -> stable hash or
  // the runner's PASEO_PORT). A foreign listener is a CRITICAL stop-and-ask,
  // never a reason to bump.
  const portProc = Bun.spawn([process.execPath, join(root, "scripts", "dev-port.ts")], {
    cwd: root,
    env,
    stdout: "pipe",
    stderr: "inherit",
  });
  const [portOutput, portCode] = await Promise.all([
    new Response(portProc.stdout).text(),
    portProc.exited,
  ]);
  const port = portOutput.trim().split(/\s+/)[0] ?? "";
  if (portCode !== 0 || !/^\d+$/.test(port)) {
    console.error(`dev: refusing to start without this worktree's dedicated port (worktree: ${root})`);
    process.exit(portCode !== 0 ? portCode : 1);
  }

  console.error(`dev: worktree ${root} on port ${port} (data: ${join(root, ".data")})`);
  const daemon = Bun.spawn(
    [process.execPath, "--watch", "run", join(root, "src", "daemon", "index.ts"), "--port", port],
    { cwd: root, env, stdin: "inherit", stdout: "inherit", stderr: "inherit" },
  );
  process.exit(await daemon.exited);
}
