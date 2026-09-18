#!/usr/bin/env bun
/** Vendor the static llama-server build for embedding into the binary.
 *  Source: ../llama.cpp/build/bin/llama-server (or $LLAMA_BIN_DIR override).
 *  Dest: src/daemon/llm/vendor/llama-server.bin (gitignored, colocated so the
 *  `with { type: "file" }` import needs no parent traversal). Skips when
 *  when the source is missing so `bun run deploy` never ships a stale binary. */
import { copyFile, mkdir, stat } from "node:fs/promises";
import { dirname, join } from "node:path";

const repoRoot = join(import.meta.dir, "..");
const srcDir = process.env.LLAMA_BIN_DIR?.trim() || join(repoRoot, "..", "llama.cpp", "build", "bin");
const src = join(srcDir, "llama-server");
const dest = join(repoRoot, "src", "daemon", "llm", "vendor", "llama-server.bin");

const srcStat = await stat(src).catch(() => undefined);
if (!srcStat) {
  console.error(`vendor: llama-server not found at ${src} (set LLAMA_BIN_DIR to override)`);
  process.exit(1);
}
const destStat = await stat(dest).catch(() => undefined);
if (destStat && destStat.size === srcStat.size && destStat.mtimeMs >= srcStat.mtimeMs) {
  console.log(`vendor: llama-server fresh (${srcStat.size} bytes)`);
  process.exit(0);
}
await mkdir(dirname(dest), { recursive: true });
await copyFile(src, dest);
console.log(`vendor: llama-server ${srcStat.size} bytes -> ${dest}`);
