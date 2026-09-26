import type { PixelEffectType } from "../project/types.ts";
import { GLITCH_CUT_BAND_HEIGHT_FRACTION, type GlitchCutBurst } from "./transitionMotion.ts";

/** Every `PixelEffectType`, in the order shown in the picker — mirrors `TEXT_ANIMATION_TYPE_OPTIONS`'s
 *  own role as the one shared source of truth a UI iterates rather than hardcoding its own copy of the
 *  union's values. */
export const PIXEL_EFFECT_TYPE_OPTIONS: PixelEffectType[] = ["glitch", "sliceGlitch", "waterRipple"];

export const PIXEL_EFFECT_TYPE_LABEL: Record<PixelEffectType, string> = {
  glitch: "Glitch",
  sliceGlitch: "Slice Glitch",
  waterRipple: "Water Ripple",
};

// Exported (not just used locally) so `buildExportPlan.ts` can build the exact same expressions as
// FFmpeg-level `geq=`/`rgbashift=`/`noise=` parameters — export and preview sharing these numbers
// directly rules out the two ever silently drifting apart, same reasoning `BOUNCE_AMPLITUDE_PX` et al.
// (`timeline/textAnimation.ts`) already document.
export const WATER_RIPPLE_AMPLITUDE_PX = 10;
export const WATER_RIPPLE_WAVELENGTH_PX = 180;
export const WATER_RIPPLE_PERIOD_SECONDS = 2.5;

/** Slice Glitch: a few THIN horizontal strips of the picture jump sideways by a lot for an instant, then snap back — no
 *  colour split, no noise. The look of a datamosh / edit-template glitch. Bursts are short (three frames at 30 fps) so it
 *  flickers rather than drifts. Fractions are of the frame's own width/height, so it looks the same at any resolution. */
export const SLICE_GLITCH_BURST_SECONDS = 0.1;
export const SLICE_GLITCH_COUNT = 3;
export const SLICE_GLITCH_HEIGHT_FRACTION = 0.03;
export const SLICE_GLITCH_MAX_SHIFT_FRACTION = 0.09;

export const GLITCH_BURST_PERIOD_SECONDS = 0.4;
export const GLITCH_SHIFT_PX = 8;
export const GLITCH_NOISE_AMOUNT = 24;
export const GLITCH_NOISE_DENSITY = 0.06;
export const GLITCH_SLICE_COUNT = 2;
export const GLITCH_SLICE_BAND_HEIGHT_FRACTION = 0.08;

// `zoomBlur`/`whipPanLeft`/`whipPanRight`/`flashZoom` are TRANSITION-only (see `TransitionType`'s own
// doc comment) — unlike glitch/waterRipple there's no continuous per-clip "Pixel FX" version of any of
// these, so these constants exist purely for `export/buildExportPlan.ts`'s
// `applyTransitionCorruptionPass` and this file's own `applyHorizontalBlur` (zoomBlur's/flashZoom's
// own blur is omnidirectional, so their PREVIEW uses a native Canvas2D `filter: blur()` directly in
// `PlaybackEngine.ts` instead of a pure function here — only whipPan's DIRECTIONAL blur needs real
// pixel math, since CSS/Canvas2D's `blur()` can't express "horizontal only").
export const ZOOM_BLUR_SCALE = 0.22;
export const ZOOM_BLUR_SIGMA_PX = 18;
export const WHIP_PAN_BLUR_RADIUS_PX = 22;

/** `flashZoom` reuses `zoomBlur`'s own scale/blur exactly, layering a brief flash-to-white pulse on
 *  top that peaks right at the cut — `0.88`, not `1.0`, so the peak frame still shows a hint of the
 *  underlying content (a full `1.0` would blend to a dead, briefly-blank white frame, reading as a
 *  glitch rather than a snappy flash). */
export const FLASH_ZOOM_PEAK = 0.88;

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
export function applyWaterRipple(imageData: ImageData, elapsedSeconds: number, speed = 1, intensity = 1, pixelScale = 1): void {
  const { width, height, data } = imageData;
  const source = data.slice();
  const rate = (2 * Math.PI) / WATER_RIPPLE_PERIOD_SECONDS;
  const phase = elapsedSeconds * speed * rate;
  // `pixelScale` < 1 when running on a downscaled working copy of a sequence-resolution frame (the
  // transition preview does, for speed) — amplitude and wavelength are sequence pixels, so both shrink
  // with the buffer to keep the same look once scaled back up.
  const amplitude = WATER_RIPPLE_AMPLITUDE_PX * pixelScale;
  const wavelength = WATER_RIPPLE_WAVELENGTH_PX * pixelScale;
  for (let y = 0; y < height; y++) {
    const offset = amplitude * intensity * Math.sin(y / wavelength + phase);
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

/** Where Slice Glitch's strips are during one burst: each strip's top row and sideways shift, both as fractions (so the same
 *  numbers drive the preview here and the export's `geq` expression). `burst` is `floor(time * speed / period)`. */
export function sliceGlitchSlices(burst: number, index: number): { topFraction: number; shiftFraction: number } {
  const seed = burst * 7 + index * 3;
  return {
    topFraction: pseudoRandom(seed) * (1 - SLICE_GLITCH_HEIGHT_FRACTION),
    shiftFraction: (pseudoRandom(seed + 1) * 2 - 1) * SLICE_GLITCH_MAX_SHIFT_FRACTION,
  };
}

/** The strips of one Slice Glitch frame in pixels of a `width` x `height` picture: `top` row, height in rows, and how far each is
 *  shifted sideways. Later strips are drawn over earlier ones. Shared by the CPU (`applySliceGlitch`) and GPU (`GlChromaKeyer`)
 *  versions, so they cannot drift apart. Strips that move nothing are left out. */
export function sliceGlitchStrips(elapsedSeconds: number, speed: number, width: number, height: number, intensity = 1): { top: number; rows: number; shift: number }[] {
  const burst = Math.floor((elapsedSeconds * speed) / SLICE_GLITCH_BURST_SECONDS);
  const band = Math.max(1, Math.round(height * SLICE_GLITCH_HEIGHT_FRACTION));
  const strips: { top: number; rows: number; shift: number }[] = [];
  for (let index = 0; index < SLICE_GLITCH_COUNT; index++) {
    const { topFraction, shiftFraction } = sliceGlitchSlices(burst, index);
    const top = Math.round(topFraction * height);
    const shift = Math.round(shiftFraction * width * intensity);
    if (shift === 0) continue;
    strips.push({ top, rows: Math.min(height, top + band) - top, shift });
  }
  return strips;
}

/** Mutates `imageData` in place with the Slice Glitch look (see `SLICE_GLITCH_*`): thin horizontal strips jump sideways for a
 *  few frames. `intensity` scales how far they jump (0 = none). Like the other pixel effects it is a pure function of time. */
export function applySliceGlitch(imageData: ImageData, elapsedSeconds: number, speed = 1, intensity = 1): void {
  const { width, height, data } = imageData;
  const strips = sliceGlitchStrips(elapsedSeconds, speed, width, height, intensity);
  if (strips.length === 0) return;
  const source = data.slice();
  for (const { top, rows, shift } of strips) {
    for (let y = top; y < top + rows; y++) {
      const rowStart = y * width * 4;
      for (let x = 0; x < width; x++) {
        const sampleX = Math.min(width - 1, Math.max(0, x + shift));
        const from = rowStart + sampleX * 4;
        const to = rowStart + x * 4;
        data[to] = source[from];
        data[to + 1] = source[from + 1];
        data[to + 2] = source[from + 2];
        data[to + 3] = source[from + 3];
      }
    }
  }
}

/** The same Slice Glitch as FFmpeg filter lines, from the stream labelled `input` to `output`. Each strip is cropped out of the
 *  frame and overlaid back at its shifted position, both with per-frame expressions of the time `t` (same hash and burst clock as
 *  the preview), so the work is a few thin strips per frame. (This used to be one `geq=` expression over the whole frame; `geq`
 *  evaluates its expression for every pixel, and at video resolution that took minutes per clip.) A strip that carries transparency
 *  (a cutout) is added over the original rather than replacing it, so a shifted strip leaves a faint ghost behind. */
export function buildSliceGlitchLines(input: string, output: string, speed = 1): string[] {
  const num = (v: number) => String(Math.round(v * 1e6) / 1e6);
  const burst = `floor(t*${num(speed)}/${num(SLICE_GLITCH_BURST_SECONDS)})`;
  const rand = (seedExpr: string) => `((sin((${seedExpr})*12.9898)*43758.5453)-floor(sin((${seedExpr})*12.9898)*43758.5453))`;
  const lines: string[] = [];
  const count = SLICE_GLITCH_COUNT;
  lines.push(`[${input}]split=${count + 1}[${output}_base]${Array.from({ length: count }, (_, i) => `[${output}_s${i}]`).join("")}`);
  for (let i = 0; i < count; i++) {
    const seed = `${burst}*7+${i * 3}`;
    const topRows = `round(${rand(seed)}*${num(1 - SLICE_GLITCH_HEIGHT_FRACTION)}*ih)`;
    lines.push(`[${output}_s${i}]crop=w=iw:h=round(${num(SLICE_GLITCH_HEIGHT_FRACTION)}*ih):x=0:y='${topRows}'[${output}_c${i}]`);
  }
  let previous = `${output}_base`;
  for (let i = 0; i < count; i++) {
    const seed = `${burst}*7+${i * 3}`;
    const top = `round(${rand(seed)}*${num(1 - SLICE_GLITCH_HEIGHT_FRACTION)}*H)`;
    const shift = `round((${rand(`${seed}+1`)}*2-1)*${num(SLICE_GLITCH_MAX_SHIFT_FRACTION)}*W)`;
    const last = i === count - 1;
    lines.push(`[${previous}][${output}_c${i}]overlay=x='-${shift}':y='${top}':eval=frame:format=auto[${last ? output : `${output}_o${i}`}]`);
    previous = `${output}_o${i}`;
  }
  return lines;
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
export function applyHorizontalBlur(imageData: ImageData, intensity = 1, pixelScale = 1): void {
  const { width, height, data } = imageData;
  const radius = Math.round(WHIP_PAN_BLUR_RADIUS_PX * pixelScale * Math.max(0, Math.min(1, intensity)));
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

/** The Glitch Cut TRANSITION's own corruption (see `transitionMotion.ts`'s Glitch Cut section) —
 *  red/blue channel split plus torn horizontal bands, with every amount taken from `burst` as a
 *  fraction of the frame so the same burst looks the same at any buffer size. No per-pixel noise,
 *  unlike the continuous `applyGlitch`: it was invisible at transition speed and cost a `Math.sin`
 *  per pixel per frame, the main reason the old glitch preview stuttered. Mirrors export's
 *  `rgbashift` + cropped-band `overlay` stages exactly (bands tear the already-split image). */
export function applyGlitchCut(imageData: ImageData, burst: GlitchCutBurst): void {
  const { width, height, data } = imageData;
  const shiftR = Math.round(burst.shiftR * width);
  const shiftB = Math.round(burst.shiftB * width);
  const bandHeight = Math.max(1, Math.round(height * GLITCH_CUT_BAND_HEIGHT_FRACTION));
  const bands = burst.bands.map((b) => ({ top: Math.round(b.top * height), shift: Math.round(b.shift * width) }));
  if (shiftR === 0 && shiftB === 0 && bands.every((b) => b.shift === 0)) return;
  const source = data.slice();
  const clampX = (x: number) => (x < 0 ? 0 : x >= width ? width - 1 : x);
  const split = new Uint8ClampedArray(data.length);
  for (let y = 0; y < height; y++) {
    const rowStart = y * width * 4;
    for (let x = 0; x < width; x++) {
      const to = rowStart + x * 4;
      split[to] = source[rowStart + clampX(x - shiftR) * 4];
      split[to + 1] = source[to + 1];
      split[to + 2] = source[rowStart + clampX(x - shiftB) * 4 + 2];
      split[to + 3] = source[to + 3];
    }
  }
  data.set(split);
  for (const band of bands) {
    if (band.shift === 0) continue;
    const end = Math.min(height, band.top + bandHeight);
    for (let y = Math.max(0, band.top); y < end; y++) {
      const rowStart = y * width * 4;
      for (let x = 0; x < width; x++) {
        // Content moves right by `shift`: output x reads from x - shift. Pixels the band vacates keep
        // the un-torn image underneath, exactly like export's `overlay` of the cropped band.
        const sx = x - band.shift;
        if (sx < 0 || sx >= width) continue;
        const to = rowStart + x * 4;
        const from = rowStart + sx * 4;
        data[to] = split[from];
        data[to + 1] = split[from + 1];
        data[to + 2] = split[from + 2];
        data[to + 3] = split[from + 3];
      }
    }
  }
}
