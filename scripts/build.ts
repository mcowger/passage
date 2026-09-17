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

const result = isCompile
  ? await Bun.build({
      entrypoints: ["./src/daemon/index.ts"],
      compile: {
        outfile: values.outfile,
        ...(values.target ? { target: values.target as Bun.Build.Target } : {}),
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
