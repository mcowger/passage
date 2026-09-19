import { useEffect, useRef } from "react";

/** Touch must start within this many px of the left viewport edge to
 *  count as an edge swipe. Narrow on purpose so horizontal scrolling
 *  inside editors, terminals, and carousels never triggers the drawer. */
export const EDGE_SWIPE_EDGE_WIDTH = 28;
/** Minimum horizontal travel for the gesture to fire. A swipe from the
 *  edge toward the middle of the phone comfortably exceeds this. */
export const EDGE_SWIPE_MIN_DISTANCE = 60;
/** Horizontal dominance: |dx| must exceed |dy| by this factor so a
 *  vertical page scroll that starts at the edge is never mistaken
 *  for a drawer gesture. */
export const EDGE_SWIPE_DIRECTION_RATIO = 1.25;

export function shouldOpenDrawerFromSwipe(
  startX: number,
  startY: number,
  endX: number,
  endY: number,
  edgeWidth: number = EDGE_SWIPE_EDGE_WIDTH,
): boolean {
  if (startX > edgeWidth) return false;
  const dx = endX - startX;
  const dy = endY - startY;
  return dx >= EDGE_SWIPE_MIN_DISTANCE && Math.abs(dx) > Math.abs(dy) * EDGE_SWIPE_DIRECTION_RATIO;
}

export function shouldCloseDrawerFromSwipe(
  startX: number,
  startY: number,
  endX: number,
  endY: number,
): boolean {
  const dx = endX - startX;
  const dy = endY - startY;
  return dx <= -EDGE_SWIPE_MIN_DISTANCE && Math.abs(dx) > Math.abs(dy) * EDGE_SWIPE_DIRECTION_RATIO;
}

type TouchLike = { identifier: number; clientX: number; clientY: number };
type TouchListLike = { length: number; item?: (index: number) => TouchLike | null } & Record<number, TouchLike>;

function firstTouch(list: TouchListLike | undefined): TouchLike | undefined {
  if (!list || list.length < 1) return undefined;
  return typeof list.item === "function" ? (list.item(0) ?? undefined) : list[0];
}

function readTouch(list: TouchListLike | undefined, id: number): TouchLike | undefined {
  if (!list) return undefined;
  for (let i = 0; i < list.length; i++) {
    const touch = typeof list.item === "function" ? list.item(i) : list[i];
    if (touch && touch.identifier === id) return touch;
  }
  return undefined;
}

type UseEdgeSwipeDrawerOptions = {
  /** Gate on the mobile breakpoint: desktop keeps mouse/keyboard behavior. */
  enabled: boolean;
  drawerOpen: boolean;
  onOpen: () => void;
  onClose: () => void;
};

/** Mobile drawer gesture: swipe right from the left screen edge toward
 *  the middle to open the sidebar, swipe left inside it to close.
 *  Threshold-based (fires on touchend), so it never fights scrolling --
 *  vertical scrolls and in-content horizontal pans are ignored by the
 *  edge-zone and direction-ratio checks. */
export function useEdgeSwipeDrawer({ enabled, drawerOpen, onOpen, onClose }: UseEdgeSwipeDrawerOptions) {
  const latest = useRef({ enabled, drawerOpen, onOpen, onClose });
  latest.current = { enabled, drawerOpen, onOpen, onClose };

  useEffect(() => {
    if (typeof window === "undefined") return;
    let tracking: {
      id: number;
      startX: number;
      startY: number;
      endX: number;
      endY: number;
      closeCandidate: boolean;
    } | null = null;

    const handleTouchStart = (event: TouchEvent) => {
      const { enabled, drawerOpen } = latest.current;
      // Synthetic or unfamiliar touch payloads carry no usable touch.
      const touch = firstTouch(event.touches as unknown as TouchListLike);
      if (!enabled || tracking || !touch || (event.touches as unknown as TouchListLike)?.length !== 1) return;
      const target = event.target as Element | null;
      if (!drawerOpen) {
        // Modal sheets (session switcher, dialogs) sit above the drawer:
        // an edge swipe there belongs to them, not the sidebar.
        if (target?.closest?.('[role="dialog"]')) return;
        if (touch.clientX > EDGE_SWIPE_EDGE_WIDTH) return;
        tracking = {
          id: touch.identifier,
          startX: touch.clientX,
          startY: touch.clientY,
          endX: touch.clientX,
          endY: touch.clientY,
          closeCandidate: false,
        };
      } else {
        // Closing swipes must start inside the open drawer so horizontal
        // pans in editors/terminals never dismiss navigation.
        if (!target?.closest?.(".sidebar")) return;
        tracking = {
          id: touch.identifier,
          startX: touch.clientX,
          startY: touch.clientY,
          endX: touch.clientX,
          endY: touch.clientY,
          closeCandidate: true,
        };
      }
    };

    const handleTouchMove = (event: TouchEvent) => {
      if (!tracking) return;
      const touches = event.touches as unknown as TouchListLike;
      const changed = event.changedTouches as unknown as TouchListLike;
      const touch = readTouch(touches, tracking.id) ?? readTouch(changed, tracking.id);
      if (!touch) return;
      tracking.endX = touch.clientX;
      tracking.endY = touch.clientY;
    };

    const handleTouchEnd = () => {
      if (!tracking) return;
      const { startX, startY, endX, endY, closeCandidate } = tracking;
      tracking = null;
      const { onOpen, onClose } = latest.current;
      if (closeCandidate) {
        if (shouldCloseDrawerFromSwipe(startX, startY, endX, endY)) onClose();
      } else if (shouldOpenDrawerFromSwipe(startX, startY, endX, endY)) {
        onOpen();
      }
    };

    const handleTouchCancel = () => {
      tracking = null;
    };

    window.addEventListener("touchstart", handleTouchStart, { passive: true });
    window.addEventListener("touchmove", handleTouchMove, { passive: true });
    window.addEventListener("touchend", handleTouchEnd, { passive: true });
    window.addEventListener("touchcancel", handleTouchCancel, { passive: true });
    return () => {
      window.removeEventListener("touchstart", handleTouchStart);
      window.removeEventListener("touchmove", handleTouchMove);
      window.removeEventListener("touchend", handleTouchEnd);
      window.removeEventListener("touchcancel", handleTouchCancel);
    };
  }, []);
}
