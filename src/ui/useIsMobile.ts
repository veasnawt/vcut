"use client";

import { useEffect, useState } from "react";

/** Whether the viewport is below this app's own `lg` breakpoint (1024px, matching Tailwind's default
 *  and every `lg:` class already used throughout this app) — the one JS-side signal several
 *  components need alongside their CSS: `Timeline.tsx`'s fixed-center-playhead-vs-independent-scroll
 *  behavior switch, and (originally) each new caller that would otherwise have re-implemented the
 *  exact same `matchMedia` listener. Reactive, not just read once at mount — rotating a tablet or
 *  resizing a desktop window across the breakpoint mid-session needs this to flip live. */
export function useIsMobile(): boolean {
  const [isMobile, setIsMobile] = useState(false);
  useEffect(() => {
    const mql = window.matchMedia("(min-width: 1024px)");
    setIsMobile(!mql.matches);
    const onChange = () => setIsMobile(!mql.matches);
    mql.addEventListener("change", onChange);
    return () => mql.removeEventListener("change", onChange);
  }, []);
  return isMobile;
}
