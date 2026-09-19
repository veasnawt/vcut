import { useEffect } from "react";

interface PinchTarget {
  /** Whether a NEW pinch gesture is allowed to start right now — checked fresh at the start of every
   *  candidate gesture (never stale-captured), so it can read whatever a caller's own single-pointer
   *  drag ref currently holds. `false` while some OTHER drag (move/corner-resize/rotate) already
   *  claimed the gesture, or nothing eligible is selected to scale. */
  isEligible: () => boolean;
  /** Called once, right as a new two-finger gesture is recognized — the caller's cue to snapshot
   *  whatever "current" value the gesture should scale from. */
  onStart: () => void;
  /** Called on every touchmove of an in-progress gesture with a MULTIPLICATIVE factor (1.02 = grow 2%
   *  since the last tick, not since gesture start). */
  onScale: (factor: number) => void;
  /** Called once the gesture ends (touch count drops below 2) — the caller's cue to commit whatever the
   *  live preview currently holds and clear it. */
  onEnd: () => void;
}

/** Two-finger pinch, scoped to touchscreens only (real `TouchEvent`s — never synthesized for a mouse or
 *  trackpad) — the gesture every mobile video editor uses for "make the selected thing bigger/smaller"
 *  directly on the Preview canvas. Shared by `TransformHandles` (video/image clips) and
 *  `TextTransformHandles` (text), so the gesture-recognition half — which is genuinely fiddly, see below
 *  — is written and tested once rather than drifting between two independent copies.
 *
 *  Window-scoped, `touchstart` registered in the CAPTURE phase specifically: the move/corner/rotate
 *  handles are `position: fixed` siblings of the canvas, stacked ABOVE it — a two-finger touch landing
 *  on the (large) move-handle hit area needs to be intercepted before that handle's own bubble-phase
 *  React `onTouchStart` turns it into a single-finger move drag instead (confirmed via a real two-touch
 *  simulation: without this, the clip visibly slid instead of scaling). `touchmove`/`touchend` don't
 *  need capture — by then nothing else has had the chance to claim the gesture. A pinch elsewhere on
 *  screen (the Timeline has its own, separate pinch-zoom) is excluded via `withinCanvas`, so the two
 *  never fight over the same touch. */
export function usePinchToScale(canvas: HTMLCanvasElement | null, target: PinchTarget): void {
  useEffect(() => {
    if (!canvas) return;

    let active = false;
    let lastDistance = 0;

    function distance(touches: TouchList): number {
      const [a, b] = [touches[0], touches[1]];
      return Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY);
    }
    function withinCanvas(touches: TouchList): boolean {
      const rect = canvas!.getBoundingClientRect();
      const midX = (touches[0].clientX + touches[1].clientX) / 2;
      const midY = (touches[0].clientY + touches[1].clientY) / 2;
      return midX >= rect.left && midX <= rect.right && midY >= rect.top && midY <= rect.bottom;
    }

    function onTouchStart(e: TouchEvent) {
      if (e.touches.length !== 2 || !target.isEligible() || !withinCanvas(e.touches)) return;
      e.stopPropagation();
      active = true;
      lastDistance = distance(e.touches);
      target.onStart();
    }
    function onTouchMove(e: TouchEvent) {
      if (!active || e.touches.length !== 2) return;
      e.preventDefault();
      const d = distance(e.touches);
      if (lastDistance > 0) target.onScale(d / lastDistance);
      lastDistance = d;
    }
    function onTouchEnd(e: TouchEvent) {
      if (e.touches.length >= 2 || !active) return;
      active = false;
      lastDistance = 0;
      target.onEnd();
    }

    window.addEventListener("touchstart", onTouchStart, { capture: true, passive: true });
    window.addEventListener("touchmove", onTouchMove, { passive: false });
    window.addEventListener("touchend", onTouchEnd, { passive: true });
    window.addEventListener("touchcancel", onTouchEnd, { passive: true });
    return () => {
      window.removeEventListener("touchstart", onTouchStart, { capture: true });
      window.removeEventListener("touchmove", onTouchMove);
      window.removeEventListener("touchend", onTouchEnd);
      window.removeEventListener("touchcancel", onTouchEnd);
    };
    // `target`'s callbacks read fresh `.current` refs internally in both callers, so this effect is
    // deliberately keyed on `canvas` alone — re-subscribing on every render would work too but churns
    // four window listeners for no behavioral difference.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [canvas]);
}
