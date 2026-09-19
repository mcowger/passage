import type { FormEvent, ReactNode } from "react";
import type { LayoutNode } from "../../shared/domain/layout.ts";
import type { FontMapping, FontOption, ThemePack } from "../../shared/domain/customization.ts";
import { resolveFontFamilies } from "../../shared/domain/customization.ts";
import { Button } from "../components/ui/button.tsx";
import { Alert, AlertDescription } from "../components/ui/alert.tsx";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "../components/ui/dialog.tsx";

export function applyThemeTokens(theme?: ThemePack) {
  if (!theme || typeof document === "undefined") return;
  const root = document.documentElement;
  root.dataset.themeMode = theme.mode;
  if (theme.mode === "dark") {
    root.classList.add("dark");
  } else {
    root.classList.remove("dark");
  }
  for (const [key, value] of Object.entries(theme.tokens)) {
    if (value) {
      const cssVar = `--${key.replace(/([A-Z])/g, "-$1").toLowerCase()}`;
      root.style.setProperty(cssVar, value);
    }
  }
}

export function applyFontTokens(mapping: FontMapping | undefined, options: FontOption[]) {
  if (typeof document === "undefined") return;
  const families = resolveFontFamilies(options, mapping);
  const root = document.documentElement;
  root.style.setProperty("--font-ui", families.ui);
  root.style.setProperty("--font-mono", families.mono);
  root.style.setProperty("--font-editor", families.editor);
  root.style.setProperty("--font-xterm", families.xterm);
}

export type FormKind = "project" | "worktree";
export type TabKind = "overview" | "agent" | "terminal" | "explorer" | "changes" | "editor" | "diff" | "preview";

export type FormDialogProps = {
  title: string;
  submitLabel: string;
  error?: string;
  onCancel: () => void;
  onSubmit: (event: FormEvent<HTMLFormElement>) => void;
  onEscapeKeyDown?: (event: KeyboardEvent) => void;
  children: ReactNode;
};

export function FormDialog({ title, submitLabel, error, onCancel, onSubmit, onEscapeKeyDown, children }: FormDialogProps) {
  return (
    <Dialog open onOpenChange={(isOpen) => { if (!isOpen) onCancel(); }}>
      <DialogContent className="max-w-[480px]" onEscapeKeyDown={onEscapeKeyDown}>
        <form onSubmit={onSubmit} aria-label={title} className="flex flex-col gap-4">
          <DialogHeader>
            <p className="text-xs uppercase tracking-wider text-muted-foreground font-semibold">Workspace setup</p>
            <DialogTitle className="text-lg font-semibold">{title}</DialogTitle>
          </DialogHeader>
          {error && <Alert variant="destructive"><AlertDescription className="text-sm font-medium">{error}</AlertDescription></Alert>}
          {children}
          <div className="flex justify-end gap-2 pt-2">
            <Button type="button" variant="secondary" onClick={onCancel}>Cancel</Button>
            <Button type="submit">{submitLabel}</Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}

export function stripGitTabsFromLayout(node: LayoutNode): LayoutNode | null {
  if (node.type === "tabs") {
    const tabs = node.tabs.filter((tab) => tab.kind !== "changes" && tab.kind !== "diff");
    if (tabs.length === 0) return null;
    const activeTabId = tabs.some((tab) => tab.id === node.activeTabId) ? node.activeTabId : tabs[0].id;
    return { ...node, tabs, activeTabId };
  }
  const children: LayoutNode[] = [];
  const sizes: number[] = [];
  for (let i = 0; i < node.children.length; i++) {
    const next = stripGitTabsFromLayout(node.children[i]);
    if (next) {
      children.push(next);
      sizes.push(node.sizes[i] ?? 1 / node.children.length);
    }
  }
  if (children.length === 0) return null;
  if (children.length === 1) return children[0];
  const total = sizes.reduce((sum, size) => sum + size, 0);
  return { ...node, children, sizes: sizes.map((size) => size / total) };
}

export function layoutContainsGitTabs(node: LayoutNode): boolean {
  if (node.type === "tabs") return node.tabs.some((tab) => tab.kind === "changes" || tab.kind === "diff");
  return node.children.some(layoutContainsGitTabs);
}

export function NonGitPane({ title }: { title: string }) {
  return (
    <div className="empty flex flex-col items-center justify-center p-8 text-center max-w-md mx-auto">
      <span className="empty-icon text-3xl mb-2" aria-hidden="true">±</span>
      <h1 className="text-lg font-semibold text-foreground mb-1">{title} unavailable</h1>
      <p className="text-xs text-muted-foreground">This workspace is not inside a Git repository.</p>
    </div>
  );
}

export const LAST_WORKSPACE_KEY = "passage.lastWorkspaceId";

export function readLastWorkspaceId(): string | undefined {
  try {
    return localStorage.getItem(LAST_WORKSPACE_KEY) ?? undefined;
  } catch {
    return undefined;
  }
}

export function setupToastId(runId: string): string {
  return `workspace-setup-${runId}`;
}

export const MOBILE_BREAKPOINT_PX = 768;

export function computeIsMobile(): boolean {
  if (typeof window === "undefined") return false;
  if (window.innerWidth < MOBILE_BREAKPOINT_PX) return true;
  // Narrow-viewport cold-start misreport (PWA deep link): a touch device
  // reporting a wide viewport is far more likely a phone whose viewport
  // hasn't settled than a touch desktop. Assume mobile until proven wide.
  try {
    return window.matchMedia?.("(pointer: coarse)").matches ?? false;
  } catch {
    return false;
  }
}
