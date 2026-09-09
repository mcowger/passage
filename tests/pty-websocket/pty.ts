const DEFAULT_COLUMNS = 80;
const DEFAULT_ROWS = 24;

type NativePtyOptions = {
  cwd: string;
  file?: string;
  args?: string[];
  onData?: (data: Uint8Array) => void;
};

export function platformShell(): { file: string; args: string[] } {
  if (process.platform === "win32") throw new Error("Bun's native terminal API is not available on Windows");
  return { file: process.env.SHELL || "/bin/sh", args: [] };
}

export function spawnPty(options: NativePtyOptions) {
  const shell = platformShell();
  let columns = DEFAULT_COLUMNS;
  let rows = DEFAULT_ROWS;
  const terminal = new Bun.Terminal({
    name: "xterm-256color",
    cols: columns,
    rows,
    data(_terminal, data) {
      options.onData?.(data);
    },
  });
  const process = Bun.spawn([options.file ?? shell.file, ...(options.args ?? shell.args)], {
    cwd: options.cwd,
    env: { ...globalThis.process.env, TERM: "xterm-256color" },
    terminal,
  });

  return {
    process,
    terminal,
    get columns() { return columns; },
    get rows() { return rows; },
    resize(nextColumns: number, nextRows: number) {
      terminal.resize(nextColumns, nextRows);
      columns = nextColumns;
      rows = nextRows;
    },
    write(data: string | Bun.BufferSource) {
      return terminal.write(data);
    },
    kill() {
      if (process.exitCode === null) process.kill();
    },
    close() {
      if (!terminal.closed) terminal.close();
    },
  };
}

export const ptyDefaults = { columns: DEFAULT_COLUMNS, rows: DEFAULT_ROWS };
