import { describe, expect, test } from "bun:test";
import React from "react";
import ReactDOMServer from "react-dom/server";
import type { PaneTab } from "../../shared/domain/layout.ts";
import type { TerminalSummary } from "../../shared/domain/terminals.ts";
import type { Workspace } from "../../shared/domain/workspaces.ts";
import type { WorkspaceApi } from "../api.ts";
import { TerminalTabPane } from "./TerminalTabPane.tsx";

const mockWorkspace: Workspace = {
  id: "wsp-1",
  projectId: "prj-1",
  kind: "directory",
  cwd: "/tmp/project",
  checkoutRoot: null,
  mainRepositoryRoot: null,
  branchRef: null,
  displayLabel: "Default",
  locationId: null,
  ownershipState: "active",
  markerId: null,
  markerPath: null,
  repairDetail: null,
  archivedAt: null,
};

const mockApi = {
  createTerminal: async () => ({ id: "trm-1" } as unknown as TerminalSummary),
  deleteTerminal: async () => {},
  reopenWorkspace: async () => {},
} as unknown as WorkspaceApi;

describe("TerminalTabPane", () => {
  test("renders connecting state while terminals are loading", () => {
    const tab: PaneTab = { id: "term-tab-1", kind: "terminal", title: "Terminal 1", targetId: "trm-old" };
    const html = ReactDOMServer.renderToString(
      React.createElement(TerminalTabPane, {
        tab,
        workspace: mockWorkspace,
        terminals: [],
        terminalsLoaded: false,
        api: mockApi,
        onClose: () => {},
        onTerminated: () => {},
        onTerminalAttached: () => {},
      })
    );

    expect(html).toContain("Connecting to terminal");
    expect(html).toContain("Loading workspace shell sessions");
  });

  test("renders starting terminal state when terminals are loaded but no matching terminal exists", () => {
    const tab: PaneTab = { id: "term-tab-1", kind: "terminal", title: "Terminal 1", targetId: "trm-old" };
    const html = ReactDOMServer.renderToString(
      React.createElement(TerminalTabPane, {
        tab,
        workspace: mockWorkspace,
        terminals: [],
        terminalsLoaded: true,
        api: mockApi,
        onClose: () => {},
        onTerminated: () => {},
        onTerminalAttached: () => {},
      })
    );

    expect(html).toContain("Starting terminal");
    expect(html).toContain("Launching a new shell session");
  });

  test("renders archived workspace message if workspace is archived", () => {
    const tab: PaneTab = { id: "term-tab-1", kind: "terminal", title: "Terminal 1", targetId: "trm-old" };
    const archivedWorkspace: Workspace = { ...mockWorkspace, archivedAt: new Date().toISOString() };
    const html = ReactDOMServer.renderToString(
      React.createElement(TerminalTabPane, {
        tab,
        workspace: archivedWorkspace,
        terminals: [],
        terminalsLoaded: true,
        api: mockApi,
        onClose: () => {},
        onTerminated: () => {},
        onTerminalAttached: () => {},
      })
    );

    expect(html).toContain("This workspace is archived");
    expect(html).toContain("Reopen Workspace");
  });
});
