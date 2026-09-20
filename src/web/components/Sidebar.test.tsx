import { describe, expect, mock, test } from "bun:test";
import React from "react";
import ReactDOMServer from "react-dom/server";
import type { WorkspaceSnapshot } from "../../shared/domain/workspaces.ts";
import { formatBuildDate } from "../../shared/build-info.ts";

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
      iconName: null,
      iconColor: null,
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
        onEditProject: () => {},
        onManageWorkspace: () => {},
      })
    );

    const touchVisibleCount = html.split("touch-visible").length - 1;
    // Edit project, discover worktrees, remove project, and workspace manage actions.
    expect(touchVisibleCount).toBe(4);
  });

  test("footer shows the build date and commit", () => {
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

    expect(html).toContain(formatBuildDate("2026-01-01T00:00:00.000Z"));
    expect(html).toContain("abc1234");
    expect(html).not.toContain("v1.4.0");
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

  test("the WS health indicator reflects real transport status, defaulting to checking rather than a false Connected", () => {
    const base = { data: snapshot, open: false, onClose: () => {}, onSelect: () => {}, onNewProject: () => {}, agents: [] };

    const noHealthHtml = ReactDOMServer.renderToString(React.createElement(Sidebar, base));
    expect(noHealthHtml).toContain("Reconnecting\u2026");
    expect(noHealthHtml).not.toContain(">Connected<");

    const onlineHtml = ReactDOMServer.renderToString(React.createElement(Sidebar, { ...base, wsHealth: "online" }));
    expect(onlineHtml).toContain("Connected");
    expect(onlineHtml).not.toContain("ws-offline");
    expect(onlineHtml).not.toContain("ws-checking");

    const offlineHtml = ReactDOMServer.renderToString(React.createElement(Sidebar, { ...base, wsHealth: "offline" }));
    expect(offlineHtml).toContain("Disconnected");
    expect(offlineHtml).toContain("ws-offline");
  });

  test("default-only projects start collapsed while projects with worktrees stay expanded", () => {
    const base = { open: false, onClose: () => {}, onSelect: () => {}, onNewProject: () => {}, onNewWorktree: () => {}, agents: [] as never[] };
    const defaultOnly: WorkspaceSnapshot = {
      projects: [
        {
          id: "prj-1",
          configuredRootPath: "/tmp/project",
          canonicalRootPath: "/tmp/project",
          displayLabel: "Project",
          iconName: null,
          iconColor: null,
          archivedAt: null,
        },
      ],
      workspaces: [
        {
          id: "wsp-default",
          projectId: "prj-1",
          kind: "directory",
          cwd: "/tmp/project",
          checkoutRoot: "/tmp/project",
          mainRepositoryRoot: "/tmp/project",
          branchRef: null,
          displayLabel: "Default",
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

    // No stored override in SSR (no window/localStorage), so the default applies.
    const collapsedHtml = ReactDOMServer.renderToString(React.createElement(Sidebar, { ...base, data: defaultOnly }));
    expect(collapsedHtml).toContain('aria-expanded="false"');
    expect(collapsedHtml).not.toContain("workspace-list");

    const expandedHtml = ReactDOMServer.renderToString(React.createElement(Sidebar, { ...base, data: snapshot }));
    expect(expandedHtml).toContain('aria-expanded="true"');
    expect(expandedHtml).toContain("workspace-list");
  });
  test("selected worktree keeps state-driven dot color and adds no green icon tint", () => {
    const agents = [
      {
        id: "agt-1",
        workspaceId: "wsp-1",
        title: "Idle agent",
        status: "idle" as const,
        modelPreference: null,
        thinkingPreference: null,
        live: false,
        persisted: true,
      },
    ];
    const html = ReactDOMServer.renderToString(
      React.createElement(Sidebar, {
        data: snapshot,
        selected: "wsp-1",
        open: false,
        onClose: () => {},
        onSelect: () => {},
        onNewProject: () => {},
        agents,
      })
    );

    // Selection shading applies...
    expect(html).toContain("workspace-row");
    expect(html).toContain("selected");
    // ...but the dot stays purely agent-state driven (idle/blue, not green)...
    expect(html).toContain("status-dot shrink-0 idle");
    expect(html).not.toContain("status-dot shrink-0 active");
    // ...and the worktree icon carries no green/state tint.
    expect(html).not.toContain("text-primary");
  });

  test("selected worktree still shows active dot when its agent is running", () => {
    const agents = [
      {
        id: "agt-1",
        workspaceId: "wsp-1",
        title: "Running agent",
        status: "running" as const,
        modelPreference: null,
        thinkingPreference: null,
        live: true,
        persisted: true,
      },
    ];
    const html = ReactDOMServer.renderToString(
      React.createElement(Sidebar, {
        data: snapshot,
        selected: "wsp-1",
        open: false,
        onClose: () => {},
        onSelect: () => {},
        onNewProject: () => {},
        agents,
      })
    );

    expect(html).toContain("status-dot shrink-0 active");
  });

  test("empty workspace with no agents shows gray empty dot, not blue", () => {
    const html = ReactDOMServer.renderToString(
      React.createElement(Sidebar, {
        data: snapshot,
        selected: "wsp-1",
        open: false,
        onClose: () => {},
        onSelect: () => {},
        onNewProject: () => {},
        agents: [],
      })
    );

    expect(html).toContain("status-dot shrink-0 empty");
    expect(html).toContain('title="Empty"');
    expect(html).not.toContain("status-dot shrink-0 idle");
  });

  test("initializing agent shows gray empty dot, not pulsing orange", () => {
    const agents = [
      {
        id: "agt-1",
        workspaceId: "wsp-1",
        title: "Starting agent",
        status: "initializing" as const,
        modelPreference: null,
        thinkingPreference: null,
        live: false,
        persisted: true,
      },
    ];
    const html = ReactDOMServer.renderToString(
      React.createElement(Sidebar, {
        data: snapshot,
        selected: "wsp-1",
        open: false,
        onClose: () => {},
        onSelect: () => {},
        onNewProject: () => {},
        agents,
      })
    );

    expect(html).toContain("status-dot shrink-0 empty");
    expect(html).not.toContain("status-dot shrink-0 active");
  });

  test("workspace with initializing and idle agents still shows blue idle dot", () => {
    const agents = [
      {
        id: "agt-1",
        workspaceId: "wsp-1",
        title: "Starting agent",
        status: "initializing" as const,
        modelPreference: null,
        thinkingPreference: null,
        live: false,
        persisted: true,
      },
      {
        id: "agt-2",
        workspaceId: "wsp-1",
        title: "Idle agent",
        status: "idle" as const,
        modelPreference: null,
        thinkingPreference: null,
        live: false,
        persisted: true,
      },
    ];
    const html = ReactDOMServer.renderToString(
      React.createElement(Sidebar, {
        data: snapshot,
        selected: "wsp-1",
        open: false,
        onClose: () => {},
        onSelect: () => {},
        onNewProject: () => {},
        agents,
      })
    );

    expect(html).toContain("status-dot shrink-0 idle");
  });

  test("non-selected workspace renders its map color without being clicked", () => {
    // Regression: only the selected workspace's agents are loaded, so every
    // other dot rendered grey until clicked. The aggregated map must drive
    // non-selected dots at a glance.
    const twoWorkspaces: WorkspaceSnapshot = {
      ...snapshot,
      workspaces: [
        ...snapshot.workspaces,
        {
          ...snapshot.workspaces[0],
          id: "wsp-2",
          displayLabel: "Other",
        },
      ],
    };
    const html = ReactDOMServer.renderToString(
      React.createElement(Sidebar, {
        data: twoWorkspaces,
        selected: "wsp-1",
        open: false,
        onClose: () => {},
        onSelect: () => {},
        onNewProject: () => {},
        agents: [],
        workspaceStatuses: { "wsp-1": "idle", "wsp-2": "active" },
      })
    );

    expect(html).toContain("status-dot shrink-0 idle");
    expect(html).toContain("status-dot shrink-0 active");
  });

  test("selected workspace prefers live agents over a stale map entry", () => {
    const agents = [
      {
        id: "agt-1",
        workspaceId: "wsp-1",
        title: "Running agent",
        status: "running" as const,
        modelPreference: null,
        thinkingPreference: null,
        live: true,
        persisted: true,
      },
    ];
    const html = ReactDOMServer.renderToString(
      React.createElement(Sidebar, {
        data: snapshot,
        selected: "wsp-1",
        open: false,
        onClose: () => {},
        onSelect: () => {},
        onNewProject: () => {},
        agents,
        workspaceStatuses: { "wsp-1": "idle" },
      })
    );

    // Live running agents win over the last poll tick.
    expect(html).toContain("status-dot shrink-0 active");
  });
});
