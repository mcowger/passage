import tailwind from "bun-plugin-tailwind";

await Bun.build({
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
