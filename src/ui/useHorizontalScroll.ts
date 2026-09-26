"use client";

import { useCallback, useRef } from "react";

/** Movement (px) before a press on a strip counts as a drag rather than a click. */
const DRAG_THRESHOLD = 5;

/** Makes a strip that scrolls sideways usable with a mouse. Phones swipe these rows, but on a desktop a plain mouse wheel only
 *  scrolls vertically and a row with a hidden scrollbar has nothing to grab, so the row simply looked stuck. This adds:
 *   - the wheel: turned into sideways scrolling while the pointer is over the row (trackpads that already send sideways
 *     movement, and rows that also scroll vertically, are left alone);
 *   - click-and-drag with a mouse, without swallowing ordinary clicks on the chips or cards inside it.
 *  Touch and pen input keep the browser's own scrolling. Use it as `<div ref={useHorizontalScroll()} className="overflow-x-auto ...">`.
 *  A callback ref, so it also works on a row that is only rendered sometimes. */
export function useHorizontalScroll<T extends HTMLElement = HTMLDivElement>(): (element: T | null) => void {
  const cleanup = useRef<(() => void) | null>(null);

  return useCallback((element: T | null) => {
    cleanup.current?.();
    cleanup.current = null;
    if (!element) return;

    function onWheel(event: WheelEvent) {
      const el = element!;
      if (event.ctrlKey || Math.abs(event.deltaX) >= Math.abs(event.deltaY)) return;
      // A row that can also scroll up and down keeps its wheel for that.
      if (el.scrollHeight > el.clientHeight + 1) return;
      const max = el.scrollWidth - el.clientWidth;
      if (max <= 1) return;
      const next = Math.min(max, Math.max(0, el.scrollLeft + event.deltaY));
      if (next === el.scrollLeft) return; // at the end: let the page scroll on
      event.preventDefault();
      el.scrollLeft = next;
    }

    let startX = 0;
    let startScroll = 0;
    let pressed = false;
    let dragging = false;
    let pointerId = -1;

    function onPointerDown(event: PointerEvent) {
      if (event.pointerType !== "mouse" || event.button !== 0) return;
      const el = element!;
      if (el.scrollWidth <= el.clientWidth + 1) return;
      pressed = true;
      dragging = false;
      startX = event.clientX;
      startScroll = el.scrollLeft;
      pointerId = event.pointerId;
    }

    function onPointerMove(event: PointerEvent) {
      if (!pressed || event.pointerId !== pointerId) return;
      const el = element!;
      const dx = event.clientX - startX;
      if (!dragging && Math.abs(dx) < DRAG_THRESHOLD) return;
      if (!dragging) {
        dragging = true;
        el.setPointerCapture(pointerId);
        el.style.cursor = "grabbing";
        el.style.userSelect = "none";
        el.style.scrollSnapType = "none"; // snapping would fight the drag
      }
      el.scrollLeft = startScroll - dx;
    }

    function endDrag(event: PointerEvent) {
      if (!pressed || event.pointerId !== pointerId) return;
      const el = element!;
      pressed = false;
      if (dragging) {
        // The click that follows the release is swallowed (below); forget the drag once that moment has passed.
        window.setTimeout(() => (dragging = false), 0);
        try {
          el.releasePointerCapture(pointerId);
        } catch {
          /* already released */
        }
        el.style.cursor = "";
        el.style.userSelect = "";
        el.style.scrollSnapType = "";
      }
    }

    // A drag that ends over a chip would otherwise also "click" it.
    function onClickCapture(event: MouseEvent) {
      if (dragging) {
        event.stopPropagation();
        event.preventDefault();
        dragging = false;
      }
    }

    element.addEventListener("wheel", onWheel, { passive: false });
    element.addEventListener("pointerdown", onPointerDown);
    element.addEventListener("pointermove", onPointerMove);
    element.addEventListener("pointerup", endDrag);
    element.addEventListener("pointercancel", endDrag);
    element.addEventListener("click", onClickCapture, true);
    cleanup.current = () => {
      element.removeEventListener("wheel", onWheel);
      element.removeEventListener("pointerdown", onPointerDown);
      element.removeEventListener("pointermove", onPointerMove);
      element.removeEventListener("pointerup", endDrag);
      element.removeEventListener("pointercancel", endDrag);
      element.removeEventListener("click", onClickCapture, true);
    };
  }, []);
}
