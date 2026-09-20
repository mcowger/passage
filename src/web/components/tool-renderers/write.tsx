import type { ToolSummary } from "./types.ts";
import { fileToolSummary } from "./shared.tsx";

export function summary(input: Record<string, unknown>, workspaceRoot?: string): ToolSummary {
  return fileToolSummary("write", "Write", input, workspaceRoot);
}
