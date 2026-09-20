import { describe, expect, test } from "bun:test";
import React from "react";
import { fireEvent, render } from "@testing-library/react";
import { ToolRow } from "./ToolRow.tsx";
import { setupDomTests } from "../test-utils/dom.ts";
import type { TimelineItem } from "../../shared/domain/agents.ts";

setupDomTests();

describe("ToolRow collapse behavior", () => {
  test("unmounts the expanded tool body when the row closes", () => {
    const item: Extract<TimelineItem, { kind: "tool" }> = {
      id: "tool-collapse",
      kind: "tool",
      name: "bash",
      input: { command: "echo regression" },
      result: "collapsed tool output",
      status: "complete",
    };
    const { container, getByRole } = render(React.createElement(ToolRow, { item }));
    const trigger = getByRole("button", { name: /shell/i });

    expect(container.querySelector(".tool-expanded-body")).toBeNull();

    fireEvent.click(trigger);
    expect(container.querySelector(".tool-expanded-body")).not.toBeNull();

    fireEvent.click(trigger);
    expect(container.querySelector(".tool-expanded-body")).toBeNull();
  });
});
