import { describe, expect, test } from "bun:test";
import React, { useState } from "react";
import { act, render } from "@testing-library/react";
import { setupDomTests } from "../test-utils/dom.ts";
import {
  shouldCloseDrawerFromSwipe,
  shouldOpenDrawerFromSwipe,
  useEdgeSwipeDrawer,
} from "./useEdgeSwipeDrawer.ts";

setupDomTests();

describe("edge-swipe gesture predicates", () => {
  test("a rightward swipe from the left edge toward the middle opens", () => {
    expect(shouldOpenDrawerFromSwipe(8, 400, 200, 405)).toBe(true);
  });

  test("swipes starting away from the edge never open", () => {
    expect(shouldOpenDrawerFromSwipe(120, 400, 320, 405)).toBe(false);
  });

  test("short or mostly-vertical edge drags never open", () => {
    expect(shouldOpenDrawerFromSwipe(8, 400, 40, 405)).toBe(false);
    expect(shouldOpenDrawerFromSwipe(8, 400, 200, 600)).toBe(false);
  });

  test("a leftward swipe closes", () => {
    expect(shouldCloseDrawerFromSwipe(200, 400, 80, 405)).toBe(true);
  });

  test("short or mostly-vertical drags never close", () => {
    expect(shouldCloseDrawerFromSwipe(200, 400, 170, 405)).toBe(false);
    expect(shouldCloseDrawerFromSwipe(200, 400, 80, 600)).toBe(false);
    expect(shouldCloseDrawerFromSwipe(80, 400, 200, 405)).toBe(false);
  });
});

function Harness({ enabled = true, startOpen = false }: { enabled?: boolean; startOpen?: boolean }) {
  const [open, setOpen] = useState(startOpen);
  useEdgeSwipeDrawer({
    enabled,
    drawerOpen: open,
    onOpen: () => setOpen(true),
    onClose: () => setOpen(false),
  });
  return (
    <div>
      <div className="sidebar" data-testid="sidebar">
        <span>drawer</span>
      </div>
      <div data-testid="state">{open ? "open" : "closed"}</div>
    </div>
  );
}

/** happy-dom has no Touch constructor, so synthesize the touch events the
 *  hook listens for with plain Events carrying touches/changedTouches. */
function swipe(target: EventTarget, points: Array<{ x: number; y: number }>) {
  // Raw dispatchEvent bypasses React's event system, so flush the
  // resulting state updates synchronously like a real browser turn.
  act(() => {
  const id = 7;
  const start = new Event("touchstart", { bubbles: true, cancelable: true });
  (start as unknown as { touches: unknown }).touches = [{ identifier: id, clientX: points[0].x, clientY: points[0].y }];
  target.dispatchEvent(start);
  for (const point of points.slice(1)) {
    const move = new Event("touchmove", { bubbles: true, cancelable: true });
    (move as unknown as { touches: unknown }).touches = [{ identifier: id, clientX: point.x, clientY: point.y }];
    (move as unknown as { changedTouches: unknown }).changedTouches = [
      { identifier: id, clientX: point.x, clientY: point.y },
    ];
    target.dispatchEvent(move);
  }
  const end = new Event("touchend", { bubbles: true, cancelable: true });
  (end as unknown as { touches: unknown }).touches = [];
  (end as unknown as { changedTouches: unknown }).changedTouches = [
    { identifier: id, clientX: points[points.length - 1].x, clientY: points[points.length - 1].y },
  ];
  target.dispatchEvent(end);
  });
}

describe("useEdgeSwipeDrawer", () => {
  test("edge swipe from the left toward the middle opens the drawer", () => {
    const { getByTestId } = render(<Harness />);
    expect(getByTestId("state").textContent).toBe("closed");
    swipe(document.body, [
      { x: 6, y: 400 },
      { x: 120, y: 405 },
      { x: 210, y: 410 },
    ]);
    expect(getByTestId("state").textContent).toBe("open");
  });

  test("swipe starting away from the edge does not open", () => {
    const { getByTestId } = render(<Harness />);
    swipe(document.body, [
      { x: 150, y: 400 },
      { x: 350, y: 405 },
    ]);
    expect(getByTestId("state").textContent).toBe("closed");
  });

  test("vertical scroll from the edge does not open", () => {
    const { getByTestId } = render(<Harness />);
    swipe(document.body, [
      { x: 6, y: 400 },
      { x: 12, y: 550 },
    ]);
    expect(getByTestId("state").textContent).toBe("closed");
  });

  test("disabled hook (desktop) ignores the gesture", () => {
    const { getByTestId } = render(<Harness enabled={false} />);
    swipe(document.body, [
      { x: 6, y: 400 },
      { x: 210, y: 405 },
    ]);
    expect(getByTestId("state").textContent).toBe("closed");
  });

  test("leftward swipe inside the open drawer closes it", () => {
    const { getByTestId } = render(<Harness startOpen />);
    expect(getByTestId("state").textContent).toBe("open");
    swipe(getByTestId("sidebar"), [
      { x: 220, y: 400 },
      { x: 100, y: 405 },
    ]);
    expect(getByTestId("state").textContent).toBe("closed");
  });

  test("leftward swipe outside the drawer does not close it", () => {
    const { getByTestId } = render(<Harness startOpen />);
    swipe(document.body, [
      { x: 500, y: 400 },
      { x: 300, y: 405 },
    ]);
    expect(getByTestId("state").textContent).toBe("open");
  });
});
