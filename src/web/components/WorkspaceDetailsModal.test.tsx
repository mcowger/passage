import { describe, expect, mock, test } from "bun:test";
import React from "react";
import ReactDOMServer from "react-dom/server";
import type { Project, Workspace } from "../../shared/domain/workspaces.ts";
import type { WorkspaceApi } from "../api.ts";

// The real dialog portals its content, which renders nothing under SSR. Stub it
// with plain elements so the class names we hand to DialogContent are visible.
// `mock.module` replaces the module for the whole process, not just this file
// (Bun doesn't undo it on `mock.restore()`), so the factory must re-export
// every real member it isn't overriding -- otherwise any test file that runs
// later and imports one of the omitted exports (e.g. `DialogDescription`)
// fails with a missing-export SyntaxError.
const RealDialog = await import("./ui/dialog.tsx");
mock.module("./ui/dialog.tsx", () => ({
  ...RealDialog,
  Dialog: ({ children }: { children: React.ReactNode }) =>
    React.createElement(React.Fragment, null, children),
  DialogContent: ({ children, className }: { children: React.ReactNode; className?: string }) =>
    React.createElement("div", { className }, children),
  DialogHeader: ({ children }: { children: React.ReactNode }) =>
    React.createElement("div", null, children),
  DialogTitle: ({ children }: { children: React.ReactNode }) =>
    React.createElement("h2", null, children),
}));

const { WorkspaceDetailsModal } = await import("./WorkspaceDetailsModal.tsx");

const workspace: Workspace = {
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
};

const project: Project = {
  id: "prj-1",
  configuredRootPath: "/tmp/project",
  canonicalRootPath: "/tmp/project",
  displayLabel: "Project",
  iconName: null,
  iconColor: null,
  archivedAt: null,
};

const api = {} as unknown as WorkspaceApi;

describe("WorkspaceDetailsModal", () => {
  test("keeps the dialog scrollable so actions stay reachable on short viewports", () => {
    const html = ReactDOMServer.renderToString(
      React.createElement(WorkspaceDetailsModal, {
        open: true,
        onClose: () => {},
        workspace,
        project,
        api,
        onRefresh: async () => {},
      })
    );

    expect(html).toContain("Archive Worktree");
    expect(html).toContain("overflow-y-auto");
    expect(html).toContain("max-h-[calc(100dvh-2rem)]");
  });
});
