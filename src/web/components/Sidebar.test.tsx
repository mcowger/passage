import { describe, expect, mock, test } from "bun:test";
import React from "react";
import ReactDOMServer from "react-dom/server";
import type { WorkspaceSnapshot } from "../../shared/domain/workspaces.ts";

// Tooltips require a provider and portal, which SSR cannot render. Stub them so
// the sidebar markup (including action class names) is observable.
mock.module("./ui/tooltip.tsx", () => ({
  TooltipProvider: ({ children }: { children: React.ReactNode }) =>
    React.createElement(React.Fragment, null, children),
  Tooltip: ({ children }: { children: React.ReactNode }) =>
    React.createElement(React.Fragment, null, children),
  TooltipTrigger: ({ children }: { children: React.ReactNode }) =>
    React.createElement(React.Fragment, null, children),
  TooltipContent: ({ children }: { children: React.ReactNode }) =>
    React.createElement(React.Fragment, null, children),
}));

const { Sidebar } = await import("./Sidebar.tsx");

const snapshot: WorkspaceSnapshot = {
  projects: [
    {
      id: "prj-1",
      configuredRootPath: "/tmp/project",
      canonicalRootPath: "/tmp/project",
      displayLabel: "Project",
      archivedAt: null,
    },
  ],
  workspaces: [
    {
      id: "wsp-1",
      projectId: "prj-1",
      kind: "worktree",
      cwd: "/tmp/project/wt",
      checkoutRoot: "/tmp/project/wt",
      mainRepositoryRoot: "/tmp/project",
      branchRef: "feature/example",
      displayLabel: "Example",
      locationId: null,
      ownershipState: "active",
      markerId: null,
      markerPath: null,
      repairDetail: null,
      archivedAt: null,
    },
  ],
  locations: [],
};

describe("Sidebar", () => {
  test("project and workspace actions are not hover-only", () => {
    const html = ReactDOMServer.renderToString(
      React.createElement(Sidebar, {
        data: snapshot,
        open: false,
        onClose: () => {},
        onSelect: () => {},
        onNewProject: () => {},
        agents: [],
        onDiscoverWorktrees: () => {},
        onArchiveProject: () => {},
        onManageWorkspace: () => {},
      })
    );

    const touchVisibleCount = html.split("touch-visible").length - 1;
    // Discover worktrees, remove project, and workspace manage actions.
    expect(touchVisibleCount).toBe(3);
  });

  test("footer shows the injected build next to the bun version", () => {
    const html = ReactDOMServer.renderToString(
      React.createElement(Sidebar, {
        data: snapshot,
        open: false,
        onClose: () => {},
        onSelect: () => {},
        onNewProject: () => {},
        agents: [],
        build: {
          commit: "abc1234567890",
          shortCommit: "abc1234",
          dirty: false,
          builtAt: "2026-01-01T00:00:00.000Z",
          bunVersion: "1.4.0",
        },
      })
    );

    expect(html).toContain("v1.4.0");
    expect(html).toContain("abc1234");
  });

  test("shows a begin-drain control while running and a cancel control with truthful blockers while draining", () => {
    const runningHtml = ReactDOMServer.renderToString(
      React.createElement(Sidebar, {
        data: snapshot,
        open: false,
        onClose: () => {},
        onSelect: () => {},
        onNewProject: () => {},
        agents: [],
        daemon: { phase: "running", instanceId: "i-1", drainId: null, readinessRevision: 0, blockedCount: 0, blockers: [], blockersTruncated: false },
      })
    );
    expect(runningHtml).toContain("Begin daemon drain for maintenance");

    const drainingHtml = ReactDOMServer.renderToString(
      React.createElement(Sidebar, {
        data: snapshot,
        open: false,
        onClose: () => {},
        onSelect: () => {},
        onNewProject: () => {},
        agents: [],
        daemon: {
          phase: "draining",
          instanceId: "i-1",
          drainId: "d-1",
          readinessRevision: 1,
          blockedCount: 1,
          blockers: [{ agentId: "agt_1", reason: "running" }],
          blockersTruncated: false,
        },
      })
    );
    expect(drainingHtml).toContain("daemon-drain-status");
    expect(drainingHtml).toContain("Draining\u2026");
    expect(drainingHtml).toContain("(1)");
    expect(drainingHtml).toContain("agt_1 (running)");

    // Absent daemon state hides the control entirely rather than showing a
    // misleading default phase.
    const noDaemonHtml = ReactDOMServer.renderToString(
      React.createElement(Sidebar, {
        data: snapshot,
        open: false,
        onClose: () => {},
        onSelect: () => {},
        onNewProject: () => {},
        agents: [],
      })
    );
    expect(noDaemonHtml).not.toContain("daemon-drain-status");
  });
});
