const testProcess = Bun.spawn([
  process.execPath,
  "test",
  "src/spikes/pty-websocket",
], {
  cwd: import.meta.dir + "/../../..",
  env: { ...process.env, PASSAGE_PTY_LIVE: "1" },
  stdin: "inherit",
  stdout: "inherit",
  stderr: "inherit",
});

process.exit(await testProcess.exited);
