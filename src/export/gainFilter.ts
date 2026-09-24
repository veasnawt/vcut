/** Pure, DOM-free FFmpeg-expression math for `Clip.gainKeyframes` — split out for the same reason
 *  `panFilter.ts` was: unit-testable under this repo's `node --test` runner without spinning up
 *  FFmpeg or diffing a whole filter-graph string. */

/** One keyframe as `buildGainVolumeExpr` needs it — the same `{ time, value }` shape `GainKeyframe`
 *  already has, kept separate here so this stays DOM/project-type-free like `panFilter.ts`. */
export interface GainVolumeKeyframe {
  time: number;
  value: number;
}

/** Builds the `volume=` option's own EXPRESSION string for FFmpeg's `volume` filter with
 *  `eval=frame` — a nested `if(lte(...))` chain that reproduces `resolveClipGain`'s exact
 *  hold-before-first / lerp-between / hold-after-last shape (see `timeline/keyframes.ts`'s own
 *  `bracket`), just expressed for FFmpeg's per-frame expression evaluator instead of evaluated once
 *  in JS. `keyframes` must be non-empty and already time-sorted (same precondition every other
 *  `resolveClip*` reader has on its own keyframe array).
 *
 *  `offsetSeconds` shifts FFmpeg's own `t` (seconds elapsed in the CURRENT filtered segment, reset to
 *  0 by the `asetpts=PTS-STARTPTS` stage immediately upstream — see `pushClipAudioFilters`'s own call
 *  site) into the same clip-window-relative space `Keyframe.time` uses (0 = the clip's own
 *  `timelineStart`), i.e. it's `elapsedAtSegmentStart` — the CLIP-elapsed time this segment's own
 *  local `t=0` corresponds to. This is exact for a clip playing at any CONSTANT rate (including
 *  `clip.speed` != 1): its own `atempo` stage already ran upstream of the `asetpts` reset that zeroes
 *  `t`, so post-atempo real-seconds already equal output-timeline-elapsed-seconds by construction, the
 *  same space `elapsedAtSegmentStart` is itself measured in. It is NOT attempted for a clip with a
 *  non-trivial `speedCurve` — see `Clip.gainKeyframes`'s own doc comment for why that one combination
 *  keeps the clip's flat `gain` instead of calling this at all.
 *
 *  `n` is the same 6-decimal numeric formatter `buildExportPlan.ts` already uses everywhere else
 *  (passed in rather than imported, matching `buildPanFilterStage`'s own signature). */
export function buildGainVolumeExpr(keyframes: readonly GainVolumeKeyframe[], offsetSeconds: number, n: (value: number) => string): string {
  const T = `(t+${n(offsetSeconds)})`;
  if (keyframes.length === 1) return n(keyframes[0].value);
  let expr = n(keyframes[keyframes.length - 1].value);
  for (let i = keyframes.length - 2; i >= 0; i--) {
    const a = keyframes[i];
    const b = keyframes[i + 1];
    const span = b.time - a.time;
    // A zero-width (or degenerate) span has nothing to ramp across — step straight to `b`'s value
    // the instant `T` passes `a`'s time, same as `bracket`'s own division would if it weren't guarded.
    const ramp = Math.abs(span) < 1e-9 ? n(b.value) : `(${n(a.value)}+(${n(b.value - a.value)})*(${T}-${n(a.time)})/${n(span)})`;
    expr = `if(lte(${T},${n(b.time)}),${ramp},${expr})`;
  }
  return `if(lte(${T},${n(keyframes[0].time)}),${n(keyframes[0].value)},${expr})`;
}
