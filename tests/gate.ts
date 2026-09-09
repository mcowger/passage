const commands: string[][] = [
  ["install", "--frozen-lockfile"],
  ["run", "typecheck"],
  ["test"],
  ["run", "test:pty-live"],
  ["run", "test:pi-live"],
  ["run", "smoke:development"],
  ["run", "build"],
  ["run", "smoke:production"],
  ["run", "package"],
  ["run", "smoke:package"],
];

for (const args of commands) {
  const command = Bun.spawn([process.execPath, ...args], {
    cwd: import.meta.dir + "/..",
    env: process.env,
    stdin: "inherit",
    stdout: "inherit",
    stderr: "inherit",
  });
  const exitCode = await command.exited;
  if (exitCode !== 0) process.exit(exitCode);
}
