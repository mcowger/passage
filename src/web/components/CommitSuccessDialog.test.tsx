import { describe, expect, mock, test } from "bun:test";
import React from "react";
import { fireEvent, render } from "@testing-library/react";
import { setupDomTests } from "../test-utils/dom.ts";

setupDomTests();

// Radix AlertDialog portals do not mount under happy-dom, so stub the dialog
// module to render inline (same pattern as MobileNav's Dialog stub).
mock.module("./ui/alert-dialog.tsx", () => ({
  AlertDialog: ({ children, open }: { children: React.ReactNode; open?: boolean }) =>
    open ? React.createElement(React.Fragment, null, children) : null,
  AlertDialogContent: ({ children }: { children: React.ReactNode }) =>
    React.createElement("div", { "data-testid": "commit-success-dialog" }, children),
  AlertDialogHeader: ({ children }: { children: React.ReactNode }) =>
    React.createElement("div", null, children),
  AlertDialogTitle: ({ children }: { children: React.ReactNode }) =>
    React.createElement("div", null, children),
  AlertDialogDescription: ({ children }: { children: React.ReactNode }) =>
    React.createElement("div", null, children),
  AlertDialogFooter: ({ children }: { children: React.ReactNode }) =>
    React.createElement("div", null, children),
  AlertDialogCancel: ({ children }: { children: React.ReactNode }) =>
    React.createElement("button", null, children),
  AlertDialogAction: ({ children }: { children: React.ReactNode }) =>
    React.createElement("button", null, children),
}));

const { CommitSuccessDialog } = await import("./CommitSuccessDialog.tsx");

describe("CommitSuccessDialog", () => {
  test("shows the subject collapsed with a Show more toggle for the body", () => {
    const message = "feat(components): icon-only Git button\n\nLong body that should start hidden.";
    const { getByText, queryByText, getByRole, getByTestId } = render(
      <CommitSuccessDialog title="Committed changes" message={message} open onOpenChange={() => {}} />,
    );

    expect(getByTestId("commit-success-dialog")).toBeInTheDocument();
    expect(getByText("Committed changes")).toBeInTheDocument();
    // Collapsed: subject visible, body hidden.
    expect(getByText(/icon-only Git button/)).toBeInTheDocument();
    expect(queryByText(/should start hidden/)).toBeNull();

    fireEvent.click(getByRole("button", { name: "Show more" }));
    expect(queryByText(/should start hidden/)).not.toBeNull();

    fireEvent.click(getByRole("button", { name: "Show less" }));
    expect(queryByText(/should start hidden/)).toBeNull();
  });

  test("a one-line message renders with no toggle", () => {
    const { getByText, queryByRole } = render(
      <CommitSuccessDialog title="Committed changes" message="fix: one-liner" open onOpenChange={() => {}} />,
    );
    expect(getByText("fix: one-liner")).toBeInTheDocument();
    expect(queryByRole("button", { name: /Show (more|less)/ })).toBeNull();
  });
});
