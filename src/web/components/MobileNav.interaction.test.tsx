import { describe, expect, mock, test } from "bun:test";
import React, { act } from "react";
import { fireEvent, render } from "@testing-library/react";
import type { AgentSummary } from "../../shared/domain/agents.ts";
import type { TerminalSummary } from "../../shared/domain/terminals.ts";
import type { WorkspaceScriptRuntime } from "../../shared/domain/workspace-actions.ts";
import { setupDomTests } from "../test-utils/dom.ts";

// Client-rendered proof that mobile can close sessions: the desktop close
// affordance lives in the canvas tab strip, which mobile never renders, so
// the session sheet rows and the context bar must carry their own close
// controls.
//
// Radix Dialog portals do not mount under happy-dom, so the dialog module
// is stubbed to render its children inline (the Sidebar test stubs its
// tooltip module the same way). The sheet rows and buttons under test are
// unaffected by the stub.
//
// NOTE: use render-bound queries (getByRole, ...), never the `screen`
// global — screen binds to document at import time, before setupDomTests'
// beforeAll registers happy-dom.
setupDomTests();

mock.module("./ui/dialog.tsx", () => ({
  Dialog: ({ children, open }: { children: React.ReactNode; open?: boolean }) =>
    open ? React.createElement(React.Fragment, null, children) : null,
  DialogContent: ({ children }: { children: React.ReactNode }) =>
    React.createElement("div", null, children),
  DialogTitle: ({ children }: { children: React.ReactNode }) =>
    React.createElement("div", null, children),
}));

const { MobileContextBar, MobileSessionSheet } = await import("./MobileNav.tsx");
const { TooltipProvider } = await import("./ui/tooltip.tsx");

function agent(id: string, title: string): AgentSummary {
  return {
    id,
    workspaceId: "wsp-1",
    title,
    status: "idle",
    modelPreference: null,
    thinkingPreference: null,
    live: true,
    persisted: true,
  };
}

function terminal(id: string, title: string): TerminalSummary {
  return {
    id,
    workspaceId: "wsp-1",
    title,
    cwd: "/tmp/project",
    columns: 80,
    rows: 24,
    status: "running",
    exitCode: null,
    hasSizeLease: false,
    createdAt: new Date().toISOString(),
  };
}

function sheetProps(overrides: Record<string, unknown> = {}) {
  return {
    open: true,
    onClose: () => {},
    agents: [agent("agt-1", "First"), agent("agt-2", "Second")],
    terminals: [terminal("term-1", "shell")],
    previews: [],
    showChanges: true,
    currentKind: "agent",
    selectedAgentId: "agt-1",
    selectedTerminalId: undefined,
    selectedPreviewId: undefined,
    onSelectAgent: () => {},
    onSelectTerminal: () => {},
    onSelectPreview: () => {},
    onOpenFiles: () => {},
    onOpenChanges: () => {},
    onNewAgent: () => {},
    onNewTerminal: () => {},
    ...overrides,
  } as unknown as React.ComponentProps<typeof MobileSessionSheet>;
}

describe("MobileSessionSheet close controls", () => {
  test("each agent and terminal row has a close button that closes only that session", async () => {
    const onCloseAgent = mock((_id: string) => {});
    const onCloseTerminal = mock((_id: string) => {});
    const onSelectAgent = mock(() => {});
    const onClose = mock(() => {});
    const { getByRole } = render(
      React.createElement(MobileSessionSheet, sheetProps({ onCloseAgent, onCloseTerminal, onSelectAgent, onClose })),
    );

    const closeFirst = getByRole("button", { name: "Close agent First" });
    await act(async () => {
      fireEvent.click(closeFirst);
    });

    expect(onCloseAgent).toHaveBeenCalledTimes(1);
    expect(onCloseAgent.mock.calls[0][0]).toBe("agt-1");
    // Closing a row must not navigate to it nor dismiss the sheet (so
    // several sessions can be closed in a row).
    expect(onSelectAgent).not.toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();

    const closeTerminal = getByRole("button", { name: "Close terminal shell" });
    await act(async () => {
      fireEvent.click(closeTerminal);
    });
    expect(onCloseTerminal).toHaveBeenCalledTimes(1);
    expect(onCloseTerminal.mock.calls[0][0]).toBe("term-1");
  });

  test("no close buttons render when no close handlers are provided", () => {
    const { queryByRole } = render(React.createElement(MobileSessionSheet, sheetProps()));
    expect(queryByRole("button", { name: /close agent/i })).toBeNull();
    expect(queryByRole("button", { name: /close terminal/i })).toBeNull();
  });
});

describe("MobileSessionSheet scripts", () => {
  function script(overrides: Partial<WorkspaceScriptRuntime> & { name: string }): WorkspaceScriptRuntime {
    return {
      type: "script",
      lifecycle: "stopped",
      terminalId: null,
      exitCode: null,
      port: null,
      url: null,
      health: null,
      ...overrides,
    };
  }

  test("groups services and tasks with compact single-line status", () => {
    const { getByText, getByRole, queryByText } = render(
      React.createElement(
        MobileSessionSheet,
        sheetProps({
          agents: [],
          terminals: [],
          scripts: [
            script({ name: "dev", type: "service", lifecycle: "running", port: 5123, url: "http://127.0.0.1:5123", health: "healthy", terminalId: "term-1" }),
            script({ name: "typecheck" }),
            script({ name: "test", exitCode: 1 }),
          ],
          onStartScript: () => {},
          onStopScript: () => {},
          onRestartScript: () => {},
          onViewScriptTerminal: () => {},
        }),
      ),
    );

    // No more single flat "Scripts (3)" bucket.
    expect(queryByText(/Scripts \(3\)/)).toBeNull();
    expect(getByText("Services (1)")).not.toBeNull();
    expect(getByText("Tasks (2)")).not.toBeNull();
    // Compact status: port only, never the full loopback URL.
    expect(getByText("running \u00b7 :5123")).not.toBeNull();
    expect(queryByText(/http:\/\/127\.0\.0\.1/)).toBeNull();
    expect(getByText("stopped")).not.toBeNull();
    expect(getByText("exit 1")).not.toBeNull();
    // Actions stay reachable per row.
    expect(getByRole("button", { name: "Run task typecheck, stopped" })).not.toBeNull();
    expect(getByRole("button", { name: "Stop service dev" })).not.toBeNull();
  });

  test("busy script disables its row actions", () => {
    const { getByRole } = render(
      React.createElement(
        MobileSessionSheet,
        sheetProps({
          agents: [],
          terminals: [],
          scripts: [script({ name: "typecheck" })],
          onStartScript: () => {},
          onStopScript: () => {},
          scriptBusyName: "typecheck",
        }),
      ),
    );
    expect(getByRole("button", { name: "Run task typecheck, stopped" }).hasAttribute("disabled")).toBe(true);
  });
});

describe("MobileContextBar close control", () => {
  function barProps(overrides: Record<string, unknown> = {}) {
    return {
      workspaceLabel: "Example",
      destKind: "agent",
      destTitle: "First",
      returnLabel: null,
      onOpenDrawer: () => {},
      onOpenSwitcher: () => {},
      onBack: () => {},
      onNewAgent: () => {},
      onNewTerminal: () => {},
      onNewPreview: () => {},
      onOpenCommands: () => {},
      onOpenSettings: () => {},
      onOpenWorkspaceDetails: () => {},
      ...overrides,
    } as unknown as React.ComponentProps<typeof MobileContextBar>;
  }

  function renderBar(props: React.ComponentProps<typeof MobileContextBar>) {
    return render(React.createElement(TooltipProvider, null, React.createElement(MobileContextBar, props)));
  }

  test("renders a close button that invokes onCloseCurrent", async () => {
    const onCloseCurrent = mock(() => {});
    const { getByRole } = renderBar(barProps({ onCloseCurrent, closeLabel: "Close agent First" }));

    const button = getByRole("button", { name: "Close agent First" });
    await act(async () => {
      fireEvent.click(button);
    });
    expect(onCloseCurrent).toHaveBeenCalledTimes(1);
  });

  test("renders no close button for destinations with nothing to close", () => {
    const { queryByRole } = renderBar(barProps({ destKind: "explorer", destTitle: "Files" }));
    expect(queryByRole("button", { name: /close/i })).toBeNull();
  });
});
