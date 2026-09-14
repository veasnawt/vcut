import type { PixelEffectType } from "../project/types.ts";

/** Every `PixelEffectType`, in the order shown in the picker — mirrors `TEXT_ANIMATION_TYPE_OPTIONS`'s
 *  own role as the one shared source of truth a UI iterates rather than hardcoding its own copy of the
 *  union's values. */
export const PIXEL_EFFECT_TYPE_OPTIONS: PixelEffectType[] = ["glitch", "waterRipple"];

export const PIXEL_EFFECT_TYPE_LABEL: Record<PixelEffectType, string> = {
  glitch: "Glitch",
  waterRipple: "Water Ripple",
};

// Exported (not just used locally) so `buildExportPlan.ts` can build the exact same expressions as
// FFmpeg-level `geq=`/`rgbashift=`/`noise=` parameters — export and preview sharing these numbers
// directly rules out the two ever silently drifting apart, same reasoning `BOUNCE_AMPLITUDE_PX` et al.
// (`timeline/textAnimation.ts`) already document.
export const WATER_RIPPLE_AMPLITUDE_PX = 10;
export const WATER_RIPPLE_WAVELENGTH_PX = 180;
export const WATER_RIPPLE_PERIOD_SECONDS = 2.5;

export const GLITCH_BURST_PERIOD_SECONDS = 0.4;
export const GLITCH_SHIFT_PX = 8;
export const GLITCH_NOISE_AMOUNT = 24;
export const GLITCH_NOISE_DENSITY = 0.06;
export const GLITCH_SLICE_COUNT = 2;
export const GLITCH_SLICE_BAND_HEIGHT_FRACTION = 0.08;

// `zoomBlur`/`whipPanLeft`/`whipPanRight` are TRANSITION-only (see `TransitionType`'s own doc
// comment) — unlike glitch/waterRipple there's no continuous per-clip "Pixel FX" version of either,
// so these constants exist purely for `export/buildExportPlan.ts`'s `applyTransitionCorruptionPass`
// and this file's own `applyHorizontalBlur` (zoomBlur's own blur is omnidirectional, so its PREVIEW
// uses a native Canvas2D `filter: blur()` directly in `PlaybackEngine.ts` instead of a pure function
// here — only whipPan's DIRECTIONAL blur needs real pixel math, since CSS/Canvas2D's `blur()` can't
// express "horizontal only").
export const ZOOM_BLUR_SCALE = 0.22;
export const ZOOM_BLUR_SIGMA_PX = 18;
export const WHIP_PAN_BLUR_RADIUS_PX = 22;

/** A deterministic, seedable pseudo-random value in `[0, 1)` — the classic GLSL-shader hash trick
 *  (`sin(seed * big-irrational) * big-number`, fractional part). NOT `Math.random()`: a pixel effect
 *  must be a pure function of `elapsedSeconds` alone (same "scrubbing backward looks identical to
 *  having played forward to the same instant" determinism `computeTextAnimationTransform`'s own doc
 *  comment establishes for text animations) — a real RNG would make the glitch look different every
 *  single frame redraw, including two redraws of the exact same paused instant. */
function pseudoRandom(seed: number): number {
  const x = Math.sin(seed * 12.9898) * 43758.5453;
  return x - Math.floor(x);
}

/** Mutates `imageData` in place with a sine-wave horizontal displacement that varies by row AND by
 *  time — a wavy, underwater-reflection look. Direct port of the `geq` recipe empirically verified
 *  against this repo's bundled ffmpeg: `p(X + amplitude*sin(Y/wavelength + T*rate), Y)`. Reads from a
 *  snapshot copy of the original pixels (not `imageData` itself) since this is a genuine spatial
 *  REMAP — unlike `applyChromaKey`/`applyColorGrading`/`applyLut3D`, which are per-pixel-independent
 *  and can safely read-then-write the same buffer, a row here reads from a DIFFERENT x than it writes,
 *  so an in-place walk would read pixels this same call already overwrote.
 *
 *  `intensity` scales the amplitude ON TOP OF the per-clip `speed`-driven phase — `1` (the default)
 *  is the ordinary per-clip "Pixel FX" strength, every existing call site's behavior unchanged;
 *  `0` is an exact no-op (every sample lands back on its own `x`); used by the water-ripple TRANSITION
 *  style (`PlaybackEngine.compositeTransitionFrame`) to ramp the distortion up then back down across
 *  the blend window instead of a flat full-strength wobble for the whole cut. */
export function applyWaterRipple(imageData: ImageData, elapsedSeconds: number, speed = 1, intensity = 1): void {
  const { width, height, data } = imageData;
  const source = data.slice();
  const rate = (2 * Math.PI) / WATER_RIPPLE_PERIOD_SECONDS;
  const phase = elapsedSeconds * speed * rate;
  for (let y = 0; y < height; y++) {
    const offset = WATER_RIPPLE_AMPLITUDE_PX * intensity * Math.sin(y / WATER_RIPPLE_WAVELENGTH_PX + phase);
    const rowStart = y * width * 4;
    for (let x = 0; x < width; x++) {
      // Clamped, not wrapped, at the left/right edges — a wrapped sample would smear the OPPOSITE
      // edge's color in, visibly wrong; a clamped one just stretches the nearest real edge pixel,
      // the same "reasonable, not exact" tradeoff FFmpeg's own default `geq` boundary handling makes.
      let sampleX = Math.round(x + offset);
      if (sampleX < 0) sampleX = 0;
      else if (sampleX >= width) sampleX = width - 1;
      const from = rowStart + sampleX * 4;
      const to = rowStart + x * 4;
      data[to] = source[from];
      data[to + 1] = source[from + 1];
      data[to + 2] = source[from + 2];
      data[to + 3] = source[from + 3];
    }
  }
}

/** Mutates `imageData` in place with a digital-corruption look: a per-frame RGB channel split (jumps
 *  between bursts, doesn't smoothly oscillate — a sudden jump reads as "glitchy", a smooth sine reads
 *  as the organic wave `applyWaterRipple` already owns), a couple of randomly-placed horizontal slice
 *  bands shifted sideways, and sparse per-pixel noise. Port of the `rgbashift`+`noise` recipe
 *  empirically verified against this repo's bundled ffmpeg. `elapsedSeconds` is quantized into
 *  discrete "burst" steps (`GLITCH_BURST_PERIOD_SECONDS`) — everything within one burst is static,
 *  matching how a real signal glitch holds for a beat rather than continuously drifting.
 *
 *  `intensity` scales every shift/jitter amount (channel split, slice displacement, noise strength) —
 *  same "1 is the ordinary per-clip default, 0 is an exact no-op" contract `applyWaterRipple`'s own
 *  `intensity` documents, for the identical reason (the glitch-cut TRANSITION style ramping the
 *  corruption across its blend window). */
export function applyGlitch(imageData: ImageData, elapsedSeconds: number, speed = 1, intensity = 1): void {
  const { width, height, data } = imageData;
  const source = data.slice();
  const burst = Math.floor((elapsedSeconds * speed) / GLITCH_BURST_PERIOD_SECONDS);

  // Channel split: R shifts one way, B shifts the other, by an amount that jumps every burst.
  const shiftR = Math.round((pseudoRandom(burst * 2) * 2 - 1) * GLITCH_SHIFT_PX * intensity);
  const shiftB = -Math.round((pseudoRandom(burst * 2 + 1) * 2 - 1) * GLITCH_SHIFT_PX * intensity);

  // Slice bands: a few short horizontal strips, each shifted sideways by its own random offset.
  const sliceBandHeight = Math.max(1, Math.round(height * GLITCH_SLICE_BAND_HEIGHT_FRACTION));
  const slices: { top: number; shift: number }[] = [];
  for (let i = 0; i < GLITCH_SLICE_COUNT; i++) {
    const top = Math.floor(pseudoRandom(burst * 7 + i * 3) * Math.max(1, height - sliceBandHeight));
    const shift = Math.round((pseudoRandom(burst * 7 + i * 3 + 1) * 2 - 1) * GLITCH_SHIFT_PX * 3 * intensity);
    slices.push({ top, shift });
  }

  function sliceShiftAt(y: number): number {
    for (const slice of slices) {
      if (y >= slice.top && y < slice.top + sliceBandHeight) return slice.shift;
    }
    return 0;
  }

  for (let y = 0; y < height; y++) {
    const rowShift = sliceShiftAt(y);
    const rowStart = y * width * 4;
    for (let x = 0; x < width; x++) {
      const to = rowStart + x * 4;
      const clampX = (sampleX: number) => Math.min(width - 1, Math.max(0, sampleX));
      const rFrom = rowStart + clampX(x - shiftR + rowShift) * 4;
      const gFrom = rowStart + clampX(x + rowShift) * 4;
      const bFrom = rowStart + clampX(x - shiftB + rowShift) * 4;
      data[to] = source[rFrom];
      data[to + 1] = source[gFrom + 1];
      data[to + 2] = source[bFrom + 2];
      data[to + 3] = source[gFrom + 3];
      // Sparse noise — a deterministic per-pixel-per-burst hash decides both WHETHER this pixel gets
      // jittered (kept rare via `GLITCH_NOISE_DENSITY`) and by how much.
      const noiseSeed = burst * 104729 + y * width + x;
      if (pseudoRandom(noiseSeed) < GLITCH_NOISE_DENSITY) {
        const jitter = Math.round((pseudoRandom(noiseSeed + 0.5) * 2 - 1) * GLITCH_NOISE_AMOUNT * intensity);
        data[to] = Math.min(255, Math.max(0, data[to] + jitter));
        data[to + 1] = Math.min(255, Math.max(0, data[to + 1] + jitter));
        data[to + 2] = Math.min(255, Math.max(0, data[to + 2] + jitter));
      }
    }
  }
}

/** Mutates `imageData` in place with a HORIZONTAL-only box blur — the "motion smear" a fast camera
 *  pan leaves behind, used by the `whipPanLeft`/`whipPanRight` TRANSITION style
 *  (`PlaybackEngine.compositeTransitionFrame`/`compositeSoloReveal`) rather than a continuous per-clip
 *  Pixel FX — there's no whip-pan hold-still look to want outside of a transition, unlike glitch/
 *  waterRipple. Direct port of `applyTransitionCorruptionPass`'s own `boxblur=luma_radius=...`
 *  recipe — vertical-only radius zero in THAT filter is what makes it read as directional motion blur
 *  rather than a plain uniform one, which a CSS/Canvas2D `filter: blur()` can't express (that's
 *  isotropic only — see `zoomBlur`'s own preview, which uses exactly that native filter instead,
 *  since ITS blur genuinely is omnidirectional).
 *
 *  A sliding-window running sum (not a fresh sum per output pixel) keeps this O(width×height)
 *  regardless of radius — a naive nested loop would be O(width×height×radius), and
 *  `WHIP_PAN_BLUR_RADIUS_PX` is large enough for that difference to matter on a full-resolution
 *  preview canvas. Edges are clamped, not wrapped — same "stretch the nearest real edge pixel rather
 *  than smear the opposite edge in" convention `applyWaterRipple` already uses. `intensity` (0..1)
 *  scales the effective radius — `0` is an exact no-op, `1` is the full `WHIP_PAN_BLUR_RADIUS_PX`, the
 *  same "ramps across the blend window" contract `applyGlitch`'s/`applyWaterRipple`'s own `intensity`
 *  parameter already establishes for their transition use. */
export function applyHorizontalBlur(imageData: ImageData, intensity = 1): void {
  const { width, height, data } = imageData;
  const radius = Math.round(WHIP_PAN_BLUR_RADIUS_PX * Math.max(0, Math.min(1, intensity)));
  if (radius <= 0) return;
  const source = data.slice();
  const windowSize = radius * 2 + 1;
  const clampX = (x: number) => Math.min(width - 1, Math.max(0, x));
  for (let y = 0; y < height; y++) {
    const rowStart = y * width * 4;
    let sr = 0;
    let sg = 0;
    let sb = 0;
    let sa = 0;
    for (let dx = -radius; dx <= radius; dx++) {
      const idx = rowStart + clampX(dx) * 4;
      sr += source[idx];
      sg += source[idx + 1];
      sb += source[idx + 2];
      sa += source[idx + 3];
    }
    for (let x = 0; x < width; x++) {
      const to = rowStart + x * 4;
      data[to] = sr / windowSize;
      data[to + 1] = sg / windowSize;
      data[to + 2] = sb / windowSize;
      data[to + 3] = sa / windowSize;
      const leaveIdx = rowStart + clampX(x - radius) * 4;
      const enterIdx = rowStart + clampX(x + radius + 1) * 4;
      sr += source[enterIdx] - source[leaveIdx];
      sg += source[enterIdx + 1] - source[leaveIdx + 1];
      sb += source[enterIdx + 2] - source[leaveIdx + 2];
      sa += source[enterIdx + 3] - source[leaveIdx + 3];
    }
  }
}
