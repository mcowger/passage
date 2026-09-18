/** Static llama-server binary embedded via `with { type: "file" }`.
 *  Copied into place at build time by scripts/vendor-llama-server.ts;
 *  gitignored, so this declaration keeps typecheck green on fresh clones. */
declare module "*/vendor/llama-server.bin" {
  const path: string;
  export default path;
}
