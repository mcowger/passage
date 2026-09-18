import tailwind from "bun-plugin-tailwind";
import { parseArgs } from "node:util";

const { values } = parseArgs({
  args: Bun.argv.slice(2),
  options: {
    compile: { type: "boolean", default: false },
    target: { type: "string" },
    outfile: { type: "string", default: "./dist/passage" },
  },
  strict: true,
});

const isCompile = values.compile;

/** Resolve build identity baked into the binary (commit hash + timestamp).
 *  Env overrides (PASSAGE_BUILD_COMMIT / PASSAGE_BUILD_TIME /
 *  PASSAGE_BUILD_DIRTY) win for CI; otherwise read live git state. */
function gitText(args: string[]): string | undefined {
  try {
    const result = Bun.spawnSync(["git", ...args], { stdout: "pipe", stderr: "ignore" });
    if (result.exitCode !== 0) return undefined;
    const text = new TextDecoder().decode(result.stdout).trim();
    return text === "" ? undefined : text;
  } catch {
    return undefined;
  }
}

const buildCommit = process.env.PASSAGE_BUILD_COMMIT ?? gitText(["rev-parse", "HEAD"]) ?? "unknown";
const buildDirty = process.env.PASSAGE_BUILD_DIRTY ?? ((gitText(["status", "--porcelain"]) ?? "") !== "" ? "true" : "false");
const buildTime = process.env.PASSAGE_BUILD_TIME ?? new Date().toISOString();
const define = {
  PASSAGE_BUILD_COMMIT: JSON.stringify(buildCommit),
  PASSAGE_BUILD_DIRTY: JSON.stringify(buildDirty),
  PASSAGE_BUILD_TIME: JSON.stringify(buildTime),
};
console.log(`build: commit=${buildCommit.slice(0, 12)}${buildDirty === "true" ? " (dirty)" : ""} builtAt=${buildTime}`);

// Vendor the static llama-server before bundling so the embed below always
// resolves. Skips when fresh; fails the build when the source is missing.
const vendor = Bun.spawnSync([process.execPath, "scripts/vendor-llama-server.ts"], {
  stdout: "inherit",
  stderr: "inherit",
});
if (vendor.exitCode !== 0) {
  console.error("build: vendoring llama-server failed");
  process.exit(vendor.exitCode ?? 1);
}

const result = isCompile
  ? await Bun.build({
      entrypoints: ["./src/daemon/index.ts"],
      compile: {
        outfile: values.outfile,
        ...(values.target ? { target: values.target as Bun.Build.Target } : {}),
      },
      target: "bun",
      minify: true,
      define,
      plugins: [tailwind],
    })
  : await Bun.build({
      entrypoints: ["./src/daemon/index.ts"],
      outdir: "./dist",
      target: "bun",
      minify: true,
      define,
      naming: {
        entry: "[name].[ext]",
        chunk: "[name]-[hash].[ext]",
        asset: "[name]-[hash].[ext]",
      },
      plugins: [tailwind],
    });

if (!result.success) {
  for (const log of result.logs) console.error(log);
  process.exit(1);
}
