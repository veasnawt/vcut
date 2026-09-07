"use client";

import { useEffect, useState } from "react";

/** The visual viewport's own live height in CSS pixels — shrinks when an on-screen keyboard opens,
 *  unlike `window.innerHeight`/a `vh` unit, which both keep reporting the full LAYOUT viewport
 *  regardless (the same gap `NewTextComposer.tsx`'s `bottomInset`/`TextTransformHandles.tsx`'s
 *  `MobileTextEditBar` already work around, just for a different purpose there — positioning a bar
 *  ABOVE the keyboard rather than capping something's own height). A centered `position: fixed`
 *  dialog sized off `max-h-[90vh]` has no such adjustment: an `autoFocus`ed text field opens the
 *  keyboard the instant the dialog mounts, and content below the fold (a footer button, the tail of a
 *  preset grid) can end up genuinely UNREACHABLE — sitting behind the keyboard rather than merely
 *  needing a scroll, since the dialog's own layout box still thinks the full, un-shrunk viewport
 *  height is available. Callers should size against THIS value instead (see any of its own callers
 *  for the pattern) so the dialog always fits whatever's actually visible, keyboard or not.
 *
 *  Falls back to `window.innerHeight` before the first observation lands and in any environment
 *  without `visualViewport` support (SSR, an older WebView) — never `undefined`, so a caller never
 *  needs its own "not ready yet" branch. */
export function useVisualViewportHeight(): number {
  const [height, setHeight] = useState(() => (typeof window !== "undefined" ? window.innerHeight : 0));

  useEffect(() => {
    const vv = window.visualViewport;
    if (!vv) return;
    function update() {
      setHeight(vv!.height);
    }
    update();
    vv.addEventListener("resize", update);
    vv.addEventListener("scroll", update);
    return () => {
      vv.removeEventListener("resize", update);
      vv.removeEventListener("scroll", update);
    };
  }, []);

  return height;
}
