export type ToolIconKind =
  | "read" | "edit" | "write" | "command" | "search" | "other"
  | "web" | "download" | "agent" | "filecode" | "codesearch" | "package"
  | "activity" | "list" | "pr" | "trigger" | "recall" | "system";

export type ToolSummary = {
  icon: ToolIconKind;
  title: string;
  subtitle: string;
  isPath?: boolean;
};
