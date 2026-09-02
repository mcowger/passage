import { readFile } from "node:fs/promises";
import { LfJsonlParser } from "../../shared/jsonl/parser.ts";

export async function readPiJsonl(path: string, maxBytes = 4 * 1024 * 1024): Promise<unknown[]> {
  const file = await readFile(path);
  if (file.byteLength > maxBytes) throw new Error("Pi JSONL exceeds byte limit");
  const records: unknown[] = [];
  const parser = new LfJsonlParser((record) => records.push(record));
  parser.push(file);
  parser.finish();
  return records;
}
