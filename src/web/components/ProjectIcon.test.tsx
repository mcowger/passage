import { describe, expect, test } from "bun:test";
import React from "react";
import ReactDOMServer from "react-dom/server";

const { ProjectIconBadge } = await import("./ProjectIcon.tsx");

describe("ProjectIconBadge", () => {
  test("renders the detected project image when a source is provided", () => {
    const html = ReactDOMServer.renderToString(
      React.createElement(ProjectIconBadge, {
        iconName: "Rocket",
        color: "#3b82f6",
        size: 14,
        imageSrc: "/api/projects/prj-1/icon",
      }),
    );
    expect(html).toContain('src="/api/projects/prj-1/icon"');
    expect(html).not.toContain("<svg");
  });

  test("falls back to the lucide icon without a source", () => {
    const html = ReactDOMServer.renderToString(
      React.createElement(ProjectIconBadge, { iconName: "Rocket", color: "#3b82f6", size: 14 }),
    );
    expect(html).toContain("<svg");
    expect(html).not.toContain("<img");
  });
});
