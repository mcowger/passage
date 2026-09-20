import {
  FileText,
  Pencil,
  FilePlus,
  Terminal as TerminalIcon,
  Search,
  Settings,
  Globe,
  Download,
  Bot,
  FileCode,
  ScanSearch,
  Package,
  Activity,
  List,
  GitPullRequest,
  Play,
  Brain,
  Cpu,
} from "lucide-react";
import type { ToolIconKind } from "./types.ts";

export function ToolIcon({ kind }: { kind: ToolIconKind }) {
  const props = { size: 13, strokeWidth: 1.8, "aria-hidden": true };
  switch (kind) {
    case "read": return <FileText {...props} />;
    case "edit": return <Pencil {...props} />;
    case "write": return <FilePlus {...props} />;
    case "command": return <TerminalIcon {...props} />;
    case "search": return <Search {...props} />;
    case "web": return <Globe {...props} />;
    case "download": return <Download {...props} />;
    case "agent": return <Bot {...props} />;
    case "filecode": return <FileCode {...props} />;
    case "codesearch": return <ScanSearch {...props} />;
    case "package": return <Package {...props} />;
    case "activity": return <Activity {...props} />;
    case "list": return <List {...props} />;
    case "pr": return <GitPullRequest {...props} />;
    case "trigger": return <Play {...props} />;
    case "recall": return <Brain {...props} />;
    case "system": return <Cpu {...props} />;
    default: return <Settings {...props} />;
  }
}
