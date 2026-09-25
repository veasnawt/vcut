import { clipDuration, clipEnd } from "../project/createProject.ts";
import { animationFrameIndex, animationFrameRect, type AssetAnimation } from "../project/stickers.ts";
import type { ChromaKeySettings, Clip, ClipEffects, ClipMask, ClipTransform, ColorGrading, CustomFontAsset, Project, TextStyle, TransitionType, Track } from "../project/types.ts";
import { isIdentityColorGrading, isIdentityEffects, isIdentityTextCrop } from "../project/types.ts";
import type { ClipOverride } from "../timeline/groupMove.ts";
import { applyColorGrading, buildCurveLut, composeLuts } from "../timeline/colorCurves.ts";
import { resolveClipColorGrading, resolveClipEffects, resolveClipGain, resolveClipTransform, resolveTextCrop, resolveTextStyle } from "../timeline/keyframes.ts";
import { applyLut3D, blendLut3D, normalizeLutIntensity, parseCubeLut } from "../timeline/lut.ts";
import type { Lut3D } from "../timeline/lut.ts";
import { applyGlitch, applyGlitchCut, applyHorizontalBlur, applyWaterRipple, FLASH_ZOOM_PEAK, ZOOM_BLUR_SCALE, ZOOM_BLUR_SIGMA_PX } from "../timeline/pixelEffects.ts";
import {
  easeTransition,
  glitchCutBurst,
  glitchCutBurstIndex,
  glitchCutBurstProgress,
  glitchCutShowsIncoming,
  midpointIntensity,
  SLICE_STRIP_COUNT,
  sliceStripBounds,
  sliceStripProgress,
  transitionFamily,
} from "../timeline/transitionMotion.ts";
import { audibleClips, clipAtTime, visibleVideoClips } from "../timeline/queries.ts";
import { clipSourceTimeAtElapsed, clipSpeedAtElapsed } from "../timeline/clipTiming.ts";
import {
  type ActiveTransitionInfo,
  findActiveTransitionAtTime,
  resolveAudioTransitionGain,
  transitionPartnerSourceTime,
  transitionTailExtension,
} from "../timeline/transitions.ts";
import { AudioMixEngine } from "./AudioMixEngine.ts";
import { holdMediaAtEnd } from "./mediaEnd.ts";
import { computeTransformedBox } from "./transformGeometry.ts";
import { drawAnimatedTextFrame, drawTextFrame } from "./textLayout.ts";

/** How far ahead of the playhead `tick()` looks when deciding whether to kick off decoding an
 *  upcoming audio-track clip's asset early — see the prefetch scan in `tick()` itself. */
const AUDIO_PREFETCH_LOOKAHEAD_SECONDS = 5;
/** How often the prefetch scan actually runs — throttled well below the render loop's own ~60Hz cadence
 *  since it walks every audio-track clip on every audio track, real but modest work not worth paying
 *  every single frame for a decision that only matters on a several-second timescale anyway. */
const AUDIO_PREFETCH_SCAN_INTERVAL_MS = 1000;

// `transitionFamily` lives in `timeline/transitionMotion.ts` so export can share it without importing
// this DOM-bound module; re-exported here for existing callers.
export { transitionFamily, type TransitionFamily } from "../timeline/transitionMotion.ts";

/** Canvas names match the project model except Normal, whose Canvas spelling is `source-over`. */
export function clipBlendCompositeOperation(clip: Pick<Clip, "blendMode">): GlobalCompositeOperation {
  return !clip.blendMode || clip.blendMode === "normal" ? "source-over" : clip.blendMode;
}

// Module-level (not per-`PlaybackEngine`-instance) scratch canvases for the pixel-math transition
// styles below — `compositeTransitionFrame` is a standalone function usable with no live instance at
// all (`TransitionPreviewTile.tsx`'s picker thumbnails call it directly), so there's no `this` to
// attach a cache to. Two of them (one per side of the blend) so both processed results stay available
// simultaneously for the final composite.
let pixelFxScratchA: HTMLCanvasElement | null = null;
let pixelFxScratchB: HTMLCanvasElement | null = null;
let pixelFxScratchFull: HTMLCanvasElement | null = null;

/** Returns one of the scratch canvases above, lazily created and resized in place. Created with
 *  `willReadFrequently`, since every user of these reads pixels back with `getImageData` every frame —
 *  without the hint Chrome keeps the canvas on the GPU and pays a full readback stall per call.
 *  `"full"` is the frame-sized canvas a solo reveal renders its one clip into before processing. */
function getPixelFxScratchCanvas(which: "a" | "b" | "full", width: number, height: number): HTMLCanvasElement {
  let canvas = which === "a" ? pixelFxScratchA : which === "b" ? pixelFxScratchB : pixelFxScratchFull;
  if (!canvas) {
    canvas = document.createElement("canvas");
    canvas.getContext("2d", { willReadFrequently: which !== "full" });
    if (which === "a") pixelFxScratchA = canvas;
    else if (which === "b") pixelFxScratchB = canvas;
    else pixelFxScratchFull = canvas;
  }
  if (canvas.width !== width || canvas.height !== height) {
    canvas.width = width;
    canvas.height = height;
  }
  return canvas;
}

/** Long-edge cap for the working buffer the per-pixel transition effects (glitch, water ripple, whip-
 *  pan blur) run on. These used to process the full sequence-resolution frame (1080×1920 — two
 *  million pixels, twice per frame, one side each) with a `getImageData` round trip on each, which is
 *  what made Glitch Cut and Water Ripple stutter in the preview. The result is drawn back scaled to
 *  the full frame, and the on-screen canvas is itself far smaller than the sequence, so nothing
 *  visible is lost; each effect is told the scale so its pixel-sized parameters shrink to match. */
const MAX_PIXEL_FX_WORK_DIMENSION = 640;

/** Draws `source` (a full `width`×`height` frame) into a scratch canvas at working resolution, runs
 *  `apply` over its pixels, and returns that canvas — ready to be drawn back at `width`×`height`.
 *  `apply` receives the working scale (≤ 1) for its own pixel-sized parameters. */
function applyPixelFxAtWorkScale(
  which: "a" | "b",
  source: CanvasImageSource,
  width: number,
  height: number,
  apply: (imageData: ImageData, pixelScale: number) => void
): HTMLCanvasElement {
  const workScale = Math.min(1, MAX_PIXEL_FX_WORK_DIMENSION / Math.max(width, height));
  const workWidth = Math.max(1, Math.round(width * workScale));
  const workHeight = Math.max(1, Math.round(height * workScale));
  const canvas = getPixelFxScratchCanvas(which, workWidth, workHeight);
  const ctx = canvas.getContext("2d", { willReadFrequently: true })!;
  ctx.clearRect(0, 0, workWidth, workHeight);
  ctx.drawImage(source, 0, 0, workWidth, workHeight);
  const imageData = ctx.getImageData(0, 0, workWidth, workHeight);
  apply(imageData, workScale);
  ctx.putImageData(imageData, 0, 0);
  return canvas;
}

/** How many device pixels one unit of `context`'s current user space covers. Canvas 2D's
 *  `filter: blur(Npx)` is applied in DEVICE pixels and ignores the current transform (measured in
 *  Chromium: the same blur spread with and without a 4× downscale) — but every blur radius in this
 *  app is in SEQUENCE pixels, the unit export's `gblur` uses. The live canvas maps the sequence onto a
 *  much smaller backing store, so an unscaled `blur()` came out several times stronger in the preview
 *  than in the exported file: the "blur is too weak after export" bug. Multiply by this first. */
function deviceScaleOf(context: CanvasRenderingContext2D): number {
  if (typeof context.getTransform !== "function") return 1;
  const m = context.getTransform();
  const scale = Math.sqrt(Math.abs(m.a * m.d - m.b * m.c));
  return Number.isFinite(scale) && scale > 0 ? scale : 1;
}

/** Fractions of a clip's own SOURCE resolution the per-pixel readback pipeline in `drawTransformed`
 *  (chroma key, curves, LUT, mask, manual effects) is allowed to run at. Discrete on purpose: the
 *  scratch canvas is re-created whenever its size changes, so a continuously-varying scale (a zoom
 *  animation, a window resize) would reallocate it every frame — a handful of stable steps keeps that
 *  to the rare frame a step boundary is actually crossed. */
const PIPELINE_SCALE_STEPS = [0.125, 0.25, 0.375, 0.5, 0.75, 1];

/** The smallest `PIPELINE_SCALE_STEPS` entry that still gives the readback pipeline at least as many
 *  pixels as the clip actually occupies on the canvas's own backing store — never fewer, so nothing
 *  visible is lost, but often far fewer than the SOURCE has: this pipeline used to run at the source's
 *  full resolution (a 1080p or 4K video) even though the preview canvas is capped to the panel's own
 *  on-screen size (see `setDisplaySize`), so a 1080p clip in a ~500px-wide panel paid for roughly 4x the
 *  pixels the screen could ever show, on the main thread, every frame — measured at ~420ms/frame with
 *  curves + LUT + mask on a 1080p clip in headless Chromium. `devicePixelsPerSourcePixel` is
 *  `TransformedBox.width * deviceScaleOf(context) / TransformedBox.cropWidth`: how many backing-store
 *  pixels one source pixel maps to once fit, scaled and cropped. */
export function pipelineScaleFor(devicePixelsPerSourcePixel: number): number {
  if (!Number.isFinite(devicePixelsPerSourcePixel) || devicePixelsPerSourcePixel <= 0) return 1;
  for (const step of PIPELINE_SCALE_STEPS) if (step >= devicePixelsPerSourcePixel) return step;
  return 1;
}

/** Blends two ALREADY-FULLY-DRAWN flat images (`outgoing`/`incoming`) onto `context`, per
 *  `transitionFamily`'s own shape for `type` — a pure, standalone function (not a method): directly
 *  usable without a live `PlaybackEngine` instance, which `TransitionPreviewTile.tsx`'s picker-grid
 *  thumbnails rely on. Shared verbatim by video and text transitions in `drawVideoClip`/
 *  `drawTextLayer` below. `durationSeconds` is the blend's real length — the time-based styles (glitch
 *  bursts, ripple phase) need real seconds, not just 0..1 progress, to line up with export.
 *
 *  Every shape here has an exact export counterpart in `buildExportPlan`'s `pushTransitionBlend`; the
 *  easing and the per-style curves come from `timeline/transitionMotion.ts`, which both import. */
export function compositeTransitionFrame(
  context: CanvasRenderingContext2D,
  frameWidth: number,
  frameHeight: number,
  type: TransitionType,
  progress: number,
  outgoing: CanvasImageSource,
  incoming: CanvasImageSource,
  durationSeconds = 0.5
): void {
  const family = transitionFamily(type);
  const eased = easeTransition(progress);

  if (family.kind === "wipe") {
    context.drawImage(outgoing, 0, 0, frameWidth, frameHeight);
    context.save();
    context.beginPath();
    // The REVEALED (incoming) rect grows from whichever edge the name points at — e.g. "wipeLeft"
    // reveals starting at the RIGHT edge and grows leftward, matching FFmpeg's own `xfade=wipeleft`.
    if (family.edge === "left") context.rect(frameWidth * (1 - eased), 0, frameWidth * eased, frameHeight);
    else if (family.edge === "right") context.rect(0, 0, frameWidth * eased, frameHeight);
    else if (family.edge === "up") context.rect(0, frameHeight * (1 - eased), frameWidth, frameHeight * eased);
    else context.rect(0, 0, frameWidth, frameHeight * eased);
    context.clip();
    context.drawImage(incoming, 0, 0, frameWidth, frameHeight);
    context.restore();
    return;
  }

  if (family.kind === "slide") {
    // Whole-frame "push": the outgoing side exits fully in the named direction while the incoming
    // side enters from the opposite edge, both moving together. `sign` is the outgoing side's own
    // exit direction: negative x/y for "left"/"up", positive for "right"/"down".
    const horizontal = family.edge === "left" || family.edge === "right";
    const sign = family.edge === "left" || family.edge === "up" ? -1 : 1;
    const outgoingDx = horizontal ? sign * frameWidth * eased : 0;
    const outgoingDy = horizontal ? 0 : sign * frameHeight * eased;
    const incomingDx = horizontal ? -sign * frameWidth * (1 - eased) : 0;
    const incomingDy = horizontal ? 0 : -sign * frameHeight * (1 - eased);
    context.drawImage(outgoing, outgoingDx, outgoingDy, frameWidth, frameHeight);
    context.drawImage(incoming, incomingDx, incomingDy, frameWidth, frameHeight);
    return;
  }

  if (family.kind === "slice") {
    // The `slide` push, run once per vertical strip with that strip's own staggered, eased progress.
    // Strip edges are whole pixels (the same `sliceStripBounds` export crops by), so there's no
    // hairline seam from sub-pixel clip regions.
    const sign = family.direction === "up" ? -1 : 1;
    for (let i = 0; i < SLICE_STRIP_COUNT; i++) {
      const local = easeTransition(sliceStripProgress(progress, i));
      const { x, width } = sliceStripBounds(frameWidth, i);
      context.save();
      context.beginPath();
      context.rect(x, 0, width, frameHeight);
      context.clip();
      context.drawImage(outgoing, 0, sign * frameHeight * local, frameWidth, frameHeight);
      context.drawImage(incoming, 0, -sign * frameHeight * (1 - local), frameWidth, frameHeight);
      context.restore();
    }
    return;
  }

  if (family.kind === "circle") {
    // A crisp circle centered on the frame: opening grows the incoming side out from the middle,
    // closing shrinks the outgoing side down to nothing over the incoming one. FFmpeg's own
    // `circleopen`/`circleclose` are a very soft, late-starting blob — export now builds this exact
    // hard-edged circle from a mask instead (see `pushTransitionBlend`).
    const maxRadius = Math.hypot(frameWidth, frameHeight) / 2;
    const radius = maxRadius * (family.opening ? eased : 1 - eased);
    context.drawImage(family.opening ? outgoing : incoming, 0, 0, frameWidth, frameHeight);
    context.save();
    context.beginPath();
    context.arc(frameWidth / 2, frameHeight / 2, Math.max(0, radius), 0, Math.PI * 2);
    context.clip();
    context.drawImage(family.opening ? incoming : outgoing, 0, 0, frameWidth, frameHeight);
    context.restore();
    return;
  }

  if (family.kind === "glitch") {
    // A hard, flickering switch between the two clips (no soft dissolve), with the currently-shown
    // side torn by the burst's channel split and bands — see `transitionMotion.ts`'s Glitch Cut
    // section. Only ONE side is ever visible, so only one side is processed per frame.
    const burstIndex = glitchCutBurstIndex(progress * durationSeconds);
    const burst = glitchCutBurst(burstIndex, midpointIntensity(glitchCutBurstProgress(burstIndex, durationSeconds)));
    const shown = glitchCutShowsIncoming(burstIndex, durationSeconds) ? incoming : outgoing;
    const processed = applyPixelFxAtWorkScale("a", shown, frameWidth, frameHeight, (imageData) => applyGlitchCut(imageData, burst));
    // Nearest-neighbor on the way back up keeps the torn edges blocky rather than smoothing them away.
    const smoothing = context.imageSmoothingEnabled;
    context.imageSmoothingEnabled = false;
    context.drawImage(processed, 0, 0, frameWidth, frameHeight);
    context.imageSmoothingEnabled = smoothing;
    return;
  }

  if (family.kind === "waterRipple") {
    // Ripple both sides by the midpoint-peaking intensity, then cross-dissolve — the same ramped `geq=`
    // displacement export runs, with the same REAL elapsed seconds driving the wave's phase (this used
    // to pass 0..1 progress as "seconds", so the wave barely moved).
    const elapsed = progress * durationSeconds;
    const intensity = midpointIntensity(progress);
    const apply = (imageData: ImageData, pixelScale: number) => applyWaterRipple(imageData, elapsed, 1, intensity, pixelScale);
    const processedOutgoing = applyPixelFxAtWorkScale("a", outgoing, frameWidth, frameHeight, apply);
    const processedIncoming = applyPixelFxAtWorkScale("b", incoming, frameWidth, frameHeight, apply);
    context.drawImage(processedOutgoing, 0, 0, frameWidth, frameHeight);
    context.globalAlpha = progress;
    context.drawImage(processedIncoming, 0, 0, frameWidth, frameHeight);
    context.globalAlpha = 1;
    return;
  }

  if (family.kind === "zoomBlur" || family.kind === "flashZoom") {
    // A centered zoom-in plus blur on BOTH sides, ramped by the midpoint-peaking intensity, then a
    // linear cross-dissolve; `flashZoom` adds a white pulse on top afterward — the same order export's
    // zoom → blur → `xfade=fade` → `colorlevels` chain uses.
    const intensity = midpointIntensity(progress);
    const scale = 1 + ZOOM_BLUR_SCALE * intensity;
    const blurPx = ZOOM_BLUR_SIGMA_PX * intensity;
    drawZoomedWithBlur(context, (_alpha, target = context) => target.drawImage(outgoing, 0, 0, frameWidth, frameHeight), frameWidth, frameHeight, scale, blurPx, 1, "a");
    drawZoomedWithBlur(context, (_alpha, target = context) => target.drawImage(incoming, 0, 0, frameWidth, frameHeight), frameWidth, frameHeight, scale, blurPx, progress, "b");
    if (family.kind === "flashZoom") {
      context.fillStyle = "#ffffff";
      context.globalAlpha = FLASH_ZOOM_PEAK * intensity;
      context.fillRect(0, 0, frameWidth, frameHeight);
      context.globalAlpha = 1;
    }
    return;
  }

  if (family.kind === "whipPan") {
    // A `slide` push with a horizontal motion blur that peaks mid-pan. Each side is blurred first and
    // THEN slid, like export (`gblur` with no vertical sigma, then `xfade=slideleft`). Both sides are
    // drawn at full opacity — the old version faded the incoming side in with alpha while it was
    // sliding over empty canvas, which dimmed it to near-black for the first half of the pan.
    const intensity = midpointIntensity(progress);
    const sign = family.edge === "left" ? -1 : 1;
    const apply = (imageData: ImageData, pixelScale: number) => applyHorizontalBlur(imageData, intensity, pixelScale);
    const processedOutgoing = applyPixelFxAtWorkScale("a", outgoing, frameWidth, frameHeight, apply);
    const processedIncoming = applyPixelFxAtWorkScale("b", incoming, frameWidth, frameHeight, apply);
    context.drawImage(processedOutgoing, sign * frameWidth * eased, 0, frameWidth, frameHeight);
    context.drawImage(processedIncoming, -sign * frameWidth * (1 - eased), 0, frameWidth, frameHeight);
    return;
  }

  // crossfade (and legacy dissolve) — a plain linear alpha blend, matching export's `xfade=fade`.
  context.drawImage(outgoing, 0, 0, frameWidth, frameHeight);
  context.globalAlpha = progress;
  context.drawImage(incoming, 0, 0, frameWidth, frameHeight);
  context.globalAlpha = 1;
}

/** Timing a solo reveal needs beyond `reveal` itself: the time-based styles (glitch bursts, ripple
 *  phase) have to be evaluated at the same seconds export evaluates them at. */
export interface SoloRevealTiming {
  /** Seconds since the fade window began. */
  windowElapsed: number;
  windowDuration: number;
  /** Seconds since the clip itself began — the water ripple's wave phase runs on clip time. */
  clipElapsed: number;
  /** True for a fade-out (`reveal` falling), false for a fade-in (`reveal` rising). */
  fadingOut: boolean;
}

/** The SOLO-transition counterpart to `compositeTransitionFrame` — used when there's only ONE real
 *  image to animate (a fade-in/out with no partner clip on the other side), not two. It never draws a
 *  stand-in for the missing side: it clips/fades the ONE real `draw()` call directly against `reveal`
 *  (0 = fully hidden, 1 = fully shown), and whatever's already on `context` (a black clear, or a lower
 *  track's content) shows through wherever `draw()` doesn't paint. `draw` receives an
 *  `alphaMultiplier` for the dissolve family (`drawTransformed` overwrites ambient `globalAlpha` with
 *  the clip's own opacity, so it needs the value passed in), and an optional `targetContext` for the
 *  pixel-math styles that must render onto a scratch canvas first. Export's
 *  `pushSoloTransitionStages` reproduces each branch. */
function compositeSoloReveal(
  context: CanvasRenderingContext2D,
  frameWidth: number,
  frameHeight: number,
  type: TransitionType,
  reveal: number,
  draw: (alphaMultiplier: number, targetContext?: CanvasRenderingContext2D) => void,
  timing: SoloRevealTiming
): void {
  const family = transitionFamily(type);
  const eased = easeTransition(reveal);
  // Peaks at the disappearing/appearing instant and is gone once fully shown — one formula for both
  // directions, since it's the boundary itself that should read as corrupted/blurred.
  const intensity = 1 - reveal;
  context.save();

  if (family.kind === "wipe") {
    context.beginPath();
    if (family.edge === "left") context.rect(frameWidth * (1 - eased), 0, frameWidth * eased, frameHeight);
    else if (family.edge === "right") context.rect(0, 0, frameWidth * eased, frameHeight);
    else if (family.edge === "up") context.rect(0, frameHeight * (1 - eased), frameWidth, frameHeight * eased);
    else context.rect(0, 0, frameWidth, frameHeight * eased);
    context.clip();
    draw(1);
  } else if (family.kind === "slide") {
    // No partner to push out of frame here — the clip simply enters/exits from the named edge.
    const horizontal = family.edge === "left" || family.edge === "right";
    const sign = family.edge === "left" || family.edge === "up" ? -1 : 1;
    context.translate(horizontal ? -sign * frameWidth * (1 - eased) : 0, horizontal ? 0 : -sign * frameHeight * (1 - eased));
    draw(1);
  } else if (family.kind === "slice") {
    const sign = family.direction === "up" ? -1 : 1;
    for (let i = 0; i < SLICE_STRIP_COUNT; i++) {
      const local = easeTransition(sliceStripProgress(reveal, i));
      const { x, width } = sliceStripBounds(frameWidth, i);
      context.save();
      context.beginPath();
      context.rect(x, 0, width, frameHeight);
      context.clip();
      context.translate(0, -sign * frameHeight * (1 - local));
      draw(1);
      context.restore();
    }
  } else if (family.kind === "circle") {
    // `circleOpen`/`circleClose` collapse to the same growing-circle reveal here — with no second
    // image, there's nothing left for the two to differ on.
    const maxRadius = Math.hypot(frameWidth, frameHeight) / 2;
    context.beginPath();
    context.arc(frameWidth / 2, frameHeight / 2, maxRadius * eased, 0, Math.PI * 2);
    context.clip();
    draw(1);
  } else if (family.kind === "glitch" || family.kind === "waterRipple" || family.kind === "whipPan") {
    // Rendered onto a full-frame scratch canvas first (`draw` supports a target context for exactly
    // this), processed at working resolution, then composited with `globalAlpha = reveal`.
    const full = getPixelFxScratchCanvas("full", frameWidth, frameHeight);
    const fullContext = full.getContext("2d")!;
    fullContext.clearRect(0, 0, frameWidth, frameHeight);
    draw(1, fullContext);
    let dx = 0;
    let processed: HTMLCanvasElement;
    if (family.kind === "glitch") {
      const burstIndex = glitchCutBurstIndex(timing.windowElapsed);
      const burstProgress = glitchCutBurstProgress(burstIndex, timing.windowDuration);
      // Evaluated once per burst (not per frame) so every frame inside a burst is identical — export
      // can only change `rgbashift` between bursts.
      const burst = glitchCutBurst(burstIndex, timing.fadingOut ? burstProgress : 1 - burstProgress);
      processed = applyPixelFxAtWorkScale("a", full, frameWidth, frameHeight, (imageData) => applyGlitchCut(imageData, burst));
      context.imageSmoothingEnabled = false;
    } else if (family.kind === "waterRipple") {
      processed = applyPixelFxAtWorkScale("a", full, frameWidth, frameHeight, (imageData, pixelScale) =>
        applyWaterRipple(imageData, timing.clipElapsed, 1, intensity, pixelScale)
      );
    } else {
      // Whip pan: blurred first, then slid in/out from the named edge — same order as the two-clip case.
      const sign = family.edge === "left" ? -1 : 1;
      dx = -sign * frameWidth * (1 - eased);
      processed = applyPixelFxAtWorkScale("a", full, frameWidth, frameHeight, (imageData, pixelScale) => applyHorizontalBlur(imageData, intensity, pixelScale));
    }
    context.globalAlpha = reveal;
    context.drawImage(processed, dx, 0, frameWidth, frameHeight);
  } else if (family.kind === "zoomBlur" || family.kind === "flashZoom") {
    const scale = 1 + ZOOM_BLUR_SCALE * intensity;
    const blurPx = ZOOM_BLUR_SIGMA_PX * intensity;
    // Flatten first: drawTransformed sets its own filter and opacity, which would overwrite the
    // transition's blur and reveal alpha if called directly inside drawZoomedWithBlur.
    const full = getPixelFxScratchCanvas("full", frameWidth, frameHeight);
    const fullContext = full.getContext("2d")!;
    fullContext.clearRect(0, 0, frameWidth, frameHeight);
    draw(1, fullContext);
    drawZoomedWithBlur(context, (_alpha, target = context) => target.drawImage(full, 0, 0, frameWidth, frameHeight), frameWidth, frameHeight, scale, blurPx, reveal, "a");
    if (family.kind === "flashZoom") {
      // `drawZoomedWithBlur` already undid its own zoom, so this covers the frame at normal scale.
      context.fillStyle = "#ffffff";
      context.globalAlpha = FLASH_ZOOM_PEAK * intensity;
      context.fillRect(0, 0, frameWidth, frameHeight);
    }
  } else {
    // crossfade (and legacy dissolve) — a plain alpha reveal.
    context.globalAlpha = reveal;
    draw(reveal);
  }

  context.restore();
}

/** How far a media element may drift from the master clock before it gets HARD re-seeked. Deliberately
 *  large — reserved for a genuinely large, discontinuous jump (scrubbing, the playhead landing on a
 *  brand new clip, resuming after a throttled/backgrounded tab), NOT the everyday correction mechanism.
 *
 *  This used to be 0.2s, tuned assuming drift accumulates slowly (ordinary clock-crystal mismatch
 *  between `performance.now()`, which the master clock in `tick` accumulates, and the element's own
 *  internal playback clock). Direct instrumentation of the real elements during playback (recording
 *  every `seeking`/`waiting`/`seeked` event with timestamps) disproved that: drift regularly ballooned
 *  PAST 0.2s within ~150ms of a `play()` or a seek, not over many seconds — a real per-element STARTUP
 *  LATENCY before it actually begins producing samples, not slow clock jitter. At the OLD, tight 0.2s
 *  threshold this forced a hard seek almost immediately after every play/seek, and a hard seek is even
 *  MORE disruptive than a click: it's a genuine re-buffer, an observed `waiting` (stalled/silent) state
 *  until the seek target re-buffers, THEN resuming — which reintroduces the exact same startup latency,
 *  which soon re-triggers ANOTHER hard seek. That repeating cycle — not slow drift — is what actually
 *  produced the reported "periodic clicks/pops": confirmed via the captured event log, seeks recurring
 *  roughly every 0.7-2s throughout ordinary playback, every single one following the identical seek→
 *  waiting→seeked pattern. Raised high enough that the proportional `playbackRate` correction below (see
 *  `MAX_DRIFT_CORRECTION_RATE_DELTA`) can absorb even that startup-latency spike without ever reaching
 *  this threshold in ordinary use, breaking the cycle instead of just tuning how often it repeats. */
const DRIFT_TOLERANCE = 1.5;
/** How far a PAUSED element's frame may sit from the playhead before it's re-seeked. Deliberately a
 *  completely different number from `DRIFT_TOLERANCE`, and deliberately NOT gated behind anything —
 *  the two tolerances exist for unrelated problems. `DRIFT_TOLERANCE`'s own 1.5s is tuned around a
 *  PLAYING element's startup-latency spike (see its own doc comment); a paused element isn't playing,
 *  isn't buffering toward a moving target, and has none of that latency to absorb — it's just sitting
 *  at a stale position. Reusing the large playing-only tolerance for the paused case meant frame-
 *  stepping, scrubbing, and clicking the ruler routinely left the picture up to 1.5s stale — a real,
 *  reported bug: split-at-playhead, trim, and any transform edit all depend on seeing the frame that's
 *  actually at the playhead. Under half a frame at 24fps, so every small step lands; verified against
 *  the export dialog's own fine-grained scrub, which already needed exactly this tolerance (this
 *  constant used to be its own opt-in `PRECISE_SCRUB_TOLERANCE`, turned on only there — now this IS
 *  the paused tolerance unconditionally, since there was never a real reason ordinary paused editing
 *  should be any less accurate than export's own scrub preview). `holdLastCompleteFrame` (see its own
 *  doc comment) is what keeps a seek at this tight a tolerance from flickering black on every step. */
const PAUSED_SEEK_TOLERANCE = 0.02;
/** Below this, drift is left alone entirely — small enough (one frame or so at 30fps) that neither a
 *  seek nor a rate nudge would be perceptible, and constantly fighting sub-frame jitter would just be
 *  wasted `playbackRate` churn for no audible benefit. Between this and `DRIFT_TOLERANCE`, `syncMedia`
 *  gently speeds up or slows down the element instead of seeking. */
const DRIFT_CORRECTION_TOLERANCE = 0.03;
/** The STRONGEST `playbackRate` offset the proportional correction below will ever apply — reached only
 *  as drift approaches `DRIFT_TOLERANCE` itself (see `syncMedia`'s own interpolation between the two
 *  tolerances). Scaled by how far off the element actually is, rather than one flat nudge regardless of
 *  magnitude — a flat small nudge (this file's own earlier attempt, ±4% always) is what let the startup-
 *  latency spike documented on `DRIFT_TOLERANCE` blow straight through it and force a seek anyway: 4% can
 *  only close a gap by roughly 4% of elapsed real time, nowhere near fast enough for a spike that reaches
 *  0.2s in ~150ms. 50% at the top of the range closes even a near-`DRIFT_TOLERANCE`-sized gap in around a
 *  second — a brief, noticeable-if-you're-listening-for-it pitch/speed change, but nowhere near as
 *  jarring as the seek-induced silence gap it replaces, and it tapers back toward a barely-perceptible
 *  nudge as drift shrinks back toward `DRIFT_CORRECTION_TOLERANCE`. */
const MAX_DRIFT_CORRECTION_RATE_DELTA = 0.5;
/** Longest the master clock will stand still waiting for a video that is mid-seek or still buffering.
 *  A cap, so an element that never becomes ready can't freeze the whole timeline. */
const MAX_MEDIA_WAIT_MS = 4000;

/** Whether this tick's clock should hold instead of advancing: a video under the playhead was still
 *  seeking/buffering last frame, and that wait hasn't yet run past `MAX_MEDIA_WAIT_MS`.
 *
 *  Reported from an iPad: three hard seeks in five seconds, readyState 4, fully buffered, no error. A
 *  precise seek there took roughly as long as `DRIFT_TOLERANCE`, so the clock ran that far ahead during
 *  it and the element landed already out of tolerance — seek, land, seek again, forever, showing about
 *  one frame per landing. Desktop and Android seek in well under 100ms, which is why only iOS looped.
 *  Holding the clock for the seek means it lands exactly where the clock is. */
export function shouldHoldClockForMedia(mediaWaitingLastFrame: boolean, mediaWaitSince: number | null, now: number): boolean {
  if (!mediaWaitingLastFrame) return false;
  return mediaWaitSince === null || now - mediaWaitSince < MAX_MEDIA_WAIT_MS;
}
/** A seek still pending after this long is re-issued once. Only a backstop: WebKit can drop a seek's
 *  completion when something interrupts it, leaving `seeking` true forever with the data fully
 *  buffered (reported from an iPhone: readyState 4, buffered end-to-end, no error, stuck seeking).
 *  Generous so a genuinely slow network seek isn't restarted into a livelock. */
const SEEK_STUCK_MS = 2000;
/** Smallest `playbackRate` change worth issuing. Drift moves a little every frame, so an unthrottled
 *  correction rewrites the rate ~60 times a second; on Safari each write reaches the native player. */
const PLAYBACK_RATE_EPSILON = 0.02;

export interface MediaSyncState {
  currentTime: number;
  playbackRate: number;
  seeking: boolean;
  /** How long the element has been continuously seeking; 0 when it isn't. */
  seekingForMs: number;
}

export interface MediaSyncAction {
  /** `playbackRate` to assign, or null to leave it. Callers must apply this BEFORE `seekTo`. */
  playbackRate: number | null;
  /** `currentTime` to seek to, or null for no seek. */
  seekTo: number | null;
}

/** Apple's WebKit: Safari on every platform, and every browser on iPhone/iPad (Apple requires WebKit
 *  there, so iOS "Chrome"/"Firefox"/"Edge" identify as `CriOS`/`FxiOS`/`EdgiOS`, never `Chrome/`).
 *  Its video elements sit on AVFoundation, where each `playbackRate` write briefly stalls playback.
 *  Reported from an iPad: element fully buffered, not paused, not seeking, yet its own clock advancing
 *  at 5% of real time (`advanceRatio` 0.053) with drawing costing under 1ms a frame. Rate nudging
 *  rewrote the rate many times a second as drift changed; each write stalled the element, adding more
 *  drift and more writes. Chrome and Firefox apply rate changes for free, which is why only iOS lagged. */
export function isAppleWebKit(userAgent: string): boolean {
  return /AppleWebKit\//.test(userAgent) && !/Chrome\/|Chromium\/|Android/.test(userAgent);
}

/** Decides how to pull one video element back onto the master clock — pure, so the rules below are
 *  unit-tested rather than trusted.
 *
 *  The load-bearing rule is the first branch: an element that is mid-seek is left completely alone.
 *  While a seek is in flight `currentTime` already reads as the target, so the clock pulls ahead and
 *  the drift branch below used to nudge `playbackRate` on every frame for the whole seek. On an iPhone
 *  that produced a seek that never finished — `seeking: true` indefinitely with the file fully
 *  buffered and no media error — freezing the picture after a few seconds of normal playback; the
 *  hard reseek every `DRIFT_TOLERANCE` seconds that followed was interrupted the same way.
 *
 *  `allowRateCorrection` false (Apple WebKit — see `isAppleWebKit`) turns off the gradual
 *  `playbackRate` nudge entirely; drift is then only ever closed by a hard seek. */
export function planMediaSync(
  state: MediaSyncState,
  sourceTime: number,
  playing: boolean,
  allowRateCorrection = true,
  pausedSeekTolerance = DRIFT_TOLERANCE,
  targetPlaybackRate = 1
): MediaSyncAction {
  const none: MediaSyncAction = { playbackRate: null, seekTo: null };

  if (state.seeking) {
    if (state.seekingForMs < SEEK_STUCK_MS) return none;
    return { playbackRate: state.playbackRate !== targetPlaybackRate ? targetPlaybackRate : null, seekTo: sourceTime };
  }

  // Positive: the element is AHEAD of where it should be (needs to slow down/seek back). Negative:
  // it's BEHIND (needs to speed up/seek forward).
  const drift = state.currentTime - sourceTime;
  const absDrift = Math.abs(drift);

  if (absDrift > (playing ? DRIFT_TOLERANCE : pausedSeekTolerance)) {
    // A real jump (scrub, clip switch, a tab that was throttled/backgrounded) — nothing gradual could
    // close a gap this size fast enough to matter, so snap, resetting any in-progress nudge first.
    return { playbackRate: state.playbackRate !== targetPlaybackRate ? targetPlaybackRate : null, seekTo: sourceTime };
  }

  if (playing && allowRateCorrection && absDrift > DRIFT_CORRECTION_TOLERANCE) {
    // Proportional, not flat — see `MAX_DRIFT_CORRECTION_RATE_DELTA`'s own doc comment. Interpolates
    // from ~0 at the dead-zone edge up to the max rate at `DRIFT_TOLERANCE` itself.
    const t = Math.min(1, (absDrift - DRIFT_CORRECTION_TOLERANCE) / (DRIFT_TOLERANCE - DRIFT_CORRECTION_TOLERANCE));
    const delta = MAX_DRIFT_CORRECTION_RATE_DELTA * t;
    const target = targetPlaybackRate * (drift > 0 ? Math.max(0.1, 1 - delta) : 1 + delta);
    return Math.abs(target - state.playbackRate) >= PLAYBACK_RATE_EPSILON ? { playbackRate: target, seekTo: null } : none;
  }

  // Back within the dead zone (or paused) — stop nudging.
  return state.playbackRate !== targetPlaybackRate ? { playbackRate: targetPlaybackRate, seekTo: null } : none;
}

/** How long a video element may stay paused/seeking/under-buffered while the transport is playing
 *  before `watchForStall` reports it. Long enough that ordinary start-up buffering never trips it. */
const STALL_REPORT_MS = 4000;
/** Hard reseeks per second of playback past which an element counts as stalled even though its
 *  `currentTime` keeps changing. An element whose own clock is frozen drifts 1s per second and gets
 *  hard-reseeked each time drift passes `DRIFT_TOLERANCE`, i.e. roughly every 1.5s; normal playback
 *  only reseeks at clip starts and scrubs. */
const STALL_RESEEKS_PER_SECOND = 0.4;

function pushRolling(buffer: number[], value: number, limit = 90): void {
  buffer.push(value);
  if (buffer.length > limit) buffer.shift();
}

function average(values: number[]): number {
  return values.length === 0 ? 0 : values.reduce((sum, v) => sum + v, 0) / values.length;
}

interface StallWatchEntry {
  rateWrites: number;
  rateSampleAt: number;
  rateSampleTime: number;
  hardSeeksAtSample: number;
  lastAdvanceRatio: number | null;
  slowSamples: number;
  startedAt: number;
  lastSeenAt: number;
  notProgressingSince: number | null;
  hardSeeks: number;
  lastProbeAt: number;
  pixelHash: number | null;
  pixelChangedAt: number;
  timeAtPixelChange: number;
}
/** Media elements kept alive after they stop being needed. Keeping a few around makes scrubbing back
 *  and forth across a cut smooth, since the element is already decoded and buffered. */
const POOL_LIMIT = 8;
/** How far the store's own `playhead` (see `internalClockTime`'s doc comment) may disagree with this
 *  engine's own running clock before it's treated as a REAL external change — a timeline scrub, a
 *  fresh `play()` — rather than the store's own frame-snapping talking back to itself. Discovered via
 *  direct instrumentation of `AudioMixEngine`'s scheduling decisions this session: at a 60Hz `tick()`
 *  cadence against a 30fps project (a common, not edge-case, ratio), `Math.round`-based frame-snapping
 *  produces a "flat, flat, jump" staircase rather than true jitter — and because each tick's `time` was
 *  being RE-DERIVED from that already-snapped store value (see the bug this constant fixes), the error
 *  didn't stay bounded to one frame, it visibly grew past 90ms within a handful of ticks. Comfortably
 *  above a worst-case single-frame snap error even at a low 12fps project (~40ms) and still far below
 *  any real user seek (which jumps by a meaningful fraction of a second at minimum). */
const INTERNAL_CLOCK_RESYNC_TOLERANCE = 0.1;

/** `ClipEffects` → one CSS `filter` string for `context.filter`. A pure, standalone function (not a
 *  method) so it's directly unit-testable without a canvas — the one non-obvious piece here is the
 *  brightness conversion: FFmpeg's `eq=brightness=` is additive (0 = unchanged) but CSS `brightness()`
 *  is multiplicative (100% = unchanged), so `-1..1` is mapped onto `0%..200%` around that midpoint.
 *  See `ClipEffects`'s own doc comment for why this (and `blur`, a different kernel than FFmpeg's
 *  `gblur`) are documented approximations, not exact matches for what export produces. */
export function buildCanvasFilterString(effects: ClipEffects, blurScale = 1): string {
  if (isIdentityEffects(effects)) return "none";
  return (
    `brightness(${100 + effects.brightness * 100}%) ` +
    `contrast(${effects.contrast * 100}%) ` +
    `saturate(${effects.saturation * 100}%) ` +
    `blur(${effects.blur * blurScale}px)`
  );
}

/** Feature-detects whether this browser's Canvas 2D `context.filter` actually applies anything, rather
 *  than assuming from a user-agent string. Confirmed live against caniuse's own compatibility data, not
 *  assumed: Safari — desktop AND iOS, every browser there runs the same WebKit engine, "Brave"/"Chrome"
 *  on an iPhone/iPad included — has shipped this API "disabled by default" through every version up to
 *  and including its own latest release as of writing. `context.filter` is a completely silent no-op
 *  there: brightness/contrast/saturation/blur simply never visually change anything, with no error or
 *  console warning to notice it by — confirmed as the real, reported cause of "effects don't work on
 *  mobile/tablet" (every device in that report runs Safari's engine under the hood), not a guess.
 *  `drawTransformed` below falls back to `applyManualEffects`' own pixel-math implementation whenever
 *  this returns `false`.
 *
 *  Draws one filled pixel with an easily-checked filter applied and reads the result back — memoized
 *  (computed once; this can't meaningfully change mid-session) since a real canvas draw + readback
 *  isn't free enough to repeat every frame. */
let cachedFilterSupport: boolean | null = null;
export function supportsCanvasFilter(): boolean {
  if (cachedFilterSupport !== null) return cachedFilterSupport;
  try {
    const canvas = document.createElement("canvas");
    canvas.width = 1;
    canvas.height = 1;
    const ctx = canvas.getContext("2d");
    if (!ctx) {
      cachedFilterSupport = false;
      return false;
    }
    ctx.filter = "invert(1)";
    ctx.fillStyle = "rgb(100, 100, 100)";
    ctx.fillRect(0, 0, 1, 1);
    const [r] = ctx.getImageData(0, 0, 1, 1).data;
    // A real invert() flips 100 to 155; an ignored filter leaves the plain fill color, 100, in place.
    cachedFilterSupport = r > 120;
  } catch {
    cachedFilterSupport = false;
  }
  return cachedFilterSupport;
}

/** A separable box blur (horizontal pass, then vertical) — not the true Gaussian FFmpeg's own `gblur`
 *  produces (a real Gaussian needs a much wider, weighted kernel), but visually close enough at the
 *  small radii `ClipEffects.blur` is actually used at in practice (this app's own presets top out at
 *  3) — same "documented approximation, not an exact match" territory that field's own doc comment
 *  already accepts for the CSS `blur()` path this replaces on a browser `supportsCanvasFilter` reports
 *  `false` for. Edge pixels clamp to the nearest real one (never sample past the frame) rather than
 *  wrapping or padding with black, so a blurred edge fades toward its own edge color, not toward black.
 *
 *  Each pass is a SLIDING-WINDOW sum, O(width×height) total regardless of `radius` — NOT the naive
 *  "resum the whole window at every pixel" approach (O(width×height×radius)) this used to be. That
 *  naive version was a real, reported performance bug, not just a theoretical inefficiency: at
 *  `ZOOM_BLUR_SIGMA_PX` (18px) over a full sequence-resolution frame (`compositeTransitionFrame` always
 *  runs at `project.sequence.width/height`, e.g. 1080×1920, regardless of how small the on-screen
 *  canvas actually is — see `drawFrame`'s own `frameWidth`/`frameHeight`), the old approach needed on
 *  the order of a BILLION array reads per animation frame across both the outgoing and incoming panels
 *  a zoomBlur/flashZoom transition draws — measured directly as a multi-hundred-millisecond stall per
 *  frame on real mobile hardware, which is what actually produced the "transition freezes on a stuck,
 *  half-composited frame" bug a user recorded and reported, not a rendering-correctness bug. The
 *  sliding-window sum below updates each pixel's window sum in O(1) from its neighbor's (adding the
 *  pixel entering the window, removing the one leaving it — both still resolved through the same
 *  clamp-to-edge index function, which is what keeps this mathematically identical to the naive
 *  version's own edge behavior, not merely visually close to it), cutting the cost by roughly
 *  `2×radius+1` — over 30× at this radius — comfortably inside a single frame's budget. */
function applyBoxBlur(imageData: ImageData, radius: number): void {
  const r = Math.round(radius);
  if (r <= 0) return;
  const { width, height, data } = imageData;
  const windowSize = r * 2 + 1;
  const horizontal = new Float32Array(data.length);
  const clampX = (x: number) => (x < 0 ? 0 : x >= width ? width - 1 : x);
  const clampY = (y: number) => (y < 0 ? 0 : y >= height ? height - 1 : y);

  for (let y = 0; y < height; y++) {
    const rowOffset = y * width * 4;
    for (let c = 0; c < 4; c++) {
      let sum = 0;
      for (let k = -r; k <= r; k++) sum += data[rowOffset + clampX(k) * 4 + c];
      horizontal[rowOffset + c] = sum / windowSize;
      for (let x = 1; x < width; x++) {
        sum -= data[rowOffset + clampX(x - 1 - r) * 4 + c];
        sum += data[rowOffset + clampX(x + r) * 4 + c];
        horizontal[rowOffset + x * 4 + c] = sum / windowSize;
      }
    }
  }

  for (let x = 0; x < width; x++) {
    for (let c = 0; c < 4; c++) {
      let sum = 0;
      for (let k = -r; k <= r; k++) sum += horizontal[(clampY(k) * width + x) * 4 + c];
      data[x * 4 + c] = sum / windowSize;
      for (let y = 1; y < height; y++) {
        sum -= horizontal[(clampY(y - 1 - r) * width + x) * 4 + c];
        sum += horizontal[(clampY(y + r) * width + x) * 4 + c];
        data[(y * width + x) * 4 + c] = sum / windowSize;
      }
    }
  }
}

/** Manual pixel-math equivalent of `buildCanvasFilterString`'s CSS filter — what `drawTransformed`
 *  falls back to when `supportsCanvasFilter()` is `false` (Safari/WebKit, every version — see that
 *  function's own doc comment). Implements FFmpeg's own `eq` filter formula directly on the STORED
 *  additive/multiplicative values (see `ClipEffects.brightness`/`.contrast`/`.saturation`'s own doc
 *  comments) rather than going through the CSS conversion `buildCanvasFilterString` needs — actually a
 *  slightly closer match to what export produces than the CSS path this replaces ever was, not just an
 *  equivalent. Contrast pivots around the frame's own midpoint (0.5 in normalized space) with brightness
 *  added afterward, matching `eq`'s own order; saturation blends each channel toward the pixel's own
 *  BT.601 luma (the same weights FFmpeg's `eq` filter uses for its saturation control — a straight R/G/B
 *  average would shift the perceived brightness of already-saturated colors). Blur is applied last, via
 *  `applyBoxBlur` above, matching `buildCanvasFilterString`'s own function order (brightness → contrast
 *  → saturate → blur). Assigning into a `Uint8ClampedArray` already clamps/rounds to a valid byte on its
 *  own; nothing here needs its own explicit clamp. */
export function applyManualEffects(imageData: ImageData, effects: ClipEffects): void {
  const { data } = imageData;
  const { brightness, contrast, saturation } = effects;
  for (let i = 0; i < data.length; i += 4) {
    let r = data[i] / 255;
    let g = data[i + 1] / 255;
    let b = data[i + 2] / 255;

    r = (r - 0.5) * contrast + 0.5 + brightness;
    g = (g - 0.5) * contrast + 0.5 + brightness;
    b = (b - 0.5) * contrast + 0.5 + brightness;

    if (saturation !== 1) {
      const gray = 0.299 * r + 0.587 * g + 0.114 * b;
      r = gray + (r - gray) * saturation;
      g = gray + (g - gray) * saturation;
      b = gray + (b - gray) * saturation;
    }

    data[i] = r * 255;
    data[i + 1] = g * 255;
    data[i + 2] = b * 255;
  }
  if (effects.blur > 0) applyBoxBlur(imageData, effects.blur);
}

/** Multiplies source alpha by a rectangle/ellipse mask. Coordinates are normalized to the clip's
 *  visible post-crop source rectangle so preview and FFmpeg use the same local space. */
export function applyClipMask(imageData: ImageData, mask: ClipMask, crop: ClipTransform["crop"]): void {
  const { width, height, data } = imageData;
  const x0 = crop.left * width;
  const y0 = crop.top * height;
  const visibleWidth = Math.max(1, width * (1 - crop.left - crop.right));
  const visibleHeight = Math.max(1, height * (1 - crop.top - crop.bottom));
  const feather = mask.feather;
  for (let y = 0; y < height; y++) {
    const ny = (y + 0.5 - y0) / visibleHeight;
    for (let x = 0; x < width; x++) {
      const nx = (x + 0.5 - x0) / visibleWidth;
      let signed: number;
      if (mask.shape === "ellipse") {
        const rx = Math.max(0.005, mask.width / 2);
        const ry = Math.max(0.005, mask.height / 2);
        signed = 1 - Math.hypot((nx - mask.centerX) / rx, (ny - mask.centerY) / ry);
      } else {
        signed = Math.min(mask.width / 2 - Math.abs(nx - mask.centerX), mask.height / 2 - Math.abs(ny - mask.centerY));
      }
      const alpha = feather > 0 ? Math.min(1, Math.max(0, signed / feather + 0.5)) : signed >= 0 ? 1 : 0;
      data[(y * width + x) * 4 + 3] *= mask.invert ? 1 - alpha : alpha;
    }
  }
}

/** A Gaussian blur of standard deviation `sigma`, approximated by three successive box blurs (the
 *  classic "boxes for Gauss" construction) — what the manual fallback paths use so their blur matches
 *  both CSS `blur(σ)` and export's `gblur=sigma=σ`, which are both true Gaussians with σ as the
 *  standard deviation. A single `applyBoxBlur(σ)` pass (what these paths used to run) has a standard
 *  deviation of only about σ/√3 and a hard-edged, boxy falloff, so Safari's preview blur was both
 *  weaker and a different shape from everything else. */
function applyGaussianBlur(imageData: ImageData, sigma: number): void {
  if (sigma <= 0.05) return;
  const passes = 3;
  const idealWidth = Math.sqrt((12 * sigma * sigma) / passes + 1);
  let lowerWidth = Math.floor(idealWidth);
  if (lowerWidth % 2 === 0) lowerWidth--;
  const upperWidth = lowerWidth + 2;
  const lowerCount = Math.round(
    (12 * sigma * sigma - passes * lowerWidth * lowerWidth - 4 * passes * lowerWidth - 3 * passes) / (-4 * lowerWidth - 4)
  );
  for (let i = 0; i < passes; i++) {
    const width = i < lowerCount ? lowerWidth : upperWidth;
    applyBoxBlur(imageData, (width - 1) / 2);
  }
}

/** Long-edge cap (pixels) for the WORKING canvas `applyDownsampledBlur` actually runs `getImageData`/
 *  `applyBoxBlur`/`putImageData` against — see that function's own doc comment for why a fixed small
 *  size, not the caller's real resolution, is what keeps blur inside a real frame budget. */
const MAX_BLUR_WORK_DIMENSION = 480;

/** Blurs `source` (`width`×`height`) by `blurPx`, working at a capped resolution regardless of how
 *  large `width`×`height` actually is — the fix for a real, reported performance bug (not merely a
 *  theoretical inefficiency): even `applyBoxBlur`'s own sliding-window pass is still `O(width×height)`,
 *  and a `getImageData`/`putImageData` round trip at a real sequence or source-video resolution (often
 *  1080×1920 or considerably larger) measured at HUNDREDS of milliseconds per call on real hardware —
 *  independent of blur radius, since pixel COUNT, not radius, dominates once the naive O(radius) cost
 *  is already gone. That's slow enough, every single animation frame a blurred clip or a zoomBlur/
 *  flashZoom transition is on screen, to freeze the whole preview on a stuck frame for a visible
 *  stretch — confirmed directly from a user's own screen recording of a transition into a text clip.
 *  Blurring at a small WORKING size instead and letting the browser's own smoothed `drawImage` scaling
 *  handle both the downscale in and the upscale back out fixes this: blur is inherently a softening
 *  operation, so the resolution lost along the way is invisible once composited — not a visible quality
 *  compromise at the radii this ever actually runs at, just a much smaller buffer to push through the
 *  expensive part. `blurPx` is scaled down by the same factor as the working size so the RESULT still
 *  reads as the same absolute blur strength once drawn back at full size, not a weaker one. Returns a
 *  canvas (not a mutated `ImageData`) since every caller composites the result via `drawImage`, the same
 *  "processed result ready to draw" contract `applyPixelFxToImage` already has. */
function applyDownsampledBlur(source: CanvasImageSource, width: number, height: number, blurPx: number, scratchSlot: "a" | "b"): HTMLCanvasElement {
  const workScale = Math.min(1, MAX_BLUR_WORK_DIMENSION / Math.max(width, height));
  const workWidth = Math.max(1, Math.round(width * workScale));
  const workHeight = Math.max(1, Math.round(height * workScale));
  const canvas = getPixelFxScratchCanvas(scratchSlot, workWidth, workHeight);
  const ctx = canvas.getContext("2d", { willReadFrequently: true })!;
  ctx.clearRect(0, 0, workWidth, workHeight);
  ctx.drawImage(source, 0, 0, workWidth, workHeight);
  const imageData = ctx.getImageData(0, 0, workWidth, workHeight);
  applyGaussianBlur(imageData, blurPx * workScale);
  ctx.putImageData(imageData, 0, 0);
  return canvas;
}

/** Draws a zoomed, optionally blurred frame — `zoomBlur`/`flashZoom`'s own shared "scale about center,
 *  blur by `blurPx`" compositing step, used by both the two-clip transition (`compositeTransitionFrame`)
 *  and solo-reveal (`compositeSoloReveal`) paths.
 *
 *  A real, reported bug: both call sites used to set `context.filter = "blur(...)"` directly and rely
 *  on the browser to actually apply it — `supportsCanvasFilter()`'s own doc comment already documents
 *  that Safari/WebKit (every version, desktop AND iOS) silently no-ops `context.filter` entirely, which
 *  is exactly the "effects don't work as they should on some devices" class of bug the OTHER effects
 *  pipeline (`ClipEffects`/`needsManualEffects`) was already fixed for, just never applied here. On an
 *  affected browser these two transitions rendered as a plain zoom (still real — the scale itself is a
 *  canvas transform, not a filter) with NO blur at all, while Chrome/Firefox/desktop showed the
 *  intended motion-blur look.
 *
 *  `draw` paints onto `target` at the given alpha — `compositeSoloReveal`'s own `draw(alpha, target?)`
 *  signature, reused verbatim (a plain `context.drawImage` wrapper would work identically for
 *  `compositeTransitionFrame`'s two-image case, since both just need "paint SOMETHING onto a context").
 *  When a manual blur is needed, `draw` is redirected onto a small WORKING canvas (capped to
 *  `MAX_BLUR_WORK_DIMENSION` regardless of `frameWidth`×`frameHeight` — see `applyDownsampledBlur`'s own
 *  doc comment for why blurring at the sequence's real resolution here was a real, reported performance
 *  bug, not merely a correctness one) with the zoom scale folded directly into that same downscale
 *  transform, so there's no full-resolution intermediate draw at all — the zoom transform still bakes
 *  in BEFORE the blur samples neighboring pixels, same as before, just at the smaller working size from
 *  the start. That result is then drawn onto `context` at `alpha`, upscaled by the browser's own
 *  smoothed `drawImage` scaling. When no manual blur is needed (blur is genuinely off, or the browser
 *  actually supports `context.filter`), this instead takes the original fast direct-context path with
 *  no extra canvas/readback cost. */
function drawZoomedWithBlur(
  context: CanvasRenderingContext2D,
  draw: (alphaMultiplier: number, targetContext?: CanvasRenderingContext2D) => void,
  frameWidth: number,
  frameHeight: number,
  scale: number,
  blurPx: number,
  alpha: number,
  scratchSlot: "a" | "b"
): void {
  if (blurPx > 0.05 && !supportsCanvasFilter()) {
    const workScale = Math.min(1, MAX_BLUR_WORK_DIMENSION / Math.max(frameWidth, frameHeight));
    const workWidth = Math.max(1, Math.round(frameWidth * workScale));
    const workHeight = Math.max(1, Math.round(frameHeight * workScale));
    const scratch = getPixelFxScratchCanvas(scratchSlot, workWidth, workHeight);
    const scratchContext = scratch.getContext("2d", { willReadFrequently: true })!;
    scratchContext.clearRect(0, 0, workWidth, workHeight);
    scratchContext.save();
    scratchContext.scale(workScale, workScale);
    scratchContext.translate(frameWidth / 2, frameHeight / 2);
    scratchContext.scale(scale, scale);
    scratchContext.translate(-frameWidth / 2, -frameHeight / 2);
    draw(1, scratchContext);
    scratchContext.restore();
    const imageData = scratchContext.getImageData(0, 0, workWidth, workHeight);
    applyGaussianBlur(imageData, blurPx * workScale);
    scratchContext.putImageData(imageData, 0, 0);
    context.globalAlpha = alpha;
    context.drawImage(scratch, 0, 0, frameWidth, frameHeight);
    context.globalAlpha = 1;
  } else {
    const priorFilter = context.filter;
    // Scaled to device pixels — see `deviceScaleOf`. Measured BEFORE the zoom transform below, so the
    // blur stays in output-frame units, like export's `gblur` after its own zoom.
    context.filter = blurPx > 0.05 ? `blur(${blurPx * deviceScaleOf(context)}px)` : "none";
    context.globalAlpha = alpha;
    context.save();
    context.translate(frameWidth / 2, frameHeight / 2);
    context.scale(scale, scale);
    context.translate(-frameWidth / 2, -frameHeight / 2);
    draw(1);
    context.restore();
    context.globalAlpha = 1;
    context.filter = priorFilter;
  }
}

/** Mutates `imageData` in place, zeroing (or feathering) alpha on pixels near `settings.color` —
 *  Canvas2D has no native chroma-key filter, so this is a plain, unit-testable pixel loop rather than
 *  a `context.filter` string. Deliberately mirrors FFmpeg's own `colorkey` filter's algorithm (not just
 *  its parameter names) so the preview and `buildExportPlan`'s `colorkey=` filter agree as closely as
 *  possible — see `ChromaKeySettings`'s own doc comment. Per pixel: normalized Euclidean RGB distance
 *  from the key color (0..1, `/sqrt(3)` so pure-white-vs-pure-black is exactly 1) — at or under
 *  `similarity`, fully transparent; within `smoothness` beyond that, a linear alpha ramp (FFmpeg's own
 *  `blend`); further than that, unchanged. Multiplies the EXISTING alpha rather than overwriting it, so
 *  this composes correctly if the source ever already carried partial alpha of its own. */
export function applyChromaKey(imageData: ImageData, settings: ChromaKeySettings): void {
  const keyR = parseInt(settings.color.slice(1, 3), 16);
  const keyG = parseInt(settings.color.slice(3, 5), 16);
  const keyB = parseInt(settings.color.slice(5, 7), 16);
  const similarity = settings.similarity;
  const smoothness = settings.smoothness;
  const data = imageData.data;
  const norm = Math.sqrt(3) * 255;
  for (let i = 0; i < data.length; i += 4) {
    const dr = data[i] - keyR;
    const dg = data[i + 1] - keyG;
    const db = data[i + 2] - keyB;
    const diff = Math.sqrt(dr * dr + dg * dg + db * db) / norm;
    let keyAlpha: number;
    if (diff <= similarity) keyAlpha = 0;
    else if (smoothness > 0 && diff < similarity + smoothness) keyAlpha = (diff - similarity) / smoothness;
    else keyAlpha = 1;
    if (keyAlpha < 1) data[i + 3] = Math.round(data[i + 3] * keyAlpha);
  }
}

export interface PlaybackHost {
  getProject: () => Project | null;
  getPlayhead: () => number;
  isPlaying: () => boolean;
  /** Called as the master clock advances during playback. */
  onTimeUpdate: (seconds: number) => void;
  /** Called when playback runs off the end of the timeline. */
  onEnded: () => void;
  /** Called when a media element's own `element.play()` call is REJECTED by the browser's autoplay
   *  policy — see `syncMedia`'s own doc comment for the real, confirmed bug this exists to recover
   *  from: without it, a rejected `play()` silently retries and silently fails forever (every tick
   *  calls it again, and every one of those calls is just as gesture-less as the last, so nothing ever
   *  self-heals), while the master clock keeps advancing regardless — "the timeline moves but the
   *  video never plays," a real, reported symptom, not a hypothetical one. This is the recovery path:
   *  stop the WHOLE transport (matching what `onEnded` already does) so the UI's own Play button
   *  reflects reality and the user's very next tap is a genuine, fresh gesture — which autoplay policy
   *  DOES allow — instead of the clock and the picture silently drifting apart forever. */
  onPlaybackBlocked: () => void;
  /** Called at most once per clip per page load when a video element stays stuck while the transport
   *  is playing. Carries the element's own media state so a platform-specific failure (iOS Safari
   *  especially, which can't be reproduced off-device) arrives as evidence rather than a guess. */
  onPlaybackStall?: (details: Record<string, unknown>) => void;
  /** Called once per page load, three seconds into playback over an audio-track clip, with the audio
   *  engine's own state (`phase: "playing-3s"` — see `maybeReportAudio`), and once per audio file whose
   *  load was slow, retried or failed (`phase: "buffer-settled"`). */
  onAudioReport?: (details: Record<string, unknown>) => void;
  /** Resolves an asset to a streamable URL — injected so this class needs no knowledge of the API. */
  mediaUrlFor: (assetId: string) => string | null;
  /** Resolves an ANIMATED image asset (a sticker/GIF — `Asset.animation`) to its preview sprite sheet,
   *  which is what preview draws it from (see `stickers.ts`). Without it, a sticker draws as a still. */
  spriteUrlFor?: (assetId: string) => string | null;
  /** Resolves a `LutAsset.id` to a fetchable URL for its raw `.cube` text — mirrors `mediaUrlFor`'s
   *  own injected-resolver shape. `null` when the id doesn't resolve to a real `LutAsset` (a stale
   *  reference to a since-deleted LUT); `resolveLut` below treats that exactly like a fetch that
   *  hasn't finished yet — just skip applying a LUT for this frame. */
  lutUrlFor: (lutId: string) => string | null;
  /** Every clip `TransformHandles`/`TextTransformHandles` is mid-dragging right now (the actively-
   *  dragged one plus any others moving with it as a multi-select group) — checked on every frame so
   *  the canvas tracks a drag live instead of only updating once it commits. See
   *  `EditorState.livePreviewOverrides`'s own comment for why this lives in the store rather than
   *  `project` itself. */
  getLiveOverrides: () => ClipOverride[];
  /** An in-progress Mixer track-fader drag, if any — wins over the track's own committed `gain` for
   *  exactly that track while dragging, the same override-wins-outright relationship `getLiveOverrides`
   *  has with `Clip.transform`/`effects`. `null` whenever no track fader is being dragged. */
  getLiveTrackGainPreview: () => { trackId: string; gain: number } | null;
  /** Same live-override relationship as `getLiveTrackGainPreview`, for an in-progress Mixer pan-knob
   *  drag. `null` whenever no track pan is being dragged. */
  getLiveTrackPanPreview: () => { trackId: string; pan: number } | null;
  /** Same live-override relationship as `getLiveTrackGainPreview`, for the Mixer's master fader. */
  getLiveMasterGainPreview: () => number | null;
}

/** A still image is decoded into an `<img>` rather than a media element: it has no `currentTime`, no
 *  `play()`, and nothing to keep in sync — it just needs to be decoded once and then drawn on every
 *  frame it covers. No `HTMLAudioElement` variant — audio-track clips are no longer pooled as DOM
 *  elements at all; see `AudioMixEngine`, which schedules them as `AudioBufferSourceNode`s instead. */
type PoolElement = HTMLVideoElement | HTMLImageElement;

interface PooledMedia {
  element: PoolElement;
  lastUsed: number;
  /** Which asset THIS pooled element's own `src` was built from — not necessarily `clip.assetId`
   *  anymore by the time `mediaFor` next looks at it, since a clip's `assetId` can change without its
   *  `id` changing (`ReplaceClipAssetCommand`, used by Remove Object landing its finished render onto
   *  the clip it processed). Confirmed a real, live bug: swapping `assetId` in the project left the
   *  OLD asset's video element sitting in the pool under the unchanged `clip.id`, still showing the
   *  original unprocessed footage until a full page reload rebuilt the pool from scratch. */
  assetId: string;
}

/** Drives the preview: advances a master clock, keeps media elements slaved to it, and composites
 *  the current frame onto a canvas.
 *
 *  ## Why a master clock rather than following `video.currentTime`
 *
 *  A single `<video>`'s own clock is the obvious choice right up until the timeline has more than one
 *  thing on it — a cut between two clips, a gap with nothing playing, or a voiceover running under
 *  the video. There's no single element whose time is authoritative in any of those cases. So this
 *  keeps its own clock from `performance.now()`, and treats every media element as a follower that
 *  gets re-seeked when it drifts (see DRIFT_TOLERANCE). Gaps then "play" correctly with nothing
 *  loaded at all, and audio stays locked to the same timeline the video is on.
 *
 *  ## Why canvas rather than showing the `<video>` directly
 *
 *  Compositing to a canvas is what lets the preview show the real output frame — correct aspect
 *  ratio, letterboxing, and a hard cut at clip boundaries with no element swap flashing through. It's
 *  also the seam where transforms and effects attach later without changing anything around it. */
export class PlaybackEngine {
  private host: PlaybackHost;
  private canvas: HTMLCanvasElement | null = null;
  private context: CanvasRenderingContext2D | null = null;
  private pool = new Map<string, PooledMedia>();
  private rafId: number | null = null;
  private lastFrameTime: number | null = null;
  /** Set by `syncMedia` during a frame when any video under the playhead is seeking or not yet able
   *  to play through; read by the NEXT tick to decide whether the clock holds. */
  private mediaWaitingThisFrame = false;
  private mediaWaitingLastFrame = false;
  private mediaWaitSince: number | null = null;
  /** Whether the most recent `drawFrame` drew every video/image clip under the playhead from media that
   *  has settled at the right time. False when a clip was skipped because its media wasn't decoded yet
   *  (still loading, or mid-seek while scrubbing — which leaves plain black where it belongs), or was
   *  drawn from a video still seeking (a stale frame from before the seek). `drawIncomplete` is the
   *  in-progress flag for the frame being drawn; `lastFrameComplete` is what `isLastFrameComplete`
   *  reports. */
  private drawIncomplete = false;
  private lastFrameComplete = true;
  /** Set whenever this frame draws a `Clip.reverse` video — see `holdLastCompleteFrame`'s own doc
   *  comment for why a discrete reseek needs this at all. A reversed clip has no native "play
   *  backward": every frame is a fresh `element.currentTime =` seek (`syncMedia`'s own `reverse`
   *  branch), which drops `readyState` below 2 for a beat exactly the same way a precise-scrub seek
   *  does — `drawVideoClip`'s own readyState gate then skips drawing that clip entirely, leaving
   *  `drawFrame`'s black clear-fill showing through as a real, confirmed flicker (measured directly:
   *  the canvas alternated between real content and near-black roughly every other frame for about a
   *  second at the start of reverse playback, before the browser's decoder caught up with the
   *  seek pattern and settled). Reset at the top of every `drawFrame`, same as `drawIncomplete`. */
  private reverseClipActiveThisFrame = false;
  /** A copy of the last complete frame, painted back over any frame a seek leaves partly black — see
   *  `holdLastCompleteFrame`. Kept fresh only while it's actually being used (whenever paused, or a
   *  reversed clip is active — see `drawFrame`'s own call site); harmless if stale the rest of the
   *  time, since nothing reads it outside that condition. */
  private scrubHoldCanvas: HTMLCanvasElement | null = null;
  private scrubHoldValid = false;
  /** Rolling tick intervals and `drawFrame` costs (ms), carried in stall reports — the preview is
   *  reported as laggy on iOS, and these tell a slow render loop apart from a slow video. */
  private frameIntervalsMs: number[] = [];
  private drawCostsMs: number[] = [];
  private recentSeekMs: number[] = [];
  /** This engine's own continuously-accumulated playhead while actively playing — `null` whenever
   *  playback is stopped/paused. Exists because the store's `playhead` (`host.getPlayhead()`) is
   *  frame-snapped (`setPlayhead` → `snapToFrame`, needed for the TIMELINE's own frame-accurate
   *  display/editing) — re-deriving `time` from that snapped value every tick, as `tick()` used to,
   *  re-introduces quantization noise into what needs to be a smooth clock for `AudioMixEngine`'s own
   *  `detectRealSeek` comparisons. See `INTERNAL_CLOCK_RESYNC_TOLERANCE`'s own doc comment for how a
   *  genuine external change (a scrub, a fresh play) is still detected and respected despite ignoring
   *  the store's snapped value on ordinary ticks. */
  private internalClockTime: number | null = null;
  private running = false;
  /** The canvas's own on-screen (CSS) size, in raw CSS pixels — set by `Preview.tsx` via a
   *  `ResizeObserver` (a class outside React has no way to observe layout on its own). Null until the
   *  first observation lands, in which case `tick` falls back to the full sequence resolution rather
   *  than guessing at a size. */
  private displayWidth: number | null = null;
  private displayHeight: number | null = null;
  /** Reused every frame that has a transition to render (video OR text — both go through the same
   *  `compositeTransitionFrame`) — one pair of scratch canvases the outgoing/incoming side are each drawn
   *  to FULLY OPAQUE first, so blending a wipe/slide/circle only ever means compositing two flat
   *  images, never re-deriving each transition's own geometry against `drawTransformed`'s crop/scale/
   *  rotate pipeline (or `drawText`'s glyph layout) directly. Created lazily, resized in place when the
   *  sequence resolution changes — see `transitionCanvas`. */
  private transitionCanvasA: HTMLCanvasElement | null = null;
  private transitionCanvasB: HTMLCanvasElement | null = null;
  /** Scratch canvas `drawTransformed` chroma-keys and/or color-grades a clip's raw source pixels onto,
   *  SOURCE-sized (not frame-sized like the transition scratch canvases above) — both operate on the
   *  un-cropped, un-scaled source, before any of `ClipTransform`'s own geometry pipeline runs. See
   *  `chromaKeyCanvas`'s own doc comment. */
  private chromaKeyCanvasEl: HTMLCanvasElement | null = null;
  /** One entry per clip currently drawing curves — invalidated by REFERENCE inequality against the
   *  `ColorGrading` object last seen for that clip id, not deep-equality. This is cheap AND correct:
   *  `resolveClipColorGrading` (static path: `clip.colorGrading` directly; keyframed/HOLD path: a
   *  bracketing keyframe's own `.value`) always returns the SAME object reference across consecutive
   *  frames unless a real edit (a new command, undo/redo, or a fresh live-preview override) actually
   *  produced a new one — this codebase's Immer-free-but-equivalent `edit()`/`structuredClone` pattern
   *  in `timeline/operations.ts` already guarantees that. So recomputing the natural-cubic-spline solve
   *  for all 4 curves only happens on an actual change, not on every tick of steady, un-edited playback. */
  private colorGradingLutCache = new Map<string, { source: ColorGrading; r: Uint8ClampedArray; g: Uint8ClampedArray; b: Uint8ClampedArray }>();
  /** One entry per `LutAsset.id` this session has needed — either the already-parsed `Lut3D` once
   *  fetch+parse completes, or the in-flight `Promise` while it's still loading (so two clips sharing
   *  the same LUT, or two consecutive frames before the first fetch resolves, never trigger a second
   *  fetch — see `resolveLut`'s own doc comment). Keyed by lutId (not clip id, unlike
   *  `colorGradingLutCache`): a `.cube` file's parsed lattice depends only on its own bytes, not on
   *  which clip references it, so this can be shared across every clip using the same LUT — no
   *  per-clip invalidation rule needed the way `colorGradingLutCache` has for a live-editable curve. */
  private lutCache = new Map<string, Lut3D | Promise<void>>();
  /** Intensity-blended copies of `lutCache` entries, keyed `lutId@hundredths` — see `resolveLut`. */
  private blendedLutCache = new Map<string, Lut3D>();
  /** Owns the entire Web Audio mixing graph — see its own doc comment. Composed here rather than
   *  subclassed: this class stays the video/canvas/clock owner, `AudioMixEngine` is a pure audio-output
   *  concern it delegates to, the same way `PlaybackHost` itself is composition rather than inheritance. */
  private audioMixEngine: AudioMixEngine;
  /** Throttle for the low-frequency upcoming-audio-clip prefetch scan in `tick()` — see
   *  `AUDIO_PREFETCH_SCAN_INTERVAL_MS`'s own comment for why this isn't just done every frame. */
  private lastPrefetchScanAt: number | null = null;

  constructor(host: PlaybackHost) {
    this.host = host;
    this.audioMixEngine = new AudioMixEngine(
      (assetId) => this.host.mediaUrlFor(assetId),
      (details) =>
        this.host.onAudioReport?.({
          phase: "buffer-settled",
          buffer: details,
          userAgent: typeof navigator === "undefined" ? null : navigator.userAgent,
        }),
      () => this.host.onPlaybackBlocked(),
      (assetId) => this.prepareElementClips(assetId)
    );
  }

  /** See `lastFrameComplete`. Read by the export dialog (`ExportDialog.tsx`), which scrubs this engine
   *  in step with the render: it holds its preview copy on the last complete frame instead of copying
   *  the black a seek briefly leaves behind, and waits for a seek to land before asking for the next. */
  isLastFrameComplete(): boolean {
    return this.lastFrameComplete;
  }


  /** Called whenever paused (see `drawFrame`'s own call site) or a reversed clip is active. Every seek
   *  blanks its clip to black for the few frames until it lands (see `drawVideoClip`'s readyState
   *  gate), and `PAUSED_SEEK_TOLERANCE` means ordinary paused scrubbing/frame-stepping seeks several
   *  times a second — measured, that left the preview black in well over half its frames, flickering.
   *  So each complete frame is kept, and painted back over any frame that isn't: the picture holds on
   *  the last real frame until the next one is ready. Works in raw backing-store pixels, independent
   *  of `drawFrame`'s transform. */
  private holdLastCompleteFrame(context: CanvasRenderingContext2D): void {
    const canvas = context.canvas;
    const hold = (this.scrubHoldCanvas ??= document.createElement("canvas"));
    if (this.lastFrameComplete) {
      if (hold.width !== canvas.width || hold.height !== canvas.height) {
        hold.width = canvas.width;
        hold.height = canvas.height;
      }
      hold.getContext("2d")?.drawImage(canvas, 0, 0);
      this.scrubHoldValid = true;
    } else if (this.scrubHoldValid && hold.width === canvas.width && hold.height === canvas.height) {
      context.save();
      context.setTransform(1, 0, 0, 1, 0, 0);
      context.drawImage(hold, 0, 0);
      context.restore();
    }
  }

  attach(canvas: HTMLCanvasElement): void {
    this.canvas = canvas;
    this.context = canvas.getContext("2d", { alpha: false });
    this.start();
  }

  /** Called whenever the canvas's own on-screen size changes — what `tick` uses to cap the canvas
   *  BACKING STORE to only as many physical pixels as are ever actually visible, instead of always
   *  compositing at the full sequence resolution regardless of how small the preview panel is. A
   *  phone/tablet showing a 1080×1920 sequence in a 300px-tall panel was paying the GPU/compositing
   *  cost of well over a million pixels a frame that never reached the screen — on a desktop's own
   *  more powerful GPU this was invisible, but it's a real, confirmed source of dropped frames on
   *  weaker hardware. Multiplied by `devicePixelRatio` and capped at the sequence's own resolution in
   *  `tick` itself (never upscaled — there's no extra detail to render past the source's own
   *  resolution, only more pixels to composite for an identical visual result).
   *
   *  Every drawing call in this class still operates in LOGICAL sequence-pixel coordinates regardless
   *  of the physical backing store size actually chosen — see `drawFrame`'s own `setTransform` call —
   *  so nothing downstream (crop math, `ClipTransform.offsetX`, text font sizes, all authored and
   *  exported in real sequence pixels) needs to know or care that the backing store shrank. */
  setDisplaySize(cssWidth: number, cssHeight: number): void {
    this.displayWidth = cssWidth;
    this.displayHeight = cssHeight;
  }

  /** Pass-through to `AudioMixEngine`'s own read methods — see their doc comments. `LevelMeter` calls
   *  these directly from its own `requestAnimationFrame` loop, bypassing `tick()` entirely: metering
   *  has no connection to the render/composite loop, it just needs a live reading from the engine on
   *  demand, whenever the Mixer panel happens to be open and polling. */
  getTrackLevelDb(trackId: string): number | null {
    return this.audioMixEngine.getTrackLevelDb(trackId);
  }
  getMasterLevelDb(): number {
    return this.audioMixEngine.getMasterLevelDb();
  }

  /** Tears everything down: stops the loop and releases every media element. Without the explicit
   *  `src` clear and `load()`, a detached element can keep its network request and decoder alive. */
  detach(): void {
    this.stop();
    for (const { element } of this.pool.values()) this.release(element);
    this.pool.clear();
    this.animationFrames.clear();
    this.mediaHostElement?.remove();
    this.mediaHostElement = null;
    this.audioMixEngine.dispose();
    this.canvas = null;
    this.context = null;
  }

  private start(): void {
    if (this.running) return;
    this.running = true;
    this.lastFrameTime = null;
    const loop = () => {
      if (!this.running) return;
      this.tick();
      this.rafId = requestAnimationFrame(loop);
    };
    this.rafId = requestAnimationFrame(loop);
  }

  private stop(): void {
    this.running = false;
    if (this.rafId !== null) cancelAnimationFrame(this.rafId);
    this.rafId = null;
  }

  /** Gets (or creates) the media element for a clip. Elements are keyed by CLIP, not by asset,
   *  because the same asset can legitimately appear at two different timeline positions at once —
   *  one element can't be in two places. */
  private mediaFor(clip: Clip, kind: "video" | "image"): PoolElement | null {
    const existing = this.pool.get(clip.id);
    // A pooled element built for this clip's PREVIOUS `assetId` is stale, not reusable — see
    // `PooledMedia.assetId`'s own doc comment for the real bug this closes. Released the same way
    // `evictStale`/`detach` already do (pause + drop `src` + `load()`) before falling through to
    // build a fresh element below, exactly as if nothing had ever been pooled for this clip.
    if (existing && existing.assetId !== clip.assetId) {
      this.release(existing.element);
      this.pool.delete(clip.id);
      this.animationFrames.delete(clip.id);
    } else if (existing) {
      existing.lastUsed = performance.now();
      return existing.element;
    }

    const animated = kind === "image" && Boolean(this.host.getProject()?.assets.find((a) => a.id === clip.assetId)?.animation) && this.host.spriteUrlFor;
    const url = animated ? this.host.spriteUrlFor!(clip.assetId) : this.host.mediaUrlFor(clip.assetId);
    if (!url) return null;

    const element = kind === "image" ? document.createElement("img") : document.createElement("video");
    element.src = url;
    // Audio is routed through `AudioMixEngine`, not the element's own output — see `syncVideoClipAudio`.
    if (element instanceof HTMLVideoElement) {
      element.preload = "auto";
      element.playsInline = true;
      element.muted = false;
      // Attached to the document (1px, invisible — see `mediaHost`), not left detached. Chrome/Firefox
      // decode a detached video into canvas `drawImage` indefinitely; iPhone/iPad (WebKit) do not:
      // reported as preview video freezing on iOS only, while Android and desktop web played the same
      // project fine, with the element itself looking healthy (buffered, not paused, not seeking).
      element.setAttribute("aria-hidden", "true");
      element.tabIndex = -1;
      element.style.cssText = "width:1px;height:1px;";
      this.mediaHost().appendChild(element);
    }

    this.pool.set(clip.id, { element, lastUsed: performance.now(), assetId: clip.assetId });
    this.evictStale();
    return element;
  }

  /** Releases one pooled element. An `<img>` only needs its `src` dropped; a media element also has
   *  to be paused and re-`load()`ed, or it can keep a network request and decoder alive after being
   *  discarded. */
  private release(element: PoolElement): void {
    if (element instanceof HTMLImageElement) {
      element.removeAttribute("src");
      return;
    }
    element.pause();
    element.removeAttribute("src");
    element.load();
    element.remove();
  }

  private mediaHostElement: HTMLDivElement | null = null;

  /** The invisible container pooled video elements live in. Kept inside the viewport at 1px with
   *  near-zero (not zero) opacity rather than `display:none`/`visibility:hidden`/off-screen, since
   *  WebKit treats a media element it considers not visible as one it may stop rendering frames for. */
  private mediaHost(): HTMLDivElement {
    if (this.mediaHostElement?.isConnected) return this.mediaHostElement;
    const host = document.createElement("div");
    host.setAttribute("aria-hidden", "true");
    host.style.cssText = "position:fixed;left:0;top:0;width:1px;height:1px;overflow:hidden;opacity:0.01;pointer-events:none;z-index:-1;";
    document.body.appendChild(host);
    this.mediaHostElement = host;
    return host;
  }

  private evictStale(): void {
    if (this.pool.size <= POOL_LIMIT) return;
    const entries = [...this.pool.entries()].sort((a, b) => a[1].lastUsed - b[1].lastUsed);
    for (const [clipId, { element }] of entries.slice(0, this.pool.size - POOL_LIMIT)) {
      // Must run before `release` clears the element's `src` — a dangling `MediaElementAudioSourceNode`
      // left in the graph otherwise. Safe to call even for a clip whose audio was never wired (an
      // image, or a video that never actually produced sound) — `releaseVideoClipAudio` no-ops when it
      // finds nothing registered for that id.
      this.audioMixEngine.releaseVideoClipAudio(clipId);
      this.release(element);
      this.pool.delete(clipId);
      this.animationFrames.delete(clipId);
    }
  }

  private playOutcome = new Map<string, string>();
  private stallWatch = new Map<string, StallWatchEntry>();
  private stallReported = new Set<string>();
  /** `maybeReportAudio`'s own state: when the current stretch of playback over an audio-track clip
   *  began (wall clock and audio clock), and whether this page load already reported. */
  private audioReportSince: number | null = null;
  private audioReportContextTime = 0;
  private audioReported = false;
  /** When each clip's element was first seen seeking (or last told to seek) — feeds `planMediaSync`'s
   *  stuck-seek backstop. Cleared the moment the element reports it is no longer seeking. */
  private seekStartedAt = new Map<string, number>();
  /** Gradual `playbackRate` drift correction — off on Apple WebKit, see `isAppleWebKit`. */
  private readonly rateCorrection = typeof navigator === "undefined" || !isAppleWebKit(navigator.userAgent);

  /** Must be called synchronously from the Play control's own event handler, BEFORE `playing` flips
   *  on. WebKit (every iOS browser) only lets audio start and unmuted media play from inside a real
   *  user gesture; everything else in this class starts playback later, from `tick`'s animation
   *  frame, where iOS no longer counts the tap. Starts the audio context and the video element(s)
   *  under the playhead while the gesture is still live; `tick` takes over syncing from there. */
  primeFromGesture(): void {
    this.audioMixEngine.resumeFromGesture();
    const project = this.host.getProject();
    if (!project) return;
    const playhead = this.host.getPlayhead();
    // `togglePlay` rewinds to 0 when starting from the very end — prime the clip that will actually play.
    const time = playhead >= this.totalDuration(project) - 1e-6 ? 0 : playhead;
    this.audioMixEngine.primeElementClipsFromGesture(this.activeAudioClips(project, time));
    for (const { clip } of visibleVideoClips(project)) {
      if (time < clip.timelineStart || time >= clipEnd(clip)) continue;
      if (project.assets.find((a) => a.id === clip.assetId)?.kind !== "video") continue;
      const element = this.mediaFor(clip, "video");
      if (!(element instanceof HTMLVideoElement) || !element.paused) continue;
      this.playOutcome.set(clip.id, "pending(gesture)");
      void element.play().then(
        () => this.playOutcome.set(clip.id, "resolved(gesture)"),
        (err: unknown) => this.playOutcome.set(clip.id, `rejected(gesture):${err instanceof Error ? err.name : String(err)}`)
      );
    }
  }

  /** Reports a video element that isn't actually playing while the transport is — once per clip per
   *  page load, through `host.onPlaybackStall`. Exists because the iOS preview freeze couldn't be
   *  reproduced off-device and two reasoned fixes both missed; this ships the element's real state
   *  back instead. The `src` has its `token` query param stripped before it leaves the page. */
  private watchForStall(clipId: string, element: HTMLVideoElement, sourceTime: number, playing: boolean): void {
    if (!playing) {
      this.stallWatch.delete(clipId);
      return;
    }
    if (!this.host.onPlaybackStall) return;

    const now = performance.now();
    let watch = this.stallWatch.get(clipId);
    // `syncMedia` only runs for the clip under the playhead, so an entry left behind when playback
    // moved off this clip would otherwise resume with a stale timer and report instantly on return.
    if (!watch || now - watch.lastSeenAt > 500) {
      watch = {
        startedAt: now,
        lastSeenAt: now,
        notProgressingSince: null,
        hardSeeks: 0,
        lastProbeAt: 0,
        pixelHash: null,
        pixelChangedAt: now,
        timeAtPixelChange: element.currentTime,
        rateWrites: 0,
        rateSampleAt: 0,
        rateSampleTime: element.currentTime,
        hardSeeksAtSample: 0,
        lastAdvanceRatio: null,
        slowSamples: 0,
      };
      this.stallWatch.set(clipId, watch);
    }
    watch.lastSeenAt = now;
    const notProgressing = element.paused || element.seeking || element.readyState < 3;
    watch.notProgressingSince = notProgressing ? (watch.notProgressingSince ?? now) : null;

    // Once a second: how far the element's own clock moved against wall time, skipping any window a
    // seek or pause landed in. Consistently under 0.85 means the device can't decode this file in
    // real time, which no amount of seeking or clock-holding can fix.
    if (now - watch.rateSampleAt >= 1000) {
      if (watch.rateSampleAt > 0 && !notProgressing && watch.hardSeeks === watch.hardSeeksAtSample) {
        const ratio = (element.currentTime - watch.rateSampleTime) / ((now - watch.rateSampleAt) / 1000);
        watch.lastAdvanceRatio = ratio;
        watch.slowSamples = ratio < 0.85 ? watch.slowSamples + 1 : 0;
      }
      watch.rateSampleAt = now;
      watch.rateSampleTime = element.currentTime;
      watch.hardSeeksAtSample = watch.hardSeeks;
    }

    const playedMs = now - watch.startedAt;
    const stuckTooLong = watch.notProgressingSince !== null && now - watch.notProgressingSince >= STALL_REPORT_MS;
    const reseekStorm =
      playedMs >= STALL_REPORT_MS && watch.hardSeeks >= 3 && watch.hardSeeks / (playedMs / 1000) > STALL_RESEEKS_PER_SECOND;
    const pictureFrozen = this.pictureFrozen(watch, element, now);
    const slowDecode = watch.slowSamples >= 3;
    const slowRender = playedMs >= STALL_REPORT_MS && this.frameIntervalsMs.length >= 30 && average(this.frameIntervalsMs) > 50;
    const reason = stuckTooLong
      ? "not-progressing"
      : reseekStorm
        ? "reseek-storm"
        : pictureFrozen
          ? "picture-frozen"
          : slowDecode
            ? "slow-decode"
            : slowRender
              ? "slow-render"
              : null;
    if (reason === null) return;
    const reportKey = `${clipId}:${reason}`;
    if (this.stallReported.has(reportKey)) return;
    this.stallReported.add(reportKey);
    let src: string | null = null;
    try {
      const url = new URL(element.currentSrc || element.src, window.location.href);
      url.searchParams.delete("token");
      src = url.pathname + url.search;
    } catch {
      src = null;
    }
    const activation = (navigator as Navigator & { userActivation?: { hasBeenActive: boolean; isActive: boolean } }).userActivation;
    this.host.onPlaybackStall({
      reason,
      advanceRatio: watch.lastAdvanceRatio === null ? null : Number(watch.lastAdvanceRatio.toFixed(3)),
      rateCorrection: this.rateCorrection,
      rateWrites: watch.rateWrites,
      playbackRate: element.playbackRate,
      recentSeekMs: this.recentSeekMs.map((ms) => Math.round(ms)),
      clockHeldForMedia: this.mediaWaitingLastFrame,
      avgFrameIntervalMs: Math.round(average(this.frameIntervalsMs)),
      maxFrameIntervalMs: Math.round(Math.max(0, ...this.frameIntervalsMs)),
      avgDrawMs: Number(average(this.drawCostsMs).toFixed(1)),
      maxDrawMs: Math.round(Math.max(0, ...this.drawCostsMs)),
      canvasSize: this.canvas ? `${this.canvas.width}x${this.canvas.height}` : null,
      devicePixelRatio: window.devicePixelRatio,
      canvasFilterSupported: supportsCanvasFilter(),
      pictureUnchangedMs: Math.round(now - watch.pixelChangedAt),
      currentTimeAdvancedWhilePictureUnchanged: Number((element.currentTime - watch.timeAtPixelChange).toFixed(3)),
      inDocument: element.isConnected,
      readyState: element.readyState,
      networkState: element.networkState,
      paused: element.paused,
      seeking: element.seeking,
      ended: element.ended,
      currentTime: element.currentTime,
      sourceTime,
      duration: element.duration,
      buffered:
        element.buffered.length > 0
          ? `${element.buffered.start(0).toFixed(2)}-${element.buffered.end(element.buffered.length - 1).toFixed(2)} (${element.buffered.length} ranges)`
          : "none",
      videoSize: `${element.videoWidth}x${element.videoHeight}`,
      errorCode: element.error?.code ?? null,
      errorMessage: element.error?.message ?? null,
      playOutcome: this.playOutcome.get(clipId) ?? "never-called",
      hardSeeks: watch.hardSeeks,
      seekingForMs: Math.round(now - (this.seekStartedAt.get(clipId) ?? now)),
      playedMs: Math.round(playedMs),
      audioContextState: this.audioMixEngine.contextState,
      userActivation: activation ? { hasBeenActive: activation.hasBeenActive, isActive: activation.isActive } : "unsupported",
      src,
      userAgent: navigator.userAgent,
    });
  }

  private probeContext: CanvasRenderingContext2D | null = null;

  /** True when the element claims to be playing — not paused, not seeking, frames decoded, and its
   *  `currentTime` has moved on by more than 2.5s — yet what `drawImage` gets from it hasn't changed
   *  for `STALL_REPORT_MS`. That combination is invisible to every media-state check above, and is
   *  exactly what iOS preview kept doing after the seek fix: frozen picture, no stall report at all.
   *  Samples an 8×8 downscale twice a second; real footage never hashes identically for seconds. */
  private pictureFrozen(watch: StallWatchEntry, element: HTMLVideoElement, now: number): boolean {
    if (element.paused || element.seeking || element.readyState < 2) {
      watch.pixelChangedAt = now;
      watch.timeAtPixelChange = element.currentTime;
      return false;
    }
    if (now - watch.lastProbeAt >= 500) {
      watch.lastProbeAt = now;
      const hash = this.framePixelHash(element);
      if (hash !== null && hash !== watch.pixelHash) {
        watch.pixelHash = hash;
        watch.pixelChangedAt = now;
        watch.timeAtPixelChange = element.currentTime;
      }
    }
    return now - watch.pixelChangedAt >= STALL_REPORT_MS && element.currentTime - watch.timeAtPixelChange >= 2.5;
  }

  private framePixelHash(element: HTMLVideoElement): number | null {
    try {
      if (!this.probeContext) {
        const probe = document.createElement("canvas");
        probe.width = 8;
        probe.height = 8;
        this.probeContext = probe.getContext("2d", { willReadFrequently: true });
      }
      const context = this.probeContext;
      if (!context) return null;
      context.drawImage(element, 0, 0, 8, 8);
      const data = context.getImageData(0, 0, 8, 8).data;
      let hash = 0;
      for (let i = 0; i < data.length; i++) hash = (hash * 31 + data[i]) | 0;
      return hash;
    } catch {
      return null;
    }
  }

  /** Slaves one video element's PICTURE timing to the master clock — `currentTime`/`playbackRate`/
   *  play-pause only. No longer touches `.muted`/`.volume` at all: a video clip's audio is routed
   *  through `AudioMixEngine.syncVideoClipAudio` instead (called separately, right after this, from
   *  `drawVideoClip`), since `createMediaElementSource` captures the element's native output entirely —
   *  setting `.volume` on an element already routed through Web Audio would have no audible effect. */
  private syncMedia(clipId: string, element: HTMLVideoElement, sourceTime: number, playing: boolean, targetPlaybackRate = 1, reverse = false): void {
    if (reverse) {
      if (!element.paused) element.pause();
      if (element.readyState === 0) return;
      // A reversed clip begins at its out-point. Seeking to the exact media duration is outside the
      // last decodable frame in Safari/iOS and can briefly draw black, so stay a fraction of a frame
      // inside the source while retaining the same exported time mapping.
      const seekTime = Math.max(0, Math.min(sourceTime, Number.isFinite(element.duration) ? Math.max(0, element.duration - 1 / 120) : sourceTime));
      if (!element.seeking && Math.abs(element.currentTime - seekTime) > PAUSED_SEEK_TOLERANCE) {
        element.currentTime = seekTime;
        this.mediaWaitingThisFrame = true;
      }
      return;
    }
    if (holdMediaAtEnd(element, sourceTime)) {
      this.playOutcome.set(clipId, "held");
      this.watchForStall(clipId, element, sourceTime, false);
      if (playing && (element.seeking || element.readyState < 2)) this.mediaWaitingThisFrame = true;
      return;
    }
    // Transport runs BEFORE the readyState gate below. iOS Safari ignores `preload`, so an element
    // that has only had its `src` assigned can sit at readyState 0 until playback is requested; with
    // `play()` behind that gate nothing would ever request it. This ordering alone did NOT fix the
    // reported iOS freeze (confirmed on-device), so it is a hazard removed, not the established cause —
    // `watchForStall` below exists to capture what that cause actually is.
    this.watchForStall(clipId, element, sourceTime, playing);
    if (playing) {
      // `play()` rejects if the browser blocks autoplay before a user gesture. The transport button's
      // own click IS a real gesture, but a clip cut deep into a long, uninterrupted play session can
      // create/activate a video element well outside that gesture's own window — "transient
      // activation" is time-boxed (a handful of seconds on most browsers, confirmed strictest on
      // Safari/WebKit, which is the reported case) and page-wide, not tied to any one element, so a
      // FRESH element attached long after the original click can legitimately fall outside it even
      // though the click itself was completely genuine. A bare `.catch(() => {})` here used to just
      // swallow that — the video silently stayed paused, retried (just as gesture-lessly) every later
      // tick, and NEVER recovered on its own, while the master clock (independent of any one element,
      // see this class's own top doc comment) kept advancing regardless: "the timeline moves but the
      // video never plays," a real, reported symptom, not a hypothetical one. `onPlaybackBlocked` is
      // what actually recovers — it stops the whole transport, so the UI honestly reflects "paused"
      // and the user's very next tap is a genuine, fresh, definitely-allowed gesture instead of the
      // clock and the picture silently drifting apart forever.
      if (element.paused) {
        this.playOutcome.set(clipId, "pending");
        void element.play().then(
          () => {
            if (this.playOutcome.get(clipId) !== "held") this.playOutcome.set(clipId, "resolved");
          },
          (err: unknown) => {
            if (this.playOutcome.get(clipId) === "held") return;
            this.playOutcome.set(clipId, `rejected:${err instanceof Error ? err.name : String(err)}`);
            this.host.onPlaybackBlocked();
          }
        );
      }
    } else if (!element.paused) {
      element.pause();
    }

    // Before the readyState gate, so an element that hasn't loaded anything yet holds the clock too.
    if (playing && (element.seeking || element.readyState < 3 || (this.playOutcome.get(clipId) ?? "").startsWith("pending"))) {
      this.mediaWaitingThisFrame = true;
    }

    // readyState 0 means nothing is loaded yet — seeking now would be discarded once metadata
    // arrives, so let it load and correct on a later frame. A clip whose `sourceIn` is past 0 can
    // therefore start decoding from 0 for a tick on the iOS path above before this gate opens; the
    // `DRIFT_TOLERANCE` seek below is what lands it on `sourceIn`, ducked exactly like every other
    // real reseek.
    if (element.readyState === 0) return;

    const now = performance.now();
    if (element.seeking) {
      if (!this.seekStartedAt.has(clipId)) this.seekStartedAt.set(clipId, now);
    } else {
      const startedAt = this.seekStartedAt.get(clipId);
      if (startedAt !== undefined) {
        pushRolling(this.recentSeekMs, now - startedAt, 8);
        this.seekStartedAt.delete(clipId);
      }
    }
    const seekStartedAt = this.seekStartedAt.get(clipId);

    const action = planMediaSync(
      {
        currentTime: element.currentTime,
        playbackRate: element.playbackRate,
        seeking: element.seeking,
        seekingForMs: seekStartedAt === undefined ? 0 : now - seekStartedAt,
      },
      sourceTime,
      playing,
      this.rateCorrection,
      // Ignored by `planMediaSync` itself whenever `playing` is true (it always uses `DRIFT_TOLERANCE`
      // then) — passed unconditionally rather than re-deriving that same branch here too.
      PAUSED_SEEK_TOLERANCE,
      targetPlaybackRate
    );
    // Rate BEFORE seek, never after: a rate change issued right behind a seek lands while that seek is
    // still in flight, which is exactly the interruption `planMediaSync` exists to stop.
    if (action.playbackRate !== null) {
      element.playbackRate = action.playbackRate;
      if (playing) {
        const watch = this.stallWatch.get(clipId);
        if (watch) watch.rateWrites++;
      }
    }
    if (action.seekTo !== null) {
      // Ducked first — see `duckAroundSeek`'s own doc comment for the click this mitigates.
      this.audioMixEngine.duckAroundSeek(clipId);
      element.currentTime = action.seekTo;
      this.seekStartedAt.set(clipId, now);
      if (playing) {
        // Hold from the very next tick, not one frame late once `seeking` is observed.
        this.mediaWaitingThisFrame = true;
        const watch = this.stallWatch.get(clipId);
        if (watch) watch.hardSeeks++;
      }
    }
  }

  private tick(): void {
    const project = this.host.getProject();
    const context = this.context;
    const canvas = this.canvas;
    if (!project || !context || !canvas) return;

    const now = performance.now();
    const delta = this.lastFrameTime === null ? 0 : (now - this.lastFrameTime) / 1000;
    this.lastFrameTime = now;

    const playing = this.host.isPlaying();
    const storedPlayhead = this.host.getPlayhead();
    let time = storedPlayhead;

    if (playing && delta > 0) {
      // Resync from the store only on a genuine external change (a scrub while playing, or playback
      // just starting) — otherwise keep accumulating from OUR OWN last computed value, not the store's
      // frame-snapped echo of it. See `internalClockTime`'s own doc comment for why this distinction
      // matters for `AudioMixEngine`'s scheduling.
      const base =
        this.internalClockTime !== null &&
        Math.abs(storedPlayhead - this.internalClockTime) <= INTERNAL_CLOCK_RESYNC_TOLERANCE
          ? this.internalClockTime
          : storedPlayhead;
      time = shouldHoldClockForMedia(this.mediaWaitingLastFrame, this.mediaWaitSince, now) ? base : base + delta;
      const total = this.totalDuration(project);
      if (time >= total) {
        this.internalClockTime = null;
        this.host.onTimeUpdate(total);
        this.host.onEnded();
        this.pauseAll();
        this.drawFrame(project, context, total, playing);
        return;
      }
      this.internalClockTime = time;
      this.host.onTimeUpdate(time);
    } else {
      this.internalClockTime = null;
    }

    // Backing store capped to the panel's own on-screen size (times devicePixelRatio, so it stays
    // crisp) instead of always the full sequence resolution — see `setDisplaySize`'s own comment for
    // why. Every draw call still works in full sequence-pixel LOGICAL coordinates regardless (see
    // `drawFrame`'s `setTransform`), so this is invisible to everything downstream.
    const dpr = typeof window !== "undefined" ? window.devicePixelRatio || 1 : 1;
    const targetWidth = this.displayWidth
      ? Math.max(1, Math.min(project.sequence.width, Math.round(this.displayWidth * dpr)))
      : project.sequence.width;
    const targetHeight = this.displayHeight
      ? Math.max(1, Math.min(project.sequence.height, Math.round(this.displayHeight * dpr)))
      : project.sequence.height;
    if (canvas.width !== targetWidth || canvas.height !== targetHeight) {
      canvas.width = targetWidth;
      canvas.height = targetHeight;
    }

    this.mediaWaitingThisFrame = false;
    const drawStartedAt = performance.now();
    this.drawFrame(project, context, time, playing);
    if (playing) {
      pushRolling(this.drawCostsMs, performance.now() - drawStartedAt);
      if (delta > 0) pushRolling(this.frameIntervalsMs, delta * 1000);
    }
    this.mediaWaitingLastFrame = playing && this.mediaWaitingThisFrame;
    this.mediaWaitSince = this.mediaWaitingLastFrame ? (this.mediaWaitSince ?? now) : null;
    this.syncAudioTracks(project, time, playing);
    this.maybeReportAudio(project, time, playing, now);

    // Live per-track/master mix levels, reconciled once per tick regardless of `playing` — cheap even
    // every frame (each is a single AudioParam.setTargetAtTime call, see AudioMixEngine's own
    // comment), and dragging the Mixer while paused should still feel responsive even though nothing
    // is actually scheduled to play yet. A Mixer fader/knob drag in progress
    // (`getLiveTrackGainPreview`/`getLiveTrackPanPreview`/`getLiveMasterGainPreview`) wins over the real
    // committed project value for exactly the track/master being dragged, the same override-wins-
    // outright relationship `getLiveOverrides` already has with `Clip.transform`/`effects` for the
    // canvas.
    const liveTrackGain = this.host.getLiveTrackGainPreview();
    const liveTrackPan = this.host.getLiveTrackPanPreview();
    const liveMasterGain = this.host.getLiveMasterGainPreview();
    for (const track of project.sequence.tracks) {
      if (track.kind !== "audio") continue;
      const gain = liveTrackGain?.trackId === track.id ? liveTrackGain.gain : (track.gain ?? 1);
      const pan = liveTrackPan?.trackId === track.id ? liveTrackPan.pan : (track.pan ?? 0);
      this.audioMixEngine.setTrackGain(track.id, gain);
      this.audioMixEngine.setTrackPan(track.id, pan);
    }
    this.audioMixEngine.setMasterGain(liveMasterGain ?? (project.sequence.masterGain ?? 1));

    // Mirrors the existing deferred `element.play()` pattern (`togglePlay` itself is a pure Zustand
    // action with no engine reference — the actual gesture-gated call only happens here, on the next
    // tick after `playing` flips true) — see the plan's "Autoplay/gesture handling" section for why this
    // already works under the browser's sticky-activation grace window without a synchronous call from
    // the transport button itself.
    if (playing) this.audioMixEngine.resume();

    // Throttled scan for audio-track clips starting within the next few seconds, so their asset buffer
    // is already decoded by the time playback reaches them instead of decoding on first touch.
    if (
      this.lastPrefetchScanAt === null ||
      now - this.lastPrefetchScanAt >= AUDIO_PREFETCH_SCAN_INTERVAL_MS
    ) {
      this.lastPrefetchScanAt = now;
      for (const { track, clip } of audibleClips(project)) {
        // Includes a clip already under the playhead, not only ones about to start — so a file this
        // browser can't decode is found out before Play is pressed, and its `<audio>`-element fallback
        // can start inside that tap (`primeElementClipsFromGesture`).
        if (clip.timelineStart + (clip.sourceOut - clip.sourceIn) <= time || clip.timelineStart > time + AUDIO_PREFETCH_LOOKAHEAD_SECONDS) continue;
        const url = this.host.mediaUrlFor(clip.assetId);
        if (url) this.audioMixEngine.prefetchAsset(clip.assetId, url);
        this.audioMixEngine.prepareElementClip(track.id, clip);
      }

      // Same reasoning, video-track clips — confirmed a real, reported gap: unlike audio,
      // `mediaFor` only ever creates a clip's `<video>`/`<img>` element reactively, the instant
      // `drawFrame` first asks for it once the clip is ALREADY active. A brand-new element starts
      // its network fetch and decode from zero at that exact moment, and `drawFrame` only paints
      // once `readyState >= 2` — so a cut to a clip whose element was never touched before shows as
      // a real, visible freeze (the last drawn frame just sits there) for however long that first
      // load takes, worse on a slow connection or a large source file. Pre-creating the element here
      // gives it a head start buffering before playback actually reaches it, exactly mirroring the
      // audio prefetch above. Color-matte clips have no real media (`colorCanvasFor` synthesizes a
      // canvas instead — see `drawVideoClip`'s own branch) and are skipped; nothing to prefetch.
      for (const { clip } of visibleVideoClips(project)) {
        // `<=`, not `<`: a clip starting exactly at `time` is already current, and `syncMedia` owns it.
        // With the clock holding at a clip's start while its element begins playing, `<` let this
        // pre-seek yank that already-playing element back to `sourceIn`.
        if (clip.timelineStart <= time || clip.timelineStart > time + AUDIO_PREFETCH_LOOKAHEAD_SECONDS) continue;
        const asset = project.assets.find((a) => a.id === clip.assetId);
        if (!asset || asset.kind === "color") continue;
        const element = this.mediaFor(clip, asset.kind === "image" ? "image" : "video");
        // Also pre-SEEKS a video element to its own clip-relative starting point, not just creates it
        // — a real, reported gap left over even after the element-creation fix above: a clip that's
        // the INCOMING side of a transition gets its first real seek inside `syncMedia`, the very
        // first tick it's drawn as "current" — which, for a transition partner, is exactly the instant
        // the blend needs it composited. Seeking here instead, while the clip is still merely upcoming
        // and nothing is waiting on the result, gives the browser the whole lookahead window to finish
        // a potentially-expensive keyframe seek quietly in the background, instead of that seek's own
        // latency landing as a visible stutter at the one moment (a transition's own onset) it's most
        // noticeable. `readyState >= 1` (HAVE_METADATA) guards against seeking before the element even
        // knows its own duration/seekable range, which some browsers silently ignore or queue
        // unreliably — if not ready yet this tick, the next scan interval (this loop reruns every
        // `AUDIO_PREFETCH_SCAN_INTERVAL_MS`) naturally retries once metadata has loaded. Only the
        // FIRST seek matters here — once `syncMedia` takes over as the clip becomes current, its own
        // `DRIFT_TOLERANCE`-gated reseek logic is what keeps it in sync from then on, same as always.
        if (element instanceof HTMLVideoElement && element.readyState >= 1 && Math.abs(element.currentTime - clip.sourceIn) > DRIFT_TOLERANCE) {
          element.currentTime = clip.sourceIn;
        }
      }
    }
  }

  /** Audio-track clips whose time window actually contains `time` right now — as opposed to
   *  `audibleClips`, which returns every clip on every audible (unmuted/soloed) track regardless of
   *  where it sits on the timeline. Each result also carries the exact `sourceTime` its own element
   *  should be seeked to and the `gain` multiplier `syncAudioTracks` should apply — ordinarily just
   *  the clip's own straightforward mapping (`clip.gain`, playhead position translated 1:1 into its
   *  footage), but a clip with a REAL transition active right now needs both computed differently. All
   *  of THAT timing math lives in `timeline/transitions.ts`'s `resolveAudioTransitionGain` (shared,
   *  pure, unit-tested — unlike this class, which needs a real DOM/canvas to run at all) — during a
   *  real crossfade blend it hands back the OUTGOING partner clip too, which is why a single active
   *  clip can expand into two results here.
   *
   *  Without this, a clip with a transition set just played (or stopped) at full/unchanged volume
   *  right up to the exact cut point in the live preview — the transition was real in EXPORT (see
   *  `buildAudioTrackStream`) but silently inert here, since nothing upstream of this function ever
   *  looked at `transitionIn`/`transitionOut` for an audio-track clip's live playback at all.
   *
   *  This distinction (which clips are "active" at all) is also what `drawFrame`'s calls to
   *  `pauseInactive` need, and using the wrong one there was a real, confirmed bug: passing ALL audible
   *  clips as "protected from pausing" meant an audio-track clip's element was NEVER told to pause once
   *  the playhead moved past its window — it just kept playing indefinitely, since `syncAudioTracks`
   *  also stops touching it the moment it's no longer active. The inverse bug hit at the same spot:
   *  during a gap in the video track, `drawFrame`'s early return called `pauseInactive(new Set())` — an
   *  EMPTY protected set — which paused every currently-audible element including audio-track clips
   *  that should keep playing under a video gap (background music, a voiceover with no matching
   *  footage yet). Both call sites now filter through this one method instead of disagreeing about
   *  what "active" means — and, now, both correctly see BOTH clips as active during a blend, so neither
   *  gets paused out from under the crossfade partway through.
   *
   *  `gain` here is `Clip.gain` × the live transition ramp only — it deliberately does NOT include
   *  `Track.gain`. A track's fader is applied downstream instead, by the one shared `GainNode` every
   *  clip on that track routes through (`AudioMixEngine.setTrackGain`) — folding it into this per-clip
   *  scalar would mean recomputing and re-pushing it into every playing clip's own node every time the
   *  fader moves, instead of the one shared-node update `tick()` already does per track per frame. */
  private activeAudioClips(project: Project, time: number): { trackId: string; clip: Clip; sourceTime: number; gain: number; sourceEnd: number }[] {
    const results: { trackId: string; clip: Clip; sourceTime: number; gain: number; sourceEnd: number }[] = [];
    for (const { track, clip } of audibleClips(project)) {
      const duration = clipDuration(clip);
      if (time < clip.timelineStart || time >= clip.timelineStart + duration) continue;
      const sourceTime = clipSourceTimeAtElapsed(clip, time - clip.timelineStart);

      const { gain, partner } = resolveAudioTransitionGain(track, clip, time);
      // Scheduled to run on past the out-point when the next clip blends out of this one, so the
      // audio flows straight into the blend (see `transitionPartnerSourceTime`). `resolveClipGain`
      // (not the bare `clip.gain ?? 1` this used to read) is what makes `gainKeyframes` do anything in
      // live preview — see its own doc comment.
      results.push({
        trackId: track.id,
        clip,
        sourceTime,
        gain: resolveClipGain(clip, time - clip.timelineStart) * gain,
        sourceEnd: clip.sourceOut + transitionTailExtension(track, clip),
      });
      if (partner) {
        results.push({
          trackId: track.id,
          clip: partner.clip,
          sourceTime: partner.sourceTime,
          gain: resolveClipGain(partner.clip, time - partner.clip.timelineStart) * partner.gain,
          sourceEnd: partner.clip.sourceOut + transitionTailExtension(track, partner.clip),
        });
      }
    }
    return results;
  }

  private totalDuration(project: Project): number {
    let end = 0;
    for (const track of project.sequence.tracks) {
      for (const clip of track.clips) {
        end = Math.max(end, clip.timelineStart + (clip.sourceOut - clip.sourceIn));
      }
    }
    return end;
  }

  private drawFrame(project: Project, context: CanvasRenderingContext2D, time: number, playing: boolean): void {
    const { width: frameWidth, height: frameHeight } = project.sequence;
    // Maps LOGICAL sequence-pixel coordinates — what every draw call below uses, since that's the
    // unit `ClipTransform.offsetX`, crop fractions, and text font sizes are all authored AND exported
    // in — onto the canvas's own physical backing store, which `tick` may have just capped to
    // something smaller than the sequence's real resolution (see `setDisplaySize`'s own comment). Set
    // fresh every frame rather than relying on it surviving one: assigning `canvas.width`/`height`
    // (which `tick` may just have done) already resets the transform to identity on its own, and no
    // `save()`/`restore()` pair anywhere in this file touches this outermost transform, so there's
    // nothing to accidentally compound across frames by setting it unconditionally here too.
    context.setTransform(context.canvas.width / frameWidth, 0, 0, context.canvas.height / frameHeight, 0, 0);

    context.fillStyle = "#000";
    context.fillRect(0, 0, frameWidth, frameHeight);
    this.drawIncomplete = false;
    this.reverseClipActiveThisFrame = false;

    // Computed once and reused by every `pauseInactive` call below, so a gap in the video track and a
    // clip actively playing agree on which audio-track elements are currently supposed to be making
    // sound — see this method's own doc comment for the two bugs that came from getting this wrong.
    const activeAudioIds = this.activeAudioClips(project, time).map((c) => c.clip.id);
    this.drawVisualLayers(project, context, frameWidth, frameHeight, time, activeAudioIds);
    this.lastFrameComplete = !this.drawIncomplete;
    // Whenever paused (frame-accurate seeking now always applies there, see `PAUSED_SEEK_TOLERANCE`'s
    // own doc comment) or a reversed clip is active (see `reverseClipActiveThisFrame`'s own doc
    // comment — that case applies during playback too).
    if (!playing || this.reverseClipActiveThisFrame) this.holdLastCompleteFrame(context);
  }

  /** Draws ONE video track's own active clip — the entire per-clip body used to run
   *  once, extracted so it can run once per visible video track without duplicating the readiness/
   *  transition/transform logic. */
  private drawVideoClip(
    project: Project,
    context: CanvasRenderingContext2D,
    frameWidth: number,
    frameHeight: number,
    track: Track,
    clip: Clip,
    time: number,
    activeTransition?: ActiveTransitionInfo | null
  ): void {
    const asset = project.assets.find((a) => a.id === clip.assetId);

    let element: HTMLVideoElement | HTMLImageElement | HTMLCanvasElement;
    let sourceWidth: number;
    let sourceHeight: number;

    if (asset?.kind === "color") {
      // A color-matte clip has no real media to load or sync — a solid-fill canvas (see
      // `colorCanvasFor`) stands in as the `drawImage` source below, sized to the FRAME itself (a flat
      // fill has no intrinsic size of its own) so it fills edge-to-edge before running through the exact
      // same crop/scale/transform/effects pipeline every other video-track clip already goes through.
      element = this.colorCanvasFor(asset.color ?? "#000000", frameWidth, frameHeight);
      sourceWidth = frameWidth;
      sourceHeight = frameHeight;
    } else {
      const isImage = asset?.kind === "image";
      const loaded = this.mediaFor(clip, isImage ? "image" : "video");
      if (!loaded) {
        this.drawIncomplete = true;
        return;
      }
      element = loaded;

      if (element instanceof HTMLImageElement) {
        // A still has no clock to sync and nothing to pause — it's ready as soon as it has decoded.
        if (!element.complete || element.naturalWidth === 0) {
          this.drawIncomplete = true;
          return;
        }
        const animation = asset?.animation;
        if (animation && this.host.spriteUrlFor) {
          element = this.animationFrameFor(clip.id, element, animation, clipSourceTimeAtElapsed(clip, time - clip.timelineStart));
          sourceWidth = animation.frameWidth;
          sourceHeight = animation.frameHeight;
        } else {
          sourceWidth = element.naturalWidth;
          sourceHeight = element.naturalHeight;
        }
      } else if (element instanceof HTMLVideoElement) {
        const sourceTime =
          activeTransition?.kind === "junction" && activeTransition.toSourceTime !== undefined
            ? activeTransition.toSourceTime
            : Math.max(0, clipSourceTimeAtElapsed(clip, time - clip.timelineStart));
        // The track's own visibility no longer needs checking here: `drawVideoLayer` already skips
        // hidden tracks entirely before this is ever called.
        this.syncMedia(clip.id, element, sourceTime, this.host.isPlaying(), clipSpeedAtElapsed(clip, time - clip.timelineStart), clip.reverse === true);
        // A video clip's own audio is silenced/scaled when the clip itself is muted/gained, OR when the
        // whole track it's on is muted — matching what export does (`buildExportPlan.ts`'s own
        // `buildTrackStreams` folds `track.muted` into the same `hasAudio` check), so preview and output
        // agree. Routed through `AudioMixEngine` (not `element.volume`/`.muted`) so it shares the same
        // mixing graph as audio-track clips and can be ducked around a reseek — see `syncVideoClipAudio`'s
        // own doc comment.
        //
        // Also ramped by `resolveAudioTransitionGain` — the same helper `activeAudioClips` already applies
        // for a pure audio-track clip's own transition (see that method's identical `(clip.gain ?? 1) *
        // gain` combination) — so a video clip's EMBEDDED audio fades in/out across its own transition
        // window in preview too, matching what export's `acrossfade` already does. Scoped to just this
        // clip's own window: a real two-clip video crossfade's OUTGOING partner still isn't wired into
        // `AudioMixEngine` as a second simultaneously-active source here — see `drawTransitionPartner`'s
        // own comment on why the partner's audio is deliberately not synced.
        const { gain: transitionGain } = resolveAudioTransitionGain(track, clip, time);
        const audioGain = resolveClipGain(clip, time - clip.timelineStart) * transitionGain;
        const audioMuted = (clip.mutedAudio ?? false) || track.muted;
        if (clip.reverse) {
          this.reverseClipActiveThisFrame = true;
          this.audioMixEngine.syncVideoClipAudio(clip, element, 0, true);
          this.audioMixEngine.syncRetimedVideoClipAudio(clip, sourceTime, clipSpeedAtElapsed(clip, time - clip.timelineStart), audioGain, audioMuted, this.host.isPlaying());
        } else {
          this.audioMixEngine.syncRetimedVideoClipAudio(clip, sourceTime, 1, 0, true, false);
          this.audioMixEngine.syncVideoClipAudio(clip, element, audioGain, audioMuted);
        }
        // readyState < 2 means no frame is decoded yet; drawing would throw or paint garbage.
        if (element.readyState < 2) {
          this.drawIncomplete = true;
          return;
        }
        if (element.seeking) this.drawIncomplete = true;
        sourceWidth = element.videoWidth;
        sourceHeight = element.videoHeight;
      } else {
        return;
      }
    }

    if (sourceWidth === 0 || sourceHeight === 0) return;

    // Computed here (not just below, where the OLD code first needed it for transition timing) since
    // the keyframe resolvers just below need it too — one clip-window-relative "how far in are we"
    // value shared by transform/effects resolution AND transition timing.
    const elapsed = time - clip.timelineStart;

    // A live drag in progress on THIS clip (directly, or as part of a multi-select group move)
    // overrides its saved transform — see `getLiveOverrides`' own comment for why: without this, the
    // canvas would only ever show the last COMMITTED position while `TransformHandles`' own overlay
    // box(es) track the pointer, which reads as "only the selection box moves." Still wins outright
    // over a keyframed value — dragging a handle mid-animation previews the dragged value at this
    // exact instant, same as it would for a static (unkeyframed) clip.
    const override = this.host.getLiveOverrides().find((o) => o.clipId === clip.id);
    const transform = override?.transform ?? resolveClipTransform(clip, elapsed);
    // Same live-drag override as `transform` above — an Inspector Effects field mid-drag/mid-type
    // previews here exactly the same way a canvas transform handle does.
    const effects = override?.effects ?? resolveClipEffects(clip, elapsed);
    // Same live-drag override as `transform`/`effects` above — a CurveEditor drag previews here too.
    const colorGrading = override?.colorGrading ?? resolveClipColorGrading(clip, elapsed);
    const mask = override?.mask ?? clip.mask;

    // A REAL partner is drawn FULLY OPAQUE to its own scratch canvas first, then blended by
    // `compositeTransitionFrame` against this clip (also drawn to its own scratch canvas) according to
    // the clip's own `transitionIn.type` — see that method's own comment for why (a wipe/slide/circle
    // needs two flat images to composite, not an alpha multiplier threaded through `drawTransformed`'s
    // existing geometry pipeline). A `null` partner (solo fade-in) instead goes through
    // `compositeSoloReveal` directly on `context` — see ITS own doc comment for why a solo fade can't
    // reuse the two-panel path with a blank stand-in for the missing side. Only attempted while
    // genuinely inside the blend window; `findTransitionPartner` re-validates adjacency fresh every
    // call (see its own doc comment), so a broken precondition just falls through to drawing this clip
    // alone, same as a plain cut always has. Operates entirely within THIS track — a transition on one
    // track has no effect on any other track's own compositing.
    if (activeTransition?.kind === "junction" && activeTransition.fromClip && activeTransition.toClip) {
      const partner = activeTransition.fromClip;
      const toClip = activeTransition.toClip;
      const progress = activeTransition.progress;
      const outCtx = this.transitionCanvas("a", frameWidth, frameHeight);
      const inCtx = this.transitionCanvas("b", frameWidth, frameHeight);
      const partnerDrawn =
        outCtx &&
        this.drawTransitionPartner(
          project,
          outCtx,
          frameWidth,
          frameHeight,
          partner,
          activeTransition.duration,
          activeTransition.elapsed,
          track.muted,
          activeTransition.fromSourceTime
        );
      if (partnerDrawn && inCtx) {
        this.drawTransformed(
          inCtx,
          element,
          sourceWidth,
          sourceHeight,
          frameWidth,
          frameHeight,
          transform,
          effects,
          1,
          clip.chromaKey,
          colorGrading,
          clip.id,
          clip.lutId,
          clip.pixelEffect,
          elapsed,
          clip.flipHorizontal,
          mask,
          clip.flipVertical,
          override?.lutIntensity ?? clip.lutIntensity
        );
        compositeTransitionFrame(
          context,
          frameWidth,
          frameHeight,
          toClip.transitionIn?.type ?? "crossfade",
          progress,
          this.transitionCanvasA!,
          this.transitionCanvasB!,
          activeTransition.duration
        );
        return;
      }
    } else if (activeTransition?.kind === "solo-in") {
      compositeSoloReveal(
        context,
        frameWidth,
        frameHeight,
        clip.transitionIn?.type ?? "crossfade",
        activeTransition.progress,
        (alphaMultiplier, targetContext) => {
          this.drawTransformed(
            targetContext ?? context,
            element,
            sourceWidth,
            sourceHeight,
            frameWidth,
            frameHeight,
            transform,
            effects,
            alphaMultiplier,
            clip.chromaKey,
            colorGrading,
            clip.id,
            clip.lutId,
            clip.pixelEffect,
            elapsed,
            clip.flipHorizontal,
            mask,
            clip.flipVertical,
          override?.lutIntensity ?? clip.lutIntensity
          );
        },
        { windowElapsed: activeTransition.elapsed, windowDuration: activeTransition.duration, clipElapsed: elapsed, fadingOut: false }
      );
      return;
    } else if (activeTransition?.kind === "solo-out") {
      const reveal = 1 - activeTransition.progress;
      compositeSoloReveal(
        context,
        frameWidth,
        frameHeight,
        clip.transitionOut?.type ?? "crossfade",
        reveal,
        (alphaMultiplier, targetContext) => {
          this.drawTransformed(
            targetContext ?? context,
            element,
            sourceWidth,
            sourceHeight,
            frameWidth,
            frameHeight,
            transform,
            effects,
            alphaMultiplier,
            clip.chromaKey,
            colorGrading,
            clip.id,
            clip.lutId,
            clip.pixelEffect,
            elapsed,
            clip.flipHorizontal,
            mask,
            clip.flipVertical,
          override?.lutIntensity ?? clip.lutIntensity
          );
        },
        {
          windowElapsed: activeTransition.elapsed,
          windowDuration: activeTransition.duration,
          clipElapsed: elapsed,
          fadingOut: true,
        }
      );
      return;
    }

    this.drawTransformed(context, element, sourceWidth, sourceHeight, frameWidth, frameHeight, transform, effects, 1, clip.chromaKey, colorGrading, clip.id, clip.lutId, clip.pixelEffect, elapsed, clip.flipHorizontal, mask, clip.flipVertical, override?.lutIntensity ?? clip.lutIntensity);
  }

  /** Draws and plays the outgoing clip's source handle during a blend, holding its final frame at EOF.
   *  Uses the same transform and audio paths as ordinary playback, without live-drag overrides. Returns
   *  `false` when the partner's element isn't ready to draw yet, so the caller can fall back to drawing
   *  this clip alone rather than blending against nothing. */
  private drawTransitionPartner(
    project: Project,
    context: CanvasRenderingContext2D,
    frameWidth: number,
    frameHeight: number,
    partner: Clip,
    duration: number,
    elapsed: number,
    trackMuted: boolean,
    sourceTimeOverride?: number
  ): boolean {
    const asset = project.assets.find((a) => a.id === partner.assetId);
    // In the centered model, elapsed is measured from transition start (cut - duration/2).
    // At the cut (elapsed = duration/2), elapsedPastCut is 0.
    const sourceTime = sourceTimeOverride ?? transitionPartnerSourceTime(partner, elapsed - duration / 2);

    let element: HTMLVideoElement | HTMLImageElement | HTMLCanvasElement;
    let sourceWidth: number;
    let sourceHeight: number;

    if (asset?.kind === "color") {
      // Same stand-in as `drawVideoClip`'s own identical branch — see its comment.
      element = this.colorCanvasFor(asset.color ?? "#000000", frameWidth, frameHeight);
      sourceWidth = frameWidth;
      sourceHeight = frameHeight;
    } else {
      const isImage = asset?.kind === "image";
      const loaded = this.mediaFor(partner, isImage ? "image" : "video");
      if (!loaded) return false;
      element = loaded;

      if (element instanceof HTMLImageElement) {
        if (!element.complete || element.naturalWidth === 0) return false;
        const animation = asset?.animation;
        if (animation && this.host.spriteUrlFor) {
          element = this.animationFrameFor(partner.id, element, animation, sourceTime);
          sourceWidth = animation.frameWidth;
          sourceHeight = animation.frameHeight;
        } else {
          sourceWidth = element.naturalWidth;
          sourceHeight = element.naturalHeight;
        }
      } else if (element instanceof HTMLVideoElement) {
        // The outgoing clip was already playing right up to its out-point, so it simply keeps playing
        // through the blend — the same drift-corrected transport every current clip gets, no seek at
        // the cut. It used to be PAUSED here instead (a frozen last frame, while export replayed the
        // tail in motion), with its embedded audio cut; now its audio fades out under the incoming
        // clip's fade-in, the way export's `acrossfade` mixes them.
        this.syncMedia(
          partner.id,
          element,
          sourceTime,
          this.host.isPlaying(),
          clipSpeedAtElapsed(partner, clipDuration(partner) - duration / 2 + elapsed),
          partner.reverse === true
        );
        const partnerGain = resolveClipGain(partner, clipDuration(partner) - duration / 2 + elapsed) * (1 - Math.min(1, elapsed / duration));
        const partnerMuted = (partner.mutedAudio ?? false) || trackMuted;
        if (partner.reverse) {
          this.reverseClipActiveThisFrame = true;
          this.audioMixEngine.syncVideoClipAudio(partner, element, 0, true);
          this.audioMixEngine.syncRetimedVideoClipAudio(partner, sourceTime, clipSpeedAtElapsed(partner, clipDuration(partner) - duration / 2 + elapsed), partnerGain, partnerMuted, this.host.isPlaying());
        } else {
          this.audioMixEngine.syncVideoClipAudio(partner, element, partnerGain, partnerMuted);
        }
        if (element.readyState < 2) return false;
        sourceWidth = element.videoWidth;
        sourceHeight = element.videoHeight;
      } else {
        return false;
      }
    }

    if (sourceWidth === 0 || sourceHeight === 0) return false;

    // The partner's OWN clip-window-relative elapsed time — past the end of its window during a blend,
    // which keyframe resolution clamps to the last keyframe's value. No live-drag override here: the
    // partner isn't "current" for editing purposes.
    const partnerElapsed = clipDuration(partner) - duration / 2 + elapsed;
    const transform = resolveClipTransform(partner, partnerElapsed);
    const effects = resolveClipEffects(partner, partnerElapsed);
    const colorGrading = resolveClipColorGrading(partner, partnerElapsed);
    this.drawTransformed(context, element, sourceWidth, sourceHeight, frameWidth, frameHeight, transform, effects, 1, partner.chromaKey, colorGrading, partner.id, partner.lutId, partner.pixelEffect, partnerElapsed, partner.flipHorizontal, partner.mask, partner.flipVertical, partner.lutIntensity);
    return true;
  }

  /** Draws one source (video frame or image) into the sequence frame under a transform — the ONE
   *  place this class composites a source onto the canvas, so the untransformed case (identity) and a
   *  fully transformed one are guaranteed to agree on geometry rather than risking two separate code
   *  paths drifting apart.
   *
   *  Pipeline, matching `ClipTransform`'s own doc comment and `buildExportPlan`'s FFmpeg graph exactly:
   *  scale-to-fit the FULL source → crop the source rect without re-centering → apply the user `scale` multiplier →
   *  rotate around center → translate by offset. `drawImage`'s 8-argument form does the crop step
   *  itself (a source rect), so there's no need for an intermediate cropped canvas.
   *
   *  `alphaMultiplier` (default 1) layers on top of the clip's own `effects.opacity` rather than
   *  replacing it, so a crossfade blend and a clip's own opacity setting compose correctly instead of
   *  one silently overriding the other. */
  private drawTransformed(
    context: CanvasRenderingContext2D,
    element: HTMLVideoElement | HTMLImageElement | HTMLCanvasElement,
    sourceWidth: number,
    sourceHeight: number,
    frameWidth: number,
    frameHeight: number,
    transform: ClipTransform,
    effects: ClipEffects,
    alphaMultiplier = 1,
    chromaKey?: ChromaKeySettings,
    colorGrading?: ColorGrading,
    clipId?: string,
    lutId?: string,
    pixelEffect?: Clip["pixelEffect"],
    elapsedSeconds = 0,
    flipHorizontal = false,
    mask?: ClipMask,
    flipVertical = false,
    lutIntensity?: number
  ): void {
    const box = computeTransformedBox(sourceWidth, sourceHeight, frameWidth, frameHeight, transform);
    if (!box) return;

    // Chroma key, color-grading curves, a LUT, and a pixel effect (glitch/water-ripple) ALL operate on
    // the RAW, un-cropped, un-scaled source, and ALL need a `getImageData`/`putImageData` round-trip —
    // combined into a SINGLE readback here rather than each running its own (chroma key touches only
    // alpha, curves and the LUT both touch only R/G/B, and a pixel effect runs LAST, after every color
    // operation, since it's a spatial displacement rather than a color one — none of the passes
    // destructively interact). Result handed to the exact same crop/scale/rotate/translate `drawImage`
    // call below a plain clip already uses, via `source` standing in for `element`. Zero geometry-path
    // divergence between a processed and unprocessed clip — only which image gets drawn differs.
    // `needsLut` gates the READBACK on `lutId` being SET, not on the LUT having actually finished
    // loading — a clip with a LUT but otherwise-identity color grading must still get the readback, or
    // a still-loading (or just-assigned) LUT would never get the chance to apply once it resolves.
    let source: CanvasImageSource = element;
    const needsColorGrading = colorGrading !== undefined && !isIdentityColorGrading(colorGrading);
    const needsLut = lutId !== undefined;
    // A real, reported bug: on a browser where `context.filter` doesn't actually apply anything at all
    // (Safari/WebKit, every version — see `supportsCanvasFilter`'s own doc comment), brightness/
    // contrast/saturation/blur silently never showed up in the live preview, with nothing to notice the
    // failure by. `applyManualEffects` is the pixel-math equivalent, run through this SAME readback
    // pipeline rather than a separate one.
    const needsManualEffects = !isIdentityEffects(effects) && !supportsCanvasFilter();
    if (chromaKey || needsColorGrading || needsLut || pixelEffect || needsManualEffects || mask) {
      // A pixel effect (glitch/water ripple) displaces by a fixed number of SOURCE pixels, so it must
      // keep running at full resolution to look the same — everything else here is either per-pixel
      // color math or expressed in resolution-independent fractions (mask, crop), so it's exactly as
      // correct at the reduced resolution. See `pipelineScaleFor`.
      const workScale = pixelEffect ? 1 : pipelineScaleFor((box.width * deviceScaleOf(context)) / box.cropWidth);
      const workWidth = Math.max(1, Math.round(sourceWidth * workScale));
      const workHeight = Math.max(1, Math.round(sourceHeight * workScale));
      const scratch = this.chromaKeyCanvas(workWidth, workHeight);
      if (scratch) {
        scratch.clearRect(0, 0, workWidth, workHeight);
        scratch.drawImage(element, 0, 0, workWidth, workHeight);
        const imageData = scratch.getImageData(0, 0, workWidth, workHeight);
        if (chromaKey) applyChromaKey(imageData, chromaKey);
        if (needsColorGrading) applyColorGrading(imageData, this.resolveColorGradingLuts(clipId ?? "", colorGrading!));
        // Applied AFTER color grading, matching `Clip.lutId`'s own doc comment and
        // `buildExportPlan.ts`'s identical curves-then-lut3d ordering. `resolveLut` returns `null` while
        // the file is still loading (or unresolvable) — this frame just renders without it rather than
        // blocking the render loop; the very next frame after it resolves applies it normally.
        if (needsLut) {
          const lut = this.resolveLut(lutId!, lutIntensity);
          if (lut) applyLut3D(imageData, lut);
        }
        // A spatial displacement, not a color operation — see `Clip.pixelEffect`'s own doc comment for
        // why this isn't keyframeable, and `timeline/pixelEffects.ts` for the two pure functions
        // themselves.
        if (pixelEffect) {
          const speed = pixelEffect.speed ?? 1;
          if (pixelEffect.type === "glitch") applyGlitch(imageData, elapsedSeconds, speed);
          else applyWaterRipple(imageData, elapsedSeconds, speed);
        }
        if (mask) applyClipMask(imageData, mask, transform.crop);
        // Last — `context.filter` (when supported) applies at DRAW time, after this whole readback
        // pipeline already finished and drew its result back via `putImageData`; running the manual
        // fallback last too keeps the two paths visually consistent with each other. Blur is EXCLUDED
        // here (`blur: 0`) and applied separately, below, via `applyDownsampledBlur` — running it in
        // place on this SAME full-`sourceWidth`×`sourceHeight` buffer (as this used to) was a real,
        // reported performance bug: brightness/contrast/saturation are cheap O(1)-per-pixel work, but
        // `applyBoxBlur` is not, and a source video's own native resolution is often considerably
        // larger than the sequence's own frame size — see `applyDownsampledBlur`'s own doc comment.
        if (needsManualEffects) applyManualEffects(imageData, { ...effects, blur: 0 });
        scratch.putImageData(imageData, 0, 0);
        source = scratch.canvas;
        if (needsManualEffects && effects.blur > 0) {
          // `effects.blur` is in sequence pixels (export blurs AFTER scaling the clip to its on-screen
          // size) but this buffer is still at SOURCE resolution — convert, or a 4K source would get a
          // fraction of the blur a 720p one does.
          const sourcePxPerFramePx = box.width > 0 ? box.cropWidth / box.width : 1;
          source = applyDownsampledBlur(source, workWidth, workHeight, effects.blur * sourcePxPerFramePx * (workWidth / sourceWidth), "a");
        }
      }
    }

    context.save();
    // `filter`/`globalAlpha` are both part of the state `save()`/`restore()` already bracket, so
    // there's no separate reset needed beyond the `restore()` this function already had — see
    // `ClipEffects`'s own doc comment for why `brightness`/`blur` are approximations here, not exact
    // matches for what `buildExportPlan`'s `eq`/`gblur` filters produce. Explicitly "none" (not just
    // left as `buildCanvasFilterString`'s own string, which would ALSO be a no-op on an unsupporting
    // browser) once `needsManualEffects` already baked the effect into pixels above — a browser that
    // silently ignores the WHOLE string today isn't guaranteed to keep ignoring every individual
    // function within it forever, and double-applying would look wrong the moment that changes.
    context.filter = needsManualEffects ? "none" : buildCanvasFilterString(effects, deviceScaleOf(context));
    context.globalAlpha = effects.opacity * alphaMultiplier;
    context.translate(box.centerX, box.centerY);
    if (transform.rotationDeg !== 0) context.rotate((transform.rotationDeg * Math.PI) / 180);
    if (flipHorizontal || flipVertical) context.scale(flipHorizontal ? -1 : 1, flipVertical ? -1 : 1);
    // `box`'s crop rect is in the ORIGINAL source's pixels; a processed `source` canvas may be smaller
    // (reduced pipeline resolution, and/or `applyDownsampledBlur`'s own working size), so map it by the
    // canvas's ACTUAL size rather than assuming it matches. 1 for an unprocessed element.
    const mapX = source === element ? 1 : (source as HTMLCanvasElement).width / sourceWidth;
    const mapY = source === element ? 1 : (source as HTMLCanvasElement).height / sourceHeight;
    context.drawImage(
      source,
      box.cropX * mapX,
      box.cropY * mapY,
      box.cropWidth * mapX,
      box.cropHeight * mapY,
      -box.width / 2,
      -box.height / 2,
      box.width,
      box.height
    );
    context.restore();
  }

  /** A solid-fill canvas per distinct (color, size) pair, memoized (the same color/frame-size combo
   *  repeats far more often than it changes) rather than rebuilt every frame. Sized to MATCH
   *  `sourceWidth`×`sourceHeight` (`drawVideoClip`'s color branch passes `frameWidth`/`frameHeight`) —
   *  NOT just 1×1 — because `drawTransformed`'s `drawImage` call reads `box.cropX/cropY/cropWidth/
   *  cropHeight` from `computeTransformedBox`, which computes that crop rectangle IN SOURCE-PIXEL SPACE
   *  against the `sourceWidth`/`sourceHeight` this function was told, not the canvas's own actual pixel
   *  dimensions. A 1×1 backing canvas with a crop rectangle computed for a 1080×1920 "source" asks
   *  `drawImage` for a source rect far outside the image's real bounds — confirmed live: it silently
   *  draws NOTHING (leaving the frame's prior black clear showing through) rather than erroring, so the
   *  mismatch is invisible until you actually look at the result. Cache key includes size so a sequence
   *  resize (rare) just adds a new cached canvas rather than reusing a stale one. */
  private colorCanvasCache = new Map<string, HTMLCanvasElement>();
  /** Per clip: a frame-sized canvas holding an animated sticker's current frame, copied out of its
   *  sprite sheet only when the frame (or the sheet) changes. Dropped with the clip's pooled element. */
  private animationFrames = new Map<string, { canvas: HTMLCanvasElement; sheet: HTMLImageElement; frame: number }>();

  /** The frame of an animated image showing at `sourceTime`, as a canvas the normal crop/scale/
   *  transform/effects drawing takes like any other source — `animationFrameIndex` is the same rule
   *  export follows (see `stickers.ts`). */
  private animationFrameFor(clipId: string, sheet: HTMLImageElement, animation: AssetAnimation, sourceTime: number): HTMLCanvasElement {
    const frame = animationFrameIndex(animation, sourceTime);
    let entry = this.animationFrames.get(clipId);
    if (!entry || entry.canvas.width !== animation.frameWidth || entry.canvas.height !== animation.frameHeight) {
      const canvas = document.createElement("canvas");
      canvas.width = animation.frameWidth;
      canvas.height = animation.frameHeight;
      entry = { canvas, sheet, frame: -1 };
      this.animationFrames.set(clipId, entry);
    }
    if (entry.frame !== frame || entry.sheet !== sheet) {
      const ctx = entry.canvas.getContext("2d");
      if (ctx) {
        const rect = animationFrameRect(animation, frame);
        ctx.clearRect(0, 0, entry.canvas.width, entry.canvas.height);
        ctx.drawImage(sheet, rect.x, rect.y, rect.width, rect.height, 0, 0, entry.canvas.width, entry.canvas.height);
      }
      entry.frame = frame;
      entry.sheet = sheet;
    }
    return entry.canvas;
  }

  private colorCanvasFor(color: string, width: number, height: number): HTMLCanvasElement {
    const key = `${color}@${width}x${height}`;
    const cached = this.colorCanvasCache.get(key);
    if (cached) return cached;
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.round(width));
    canvas.height = Math.max(1, Math.round(height));
    const ctx = canvas.getContext("2d");
    if (ctx) {
      ctx.fillStyle = color;
      ctx.fillRect(0, 0, canvas.width, canvas.height);
    }
    this.colorCanvasCache.set(key, canvas);
    return canvas;
  }

  /** Gets (or creates/resizes) one of the two scratch canvases `compositeTransitionFrame` blends —
   *  `which` picks A (the OUTGOING side) or B (the INCOMING side). Cleared to fully transparent on
   *  every call: a transition's own `drawFrame` already cleared the MAIN canvas to opaque black before
   *  any of this runs, so a transparent scratch canvas composited on top (via plain `drawImage`, no
   *  extra alpha math) naturally reproduces the same "letterbox shows through" result a direct draw
   *  would have. */
  private transitionCanvas(which: "a" | "b", width: number, height: number): CanvasRenderingContext2D | null {
    const existing = which === "a" ? this.transitionCanvasA : this.transitionCanvasB;
    const canvas = existing ?? document.createElement("canvas");
    if (!existing) {
      if (which === "a") this.transitionCanvasA = canvas;
      else this.transitionCanvasB = canvas;
    }
    if (canvas.width !== width || canvas.height !== height) {
      canvas.width = width;
      canvas.height = height;
    }
    const context = canvas.getContext("2d");
    if (context) context.clearRect(0, 0, width, height);
    return context;
  }

  /** Gets (or creates/resizes) the one scratch canvas `drawTransformed` chroma-keys a clip's raw
   *  source pixels onto, before handing the result to the SAME crop/scale/rotate/translate pipeline a
   *  plain (non-keyed) clip already goes through — so a chroma-keyed clip's own `ClipTransform` behaves
   *  identically to a plain one, no separate geometry path to keep in sync. `willReadFrequently: true`
   *  since `getImageData` runs here every frame a keyed clip is visible — without this hint, some
   *  browsers keep the canvas's backing store GPU-side and pay a full readback penalty on every call. */
  private chromaKeyCanvas(width: number, height: number): CanvasRenderingContext2D | null {
    const canvas = this.chromaKeyCanvasEl ?? document.createElement("canvas");
    if (!this.chromaKeyCanvasEl) this.chromaKeyCanvasEl = canvas;
    if (canvas.width !== width || canvas.height !== height) {
      canvas.width = width;
      canvas.height = height;
    }
    return canvas.getContext("2d", { willReadFrequently: true });
  }

  /** Composed per-channel R/G/B LUTs for `grading`, memoized per clip id — see `colorGradingLutCache`'s
   *  own doc comment for the invalidation rule. Composition order (`master(channel(input))`) matches
   *  `colorCurves.ts`'s own `composeLuts` doc comment, verified against FFmpeg's `vf_curves.c`. */
  private resolveColorGradingLuts(clipId: string, grading: ColorGrading) {
    const cached = this.colorGradingLutCache.get(clipId);
    if (cached && cached.source === grading) return cached;
    const masterLut = buildCurveLut(grading.master);
    const next = {
      source: grading,
      r: composeLuts(masterLut, buildCurveLut(grading.red)),
      g: composeLuts(masterLut, buildCurveLut(grading.green)),
      b: composeLuts(masterLut, buildCurveLut(grading.blue)),
    };
    this.colorGradingLutCache.set(clipId, next);
    return next;
  }

  /** Resolves `lutId` to its parsed `Lut3D`, fetching + parsing the `.cube` file at most once per id
   *  (see `lutCache`'s own doc comment). Returns `null` — meaning "skip applying a LUT this frame" —
   *  for THREE distinct cases the caller doesn't need to tell apart: the id doesn't resolve to a real
   *  `LutAsset` (`lutUrlFor` returned `null`), the fetch/parse is still in flight, or it already failed
   *  (network error, or a `.cube` file `parseCubeLut` couldn't read). This is the same "don't stall the
   *  render loop for a still-loading resource" principle `mediaFor`'s own not-yet-decoded-frame checks
   *  already follow elsewhere in this file — a LUT that hasn't loaded yet just renders as if absent for
   *  a frame or two, then starts applying itself the instant it resolves, with no visible stall. */
  private resolveLut(lutId: string, intensity?: number): Lut3D | null {
    const full = this.resolveFullLut(lutId);
    if (!full) return null;
    const k = normalizeLutIntensity(intensity);
    if (k >= 1) return full;
    // Blended lattices are cheap (≈36k floats for a 33³ LUT) but a slider drag asks for a new one every
    // frame, so they're cached per (lut, hundredths) and the cache is trimmed to a handful of recent
    // entries — a drag walks through many values and only the latest matters.
    const key = `${lutId}@${Math.round(k * 100)}`;
    const cached = this.blendedLutCache.get(key);
    if (cached) return cached;
    const blended = blendLut3D(full, k);
    this.blendedLutCache.set(key, blended);
    if (this.blendedLutCache.size > 12) this.blendedLutCache.delete(this.blendedLutCache.keys().next().value as string);
    return blended;
  }

  private resolveFullLut(lutId: string): Lut3D | null {
    const cached = this.lutCache.get(lutId);
    if (cached instanceof Promise) return null;
    if (cached) return cached;

    const url = this.host.lutUrlFor(lutId);
    if (!url) return null;

    const pending = fetch(url)
      .then((response) => response.text())
      .then((text) => {
        this.lutCache.set(lutId, parseCubeLut(text));
      })
      .catch(() => {
        // Drop the cache entry (rather than caching the rejected promise forever) so a transient
        // failure — a dropped connection, a file removed mid-fetch — gets a real retry on the NEXT
        // frame that needs this lutId, instead of silently never applying the LUT for the rest of the
        // session.
        this.lutCache.delete(lutId);
      });
    this.lutCache.set(lutId, pending);
    return null;
  }

  /** Draws every visible text track's active clip, on top of whatever the video layer drew. Several
   *  text tracks can be simultaneously active (each its own overlay) — drawn in track order, so a
   *  lower text track is behind a higher one if they ever visually overlap, matching how stacking
   *  order works for every other track kind in this app. */
  /** Draws all visual tracks (video and text) in their sequence array order —
   *  allowing visual tracks to be interleaved so text can be placed behind a cutout person or between video layers! */
  private drawVisualLayers(
    project: Project,
    context: CanvasRenderingContext2D,
    frameWidth: number,
    frameHeight: number,
    time: number,
    activeAudioIds: string[]
  ): void {
    const activeClipIds = new Set<string>();

    for (const track of project.sequence.tracks) {
      if (!track.visible) continue;

      if (track.kind === "video") {
        const activeTransition = findActiveTransitionAtTime(track, time);
        if (activeTransition?.kind === "junction" && activeTransition.fromClip && activeTransition.toClip) {
          activeClipIds.add(activeTransition.fromClip.id);
          activeClipIds.add(activeTransition.toClip.id);
          const blendClip = time < (activeTransition.cut ?? activeTransition.toClip.timelineStart)
            ? activeTransition.fromClip
            : activeTransition.toClip;
          context.save();
          context.globalCompositeOperation = clipBlendCompositeOperation(blendClip);
          this.drawVideoClip(project, context, frameWidth, frameHeight, track, activeTransition.toClip, time, activeTransition);
          context.restore();
        } else {
          const clip = clipAtTime(track, time);
          if (!clip) continue;
          activeClipIds.add(clip.id);
          context.save();
          context.globalCompositeOperation = clipBlendCompositeOperation(clip);
          this.drawVideoClip(project, context, frameWidth, frameHeight, track, clip, time, activeTransition);
          context.restore();
        }
      } else if (track.kind === "text") {
        this.drawSingleTextTrack(project, context, frameWidth, frameHeight, track, time);
      }
    }

    this.pauseInactive(new Set([...activeClipIds, ...activeAudioIds]));
  }

  private drawSingleTextTrack(
    project: Project,
    context: CanvasRenderingContext2D,
    frameWidth: number,
    frameHeight: number,
    track: Track,
    time: number
  ): void {
    if (track.kind !== "text" || !track.visible) return;
    const activeTransition = findActiveTransitionAtTime(track, time);
    const clip = activeTransition?.kind === "junction" && activeTransition.toClip ? activeTransition.toClip : clipAtTime(track, time);
    if (!clip) return;
    const asset = project.assets.find((a) => a.id === clip.assetId);
    if (!asset || asset.kind !== "text" || !asset.textStyle) return;
    const elapsed = time - clip.timelineStart;
    const overrides = this.host.getLiveOverrides();
    const style = overrides.find((o) => o.clipId === clip.id)?.textStyle ?? resolveTextStyle(clip, elapsed, asset.textStyle);

    const textCrop = overrides.find((o) => o.clipId === clip.id)?.textCrop ?? resolveTextCrop(clip, elapsed);
    const cropRect =
      textCrop && !isIdentityTextCrop(textCrop)
        ? {
            x: frameWidth * textCrop.left,
            y: frameHeight * textCrop.top,
            w: frameWidth * (1 - textCrop.left - textCrop.right),
            h: frameHeight * (1 - textCrop.top - textCrop.bottom),
          }
        : null;
    function withCrop(draw: () => void): void {
      if (cropRect) {
        context.save();
        context.beginPath();
        context.rect(cropRect.x, cropRect.y, cropRect.w, cropRect.h);
        context.clip();
      }
      draw();
      if (cropRect) context.restore();
    }

    if (activeTransition?.kind === "junction" && activeTransition.fromClip && activeTransition.toClip) {
      const partner = activeTransition.fromClip;
      const partnerAsset = project.assets.find((a) => a.id === partner.assetId);
      if (partnerAsset?.kind === "text" && partnerAsset.textStyle) {
        const outCtx = this.transitionCanvas("a", frameWidth, frameHeight);
        const inCtx = this.transitionCanvas("b", frameWidth, frameHeight);
        if (outCtx && inCtx) {
          const partnerElapsed = partner.timelineStart + clipDuration(partner) - activeTransition.cut! + (time - activeTransition.cut!);
          const fromStyle = overrides.find((o) => o.clipId === partner.id)?.textStyle ?? resolveTextStyle(partner, partnerElapsed, partnerAsset.textStyle);
          this.drawText(outCtx, frameWidth, frameHeight, partnerAsset.textContent ?? "", fromStyle, undefined, project.customFonts);
          this.drawText(inCtx, frameWidth, frameHeight, asset.textContent ?? "", style, undefined, project.customFonts);
          withCrop(() => {
            compositeTransitionFrame(context, frameWidth, frameHeight, activeTransition.type, activeTransition.progress, outCtx.canvas, inCtx.canvas, activeTransition.duration);
          });
          return;
        }
      }
    } else if (activeTransition?.kind === "solo-in") {
      withCrop(() => {
        compositeSoloReveal(
          context,
          frameWidth,
          frameHeight,
          activeTransition.type,
          activeTransition.progress,
          () => {
            this.drawText(context, frameWidth, frameHeight, asset.textContent ?? "", style, undefined, project.customFonts);
          },
          { windowElapsed: activeTransition.elapsed, windowDuration: activeTransition.duration, clipElapsed: elapsed, fadingOut: false }
        );
      });
      return;
    } else if (activeTransition?.kind === "solo-out") {
      const reveal = 1 - activeTransition.progress;
      withCrop(() => {
        compositeSoloReveal(
          context,
          frameWidth,
          frameHeight,
          activeTransition.type,
          reveal,
          () => {
            this.drawText(context, frameWidth, frameHeight, asset.textContent ?? "", style, undefined, project.customFonts);
          },
          { windowElapsed: activeTransition.elapsed, windowDuration: activeTransition.duration, clipElapsed: elapsed, fadingOut: true }
        );
      });
      return;
    }

    withCrop(() => {
      this.drawAnimatedText(
        context,
        frameWidth,
        frameHeight,
        asset.textContent ?? "",
        style,
        clip.textAnimation,
        elapsed,
        clipDuration(clip),
        project.customFonts,
        clip.wordTimings
      );
    });
  }

  /** Thin wrapper over the extracted, standalone `drawAnimatedTextFrame` (`textLayout.ts`) — same
   *  "reuse the exact preview code, don't reimplement it" reasoning as `drawText`'s own wrapper above. */
  private drawAnimatedText(
    context: CanvasRenderingContext2D,
    frameWidth: number,
    frameHeight: number,
    content: string,
    style: TextStyle,
    animation: Clip["textAnimation"],
    elapsedSeconds: number,
    clipDurationSeconds: number,
    customFonts: CustomFontAsset[],
    wordTimings?: Clip["wordTimings"]
  ): void {
    drawAnimatedTextFrame(context, frameWidth, frameHeight, content, style, animation, elapsedSeconds, clipDurationSeconds, customFonts, wordTimings);
  }

  /** Renders one text asset's content+style. Mirrors `buildExportPlan`'s FFmpeg `drawtext` chain in
   *  two ways, both covered by `textLayout.ts`'s own doc comment: the block's own screen position
   *  depends only on `offsetX`/`offsetY`, never on `align` (so re-justifying text never moves the box),
   *  and per-line justification WITHIN that fixed box (via `lineX` below) matches FFmpeg's own
   *  `text_align` option exactly — both true per-line alignment now, not an approximation.
   *
   *  Rotation pivots around the SEQUENCE FRAME's own center, offset applied AFTER rotating — which,
   *  now that the block's own position no longer depends on `align`, IS the block's own true center
   *  for every `align` value (not just `"center"`), so this needs no per-align special case on either
   *  renderer — see `buildRotatedDrawTextFilter`'s own comment for the FFmpeg-side half of this. */
  // Thin wrapper over the extracted, standalone `drawTextFrame` (`textLayout.ts`) — moved out so the
  // Khmer-script export render harness (a headless-browser page, see `khmerTextRenderer.ts`) can call
  // the exact same function the live preview uses, guaranteeing byte-for-byte parity rather than a
  // reimplementation that could quietly drift from what this class actually draws.
  private drawText(
    context: CanvasRenderingContext2D,
    frameWidth: number,
    frameHeight: number,
    content: string,
    style: TextStyle,
    wordHighlight?: { activeWordIndex: number; highlightColor: string },
    customFonts: CustomFontAsset[] = []
  ): void {
    drawTextFrame(context, frameWidth, frameHeight, content, style, wordHighlight, customFonts);
  }

  /** Once per page load, three seconds into continuous playback over at least one audio-track clip,
   *  reports what the audio engine is actually doing — whether each clip's file fetched and decoded,
   *  whether its buffer source is playing (or restarting), whether the audio clock advanced, and the
   *  state of the video elements alongside. Sent whether or not anything looks wrong, so a working
   *  device is evidence too. Exists because an extracted audio clip was reported silent on an iPhone
   *  while the same project played fine in desktop Chromium. */
  private maybeReportAudio(project: Project, time: number, playing: boolean, now: number): void {
    if (this.audioReported || !this.host.onAudioReport) return;
    const active = playing ? this.activeAudioClips(project, time) : [];
    if (active.length === 0) {
      this.audioReportSince = null;
      return;
    }
    if (this.audioReportSince === null) {
      this.audioReportSince = now;
      this.audioReportContextTime = this.audioMixEngine.contextTime;
      return;
    }
    if (now - this.audioReportSince < 3000) return;
    this.audioReported = true;
    const videoElements = [...this.pool.entries()]
      .filter(([, entry]) => entry.element instanceof HTMLVideoElement)
      .map(([clipId, entry]) => {
        const element = entry.element as HTMLVideoElement;
        return { clipId, paused: element.paused, muted: element.muted, volume: element.volume, readyState: element.readyState };
      });
    this.host.onAudioReport({
      phase: "playing-3s",
      ...this.audioMixEngine.diagnostics(active.map(({ clip }) => ({ clipId: clip.id, assetId: clip.assetId }))),
      assetKinds: active.map(({ clip }) => project.assets.find((a) => a.id === clip.assetId)?.kind ?? null),
      audioClockAdvanced: Number((this.audioMixEngine.contextTime - this.audioReportContextTime).toFixed(3)),
      wallClockSeconds: Number(((now - this.audioReportSince) / 1000).toFixed(3)),
      videoElements,
      userAgent: typeof navigator === "undefined" ? null : navigator.userAgent,
    });
  }

  /** Creates the `<audio>` elements for an asset's clips near the playhead the moment it switches to
   *  element playback (`AudioMixEngine.onElementFallback`), so they're already loading before Play. */
  private prepareElementClips(assetId: string): void {
    const project = this.host.getProject();
    if (!project) return;
    const time = this.host.getPlayhead();
    for (const { track, clip } of audibleClips(project)) {
      if (clip.assetId !== assetId) continue;
      if (clip.timelineStart + (clip.sourceOut - clip.sourceIn) <= time || clip.timelineStart > time + AUDIO_PREFETCH_LOOKAHEAD_SECONDS) continue;
      this.audioMixEngine.prepareElementClip(track.id, clip);
    }
  }

  private syncAudioTracks(project: Project, time: number, playing: boolean): void {
    this.audioMixEngine.syncAudioTrackClips(this.activeAudioClips(project, time), playing);
  }

  /** Pauses everything that isn't currently under the playhead. Without this, a clip's audio keeps
   *  playing after the playhead has moved past it. */
  private pauseInactive(activeClipIds: Set<string>): void {
    for (const [clipId, { element }] of this.pool) {
      // Images have nothing to pause — they're just a decoded bitmap sitting in the pool.
      if (element instanceof HTMLImageElement) continue;
      if (!activeClipIds.has(clipId) && !element.paused) element.pause();
    }
  }

  private pauseAll(): void {
    for (const { element } of this.pool.values()) {
      if (!(element instanceof HTMLImageElement)) element.pause();
    }
  }
}
