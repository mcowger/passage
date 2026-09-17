import tailwind from "bun-plugin-tailwind";

const isCompile = process.argv.includes("--compile");

const result = isCompile
  ? await Bun.build({
      entrypoints: ["./src/daemon/index.ts"],
      compile: {
        outfile: "./dist/passage",
      },
      target: "bun",
      minify: true,
      plugins: [tailwind],
    })
  : await Bun.build({
      entrypoints: ["./src/daemon/index.ts"],
      outdir: "./dist",
      target: "bun",
      minify: true,
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
