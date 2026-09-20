import type { TransitionType } from "../project/types.ts";

/** The timing math every transition style shares between the live canvas preview
 *  (`PlaybackEngine.compositeTransitionFrame`/`compositeSoloReveal`) and export
 *  (`buildExportPlan`'s transition builders). Kept as pure number-in/number-out functions in one
 *  module so the two sides evaluate the SAME curve at the same instant — the preview used to run its
 *  own geometry while export leaned on FFmpeg's built-in `xfade` shapes (a soft, back-loaded blob for
 *  `circleopen`, horizontal bands for `vuslice`), and the two visibly disagreed. */

/** Groups `TransitionType`'s styles into the shapes the canvas preview actually knows how to render —
 *  exported (not a private switch inline) so it's directly unit-testable without a canvas.
 *  `PlaybackEngine.compositeTransitionFrame` turns one of these into canvas pixels; export builds the
 *  same shapes from FFmpeg filters (`buildExportPlan`'s `pushTransitionBlend`/
 *  `pushSoloTransitionStages`). `crossfade` and the legacy `dissolve` both map to the plain alpha
 *  blend — see `TransitionType`'s own doc comment on why `dissolve` is no longer offered. */
export type TransitionFamily =
  | { kind: "dissolve" }
  | { kind: "wipe"; edge: "left" | "right" | "up" | "down" }
  | { kind: "slide"; edge: "left" | "right" | "up" | "down" }
  | { kind: "slice"; direction: "up" | "down" }
  | { kind: "circle"; opening: boolean }
  | { kind: "glitch" }
  | { kind: "waterRipple" }
  | { kind: "zoomBlur" }
  | { kind: "whipPan"; edge: "left" | "right" }
  | { kind: "flashZoom" };

export function transitionFamily(type: TransitionType): TransitionFamily {
  switch (type) {
    case "wipeLeft":
      return { kind: "wipe", edge: "left" };
    case "wipeRight":
      return { kind: "wipe", edge: "right" };
    case "wipeUp":
      return { kind: "wipe", edge: "up" };
    case "wipeDown":
      return { kind: "wipe", edge: "down" };
    case "slideLeft":
      return { kind: "slide", edge: "left" };
    case "slideRight":
      return { kind: "slide", edge: "right" };
    case "slideUp":
      return { kind: "slide", edge: "up" };
    case "slideDown":
      return { kind: "slide", edge: "down" };
    case "sliceUp":
      return { kind: "slice", direction: "up" };
    case "sliceDown":
      return { kind: "slice", direction: "down" };
    case "circleOpen":
      return { kind: "circle", opening: true };
    case "circleClose":
      return { kind: "circle", opening: false };
    case "glitchCut":
      return { kind: "glitch" };
    case "waterRippleCut":
      return { kind: "waterRipple" };
    case "zoomBlur":
      return { kind: "zoomBlur" };
    case "whipPanLeft":
      return { kind: "whipPan", edge: "left" };
    case "whipPanRight":
      return { kind: "whipPan", edge: "right" };
    case "flashZoom":
      return { kind: "flashZoom" };
    case "crossfade":
    case "dissolve":
    default:
      return { kind: "dissolve" };
  }
}

/** How many vertical strips the slice style divides the frame into. Each strip is a whole-frame push
 *  confined to its own column, started a little after the strip to its left — the stagger is what
 *  makes it read as a cascade rather than one uniform slide. */
export const SLICE_STRIP_COUNT = 10;
/** Share of the whole transition any ONE strip's own push takes (the rest is spent waiting for its
 *  turn). The last strip always finishes exactly at progress 1, regardless of either constant. */
export const SLICE_WIPE_FRACTION = 0.5;

/** Overall progress → one strip's own linear progress, 0..1. */
export function sliceStripProgress(overallProgress: number, stripIndex: number): number {
  const staggerStep = SLICE_STRIP_COUNT > 1 ? (1 - SLICE_WIPE_FRACTION) / (SLICE_STRIP_COUNT - 1) : 0;
  const local = (overallProgress - stripIndex * staggerStep) / SLICE_WIPE_FRACTION;
  return Math.min(1, Math.max(0, local));
}

/** Whole-pixel left edge and width of slice strip `index` — the preview clips and export crops at
 *  identical columns, so neither shows a hairline seam the other doesn't. */
export function sliceStripBounds(frameWidth: number, index: number): { x: number; width: number } {
  const x = Math.round((index * frameWidth) / SLICE_STRIP_COUNT);
  const next = Math.round(((index + 1) * frameWidth) / SLICE_STRIP_COUNT);
  return { x, width: next - x };
}

/** Ease-in-out cubic — starts and lands softly instead of the constant-speed motion a raw linear
 *  progress gives, which is what made wipes/slides/circles feel mechanical. Applied only to the
 *  geometric styles (see `isEasedTransition`); a crossfade's alpha stays linear, the way every NLE
 *  does it. */
export function easeTransition(progress: number): number {
  const q = Math.min(1, Math.max(0, progress));
  return q < 0.5 ? 4 * q * q * q : 1 - Math.pow(-2 * q + 2, 3) / 2;
}

/** The same curve as an FFmpeg expression over `q` (itself an expression already clamped to 0..1). */
export function easeTransitionExpr(q: string): string {
  return `if(lt(${q},0.5),4*${q}*${q}*${q},1-pow(2-2*${q},3)/2)`;
}

/** Whether `type`'s MOTION (edge position, strip offset, circle radius, pan offset) follows
 *  `easeTransition` rather than raw linear progress. */
export function isEasedTransition(type: TransitionType): boolean {
  return (
    type.startsWith("wipe") ||
    type.startsWith("slide") ||
    type.startsWith("slice") ||
    type.startsWith("circle") ||
    type.startsWith("whipPan")
  );
}

/** 0 at both ends of a two-clip blend, 1 at the midpoint — how hard the blur/zoom/corruption styles
 *  hit at a given progress, so the effect bursts at the cut and is clean going in and out. */
export function midpointIntensity(progress: number): number {
  const q = Math.min(1, Math.max(0, progress));
  return 4 * q * (1 - q);
}

// ---- Glitch Cut ----------------------------------------------------------------------------------
//
// A glitch cut is a hard, flickering switch between the two clips with RGB channel split and a couple
// of torn horizontal bands, all changing in discrete "bursts" (a real signal glitch holds for a beat
// rather than drifting). Every value is a pure function of the burst index, so the preview (per
// animation frame) and export (a `sendcmd` per burst) land on identical frames.

/** Length of one burst — two frames at 30fps, fast enough to read as a stutter. */
export const GLITCH_CUT_BURST_SECONDS = 1 / 15;
/** Peak red/blue channel offset, as a fraction of frame width (≈27px on a 1080-wide frame). */
export const GLITCH_CUT_SHIFT_FRACTION = 0.025;
/** Peak sideways tear of a band, as a fraction of frame width. */
export const GLITCH_CUT_BAND_SHIFT_FRACTION = 0.08;
export const GLITCH_CUT_BAND_COUNT = 2;
/** Height of each torn band, as a fraction of frame height. */
export const GLITCH_CUT_BAND_HEIGHT_FRACTION = 0.07;

function hash(seed: number): number {
  const x = Math.sin(seed * 12.9898) * 43758.5453;
  return x - Math.floor(x);
}

export function glitchCutBurstIndex(elapsedSeconds: number): number {
  return Math.max(0, Math.floor(elapsedSeconds / GLITCH_CUT_BURST_SECONDS + 1e-6));
}

export interface GlitchCutBurst {
  /** Red channel offset, fraction of width (positive = content moves right). */
  shiftR: number;
  /** Blue channel offset, fraction of width. */
  shiftB: number;
  /** Torn bands: top edge as a fraction of height, sideways offset as a fraction of width. */
  bands: { top: number; shift: number }[];
}

/** One burst's corruption, scaled by `intensity` (0 = untouched, 1 = full strength). */
export function glitchCutBurst(burstIndex: number, intensity: number): GlitchCutBurst {
  const k = Math.min(1, Math.max(0, intensity));
  const shiftR = (hash(burstIndex * 2 + 0.31) * 2 - 1) * GLITCH_CUT_SHIFT_FRACTION * k;
  const shiftB = -(hash(burstIndex * 2 + 1.17) * 2 - 1) * GLITCH_CUT_SHIFT_FRACTION * k;
  const bands: GlitchCutBurst["bands"] = [];
  for (let i = 0; i < GLITCH_CUT_BAND_COUNT; i++) {
    const top = hash(burstIndex * 7 + i * 3 + 0.5) * (1 - GLITCH_CUT_BAND_HEIGHT_FRACTION);
    const shift = (hash(burstIndex * 7 + i * 3 + 1.5) * 2 - 1) * GLITCH_CUT_BAND_SHIFT_FRACTION * k;
    bands.push({ top, shift });
  }
  return { shiftR, shiftB, bands };
}

/** Progress at the MIDDLE of a burst — the one value a whole burst is evaluated at, so every frame
 *  inside it is identical (export can only change `rgbashift` between bursts, not within one). */
export function glitchCutBurstProgress(burstIndex: number, durationSeconds: number): number {
  if (durationSeconds <= 0) return 1;
  return Math.min(1, ((burstIndex + 0.5) * GLITCH_CUT_BURST_SECONDS) / durationSeconds);
}

/** Whether a two-clip glitch cut shows the INCOMING clip during `burstIndex`: a hard switch at the
 *  midpoint, with a few bursts either side flickering to the other clip — never a soft dissolve,
 *  which is what made the old version read as a smudgy crossfade rather than a glitch. */
export function glitchCutShowsIncoming(burstIndex: number, durationSeconds: number): boolean {
  const q = glitchCutBurstProgress(burstIndex, durationSeconds);
  const base = q >= 0.5;
  const flicker = q > 0.15 && q < 0.85 && hash(burstIndex * 13.7 + 5.3) < 0.35;
  return flicker ? !base : base;
}
