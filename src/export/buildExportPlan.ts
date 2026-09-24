import { applyTextTransform, TEXT_BOX_PADDING, TEXT_MARGIN_PX } from "../playback/textLayout.ts";
import { clipDuration, clipEnd, findAsset, sequenceDuration } from "../project/createProject.ts";
import { fontById, fontFileFor, resolveFontVariant } from "../project/fonts.ts";
import type { AssFontMetrics, FontDefinition } from "../project/fonts.ts";
import type { ChromaKeySettings, Clip, ClipBlendMode, ClipEffects, ClipMask, ClipTransform, ColorGrading, PixelEffectType, Project, TextCrop, TextStyle, TransitionType, Track } from "../project/types.ts";
import { IDENTITY_EFFECTS, IDENTITY_TRANSFORM, isIdentityColorGrading, isIdentityEffects, isIdentityTextCrop, isIdentityTransform } from "../project/types.ts";
import {
  BOUNCE_AMPLITUDE_PX,
  BOUNCE_PERIOD_SECONDS,
  DEFAULT_WORD_HIGHLIGHT_COLOR,
  PULSE_AMPLITUDE,
  PULSE_PERIOD_SECONDS,
  segmentLine,
  splitWords,
  TYPEWRITER_CHARS_PER_SECOND,
  WIGGLE_AMPLITUDE_DEG,
  WIGGLE_PERIOD_SECONDS,
  wordBoundaries,
} from "../timeline/textAnimation.ts";
import { hasColorGradingKeyframes, hasEffectsKeyframes, hasTextCropKeyframes, hasTextStyleKeyframes, hasTransformKeyframes, resolveClipColorGrading, resolveClipEffects, resolveClipTransform, resolveTextCrop, resolveTextStyle } from "../timeline/keyframes.ts";
import { clipProgressAtElapsed, clipSourceTimeAtElapsed, sliceSpeedCurve } from "../timeline/clipTiming.ts";
import {
  easeTransitionExpr,
  GLITCH_CUT_BAND_COUNT,
  GLITCH_CUT_BAND_HEIGHT_FRACTION,
  GLITCH_CUT_BURST_SECONDS,
  glitchCutBurst,
  glitchCutBurstProgress,
  glitchCutShowsIncoming,
  midpointIntensity,
  SLICE_STRIP_COUNT,
  SLICE_WIPE_FRACTION,
  sliceStripBounds,
  transitionFamily,
} from "../timeline/transitionMotion.ts";
import {
  FLASH_ZOOM_PEAK,
  GLITCH_NOISE_AMOUNT,
  GLITCH_SHIFT_PX,
  WATER_RIPPLE_AMPLITUDE_PX,
  WATER_RIPPLE_PERIOD_SECONDS,
  WATER_RIPPLE_WAVELENGTH_PX,
  WHIP_PAN_BLUR_RADIUS_PX,
  ZOOM_BLUR_SCALE,
  ZOOM_BLUR_SIGMA_PX,
} from "../timeline/pixelEffects.ts";
import { snapToFrame } from "../timeline/time.ts";
import { findTransitionOut, findTransitionPartner } from "../timeline/transitions.ts";
import { animationFrameIndex, animationLoopOffset } from "../project/stickers.ts";
import { buildCurvesFilterFragment } from "./curvesFilter.ts";
import { buildGainVolumeExpr } from "./gainFilter.ts";
import type { KhmerTextWindow } from "./khmerTextRenderer.ts";
import { buildPanFilterStage } from "./panFilter.ts";

/** Builds the FFmpeg invocation that renders a project to a finished file.
 *
 *  Kept as a pure function — project in, argument list out — specifically so the hardest part of
 *  export (getting the filter graph right) can be unit-tested without spawning anything or touching
 *  a disk. The route layer only resolves paths and runs what this returns.
 *
 *  ## Why one input per clip, with `-ss`/`-t`
 *
 *  Each clip becomes its own `-i` with `-ss <in> -t <duration>` in front of it, rather than one
 *  input per file with `trim` filters. Two reasons: placing `-ss` BEFORE `-i` makes FFmpeg seek and
 *  decode only the range actually needed (dramatically faster on long sources — the exact case
 *  non-destructive editing creates), and it sidesteps having to `split` a reused input pad when the
 *  same file appears in several clips.
 *
 *  ## Why gaps become real black segments
 *
 *  A timeline with a hole in it has to export with that hole intact, or the exported video would be
 *  shorter than the edit and every clip after the gap would land at the wrong time. Gaps are filled
 *  with generated black video and silence so the output matches the timeline exactly. */

export interface ExportPlanOptions {
  /** Absolute path to the media file backing an asset. Injected rather than computed here so this
   *  module stays free of any filesystem or path knowledge. */
  inputPathFor: (assetId: string) => string;
  /** Returns a provider-rendered replacement file for a clip with active Face Effects. The file must
   * cover the ORIGINAL source timeline, starting at timestamp zero, because this plan still applies
   * `sourceIn`/`sourceOut`, reverse, speed, and transition source handles after this step. For video,
   * it must preserve the original audio stream; for an image, it must be a still image. The caller's
   * async provider pre-pass runs before this pure FFmpeg-plan builder. Omitting the resolver or
   * returning no path fails export explicitly, so a Face Effect never silently disappears. */
  faceEffectInputPathFor?: (clip: Clip) => string | undefined;
  outputPath: string;
  /** Absolute path to a bundled font FILE, given its filename (e.g. "Battambang-Bold.ttf" — see the
   *  registry in `project/fonts.ts`, which is what this module uses to turn a clip's `fontFamily`/
   *  `bold`/`italic` into that filename before calling this). Only called when the project actually
   *  has a text clip — a project with none never needs to know fonts exist. */
  fontPathFor: (fileName: string) => string;
  /** Writes `content` to a text file FFmpeg's `drawtext` can read via `textfile=`, and returns its
   *  absolute path. A real (if small) side effect behind an injected function, same as `inputPathFor`
   *  implicitly assumes its files already exist on disk — kept out of this module directly so a unit
   *  test can inject a fake resolver that never touches disk. `textfile=` rather than escaping
   *  `content` into `text=` directly: user-authored text can contain `:`, `'`, `\`, or `%`, every one
   *  of them meaningful to FFmpeg's OWN filter-string grammar, and a text FILE sidesteps that whole
   *  class of injection/escaping bugs by never putting the content in the filter string at all.
   *
   *  `variant` distinguishes the several DIFFERENT text files one clip can now need — `typewriter`
   *  export renders one `drawtext` per revealed-prefix state (see `buildTypewriterDrawTextCalls`), each
   *  needing its own file so an earlier prefix's file isn't overwritten by a later one before FFmpeg
   *  reads it. Omitted (the plain, single-file case) for every other clip, unchanged from before this
   *  existed. */
  textFilePathFor: (clip: Clip, content: string, variant?: string) => string;
  /** The video encoder + its own rate-control flags, as one pre-built arg fragment — defaults to
   *  libx264 (desktop/server behavior, unchanged) when omitted. Injected rather than hardcoded because
   *  the encoder NAME alone isn't swappable in isolation: `-preset`/`-crf` are libx264-specific flags,
   *  meaningless (or rejected outright) by another encoder, so a caller needing a different one has to
   *  supply its complete matching fragment, not just a different `-c:v` value. `nativeExport.ts` passes
   *  one — the FFmpeg engine bundled for on-device mobile export doesn't include libx264 at all (a real
   *  gap discovered testing on a physical device, not a hypothetical). */
  videoEncoderArgs?: string[];
  /** Whether the target FFmpeg drawtext filter supports per-line `text_align` (default true).
   *  Android's bundled engine lacks this option. When false, keep the block's position and
   *  styling, using the engine's default left alignment within multiline text blocks. */
  drawtextTextAlign?: boolean;
  /** Overrides `computeSliceBoundaries`'s own default sampling interval/cap for a KEYFRAMED VIDEO/
   *  image clip's transform+effects+colorGrading slicing (see that function's own doc comment) —
   *  omitted keeps the exact same defaults every caller already got before this option existed.
   *  Confirmed a real, live contributor to a hosted export crashing its own memory-limited container:
   *  Railway's own metrics showed the peak drop measurably once an UNRELATED oversized-source-image
   *  fix shipped, but a heavily transform-keyframed clip (independent of its image's resolution)
   *  still pushed memory close to the ceiling on its own — every slice a keyframed clip's segment
   *  expands into is its own real chunk of FFmpeg filter-graph state (`split`+`trim`+the full transform/
   *  crop/effects chain, PER slice), so a coarser interval and/or a lower slice-count ceiling directly
   *  bounds that regardless of what made the clip need many slices in the first place. A real,
   *  visible tradeoff (slightly coarser motion for a densely-keyframed clip) — used HOSTED-only for
   *  exactly that reason; desktop/local dev keep the original, finer defaults since there's no
   *  memory ceiling there to protect. */
  keyframeSliceTuning?: { baseIntervalSeconds: number; maxSlices: number };
  /** The three capabilities `wordHighlight` export needs — ALL THREE optional together, not
   *  independently: a `clip.textAnimation.type === "wordHighlight"` clip renders through FFmpeg's
   *  `subtitles=` (libass) filter instead of `drawtext`, since coloring individual WORDS within one
   *  call is beyond what `drawtext` can express and there's no way to feed one `drawtext` call's
   *  measured `text_w` into another's position (see `buildWordHighlightSubtitlesFilter`'s own comment
   *  for the full reasoning). Omitting any of the three makes `wordHighlight` fall back to rendering as
   *  plain static text — the same behavior every OTHER animation type already falls back to when
   *  combined with a scope cut (e.g. a static `rotationDeg` alongside `bounce`/`pulse`) — rather than
   *  this module assuming libass is always available. `nativeExport.ts` (mobile) currently omits all
   *  three: the bundled on-device FFmpeg engine's libass support hasn't been confirmed, so mobile export
   *  keeps the pre-existing plain-text behavior rather than risking a broken filtergraph on a build that
   *  might not have the filter at all. */
  assFilePathFor?: (clip: Clip, assContent: string) => string;
  /** Resolves a font's real ASS metrics (family name + fontsize scale) from its own file bytes — see
   *  `AssFontMetrics`'s own doc comment in `project/fonts.ts` for why both are needed and how
   *  `fontsizeScale` was derived. Returning `null` (a font whose bytes didn't parse as expected) is
   *  treated the same as the option being entirely absent for THAT font — `wordHighlight` falls back to
   *  plain text for that one clip rather than emitting a filter libass can't resolve a font for. */
  fontMetricsFor?: (font: FontDefinition) => AssFontMetrics | null;
  /** Absolute path to the directory containing every bundled font file — libass's `subtitles=` filter
   *  resolves a `Style: Fontname` by NAME via its own `fontsdir=` directory scan (unlike `drawtext`'s
   *  `fontfile=`, which points at one exact file), so this needs the whole folder, not a per-file path
   *  the way `fontPathFor` is. */
  fontsDirFor?: () => string;
  /** Synchronous lookup for a Khmer-script text clip's own pre-rendered window images — populated by
   *  an ASYNC pre-pass the caller runs BEFORE calling `buildExportPlan` (this function itself stays
   *  synchronous, same as every other resolver here), driving a headless-browser render harness (see
   *  `khmerTextRenderer.ts`'s own doc comment for the full reasoning: every FFmpeg-side Khmer text path
   *  fails to correctly stack certain subscript-consonant clusters, confirmed empirically, so Khmer text
   *  is rendered through a real browser ahead of time instead of asking FFmpeg to shape it). Returns
   *  `undefined` for a clip that wasn't pre-rendered (any non-Khmer clip, or a caller — `nativeExport.ts`
   *  — that doesn't support this path at all), which falls back to the plain `drawtext` path exactly
   *  like every other optional resolver here degrades when omitted. */
  khmerTextWindowsFor?: (clip: Clip) => KhmerTextWindow[] | undefined;
  /** Absolute path to a `.cube` 3D LUT file, given a `LutAsset.id` (`Clip.lutId`) — same "resolve to a
   *  real file only at render time" seam `fontPathFor` uses for a font id. Omitted entirely (rather
   *  than throwing) skips the `lut3d=` stage for every clip, same graceful-degradation shape every
   *  other optional resolver here already has — `nativeExport.ts` currently doesn't support LUTs, so
   *  it simply doesn't supply this. */
  lutPathFor?: (lutId: string) => string | undefined;
}

export interface ExportPlan {
  args: string[];
  /** Total output length in seconds — what progress is measured against. */
  duration: number;
}

export class ExportError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ExportError";
  }
}

/** One side of a transition segment — the clip it's drawn from, plus everything needed to build its
 *  own filter chain, mirroring the fields a plain "clip" segment already carries. */
interface TransitionSide {
  clip: Clip;
  hasAudio: boolean;
  isImage: boolean;
  path: string;
  sourceIn?: number;
  elapsedStart?: number;
}

export type Segment =
  | {
      kind: "clip";
      clip: Clip;
      hasAudio: boolean;
      isImage: boolean;
      path: string;
      sourceIn: number;
      duration: number;
      elapsedStart: number;
      /** Set only for a SOLO transition-in — `findTransitionPartner` resolved `clip.transitionIn` but
       *  found no adjacent predecessor to blend from (see that function's own doc comment). `xfade`
       *  needs two real streams, which a solo fade doesn't have, so this renders as a plain `fade`/
       *  `afade` on the clip's own stream instead of a `"transition"` segment — see `buildTrackStreams`'s
       *  own handling. Absent (not 0) for every ordinary clip, same "small/cheap default path"
       *  convention the rest of this codebase uses for optional fields. */
      fadeIn?: number;
      /** `findTransitionOut`'s resolved duration, when this segment is the TAIL segment of a clip that
       *  has one (see that function's own doc comment — always a solo fade, there's no blend-into-next
       *  shape to speak of). Rendered the same way as `fadeIn`: a plain `fade`/`afade` stage, just
       *  anchored at this segment's own END instead of its start. NOT attached when a real
       *  `"transition"` segment consumes this clip's ENTIRE duration (no separate tail segment exists
       *  to attach it to) — an edge case narrow enough (a transition-in longer than the whole clip)
       *  that a fade-out simply doesn't apply there, rather than adding a third rendering shape for it. */
      fadeOut?: number;
    }
  | { kind: "gap"; duration: number }
  | { kind: "transition"; duration: number; from: TransitionSide; to: TransitionSide };

function inputPathForClip(
  clip: Clip,
  options: Pick<ExportPlanOptions, "inputPathFor" | "faceEffectInputPathFor">
): string {
  const hasActiveFaceEffect = clip.faceEffects?.some((effect) => effect.enabled !== false && effect.intensity > 0) ?? false;
  if (!hasActiveFaceEffect) return options.inputPathFor(clip.assetId);
  // `buildAudioOnlyExportPlan` reuses this segment walker for transcription and deliberately supplies
  // no visual preprocessor. Face geometry cannot change audio, so that caller keeps the original
  // source. Full video export validates the resolver before it enters this walker (below).
  if (!options.faceEffectInputPathFor) return options.inputPathFor(clip.assetId);
  const processed = options.faceEffectInputPathFor?.(clip);
  if (!processed) {
    throw new ExportError("This project uses Face Effects, but the Face Effects export provider is not configured.");
  }
  return processed;
}

/** Walks the track start-to-end, emitting a segment per clip and a gap wherever the timeline is
 *  empty between them — plus, wherever `findTransitionPartner` confirms a real crossfade into a
 *  clip, a `"transition"` segment spliced in front of that clip's own (now head-shortened) one.
 *  Finally, a trailing gap fills any remaining space between this track's own last clip and
 *  `targetDuration` (the FULL project duration, not just this track's own content) — without it, a
 *  track whose own content ends early would produce a SHORTER stream than a track that runs the
 *  whole timeline. That's harmless for a single video track (nothing to compare it against), but
 *  fatal once multiple video tracks are layered with `overlay`: FFmpeg's `overlay` filter defaults to
 *  `eof_action=repeat`, freezing on the shorter stream's OWN last frame for the rest of the export
 *  the moment it runs out — so a short overlay clip (a watermark, a PIP insert) would otherwise stay
 *  frozen on-screen long after its own clip actually ended. Always padding every track's stream out
 *  to the same `targetDuration` is what keeps every layer's own EOF landing at the same instant.
 *
 *  The split is deliberately ASYMMETRIC, to exactly match `PlaybackEngine.drawVideoLayer`'s own
 *  preview behavior (see its comment): the transition's `duration` seconds live entirely within the
 *  INCOMING clip's own nominal timeline window (`[clip.timelineStart, clip.timelineStart+duration)`),
 *  never inside the OUTGOING clip's. So the outgoing clip's segment is emitted in full, unshortened
 *  — the same tail frames it ends on play twice (once plainly, once blended into the transition),
 *  same as preview replays them — while only the incoming clip's own segment is shortened, at its
 *  HEAD, by however much the transition already covers. This keeps the total exported duration
 *  exactly equal to the sum of every clip's own nominal length, matching `sequenceDuration` with no
 *  separate accounting needed. */
/** Exported so `buildAudioOnlyExportPlan.ts` can reuse the exact same segment-walk (clip/gap/
 *  transition boundaries, transition-shortened heads) an audio-only mixdown needs to match precisely
 *  — narrowed to the two media-path resolvers rather than the full options shape (fonts/text-file
 *  paths are video-layer-only concerns, resolved by callers that actually draw text). */
export function buildSegments(
  project: Project,
  track: Track,
  clips: Clip[],
  options: Pick<ExportPlanOptions, "inputPathFor" | "faceEffectInputPathFor">,
  targetDuration: number
): Segment[] {
  const segments: Segment[] = [];
  let cursor = 0;

  for (const clip of clips) {
    if (clip.timelineStart > cursor + 1e-6) {
      segments.push({ kind: "gap", duration: clip.timelineStart - cursor });
    }
    const asset = findAsset(project, clip.assetId);
    if (!asset) throw new ExportError(`A clip references media that is no longer in the project`);
    if (asset.offline) throw new ExportError(`"${asset.name}" is offline. Relink it before exporting.`);

    // A color-matte asset (`AssetKind === "color"`) has no intrinsic duration or seekable timeline of
    // its own, same as a still image — both resolve to a single generated frame that needs `-loop 1`
    // to occupy real time on the timeline, never `-ss`.
    const isImage = asset.kind === "image" || asset.kind === "color";
    const path = inputPathForClip(clip, options);
    const fullDuration = clipDuration(clip);
    const transition = findTransitionPartner(track, clip);
    const transitionOut = findTransitionOut(track, clip);
    const fadeOut = transitionOut?.duration;

    if (transition?.partner) {
      const partner = transition.partner;
      const partnerAsset = findAsset(project, partner.assetId);
      if (!partnerAsset) throw new ExportError(`A clip references media that is no longer in the project`);
      const fps = project.exportSettings?.fps || project.sequence.fps || 30;
      const D = transition.duration;
      const halfD = snapToFrame(D / 2, fps);
      const tailD = D - halfD;

      // The transition spans [cut - halfD, cut + tailD], where cut = clip.timelineStart.
      // Shorten the preceding partner's solo segment by halfD.
      const prevSegment = segments[segments.length - 1];
      if (prevSegment && prevSegment.kind === "clip" && prevSegment.clip.id === partner.id) {
        prevSegment.duration -= halfD;
        if (prevSegment.duration <= 1e-6) {
          segments.pop();
        }
      }

      segments.push({
        kind: "transition",
        duration: D,
        from: {
          clip: partner,
          hasAudio: partnerAsset.hasAudio,
          isImage: partnerAsset.kind === "image" || partnerAsset.kind === "color",
          path: inputPathForClip(partner, options),
          sourceIn: partner.sourceOut - halfD,
          elapsedStart: clipDuration(partner) - halfD,
        },
        to: {
          clip,
          hasAudio: asset.hasAudio,
          isImage,
          path,
          sourceIn: clip.sourceIn - halfD,
          elapsedStart: -halfD,
        },
      });

      const remaining = fullDuration - tailD;
      if (remaining > 1e-6) {
        segments.push({
          kind: "clip",
          clip,
          hasAudio: asset.hasAudio,
          isImage,
          path,
          sourceIn: clip.sourceIn + tailD,
          duration: remaining,
          elapsedStart: tailD,
          fadeOut,
        });
      }
      // else: the transition-in blend consumes this clip's entire duration — no separate tail
      // segment exists to attach `fadeOut` to (see `Segment["clip"]["fadeOut"]`'s own doc comment).
    } else if (transition) {
      // Solo fade-in: no adjacent predecessor to blend from, so this is the clip's full, unshortened
      // segment (nothing stole a "head" duration from it) with `fadeIn` set instead of being split into
      // a `"transition"` segment — see `Segment["clip"]["fadeIn"]`'s own doc comment.
      segments.push({
        kind: "clip",
        clip,
        hasAudio: asset.hasAudio,
        isImage,
        path,
        sourceIn: clip.sourceIn,
        duration: fullDuration,
        elapsedStart: 0,
        fadeIn: transition.duration,
        fadeOut,
      });
    } else {
      segments.push({ kind: "clip", clip, hasAudio: asset.hasAudio, isImage, path, sourceIn: clip.sourceIn, duration: fullDuration, elapsedStart: 0, fadeOut });
    }

    cursor = clipEnd(clip);
  }

  if (targetDuration > cursor + 1e-6) {
    segments.push({ kind: "gap", duration: targetDuration - cursor });
  }

  return segments;
}

/** Rounds to millisecond precision. FFmpeg parses these as decimal seconds, and full float precision
 *  produces unreadable argument lists without improving accuracy at frame granularity. */
function t(seconds: number): string {
  return seconds.toFixed(6);
}

/** Same rounding for a plain numeric expression fragment (crop fractions, scale, degrees, pixel
 *  offsets) — not a time value, but the same "readable, frame/pixel-accurate precision" reasoning. */
function n(value: number): string {
  return value.toFixed(6);
}

/** FFmpeg setpts expression for the selected clip-time range. Curve points are linear in SOURCE
 *  progress, so integrating 1/speed gives the exact output time and matches clipTiming.ts. */
function speedSetptsExpression(clip: Clip, elapsedStart: number, timelineDuration: number, sourceDuration: number): string | null {
  if (elapsedStart < 0 || elapsedStart + timelineDuration > clipDuration(clip)) {
    const effective = sourceDuration / Math.max(1e-9, timelineDuration);
    return Math.abs(effective - 1) < 1e-6 ? null : `(PTS-STARTPTS)/${n(effective)}`;
  }
  const p0 = clipProgressAtElapsed(clip, elapsedStart);
  const p1 = clipProgressAtElapsed(clip, elapsedStart + timelineDuration);
  const curve = sliceSpeedCurve(clip.speedCurve, Math.min(p0, p1), Math.max(p0, p1));
  if (!curve) {
    const speed = clip.speed ?? 1;
    return Math.abs(speed - 1) < 1e-6 ? null : `(PTS-STARTPTS)/${n(speed)}`;
  }
  const q = `((PTS-STARTPTS)*TB/${n(Math.max(1e-9, sourceDuration))})`;
  let cumulative = 0;
  const expressions: { end: number; value: string }[] = [];
  for (let i = 0; i < curve.length - 1; i++) {
    const a = curve[i];
    const b = curve[i + 1];
    const width = b.position - a.position;
    const delta = b.speed - a.speed;
    const local = Math.abs(delta) < 1e-8
      ? `${n(sourceDuration / a.speed)}*(${q}-${n(a.position)})`
      : `${n(sourceDuration * width / delta)}*log((${n(a.speed)}+${n(delta)}*((${q}-${n(a.position)})/${n(width)}))/${n(a.speed)})`;
    expressions.push({ end: b.position, value: `${n(cumulative)}+${local}` });
    cumulative += Math.abs(delta) < 1e-8
      ? sourceDuration * width / a.speed
      : sourceDuration * width / delta * Math.log(b.speed / a.speed);
  }
  let expression = expressions[expressions.length - 1].value;
  for (let i = expressions.length - 2; i >= 0; i--) {
    expression = `if(lte(${q}\,${n(expressions[i].end)})\,${expressions[i].value}\,${expression})`;
  }
  return `(${expression})/TB`;
}

function hasRotationOnlyTransformKeyframes(clip: Clip): boolean {
  const keyframes = clip.transformKeyframes ?? [];
  if (keyframes.length < 2 || hasEffectsKeyframes(clip) || hasColorGradingKeyframes(clip)) return false;
  const first = keyframes[0].value;
  const sameGeometry = keyframes.every(({ value }) =>
    value.offsetX === first.offsetX &&
    value.offsetY === first.offsetY &&
    value.scale === first.scale &&
    value.crop.top === first.crop.top &&
    value.crop.right === first.crop.right &&
    value.crop.bottom === first.crop.bottom &&
    value.crop.left === first.crop.left
  );
  return sameGeometry && keyframes.some(({ value }) => value.rotationDeg !== first.rotationDeg);
}

/** A continuous, piecewise-linear FFmpeg expression for rotation keyframes. `t` is local to the
 *  segment's zeroed source, so `elapsedAtSegmentStart` maps it back into clip-relative keyframe time.
 *  Commas are escaped for the filter-graph parser while remaining expression separators. */
function rotationKeyframeExpression(clip: Clip, elapsedAtSegmentStart: number): string {
  const keyframes = [...(clip.transformKeyframes ?? [])].sort((a, b) => a.time - b.time);
  if (keyframes.length === 0) return n(clip.transform?.rotationDeg ?? 0);
  const elapsed = elapsedAtSegmentStart === 0 ? "t" : `(t+${n(elapsedAtSegmentStart)})`;
  let expression = n(keyframes[keyframes.length - 1].value.rotationDeg);
  for (let index = keyframes.length - 2; index >= 0; index--) {
    const from = keyframes[index];
    const to = keyframes[index + 1];
    const duration = Math.max(1e-9, to.time - from.time);
    const delta = to.value.rotationDeg - from.value.rotationDeg;
    const interpolated = `${n(from.value.rotationDeg)}+${n(delta)}*clip((${elapsed}-${n(from.time)})/${n(duration)},0,1)`;
    expression = `if(lt(${elapsed},${n(to.time)}),${interpolated},${expression})`;
  }
  return expression.replaceAll(",", "\\,");
}

/** Filter chain for a clip with a REAL transform and/or REAL effects (see `isIdentityTransform`/
 *  `isIdentityEffects` — the plain scale+pad chain below handles the fully-untouched case and is
 *  untouched by this). Empirically verified against the actual bundled FFmpeg binary before being
 *  wired in here — see the "any degree" verification in this feature's development notes for a
 *  rendered example.
 *
 *  Two FFmpeg mechanisms are what make the geometry tractable without any JS-side trigonometry:
 *  `rotate`'s `ow=rotw(a):oh=roth(a)` macros let FFmpeg itself compute the exact bounding box that
 *  fits the rotated content losslessly (no precomputed sizes needed here), and `overlay`'s
 *  `W`/`H`/`w`/`h` expression variables let the composite position reference both the background and
 *  overlay's actual sizes symbolically. `format=rgba` right after `crop` is what makes `rotate`'s
 *  `black@0` fill genuinely transparent PADDING rather than a visible black box — without an alpha
 *  channel there, `overlay` has nothing to composite through and the rotated corners show as solid
 *  black; it's also what `colorchannelmixer=aa=` (opacity) needs an alpha channel to modulate. */
function buildTransformFilters(params: {
  /** A filter-graph SOURCE reference — either a raw FFmpeg input selector (`` `${videoIndex}:v` ``, the
   *  non-keyframed path's own convention) or an already-`trim=`+`setpts=PTS-STARTPTS`-normalized label
   *  produced by `pushKeyframedClipVideoFilters`'s own `split=`/`trim=` fan-out — either way, just
   *  substituted verbatim into `[${source}]`, so this function doesn't need to know or care which. */
  source: string;
  /** Same shape as `source`, for the background input `overlay` composites the transformed clip onto. */
  bg: string;
  outputLabel: string;
  transform: ClipTransform;
  effects: ClipEffects;
  width: number;
  height: number;
  fps: number;
  chromaKey?: ChromaKeySettings;
  colorGrading?: ColorGrading;
  /** Resolved `.cube` file path (`ExportPlanOptions.lutPathFor(clip.lutId)`), or `undefined` when the
   *  clip has no `lutId` or the resolver itself wasn't supplied — either way, no `lut3d=` stage. */
  lutPath?: string;
  pixelEffect?: { type: PixelEffectType; speed?: number };
  flipHorizontal?: boolean;
  flipVertical?: boolean;
  mask?: ClipMask;
  /** Continuous degrees expression in this filter's local `t`; used for rotation-only keyframes. */
  rotationExpressionDegrees?: string;
}): string[] {
  const { source, bg, outputLabel, transform, effects, width, height, fps, chromaKey, colorGrading, lutPath, pixelEffect, flipHorizontal, flipVertical, mask, rotationExpressionDegrees } = params;
  const { crop } = transform;
  const clipLabel = `${outputLabel}_src`;
  const bgLabel = `${outputLabel}_bg`;
  const angle = rotationExpressionDegrees ? `(${rotationExpressionDegrees})*PI/180` : `${n(transform.rotationDeg)}*PI/180`;
  // Applied FIRST, on the raw un-cropped/un-scaled source — keying is a per-pixel color operation that
  // commutes with crop/scale/rotate, so where in the chain it runs doesn't change the RESULT, only
  // performance (fewer pixels to key before a downsize) and needing `format=rgba` right after it rather
  // than a separate reformat, since `colorkey` already outputs an alpha channel itself. `similarity` is
  // floored at 0.01 here (FFmpeg's own documented minimum) without touching the STORED value — 0 stays
  // meaningful in the UI/preview as "key nothing", `buildTransformFilters` just needs a technically
  // valid argument. Mirrors `applyChromaKey` (`playback/PlaybackEngine.ts`)'s own algorithm — see
  // `ChromaKeySettings`'s own doc comment for the shared preview/export parity goal.
  const chromaKeyFilter = chromaKey
    ? `colorkey=color=0x${chromaKey.color.slice(1)}:similarity=${n(Math.max(0.01, chromaKey.similarity))}:blend=${n(chromaKey.smoothness)},`
    : "";

  const cropFilter =
    `crop=w=iw*(1-${n(crop.left)}-${n(crop.right)}):h=ih*(1-${n(crop.top)}-${n(crop.bottom)})` +
    `:x=iw*${n(crop.left)}:y=ih*${n(crop.top)}`;
  const remainingX = 1 - crop.left - crop.right;
  const remainingY = 1 - crop.top - crop.bottom;
  const hasCrop = crop.top > 0 || crop.right > 0 || crop.bottom > 0 || crop.left > 0;
  // `iw`/`ih` are already cropped here. Multiplying the target dimensions by the remaining fractions
  // reconstructs the fit scale of the FULL source, so cropping one edge does not re-fit/zoom the image.
  const scaleFilter = hasCrop
    ? `scale=w='iw*min(${width}*${n(remainingX)}/iw,${height}*${n(remainingY)}/ih)*${n(transform.scale)}'` +
      `:h='ih*min(${width}*${n(remainingX)}/iw,${height}*${n(remainingY)}/ih)*${n(transform.scale)}'`
    : `scale=w='iw*min(${width}/iw,${height}/ih)*${n(transform.scale)}'` +
      `:h='ih*min(${width}/iw,${height}/ih)*${n(transform.scale)}'`;
  // Restore the cropped pixels' position inside a transparent full-source-sized canvas before
  // rotating. This keeps the untouched opposite edge fixed and matches computeTransformedBox.
  const padFilter = hasCrop
    ? `,format=rgba,pad=w='iw/${n(remainingX)}':h='ih/${n(remainingY)}'` +
      `:x='iw*${n(crop.left)}/${n(remainingX)}':y='ih*${n(crop.top)}/${n(remainingY)}':color=black@0`
    : "";
  // A dynamic angle cannot also drive `rotw(a)`/`roth(a)`: FFmpeg evaluates output dimensions once
  // while `t` is unavailable. A fixed diagonal square safely contains every angle and lets one filter
  // interpolate every output frame, avoiding the visible 150–300ms staircase of the old slice path.
  const rotateFilter = rotationExpressionDegrees
    ? `rotate=a='${angle}':ow='hypot(iw,ih)':oh='hypot(iw,ih)':c=black@0`
    : `rotate=a=${angle}:ow=rotw(${angle}):oh=roth(${angle}):c=black@0`;
  // eq's own defaults (brightness=0, contrast=1, saturation=1) are genuine no-ops, so — unlike
  // gblur/colorchannelmixer below — it's always safe to include unconditionally, no identity check
  // needed for this one fragment.
  //
  // NOT actually `eq=brightness=...:contrast=...:saturation=...` — `eq` is one of FFmpeg's own
  // GPL-only filters (see FFmpeg's "GPL Licensed Filters" list), so it doesn't exist in the LGPL
  // build the mobile app ships (see apps/mobile/ios/App/FFmpegKitLGPL's own comment on why that
  // build was chosen over a GPL one). This reproduces eq's exact per-plane math instead — from
  // FFmpeg's own vf_eq.c: luma gets `contrast*(v-0.5)+0.5+brightness` (v normalized to 0..1), chroma
  // gets the identical formula with `saturation` standing in for `contrast` and brightness pinned at
  // 0 — via `lutyuv`, which isn't GPL-gated. Same visual result, not an approximation; written
  // directly in the 0..255 pixel domain (127.5 standing in for eq's 0.5 midpoint) rather than
  // normalizing to 0..1 and back, since lutyuv's `val` is already the raw 8-bit sample.
  const eqFilter =
    `lutyuv=y='clip((val-127.5)*${n(effects.contrast)}+127.5+${n(effects.brightness * 255)},0,255)'` +
    `:u='clip((val-127.5)*${n(effects.saturation)}+127.5,0,255)'` +
    `:v='clip((val-127.5)*${n(effects.saturation)}+127.5,0,255)'`;
  // RGB curves color grading — see `curvesFilter.ts`'s own doc comment for why `master=` (never `all=`)
  // and why `curves` (unlike `eq` above) needs no LGPL workaround. Applied right after `eq`, same
  // post-crop/pre-scale pixel-domain position `PlaybackEngine.ts`'s own `drawTransformed` applies its
  // curves LUT pass in (both right after the chroma-key stage, before geometry).
  const curvesFilter = colorGrading ? buildCurvesFilterFragment(colorGrading, n) : null;
  // Applied right after curves, before geometry — matches `PlaybackEngine.drawTransformed`'s own
  // post-color-grading/pre-geometry placement for its LUT pass. `interp=tetrahedral` matches the
  // interpolation quality `Lut3DEngine`'s own preview LUT sampling already uses.
  const lutFilter = lutPath ? `,lut3d=file='${lutPath}':interp=tetrahedral` : "";
  // Applied right after the LUT stage, still before geometry — a spatial displacement needs to see the
  // clip's own native pixels, same reasoning `PlaybackEngine.drawTransformed` runs `applyGlitch`/
  // `applyWaterRipple` LAST among its color/grade passes, before the geometric transform. Only one of
  // the two can ever be set (`PixelEffectType` is a single-choice union on the clip, not a set), so
  // there's no ordering question between them.
  //
  // `applyWaterRipple`'s own per-pixel loop (`timeline/pixelEffects.ts`) is a direct, empirically-
  // verified port of this `geq=` recipe — `p(X+amplitude*sin(Y/wavelength+T*rate*speed),Y)` samples
  // each output pixel from a horizontally-displaced input coordinate that varies by row and by time,
  // applied identically to all three planes (luma reads full-resolution X/Y; FFmpeg's own `geq`
  // evaluates cb/cr in THEIR plane's own coordinate space, so the same expression already samples
  // correctly at chroma resolution with no extra scaling needed).
  //
  // `applyGlitch`'s own preview version varies per discrete time "burst" (`GLITCH_BURST_PERIOD_SECONDS`)
  // via a seeded pseudo-random hash — `rgbashift`'s `rh=`/`bv=` take plain constants, not a `T`-driven
  // expression the way `geq=` does, so there's no way to reproduce that per-burst jitter at the FFmpeg
  // level. A deliberate, documented scope cut: export renders ONE fixed R/B channel split (deterministic
  // from `speed` alone, not real time) for the clip's whole duration instead, with `noise=allf=t` at
  // least keeping the per-pixel noise grain itself animating frame-to-frame so the result doesn't read
  // as a completely static filter.
  const pixelEffectFilter = (() => {
    if (!pixelEffect) return "";
    const speed = pixelEffect.speed ?? 1;
    if (pixelEffect.type === "waterRipple") {
      const rate = (2 * Math.PI) / WATER_RIPPLE_PERIOD_SECONDS;
      const expr = `p(X+${n(WATER_RIPPLE_AMPLITUDE_PX)}*sin(Y/${n(WATER_RIPPLE_WAVELENGTH_PX)}+T*${n(rate)}*${n(speed)}),Y)`;
      return `,geq=lum='${expr}':cb='${expr}':cr='${expr}'`;
    }
    // "glitch"
    const shift = Math.round(GLITCH_SHIFT_PX * speed) || GLITCH_SHIFT_PX;
    return `,rgbashift=rh=${shift}:bv=${-shift},noise=alls=${n(GLITCH_NOISE_AMOUNT)}:allf=t`;
  })();
  const flipFilter = `${flipHorizontal ? ",hflip" : ""}${flipVertical ? ",vflip" : ""}`;
  const maskFilter = (() => {
    if (!mask) return "";
    const signed = mask.shape === "ellipse"
      ? `1-hypot((X/W-${n(mask.centerX)})/${n(mask.width / 2)},(Y/H-${n(mask.centerY)})/${n(mask.height / 2)})`
      : `min(${n(mask.width / 2)}-abs(X/W-${n(mask.centerX)}),${n(mask.height / 2)}-abs(Y/H-${n(mask.centerY)}))`;
    const amount = mask.feather > 0 ? `clip((${signed})/${n(mask.feather)}+0.5,0,1)` : `gte(${signed},0)`;
    const alpha = mask.invert ? `1-(${amount})` : amount;
    return `,geq=r='r(X,Y)':g='g(X,Y)':b='b(X,Y)':a='alpha(X,Y)*(${alpha})'`;
  })();
  // Applied AFTER scale, not before — so `blur`'s sigma corresponds to the clip's FINAL on-screen
  // pixel size, matching both the "pixels" unit the Inspector's slider promises and how Canvas2D's
  // own `context.filter` blurs the already-scaled draw, not the source's native resolution. Only
  // appended when actually blurring — an unconditional `gblur=sigma=0` is real filter-graph work
  // (unlike `eq` at its defaults) for the common no-blur case.
  const blurFilter = effects.blur > 0 ? `,gblur=sigma=${n(effects.blur)}` : "";
  // Alpha applied right before compositing onto the background, not earlier — the geometric filters
  // upstream (scale/rotate) don't need to see a partially-transparent source, only the final overlay
  // blend does.
  const opacityFilter = effects.opacity < 1 ? `,colorchannelmixer=aa=${n(effects.opacity)}` : "";

  return [
    `[${source}]${chromaKeyFilter}${cropFilter},format=rgba${maskFilter},${eqFilter}${curvesFilter ? `,${curvesFilter}` : ""}${lutFilter}${pixelEffectFilter}${flipFilter},${scaleFilter}${blurFilter}${padFilter},${rotateFilter}${opacityFilter},` +
      `setsar=1,fps=${fps},setpts=PTS-STARTPTS[${clipLabel}]`,
    // The background is its own lavfi input (pushed alongside this), not an inline `color=` source
    // filter — matching the pattern gap segments already use elsewhere in this function, so there's
    // only one way black/silence sources get created in this file, not two.
    `[${bg}]setpts=PTS-STARTPTS[${bgLabel}]`,
    `[${bgLabel}][${clipLabel}]overlay=x='(W-w)/2+${n(transform.offsetX)}':y='(H-h)/2+${n(transform.offsetY)}':format=auto[${outputLabel}]`,
  ];
}

/** Base sampling interval for a keyframed clip's export slicing — see `computeKeyframeSlices`'s own
 *  doc comment for the full reasoning. ~4-5 frames at 30fps: each slice is a STATIC image held for its
 *  own duration, so the perceptible "step" between adjacent slices is the size of the VALUE jump, not
 *  the slice's own length — 150ms keeps that jump small for any reasonable keyframe-to-keyframe
 *  distance while keeping a typical 5-15s keyframed clip's slice count in the tens, not hundreds. */
const KEYFRAME_SLICE_SECONDS = 0.15;
/** Ceiling on how many slices ONE clip's own keyframed segment can produce — mirrors
 *  `MAX_TYPEWRITER_STEPS`'s own chosen ceiling (a magnitude already load-tested in this exact
 *  codebase), bounding worst-case filter-graph size for a pathological case (e.g. a keyframe pair
 *  spanning a 60+ second clip) at a KNOWN cost rather than an unbounded one. Unlike
 *  `buildTypewriterDrawTextCalls`, exceeding this does NOT drop the animation — see
 *  `computeKeyframeSlices`'s own comment on why silently discarding it would be a much worse
 *  regression here than in the typewriter case. */
const MAX_KEYFRAME_SLICES_PER_CLIP = 240;

/** Slices ONE keyframed clip's segment — spanning clip-window-relative time
 *  `[elapsedAtSegmentStart, elapsedAtSegmentStart + sliceDuration)` (the same "seconds since this
 *  clip's own timelineStart" space `Keyframe.time` itself uses) — into short STATIC sub-pieces, each
 *  sampled at its own midpoint via `resolveClipTransform`/`resolveClipEffects`. This is what lets a
 *  keyframed Transform/Effects animation (including scale/crop — real zoom/pan) render through the
 *  EXACT SAME `buildTransformFilters` every static clip already uses, unchanged, rather than needing
 *  FFmpeg to animate a filter's own output DIMENSIONS per-frame via an in-expression `t` — which isn't
 *  safely possible (confirmed by this file's own `rotate`'s `ow=`/`oh=` constraint: buffer-geometry
 *  parameters must stay fixed at graph-configure time, only per-pixel/per-sample math can vary with
 *  `t`).
 *
 *  Boundaries: every keyframe time strictly inside the segment, plus the segment's own two endpoints.
 *  Any gap between consecutive boundaries wider than `KEYFRAME_SLICE_SECONDS` is subdivided at fixed
 *  steps — interpolation is CONTINUOUS between keyframes, so even a long gap between two distant
 *  keyframes still needs intermediate sampling to read as motion, not a single static average. If the
 *  resulting count would exceed `MAX_KEYFRAME_SLICES_PER_CLIP`, the whole thing is recomputed with an
 *  ADAPTIVE, coarser interval (`sliceDuration / MAX_KEYFRAME_SLICES_PER_CLIP`) instead — a keyframed
 *  Ken-Burns pan on an ordinary long clip is the COMMON case here, not a rare edge, so silently
 *  dropping the whole animation (the way `buildTypewriterDrawTextCalls` does past ITS own cap) would
 *  be a far worse regression than slightly coarser (but still real) motion.
 *
 *  Every boundary is snapped to the frame grid, EXCEPT the first and last, which are pinned to the
 *  segment's own exact start/end — consecutive slice durations telescope to exactly `sliceDuration`
 *  regardless of how the interior boundaries snap, so no separate "fix up the last slice" step is
 *  needed. */
/** Shared boundary/snap/adaptive-recompute mechanics for BOTH video keyframe slicing
 *  (`computeKeyframeSlices`) and text keyframe slicing (`computeTextStyleKeyframeSlices`) — extracted
 *  so the two can't drift apart on the "how many slices, where do they land" question, even though
 *  what gets SAMPLED at each slice differs (three resolvers for video, one for text; see
 *  `computeTextStyleKeyframeSlices`'s own doc comment for why that stays a separate function rather
 *  than this one growing a generic resolver list). `keyframeTimes` is the flat, already-merged list of
 *  every keyframe time relevant to whichever caller is asking (video: transform+effects+colorGrading;
 *  text: textStyleKeyframes alone) — see `computeKeyframeSlices`'s own comment on why a HOLD-resolved
 *  field's keyframe times still need to be included here, not just interpolated ones.
 *
 *  Exported so `khmerTextRenderer.ts` can reuse the exact same "flipbook" slice boundaries for a
 *  Khmer bounce/pulse/typewriter text clip's own per-window image renders — same reasoning as
 *  `buildSegments`'s own export, reuse over reimplementation. */
export function computeSliceBoundaries(
  keyframeTimes: number[],
  elapsedAtSegmentStart: number,
  sliceDuration: number,
  fps: number,
  // Both optional, defaulting to the exact constants this always used — existing callers (text
  // keyframe slicing, khmerTextRenderer.ts) are completely unaffected. Threaded through so hosted
  // mode can pass a coarser interval/lower cap for VIDEO transform keyframes specifically — see
  // `ExportPlanOptions.keyframeSliceTuning`'s own doc comment for why.
  baseIntervalSeconds: number = KEYFRAME_SLICE_SECONDS,
  maxSlices: number = MAX_KEYFRAME_SLICES_PER_CLIP
): number[] {
  const segmentEnd = elapsedAtSegmentStart + sliceDuration;

  function boundariesAt(interval: number): number[] {
    const filteredTimes = keyframeTimes.filter((time) => time > elapsedAtSegmentStart + 1e-9 && time < segmentEnd - 1e-9);
    const sorted = [...new Set([elapsedAtSegmentStart, segmentEnd, ...filteredTimes])].sort((a, b) => a - b);

    const withSubdivisions: number[] = [sorted[0]];
    for (let i = 1; i < sorted.length; i++) {
      const from = sorted[i - 1];
      const to = sorted[i];
      const steps = Math.max(1, Math.ceil((to - from) / interval));
      for (let s = 1; s < steps; s++) withSubdivisions.push(from + ((to - from) * s) / steps);
      withSubdivisions.push(to);
    }
    return withSubdivisions;
  }

  let boundaries = boundariesAt(baseIntervalSeconds);
  if (boundaries.length - 1 > maxSlices) {
    boundaries = boundariesAt(sliceDuration / maxSlices);
  }

  const snapped = boundaries.map((time) => snapToFrame(time, fps));
  snapped[0] = elapsedAtSegmentStart;
  snapped[snapped.length - 1] = segmentEnd;
  return snapped;
}

function computeKeyframeSlices(
  clip: Clip,
  elapsedAtSegmentStart: number,
  sliceDuration: number,
  fps: number,
  keyframeSliceTuning?: { baseIntervalSeconds: number; maxSlices: number }
): { offset: number; duration: number; transform: ClipTransform; effects: ClipEffects; colorGrading: ColorGrading }[] {
  // `colorGradingKeyframes` is included here even though its own resolver HOLDS (never lerps) between
  // keyframes — a HOLD boundary is exactly where the visible value jumps discontinuously, so it needs
  // its own slice boundary the same way a transform/effects keyframe's interpolation midpoint does,
  // otherwise a single slice could straddle the jump and render the WRONG side of it for part of its
  // own duration.
  const keyframeTimes = [...(clip.transformKeyframes ?? []), ...(clip.effectsKeyframes ?? []), ...(clip.colorGradingKeyframes ?? [])].map(
    (k) => k.time
  );
  const snapped = computeSliceBoundaries(
    keyframeTimes,
    elapsedAtSegmentStart,
    sliceDuration,
    fps,
    keyframeSliceTuning?.baseIntervalSeconds,
    keyframeSliceTuning?.maxSlices
  );

  const slices: { offset: number; duration: number; transform: ClipTransform; effects: ClipEffects; colorGrading: ColorGrading }[] = [];
  for (let i = 1; i < snapped.length; i++) {
    const offset = snapped[i - 1];
    const sliceLength = snapped[i] - offset;
    if (sliceLength <= 1e-9) continue; // two boundaries snapped onto the same frame — collapse, don't emit a zero-length slice
    const midpoint = offset + sliceLength / 2;
    slices.push({
      offset,
      duration: sliceLength,
      transform: resolveClipTransform(clip, midpoint),
      effects: resolveClipEffects(clip, midpoint),
      colorGrading: resolveClipColorGrading(clip, midpoint),
    });
  }
  return slices;
}

/** `computeKeyframeSlices`'s own counterpart for a text clip's `textStyleKeyframes` — a SEPARATE
 *  function, not a generalized/parameterized version of it, matching this file's existing pattern of
 *  parallel-but-distinct resolvers (`resolveClipTransform`/`resolveClipEffects`/`resolveClipColorGrading`/
 *  `resolveTextStyle` are four separate functions, not one generic one). Simpler than the video case in
 *  one respect: text clips are never run through `buildSegments`/transition-cutting the way video clips
 *  are (the text-track loop iterates `track.clips` directly), so `elapsedAtSegmentStart` is always `0`
 *  and `sliceDuration` is always the clip's own full `clipDuration()` — `slice.offset` is directly
 *  "seconds since `clip.timelineStart`," the same space `Keyframe.time`/`resolveTextStyle`'s own
 *  `elapsedSeconds` already use, with no segment-relative conversion needed anywhere downstream. */
function computeTextStyleKeyframeSlices(clip: Clip, baseStyle: TextStyle, fps: number): { offset: number; duration: number; style: TextStyle }[] {
  const sliceDuration = clipDuration(clip);
  const keyframeTimes = (clip.textStyleKeyframes ?? []).map((k) => k.time);
  const snapped = computeSliceBoundaries(keyframeTimes, 0, sliceDuration, fps);

  const slices: { offset: number; duration: number; style: TextStyle }[] = [];
  for (let i = 1; i < snapped.length; i++) {
    const offset = snapped[i - 1];
    const sliceLength = snapped[i] - offset;
    if (sliceLength <= 1e-9) continue;
    const midpoint = offset + sliceLength / 2;
    slices.push({ offset, duration: sliceLength, style: resolveTextStyle(clip, midpoint, baseStyle) });
  }
  return slices;
}

/** `computeTextStyleKeyframeSlices`'s own counterpart for a text clip's `textCropKeyframes` — same
 *  "always the clip's own full duration, elapsedAtSegmentStart always 0" shape (text has no segment
 *  concept), just sampling `resolveTextCrop` instead. A SEPARATE slicer from the style one, not a
 *  shared/merged boundary set: crop and style keyframes are independent arrays a clip can carry either,
 *  both, or neither of, and the crop stage runs as its OWN downstream filter step (after whatever
 *  produced the fully-rendered text stream, keyframed or not) rather than inside the drawtext chain
 *  itself, so there's no reason its own slice boundaries need to line up with style's. */
function computeTextCropKeyframeSlices(clip: Clip, fps: number): { offset: number; duration: number; crop: TextCrop }[] {
  const sliceDuration = clipDuration(clip);
  const keyframeTimes = (clip.textCropKeyframes ?? []).map((k) => k.time);
  const snapped = computeSliceBoundaries(keyframeTimes, 0, sliceDuration, fps);

  const slices: { offset: number; duration: number; crop: TextCrop }[] = [];
  for (let i = 1; i < snapped.length; i++) {
    const offset = snapped[i - 1];
    const sliceLength = snapped[i] - offset;
    if (sliceLength <= 1e-9) continue;
    const midpoint = offset + sliceLength / 2;
    slices.push({ offset, duration: sliceLength, crop: resolveTextCrop(clip, midpoint) });
  }
  return slices;
}

/** One `crop=`+`pad=` stage for a `TextCrop` rectangle — shared by the static (single-slice) and
 *  keyframed (multi-slice, one call per slice) text-crop paths below, so the two can't drift apart on
 *  the actual pixel math. `pad`'s own `x=`/`y=` can't reuse `crop`'s output `iw`/`ih` symbolically the
 *  way `crop`'s own `x=`/`y=` can reuse the PRE-crop stream's `iw`/`ih` — after `crop` runs, `iw`/`ih`
 *  refer to the smaller cropped buffer, not the original frame. Frame dimensions and crop fractions are
 *  both known JS constants here (unlike `buildTransformFilters`'s source crop, where source dimensions
 *  vary per asset), so every arg below is a precomputed pixel literal rather than a mix of symbolic and
 *  literal forms. `format=rgba` re-applied immediately before `pad`, same defensive convention as
 *  everywhere else in this file that depends on alpha surviving a filter — never assumed to have
 *  survived untouched. */
function buildTextCropFilter(inputLabel: string, crop: TextCrop, outputLabel: string, width: number, height: number): string {
  const cropX = n(width * crop.left);
  const cropY = n(height * crop.top);
  const cropW = n(width * (1 - crop.left - crop.right));
  const cropH = n(height * (1 - crop.top - crop.bottom));
  return (
    `[${inputLabel}]crop=w=${cropW}:h=${cropH}:x=${cropX}:y=${cropY},format=rgba,` +
    `pad=w=${n(width)}:h=${n(height)}:x=${cropX}:y=${cropY}:color=black@0[${outputLabel}]`
  );
}

/** Windows paths carry a drive-letter colon and, in this repo, spaces (`.../App Development/...`) —
 *  both fatal to FFmpeg's OWN filter-graph string parser unless the whole value is wrapped in single
 *  quotes AND the colon is still separately backslash-escaped even inside them. Empirically verified
 *  against the real bundled binary (not from documentation alone — the colon-inside-quotes requirement
 *  in particular is not obvious and easy to get wrong) before being wired in here.
 *
 *  Backslashes (the path separator `path.join`/`path.resolve`/`os.tmpdir()` actually produce on
 *  Windows) get normalized to forward slashes FIRST, before the colon escape — a raw backslash is
 *  FFmpeg's OWN filtergraph escape character, so an un-normalized Windows path silently eats its own
 *  separators (confirmed live: `C:\Users\...\vcut-text-xyz\clip.txt` arrived at FFmpeg as
 *  `C:Users...vcut-text-xyzclip.txt`, "no such file"). Forward slashes work as path separators on
 *  Windows regardless of what produced the string, so this is a safe normalization either way. */
function ffmpegPath(absolutePath: string): string {
  return `'${absolutePath.replace(/\\/g, "/").replace(/:/g, "\\:")}'`;
}

/** "#rrggbb" → "0xrrggbb", FFmpeg's own hex color syntax; passes anything else (a named color, or an
 *  already-`0x`-prefixed value) through untouched. */
function ffmpegColor(hex: string): string {
  return hex.startsWith("#") ? `0x${hex.slice(1)}` : hex;
}

/** The `box=`/`bordercolor=`/`shadowcolor=` fragments — background box, stroke outline, and drop
 *  shadow — shared VERBATIM by both `drawtext` builders below, since all three are purely additive
 *  style knobs that don't interact with either builder's own positioning math. FFmpeg's `drawtext`
 *  composites these in a fixed order (shadow, then outline, then fill) regardless of the order their
 *  key=value pairs appear in the filter string — `PlaybackEngine.drawText` draws in that same order
 *  for the same visual result. */
function buildDrawTextStyleParams(style: TextStyle, textAlignSupported = true): string {
  const box = style.backgroundColor
    ? `:box=1:boxcolor=${ffmpegColor(style.backgroundColor)}:boxborderw=${TEXT_BOX_PADDING}`
    : "";
  const border = style.strokeColor ? `:bordercolor=${ffmpegColor(style.strokeColor)}:borderw=${n(style.strokeWidth)}` : "";
  const shadow = style.shadowColor
    ? `:shadowcolor=${ffmpegColor(style.shadowColor)}:shadowx=${n(style.shadowOffsetX)}:shadowy=${n(style.shadowOffsetY)}`
    : "";
  // `text_align` is what per-line-justifies multi-line text WITHIN the frame-centered block that
  // `buildDrawTextGeometry`'s own `x=` now always anchors regardless of `align` — see that function's
  // own comment, and `textLayout.ts`'s top-of-file comment for the preview-side mirror of this split.
  // `TextStyle.align`'s three values map 1:1 onto `drawtext`'s own `text_align` option, confirmed live
  // against the desktop FFmpeg build. Mobile omits the option because its engine rejects it.
  const textAlign = textAlignSupported ? `:text_align=${style.align}` : "";
  return `${box}${border}${shadow}${textAlign}`;
}

/** A text clip's own fade-out is one of two genuinely different things, both surfaced by the main
 *  text-track loop's own `fadeOutByClipId`-or-`findTransitionOut` lookup, but needing DIFFERENT timing:
 *
 *  - A real crossfade INTO whatever clip follows this one directly (`extendsPastEnd: true`, sourced
 *    from `fadeOutByClipId`): the alpha ramp must happen AFTER this clip's own nominal `clipEnd`, over
 *    `[end, end+duration]` — staying FULLY VISIBLE right up to `end` — so it genuinely OVERLAPS the
 *    incoming clip's own fade-in, which always ramps over ITS OWN `[start, start+duration]`. Fading out
 *    BEFORE `end` instead would mean this clip finishes vanishing the instant the next one's fade-in
 *    begins, with no moment both are simultaneously part-visible — not a real blend, matching this
 *    file's own established reasoning for why `enableEnd` extends past `end` at all.
 *  - A SOLO fade to nothing (`extendsPastEnd: false`, sourced from `findTransitionOut` — resolves only
 *    when nothing genuinely follows this clip at all): there is no incoming clip to overlap with, so
 *    the ramp instead happens DURING this clip's own existing tail, over `[end-duration, end]`, reaching
 *    fully invisible EXACTLY at `end` — matching `PlaybackEngine.drawTextLayer`'s own solo
 *    `compositeSoloReveal` timing exactly, and matching how a video/image clip's own solo fade-out
 *    already behaves (`pushClipVideoFilters`'s `fade=t=out:st=${sliceDuration-fadeOut}`, self-contained
 *    within the clip's existing duration, never past it). Confirmed live: before this distinction
 *    existed, EVERY text fade-out (solo included) used the crossfade-shaped `[end, end+duration]`
 *    timing — a solo clip stayed fully opaque for its entire nominal duration, then kept lingering on
 *    screen fading out for `duration` MORE seconds past where its own clip bar visually ends in the
 *    editor, a real, confirmed mismatch from what preview shows. */
interface TextFadeOut {
  duration: number;
  extendsPastEnd: boolean;
}

/** Computes the `alpha=` expression and enable-window end for one text clip's `drawtext` — shared by
 *  `buildDrawTextFilter` and `buildRotatedDrawTextFilter`. `fadeIn` is the transition duration at this
 *  clip's own head (from `findTransitionPartner` resolved against THIS clip) — `undefined`/`0` for a
 *  plain cut on that side, which is what every existing non-transitioning clip already has, so it gets
 *  byte-for-byte the same filter string as before this feature existed (no `alpha=` term at all). See
 *  `TextFadeOut`'s own doc comment for why `fadeOut`'s two shapes need different timing.
 *
 *  Always a plain fade regardless of the clip's own `transitionIn.type` — unlike video's `xfade`,
 *  `drawtext` has no per-type geometry primitive to reach for (a wipe/slide/circle needs masking two
 *  SEPARATE rendered buffers, not a single call's own parameters), so every text transition TYPE
 *  renders as a dissolve in export specifically. The canvas preview's fuller wipe/slide/circle variety
 *  (see `PlaybackEngine.transitionFamily`) is preview-only for text — a deliberate, documented scope
 *  cut, not an oversight. */
function buildTextFadeParams(clip: Clip, fadeIn: number | undefined, fadeOut: TextFadeOut | undefined): { enableEnd: number; alphaParam: string } {
  const start = clip.timelineStart;
  const end = clipEnd(clip);
  const enableEnd = fadeOut?.extendsPastEnd ? end + fadeOut.duration : end;

  const terms: string[] = [];
  if (fadeIn) terms.push(`(t-${t(start)})/${t(fadeIn)}`);
  if (fadeOut) {
    // The ramp's own END instant: `end+duration` for a crossfade (matches `enableEnd`), or plain `end`
    // for a solo fade (the window itself is never extended, but the RAMP still needs to finish exactly
    // at `end`, not `enableEnd`, which for a solo fade equals `end` anyway — spelled out explicitly
    // rather than reusing `enableEnd` directly so this stays correct if the two ever diverge further).
    const rampEnd = fadeOut.extendsPastEnd ? end + fadeOut.duration : end;
    terms.push(`(${t(rampEnd)}-t)/${t(fadeOut.duration)}`);
  }
  if (terms.length === 0) return { enableEnd, alphaParam: "" };

  // Nested `min(...)` (FFmpeg's `min`/`max` take exactly two args) clamped against 1 so a fade-in that
  // hasn't started yet — or a fade-out ramp evaluated before its own window — can't push alpha above
  // full opacity; each term individually already reaches exactly 1 at the instant its own ramp ends.
  const expr = terms.reduce((acc, term) => (acc ? `min(${acc}\\,${term})` : term), "");
  return { enableEnd, alphaParam: `:alpha='min(1\\,${expr})'` };
}

/** "#rrggbb" → ASS's own `&H00BBGGRR` color syntax (alpha byte first, then BLUE-GREEN-RED — the
 *  reverse channel order `ffmpegColor`'s plain `0xrrggbb` uses). NO trailing `&` here — a `Style:`
 *  line's color fields are plain comma-delimited values, and the trailing `&` some ASS documentation
 *  shows belongs only to the INLINE `{\c...&}` override tag's own closing delimiter, added explicitly
 *  at that one call site (`buildWordHighlightAss`'s per-word loop) instead of baked in here — empirically
 *  verified against the real bundled FFmpeg/libass to matter: an extra trailing `&` baked into EVERY use
 *  (including the `Style:` line) rendered without erroring, but doubled up into `&&` wherever the inline
 *  call site's own `&}` was then appended on top, an accidental-but-real malformed value this fixes. */
function assColor(hex: string): string {
  const r = hex.slice(1, 3);
  const g = hex.slice(3, 5);
  const b = hex.slice(5, 7);
  return `&H00${b}${g}${r}`;
}

/** Seconds → ASS's own `H:MM:SS.cc` (CENTIsecond, not millisecond) timestamp format. */
function assTimestamp(seconds: number): string {
  const clamped = Math.max(0, seconds);
  const totalCentiseconds = Math.round(clamped * 100);
  const cs = totalCentiseconds % 100;
  const totalSeconds = Math.floor(totalCentiseconds / 100);
  const s = totalSeconds % 60;
  const totalMinutes = Math.floor(totalSeconds / 60);
  const m = totalMinutes % 60;
  const h = Math.floor(totalMinutes / 60);
  return `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}.${String(cs).padStart(2, "0")}`;
}

/** `{` and `}` delimit ASS override blocks — literal typed text containing either would otherwise
 *  corrupt the `{\c...&}` color tags `buildWordHighlightAss` wraps every word in. ASS has no escape
 *  sequence for a literal brace inside a Dialogue `Text` field, so this strips them rather than risk a
 *  garbled render — a rare enough thing to type in a caption that silently dropping it is the more
 *  defensible failure mode of the two. */
function assEscapeRun(text: string): string {
  return text.replace(/[{}]/g, "");
}

/** Whether `text` contains any Khmer-script codepoint (U+1780–U+17FF) — decides whether a text clip
 *  routes through the browser-rendered image-overlay path (`pushKhmerTextOverlay`, driven by an async
 *  pre-pass the export route runs before calling `buildExportPlan` at all — see
 *  `ExportPlanOptions.khmerTextWindowsFor`'s own doc comment) instead of `drawtext=`. Exported so that
 *  same pre-pass (`studios/vcut`'s export route) can decide which clips are even worth rendering
 *  through the headless-browser harness in the first place, without duplicating this check.
 *
 *  `drawtext` selects glyphs via a raw FreeType cmap lookup with no OpenType GSUB substitution — most
 *  of this app's bundled Khmer fonts need GSUB even to select a BASE consonant glyph, not just for
 *  subscript/vowel-sign reordering. The libass `subtitles=` filter this app's Khmer text used to route
 *  through instead gets much closer (no tofu) but was separately confirmed to fail at correctly
 *  stacking certain subscript-consonant clusters regardless of font or FFmpeg build (see
 *  `khmerTextRenderer.ts`'s own doc comment for the full empirical trail) — the browser is the one
 *  thing confirmed to shape Khmer correctly, hence the image-overlay path. Latin text is unaffected
 *  either way, so this only redirects the specific case that's actually broken. */
export function containsKhmerScript(text: string): boolean {
  for (const ch of text) {
    const codePoint = ch.codePointAt(0);
    if (codePoint !== undefined && codePoint >= 0x1780 && codePoint <= 0x17ff) return true;
  }
  return false;
}

/** Builds one complete `.ass` subtitle document implementing `wordHighlight` — see
 *  `buildWordHighlightSubtitlesFilter`'s own comment for WHY this exists as a wholly separate render
 *  path from every other text clip (`drawtext` fundamentally can't color individual words within one
 *  call). One `Style:` line carries the clip's font/size/color/outline; one `Dialogue:` EVENT per word
 *  covers the clip's ENTIRE text for that word's own active window (`activeWordIndex`'s timing, exactly
 *  matching the canvas preview) with an inline `{\c...&}` override wrapping just that word in
 *  `highlightColor` — everything else stays the Style's own `PrimaryColour`. This is deliberately NOT
 *  built from ASS `\k` karaoke tags: real `\k` karaoke is CUMULATIVE (each syllable, once reached, stays
 *  highlighted for the rest of the line) — a different visual effect from this app's own "exactly one
 *  word lit at a time" design (`PlaybackEngine.drawText`'s own word-highlight fill loop), which plain
 *  per-event color overrides reproduce exactly with no cross-event state needed.
 *
 *  `\pos(...)` + a numpad `Alignment` (4/5/6 — this app never docks text to a frame edge, always
 *  anchoring around `offsetX`/`offsetY` the same way `computeTextBlock` does) gives libass the exact
 *  same anchor point `buildDrawTextFilter`'s own `x`/`y` formulas resolve to, so a `wordHighlight` clip
 *  sits at the same place on screen a plain text clip with the same style would.
 *
 *  Deliberately scoped OUT for v1: `backgroundColor`/`shadowColor` (ASS's model has no independent
 *  shadow color distinct from its outline color, and no clean equivalent to this app's own background-
 *  box padding/border-radius story), and transition fades (no `alpha=`-style mechanism shared with
 *  `drawtext`'s own fade handling here) — a `wordHighlight` clip with either set still exports, just
 *  without that particular styling; documented, not silently almost-right. */
function buildWordHighlightAss(params: {
  content: string;
  style: TextStyle;
  clip: Clip;
  family: string;
  fontsizeScale: number;
  frameWidth: number;
  frameHeight: number;
  /** Same meaning as `buildDrawTextFilter`'s own `fadeIn`/`fadeOut` — see `TextFadeOut`'s own doc
   *  comment for why `fadeOut`'s two shapes need different timing. Rendered here via libass's
   *  `\fad(t1,t2)` override tag rather than `drawtext`'s `alpha=` expression, since this path renders
   *  through `subtitles=`, not `drawtext` — see `buildWordHighlightSubtitlesFilter`'s own comment for
   *  why `wordHighlight` needs a wholly different filter to begin with. Unlike `buildTextFadeParams`,
   *  this needs no explicit "which instant does the ramp end at" branch: `\fad(t1,t2)` fades over the
   *  last `t2` ms of THIS EVENT's own [Start,End] window, always — so simply choosing whether the
   *  LAST event's own End extends past the clip's nominal end (`fadeOutSeconds` below) is already
   *  enough to land the ramp in the right place for both cases. */
  fadeIn?: number;
  fadeOut?: TextFadeOut;
}): string | null {
  const { content, style, clip, family, fontsizeScale, frameWidth, frameHeight, fadeIn, fadeOut } = params;
  const words = splitWords(content);
  if (words.length === 0) return null;

  const start = clip.timelineStart;
  const end = clipEnd(clip);
  const duration = clipDuration(clip);
  if (duration <= 0) return null;

  const variant = resolveFontVariant(fontById(style.fontFamily), style.bold, style.italic);
  const fontsize = Math.max(1, Math.round(style.fontSize * fontsizeScale));
  const baseColor = assColor(style.color);
  const highlightColor = assColor(clip.textAnimation?.highlightColor ?? DEFAULT_WORD_HIGHLIGHT_COLOR);
  const alignment = style.align === "left" ? 4 : style.align === "right" ? 6 : 5;
  const outline = style.strokeColor ? 2 : 0;
  const outlineColor = style.strokeColor ? assColor(style.strokeColor) : "&H00000000";
  const anchorX =
    style.align === "left"
      ? TEXT_MARGIN_PX + style.offsetX
      : style.align === "right"
        ? frameWidth - TEXT_MARGIN_PX + style.offsetX
        : frameWidth / 2 + style.offsetX;
  const anchorY = frameHeight / 2 + style.offsetY;

  const lines = content.split("\n");
  const speed = clip.textAnimation?.speed ?? 1;
  // Real per-word timing (`clip.wordTimings`, when present — see that field's own doc comment) makes
  // each word's own highlight window switch at the moment it's ACTUALLY spoken, instead of every word
  // getting an identical evenly-divided slice regardless of real speech pacing — exactly matching
  // `drawAnimatedTextFrame`'s own `wordBoundaries` call in the live canvas preview (`playback/
  // textLayout.ts`) and `khmerTextRenderer.ts`'s own export-window slicing. Before this fix, THIS path
  // (the non-Khmer libass export route) was the one renderer still doing its own independent
  // `duration / words.length` split, silently drifting from the preview for any caption with real
  // per-word timing — a genuine, reported preview/export mismatch, not a hypothetical. Dividing by
  // `speed` inverts the same `* speed` scaling `drawAnimatedTextFrame` applies to its own elapsed time
  // before this identical boundary lookup — see `khmerTextRenderer.ts`'s own comment on why.
  const boundaries = wordBoundaries(words.length, duration, clip.wordTimings).map((b) => b / speed);

  // Converted once, outside the loop — `\fad`'s own two args are milliseconds, unlike every other
  // time value in this function (which are libass `H:MM:SS.cc` timestamps via `assTimestamp`).
  const fadeInMs = fadeIn ? Math.round(fadeIn * 1000) : 0;
  const fadeOutMs = fadeOut ? Math.round(fadeOut.duration * 1000) : 0;
  // Only a REAL crossfade extends the last event's own End past the clip's nominal end — a solo
  // fade-out's End stays exactly at `end` (a plain cut's own boundary), which is what makes `\fad`'s
  // "over the last t2 ms of THIS event" own mechanic land the ramp at `[end-duration, end]` for free,
  // matching `PlaybackEngine`'s own solo-reveal timing with no extra math needed here.
  const fadeOutSeconds = fadeOut?.extendsPastEnd ? fadeOut.duration : 0;

  const events: string[] = [];
  for (let k = 0; k < words.length; k++) {
    const isLastWord = k === words.length - 1;
    // The FIRST word's own window always starts at the clip's real head (`start`), never at
    // `boundaries[0]` — `activeWordIndexFromBoundaries` (what the live preview and
    // `khmerTextRenderer.ts` both key off) never actually tests `boundaries[0]` itself, since word 0 is
    // already the loop's own starting index; a real first-word timestamp landing slightly after 0 must
    // not leave a gap with nothing highlighted at the clip's true start. Matches
    // `khmerTextRenderer.ts`'s own identical "forced to 0" rule for its export-window equivalent.
    const windowStart = k === 0 ? start : start + boundaries[k];
    // For a REAL crossfade (not just two independent fades that happen to meet at a hard cut), the
    // OUTGOING clip's own visible window has to genuinely OVERLAP the incoming clip's — otherwise this
    // clip finishes fading to invisible exactly AT its own nominal end, the instant the next clip's
    // fade-in begins, and there's never a moment both are simultaneously part-visible together. Mirrors
    // `buildTextFadeParams`'s own `enableEnd = fadeOut ? end + fadeOut : end` for the plain-drawtext
    // path exactly — the LAST event's own End extends `fadeOutMs` past the clip's nominal `end`, so
    // `\fad`'s fade-out ramp (which ends exactly AT this event's End) lands on the SAME instant the next
    // clip's own fade-in ramp finishes, not `fadeOut` seconds before it. The fade-IN side needs no
    // matching shift on `windowStart` — `buildTextFadeParams` doesn't shift its own `enableStart`
    // either; the incoming clip simply starts ramping at its normal `start`, and the OVERLAP is created
    // entirely by the outgoing clip reaching forward past its own boundary, not by the incoming one
    // reaching back before its own.
    const windowEnd = isLastWord ? end + fadeOutSeconds : start + boundaries[k + 1];
    // `\fad(t1,t2)` fades relative to THIS EVENT's own Start/End, not the clip's — applying it to
    // every per-word event would fade each word in/out individually as the highlight moves along,
    // not fade the text BLOCK in once at the clip's head and out once at its tail. Only the FIRST
    // event (fade-in) and the LAST event (fade-out) get a nonzero term; a single-word clip is both at
    // once, correctly getting `\fad(fadeInMs,fadeOutMs)` on its one event.
    const isFirst = k === 0;
    const isLast = k === words.length - 1;
    const fadeTag = (isFirst && fadeInMs) || (isLast && fadeOutMs) ? `{\\fad(${isFirst ? fadeInMs : 0},${isLast ? fadeOutMs : 0})}` : "";

    const textParts: string[] = [];
    let wIndex = 0;
    for (const line of lines) {
      // `segmentLine` (not a plain `.split(/\s+/)`) is what makes this correct for Khmer and every
      // other script that doesn't space words at all — see its own comment in
      // `timeline/textAnimation.ts`. Walking EVERY segment (not just the word-like ones) and re-
      // emitting non-word text verbatim preserves the line's own original spacing/punctuation exactly,
      // rather than collapsing it down to single ASCII spaces the way `.join(" ")` used to.
      const rendered = segmentLine(line).map((segment) => {
        if (!segment.isWord) return assEscapeRun(segment.text);
        const isActive = wIndex === k;
        wIndex++;
        return `{\\c${isActive ? highlightColor : baseColor}&}${assEscapeRun(segment.text)}`;
      });
      textParts.push(rendered.join(""));
    }
    // The comma inside `\pos(...)` is the OVERRIDE TAG's own argument separator, not a Dialogue-line
    // CSV field separator — it must NOT be backslash-escaped, unlike this file's pervasive FFmpeg-
    // expression convention (`between(t\,x\,y)`) that an escaped comma here was apparently copied from.
    // Confirmed empirically against the real bundled libass: an escaped `\,` here makes `\pos` fail to
    // parse silently (no error, no warning), falling back to the Style's own default MarginL/Alignment-
    // based placement instead — exactly the "position is different after export" symptom this fixes.
    // `\fad(...)` just below already uses a plain comma correctly; this now matches it.
    const text = fadeTag + `{\\pos(${n2(anchorX)},${n2(anchorY)})}` + textParts.join("\\N");

    events.push(
      `Dialogue: 0,${assTimestamp(windowStart)},${assTimestamp(windowEnd)},Default,,0,0,0,,${text}`
    );
  }

  const header =
    `[Script Info]\nScriptType: v4.00+\nPlayResX: ${frameWidth}\nPlayResY: ${frameHeight}\nScaledBorderAndShadow: yes\n\n` +
    `[V4+ Styles]\n` +
    `Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding\n` +
    `Style: Default,${family},${fontsize},${baseColor},${baseColor},${outlineColor},&H00000000,${variant.bold ? -1 : 0},${variant.italic ? -1 : 0},0,0,100,100,0,0,1,${outline},0,${alignment},10,10,10,1\n\n` +
    `[Events]\n` +
    `Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text\n`;

  return header + events.join("\n") + "\n";
}

/** Same rounding as `n()` below, but for a value going into an ASS override tag rather than an FFmpeg
 *  filter expression — kept as its own tiny function (not a shared export) since `n()` isn't declared
 *  until later in this file and ASS values don't need `n()`'s six-decimal precision (ASS positions are
 *  already sub-pixel-meaningless at one decimal place). */
function n2(value: number): string {
  return value.toFixed(2);
}

/** `wordHighlight`'s export path — routes through FFmpeg's `subtitles=` (libass) filter instead of
 *  `drawtext`, the one animation type that fundamentally can't be expressed as a single `drawtext` call
 *  no matter how the `x`/`y`/`fontsize` expressions are shaped. The core problem: coloring one WORD
 *  within a longer string needs either (a) knowing that word's exact pixel x-offset to draw it as a
 *  separate, precisely-positioned `drawtext` call, or (b) a renderer with native per-run color support.
 *  FFmpeg's expression language has no way to feed one `drawtext` call's measured `text_w` into ANOTHER
 *  call's `x=` expression — confirmed by re-deriving the filtergraph's actual data-flow model, not
 *  assumed — so (a) would require this module to compute glyph advance widths itself, which is exactly
 *  where it stops being safe: this app is Khmer-first, and Khmer's complex shaping (subscript
 *  consonants, vowel-sign reordering) is NOT correctly reproduced by summing simple per-character
 *  advance widths — only a real shaping engine (HarfBuzz) gets it right. libass already links HarfBuzz/
 *  FreeType/FriBidi (confirmed in the bundled FFmpeg build), so (b) reuses the SAME shaping engine
 *  `drawtext` itself uses, just accessed through the `subtitles=` filter instead, and it's correct for
 *  Khmer by construction rather than by additional effort.
 *
 *  Returns `null` (caller falls back to plain `drawtext`) when the font's metrics couldn't be resolved,
 *  or when `buildWordHighlightAss` itself returns `null` (empty content, non-positive duration) — both
 *  genuinely "nothing sensible to render here" cases, not errors. */
function buildWordHighlightSubtitlesFilter(params: {
  inputLabel: string;
  outputLabel: string;
  content: string;
  style: TextStyle;
  clip: Clip;
  frameWidth: number;
  frameHeight: number;
  assFilePathFor: (clip: Clip, assContent: string) => string;
  fontMetricsFor: (font: FontDefinition) => AssFontMetrics | null;
  fontsDirFor: () => string;
  /** Threaded straight through to `buildWordHighlightAss` — see its own doc comment. */
  fadeIn?: number;
  fadeOut?: TextFadeOut;
}): string[] | null {
  const { inputLabel, outputLabel, content, style, clip, frameWidth, frameHeight, assFilePathFor, fontMetricsFor, fontsDirFor, fadeIn, fadeOut } = params;
  const font = fontById(style.fontFamily);
  const metrics = fontMetricsFor(font);
  if (!metrics) return null;

  const assContent = buildWordHighlightAss({
    content,
    style,
    clip,
    family: metrics.family,
    fontsizeScale: metrics.fontsizeScale,
    frameWidth,
    frameHeight,
    fadeIn,
    fadeOut,
  });
  if (!assContent) return null;

  const assPath = ffmpegPath(assFilePathFor(clip, assContent));
  const fontsDir = ffmpegPath(fontsDirFor());
  return [`${inputLabel}subtitles=${assPath}:fontsdir=${fontsDir}[${outputLabel}]`];
}

/** How many chained `drawtext` calls `buildTypewriterDrawTextCalls` will build for one clip, at most —
 *  one call per character of `content`. An ordinary caption is nowhere near this long; a text clip that
 *  somehow is (a pasted paragraph) degrading to a plain, static, un-animated `drawtext` is a far better
 *  failure mode than a filter graph with thousands of chained nodes. Exported so `nativeExport.ts` can
 *  pre-write the exact same set of per-character text file variants this module will ask for — see its
 *  own `collectTextClips` comment on why that enumeration has to be duplicated rather than shared. */
export const MAX_TYPEWRITER_STEPS = 240;

/** One `drawtext=...` filter body (no `[input]`/`[output]` labels — callers wrap those) — the piece
 *  `buildDrawTextFilter`'s single call and `buildTypewriterDrawTextCalls`'s N chained calls both need,
 *  factored out so the two can never drift on the option list `drawtext` actually takes. */
function drawTextFilterBody(params: {
  fontFile: string;
  textFile: string;
  fontSizeExpr: string;
  color: string;
  styleParams: string;
  lineSpacing: string;
  x: string;
  y: string;
  alphaParam: string;
  enableStart: number;
  enableEnd: number;
}): string {
  const { fontFile, textFile, fontSizeExpr, color, styleParams, lineSpacing, x, y, alphaParam, enableStart, enableEnd } = params;
  return (
    `drawtext=fontfile=${fontFile}:textfile=${textFile}:fontsize=${fontSizeExpr}:` +
    `fontcolor=${color}${styleParams}:line_spacing=${lineSpacing}:x=${x}:y=${y}${alphaParam}:` +
    `enable='between(t\\,${t(enableStart)}\\,${t(enableEnd)})'`
  );
}

/** `typewriter`'s export equivalent of `typewriterVisibleContent` (`../timeline/textAnimation.ts`) —
 *  FFmpeg's `drawtext` has no notion of "reveal one more character every frame" within a single call,
 *  so this instead chains one `drawtext` per distinct visible-prefix state (`content.slice(0, k)` for
 *  `k` = 1..N), each gated to its own `enable=` window on the SAME clock `typewriterVisibleContent`
 *  uses (`TYPEWRITER_CHARS_PER_SECOND`, scaled by the clip's own animation `speed`) — the final, full-
 *  content call's window extends all the way to `enableEnd` so the clip settles on showing everything
 *  for its remaining duration, matching the preview's own clamp. Position/size never move (only the
 *  revealed prefix changes), so every step reuses the same `x`/`y`/`fontSizeExpr` the caller already
 *  resolved. Every step shares one `alphaParam` (built once, against the whole CLIP's fade window, not
 *  any one step's) since it's already a pure function of absolute `t` — correct regardless of which
 *  step happens to be the active one when a fade is in progress. */
function buildTypewriterDrawTextCalls(params: {
  inputLabel: string;
  outputLabel: string;
  content: string;
  fontFile: string;
  fontSizeExpr: string;
  color: string;
  styleParams: string;
  lineSpacing: string;
  x: string;
  y: string;
  clip: Clip;
  speed: number;
  alphaParam: string;
  enableEnd: number;
  textFilePathFor: ExportPlanOptions["textFilePathFor"];
}): string[] {
  const {
    inputLabel,
    outputLabel,
    content,
    fontFile,
    fontSizeExpr,
    color,
    styleParams,
    lineSpacing,
    x,
    y,
    clip,
    speed,
    alphaParam,
    enableEnd,
    textFilePathFor,
  } = params;
  const start = clip.timelineStart;
  const charDuration = 1 / (TYPEWRITER_CHARS_PER_SECOND * speed);
  const stepCount = content.length;

  const calls: string[] = [];
  let currentInput = inputLabel;
  for (let k = 1; k <= stepCount; k++) {
    const isLast = k === stepCount;
    const stepLabel = isLast ? outputLabel : `${outputLabel}_tw${k}`;
    const stepStart = start + (k - 1) * charDuration;
    const stepEnd = isLast ? enableEnd : start + k * charDuration;
    const textFile = ffmpegPath(textFilePathFor(clip, content.slice(0, k), `tw${k}`));
    const body = drawTextFilterBody({
      fontFile,
      textFile,
      fontSizeExpr,
      color,
      styleParams,
      lineSpacing,
      x,
      y,
      alphaParam,
      enableStart: stepStart,
      enableEnd: stepEnd,
    });
    calls.push(`${currentInput}${body}[${stepLabel}]`);
    currentInput = `[${stepLabel}]`;
  }
  return calls;
}

/** One text clip's `drawtext`, chained onto whatever the video layer built (`inputLabel`) — see
 *  `trackKindForAsset`'s own comment on why this, not a true overlay-based multi-layer composite, is
 *  what makes "text over video" tractable at all given a single-video-track export. `drawtext` draws
 *  directly onto its input stream, so stacking N of these in sequence (one per active text clip) is
 *  all "compositing" text over video actually requires here — no alpha blending step needed.
 *
 *  `enable='between(t,start,end)'` is what confines the text to its own clip's timeline window on the
 *  SAME absolute clock the concatenated `[cv]` stream already runs on (concat's own `setpts=PTS-
 *  STARTPTS` per segment is what keeps that clock starting at 0 and matching the sequence exactly).
 *
 *  Positioning mirrors `PlaybackEngine.drawText` exactly (same margin/anchor logic, see
 *  `textLayout.ts`'s own doc comment on the one approximation both renderers deliberately share for
 *  multi-line center/right alignment) — just expressed as an FFmpeg formula instead of a JS number,
 *  since `text_w`/`text_h` only exist once FreeType has actually shaped these exact glyphs.
 *
 *  `clip.textAnimation` (when set) adds a time-varying term on top of that same base formula — `bounce`
 *  into `y` (a `-abs(sin(...))` hop, identical shape to `computeTextAnimationTransform`'s own `dy`) and
 *  `pulse` into `fontsize` (a `sin(...)`-modulated scale) — both proven, against the real bundled FFmpeg
 *  binary, to re-center correctly on their own since `x`/`y` here are already `text_w`/`text_h`-relative
 *  expressions FFmpeg re-evaluates every frame (see this feature's own empirical notes). `typewriter`
 *  branches out entirely into `buildTypewriterDrawTextCalls` (a genuinely different shape — many calls,
 *  not one modified call). `wiggle` needs the ROTATED path instead (`buildRotatedDrawTextFilter`) since
 *  it animates rotation, not position/size — the caller picks between the two based on
 *  `style.rotationDeg`/`animation.type`, same as it already did for a plain static rotation. `bounce`/
 *  `pulse` combined with a nonzero STATIC `style.rotationDeg` is a deliberate, documented scope cut (see
 *  the caller): that combination renders as a plain static rotated clip, animation ignored — a real
 *  filter-graph limitation (this path's `text_w`-relative centering and the rotated path's frame-center
 *  pivot are mutually exclusive constructions), not an oversight. `wordHighlight` has no export
 *  equivalent at all (no per-word color/position within one `drawtext` call, and no way to learn a
 *  word's pixel offset server-side without a new font-metrics dependency) and always renders as plain
 *  static full-text, same as before this feature existed. */
/** The static font/position/style geometry `buildDrawTextFilter` needs — extracted so a keyframed
 *  clip's per-slice renderer (`buildKeyframedDrawTextCalls`) can call this once per slice with that
 *  slice's own `resolveTextStyle`-resolved `TextStyle`, instead of duplicating this math. Pure function
 *  of `style` alone — never touches `clip`/time, which is exactly why it's safe to call once per slice
 *  with a different `style` each time. */
function buildDrawTextGeometry(
  style: TextStyle,
  fontPathFor: ExportPlanOptions["fontPathFor"],
  textAlignSupported = true,
): { fontFile: string; x: string; y: string; fontSizeExpr: string; color: string; styleParams: string; lineSpacing: string } {
  const font = fontById(style.fontFamily);
  const fontFile = ffmpegPath(fontPathFor(fontFileFor(font, style.bold, style.italic)));

  // The block's own on-screen position depends ONLY on `offsetX` — the frame's center, nudged by the
  // user's own drag/offset — never on `align`, matching `textLayout.ts`'s own `anchorX` fix (see its
  // top-of-file comment): re-justifying a text box's lines must not teleport the box itself. `align`
  // now only drives `text_align=` (`buildDrawTextStyleParams`), which handles per-LINE justification
  // within this frame-centered block natively — the same job `textLayout.ts`'s own `lineX` does for
  // preview.
  const anchorX = `(w/2)+${n(style.offsetX)}`;
  const x = `(${anchorX})-text_w/2`;
  const y = `(h/2)+${n(style.offsetY)}-text_h/2`;

  const styleParams = buildDrawTextStyleParams(style, textAlignSupported);
  // FFmpeg's `line_spacing` is EXTRA pixels added between lines on top of the font's own natural line
  // height, unlike the multiplier `style.lineHeightMultiplier` applies wholesale in the canvas preview
  // — this converts one convention to the other; see `textLayout.ts` for why exact agreement isn't the
  // bar for text the way it is for video.
  const lineSpacing = n(style.fontSize * (style.lineHeightMultiplier - 1));
  const color = ffmpegColor(style.color);
  const fontSizeExpr = n(style.fontSize);

  return { fontFile, x, y, fontSizeExpr, color, styleParams, lineSpacing };
}

/** Folds `bounce`/`pulse` onto an already-built `y`/`fontSizeExpr` pair — extracted so
 *  `buildKeyframedDrawTextCalls` can apply the SAME animation formula once per slice. Depends only on
 *  `clip.textAnimation`/`clip.timelineStart` (never on `style`), which is exactly why this composes for
 *  free with per-slice re-rendering: every animation term here is anchored to absolute timeline
 *  seconds, not to a per-call local clock, so calling this once per slice — each slice just gating WHEN
 *  its own copy of the always-correctly-phased expression is visible — produces continuous,
 *  uninterrupted motion across slice boundaries with zero change to the formula itself. */
function applyTextMotionAnimation(clip: Clip, y: string, fontSizeExpr: string): { y: string; fontSizeExpr: string } {
  const animation = clip.textAnimation;
  const speed = animation?.speed ?? 1;
  const start = clip.timelineStart;
  if (animation?.type === "bounce") {
    const dyExpr = `-abs(sin(2*PI*((t-${t(start)})*${n(speed)})/${n(BOUNCE_PERIOD_SECONDS)}))*${n(BOUNCE_AMPLITUDE_PX)}`;
    return { y: `${y}${dyExpr}`, fontSizeExpr };
  }
  if (animation?.type === "pulse") {
    const scaleExpr = `(1+sin(2*PI*((t-${t(start)})*${n(speed)})/${n(PULSE_PERIOD_SECONDS)})*${n(PULSE_AMPLITUDE)})`;
    return { y, fontSizeExpr: `'${fontSizeExpr}*${scaleExpr}'` };
  }
  return { y, fontSizeExpr };
}

function buildDrawTextFilter(params: {
  inputLabel: string;
  outputLabel: string;
  content: string;
  style: TextStyle;
  clip: Clip;
  fontPathFor: ExportPlanOptions["fontPathFor"];
  drawtextTextAlign?: boolean;
  textFilePathFor: ExportPlanOptions["textFilePathFor"];
  fadeIn?: number;
  fadeOut?: TextFadeOut;
}): string[] {
  const { inputLabel, outputLabel, content, style, clip, fontPathFor, textFilePathFor, fadeIn, fadeOut } = params;
  const geo = buildDrawTextGeometry(style, fontPathFor, params.drawtextTextAlign);
  const { enableEnd, alphaParam } = buildTextFadeParams(clip, fadeIn, fadeOut);
  const start = clip.timelineStart;
  const animation = clip.textAnimation;
  const speed = animation?.speed ?? 1;

  if (animation?.type === "typewriter" && content.length > 0 && content.length <= MAX_TYPEWRITER_STEPS) {
    return buildTypewriterDrawTextCalls({
      inputLabel,
      outputLabel,
      content,
      fontFile: geo.fontFile,
      fontSizeExpr: geo.fontSizeExpr,
      color: geo.color,
      styleParams: geo.styleParams,
      lineSpacing: geo.lineSpacing,
      x: geo.x,
      y: geo.y,
      clip,
      speed,
      alphaParam,
      enableEnd,
      textFilePathFor,
    });
  }

  const { y: yExpr, fontSizeExpr } = applyTextMotionAnimation(clip, geo.y, geo.fontSizeExpr);

  const textFile = ffmpegPath(textFilePathFor(clip, content));
  const body = drawTextFilterBody({
    fontFile: geo.fontFile,
    textFile,
    fontSizeExpr,
    color: geo.color,
    styleParams: geo.styleParams,
    lineSpacing: geo.lineSpacing,
    x: geo.x,
    y: yExpr,
    alphaParam,
    enableStart: start,
    enableEnd,
  });
  return [`${inputLabel}${body}[${outputLabel}]`];
}

/** Text clips whose `textStyleKeyframes` is armed slice into short static per-slice renders — same
 *  "many cheap static frames instead of one continuously-varying expression" strategy video's own
 *  Transform/Effects/ColorGrading keyframes already use, but shaped like `buildTypewriterDrawTextCalls`
 *  above (N chained `drawtext` calls onto the already-continuous stream, no `concat=`, no extra source
 *  inputs) rather than video's own `concat=`-based slicing — text has no source media to re-cut, so
 *  there's no independent PTS clock per slice to stitch back together the way video's slicing needs to.
 *  One shared `alphaParam`/`enableEnd` (computed once, exactly like `buildTypewriterDrawTextCalls`'s own
 *  `alphaParam` — see its doc comment) is reused verbatim by every slice; only each slice's own
 *  `enable` WINDOW and `resolveTextStyle`-resolved geometry differ. `content`/`textFile` never vary
 *  with `textStyleKeyframes` (only style/position do), so `textFilePathFor` is called exactly ONCE for
 *  the whole clip — the same `(clip, content)` key every plain (non-typewriter, non-keyframed) clip
 *  already uses, which is load-bearing: `nativeExport.ts`'s `collectTextClips` only pre-writes THAT
 *  variant for a keyframed clip (it only special-cases `typewriter`), so calling this with any other
 *  key would throw on native export. */
function buildKeyframedDrawTextCalls(params: {
  inputLabel: string;
  outputLabel: string;
  content: string;
  baseStyle: TextStyle;
  clip: Clip;
  fontPathFor: ExportPlanOptions["fontPathFor"];
  drawtextTextAlign?: boolean;
  textFilePathFor: ExportPlanOptions["textFilePathFor"];
  fadeIn?: number;
  fadeOut?: TextFadeOut;
  fps: number;
}): string[] {
  const { inputLabel, outputLabel, content, baseStyle, clip, fontPathFor, textFilePathFor, fadeIn, fadeOut, fps } = params;
  const { enableEnd, alphaParam } = buildTextFadeParams(clip, fadeIn, fadeOut);
  const textFile = ffmpegPath(textFilePathFor(clip, content));
  const slices = computeTextStyleKeyframeSlices(clip, baseStyle, fps);

  const calls: string[] = [];
  let currentInput = inputLabel;
  slices.forEach((slice, i) => {
    const isLast = i === slices.length - 1;
    const stepLabel = isLast ? outputLabel : `${outputLabel}_kf${i}`;
    const geo = buildDrawTextGeometry(slice.style, fontPathFor, params.drawtextTextAlign);
    const { y, fontSizeExpr } = applyTextMotionAnimation(clip, geo.y, geo.fontSizeExpr);
    // Last slice's own window extends to the real fade-adjusted `enableEnd` (not clipped to its own
    // nominal boundary) — matches how the un-sliced path's one-and-only call already extends past the
    // clip's nominal end for a fade-out, and how `buildTypewriterDrawTextCalls`'s own last step does
    // the same for its own last character.
    const body = drawTextFilterBody({
      fontFile: geo.fontFile,
      textFile,
      fontSizeExpr,
      color: geo.color,
      styleParams: geo.styleParams,
      lineSpacing: geo.lineSpacing,
      x: geo.x,
      y,
      alphaParam,
      enableStart: clip.timelineStart + slice.offset,
      enableEnd: isLast ? enableEnd : clip.timelineStart + slice.offset + slice.duration,
    });
    calls.push(`${currentInput}${body}[${stepLabel}]`);
    currentInput = `[${stepLabel}]`;
  });
  return calls;
}

/** The rotated-text equivalent of `buildDrawTextFilter` above, used only when `style.rotationDeg` is
 *  nonzero (see `isIdentityTransform`'s sibling reasoning: the plain, already-tested `drawtext`-onto-
 *  `[cv]` chain handles the unrotated case and stays untouched by this).
 *
 *  FFmpeg's `rotate` filter can only spin a buffer around ITS OWN geometric center — there's no
 *  parameter for an arbitrary pivot, and (the actual constraint that shapes everything below) no
 *  sibling filter can see `text_w`/`text_h` — those only exist inside the ONE `drawtext` call that
 *  computed them from the actual shaped glyphs. So the text's true visual center for `align: "left"`/
 *  `"right"` is fundamentally unknowable outside that one filter, and the pivot this uses is the
 *  SEQUENCE FRAME's own center instead — see `PlaybackEngine.drawText`'s matching comment for why that
 *  (not the text's own center) is the one pivot both renderers can compute identically. For
 *  `align: "center"` (the default) the two coincide exactly, so nothing is actually approximated there.
 *
 *  The construction:
 *   1. Draw the text at its NATURAL align-anchored position (same `x`/`y` formula `buildDrawTextFilter`
 *      uses, just with `offsetX`/`offsetY` left OUT) within a background buffer the size of the whole
 *      sequence frame — so the buffer's own center is the FRAME's center, not the text's.
 *   2. `rotate` that whole buffer around ITS OWN (= the frame's) center. `ow=rotw(a):oh=roth(a)` has
 *      FFmpeg itself compute the exact bounding box a WxH buffer needs once rotated by angle `a` — the
 *      same macro `buildTransformFilters` already relies on for clip rotation.
 *   3. `overlay` the rotated buffer onto the video built so far, offset by `offsetX/offsetY` — applying
 *      the offset AFTER rotation, never before (baking it into step 1's position instead would rotate
 *      the text around a point that itself moves with the offset, making it orbit rather than spin in
 *      place — see `PlaybackEngine.drawText` for the identical two-stage `translate`+`rotate`+
 *      `translate` this mirrors).
 *
 *  `format=rgba` before `rotate` is what makes its `black@0` fill genuinely transparent padding — same
 *  reasoning as `buildTransformFilters`'s identical comment. The background buffer spans the FULL
 *  sequence duration (not just the clip's own) so its PTS stays trivially aligned with `[cv]`'s from
 *  frame 0 with no explicit sync step needed; `enable=` on both `drawtext` and the final `overlay`
 *  confines the actual visible window to the clip's own, same as the unrotated path. Empirically
 *  verified against the real bundled FFmpeg binary before being wired in here (see this feature's own
 *  development notes).
 *
 *  `clip.textAnimation?.type === "wiggle"` layers a time-varying term onto `style.rotationDeg` in the
 *  `a=` (angle) expression — the same `sin(...)` shape `computeTextAnimationTransform`'s own
 *  `rotationDeg` uses. `rotate`'s `ow=`/`oh=` (the buffer FFmpeg allocates to hold the rotated result)
 *  are evaluated ONCE at filter-graph configuration time, before `t` exists, so they can never
 *  themselves reference `t` (confirmed empirically: a `t`-dependent `oh=roth(...)` fails outright with
 *  "non-positive or indefinite value nan") — `maxAngleExpr` sizes that buffer for the worst case
 *  (`|style.rotationDeg| + WIGGLE_AMPLITUDE_DEG`) instead, a fixed constant, while only `a=` itself
 *  varies with time. For every clip that ISN'T wiggling, `maxAngleExpr` reduces to the same fixed value
 *  `a=` already uses, so a plain static rotation renders byte-identically to before this animation
 *  branch existed. */
/** The rotated-path's own static geometry — `buildRotatedDrawTextGeometry`'s counterpart to
 *  `buildDrawTextGeometry` above, extracted for the identical reason (per-slice reuse from
 *  `buildKeyframedRotatedDrawTextCalls`). Pure function of `style` alone. */
function buildRotatedDrawTextGeometry(
  style: TextStyle,
  fontPathFor: ExportPlanOptions["fontPathFor"],
  textAlignSupported = true,
): { fontFile: string; x: string; y: string; color: string; styleParams: string; lineSpacing: string } {
  const font = fontById(style.fontFamily);
  const fontFile = ffmpegPath(fontPathFor(fontFileFor(font, style.bold, style.italic)));

  // Centered within the background buffer's OWN w/h (== the full sequence frame), not the final
  // on-screen position — offset is applied later, at the overlay step, after rotation. Never
  // align-dependent, same fix and reasoning as `buildDrawTextGeometry` above — `align` only drives
  // `text_align=` now, not which edge the block itself anchors to.
  const x = `(w/2)-text_w/2`;
  const y = `(h/2)-text_h/2`;

  const styleParams = buildDrawTextStyleParams(style, textAlignSupported);
  const lineSpacing = n(style.fontSize * (style.lineHeightMultiplier - 1));
  const color = ffmpegColor(style.color);

  return { fontFile, x, y, color, styleParams, lineSpacing };
}

/** `angle`/`maxAngle` for the rotated path's `rotate=` filter — extracted so
 *  `buildKeyframedRotatedDrawTextCalls` can call this once per slice with that slice's own
 *  `rotationDeg` (a real possibility: `rotationDeg` is one of `lerpTextStyle`'s interpolated numeric
 *  fields, so it can legitimately differ from slice to slice for a keyframed clip). Depends on
 *  `clip.textAnimation`/`clip.timelineStart` for the wiggle term (absolute-timeline-anchored, same
 *  "composes for free per-slice" reasoning as `applyTextMotionAnimation`) and on `style.rotationDeg`
 *  for the static base angle. */
function computeWiggleRotationAngle(clip: Clip, style: TextStyle): { angle: string; maxAngle: string } {
  const animation = clip.textAnimation;
  const isWiggle = animation?.type === "wiggle";
  const speed = animation?.speed ?? 1;
  const staticDeg = n(style.rotationDeg);
  const angle = isWiggle
    ? `(${staticDeg}+sin(2*PI*((t-${t(clip.timelineStart)})*${n(speed)})/${n(WIGGLE_PERIOD_SECONDS)})*${n(WIGGLE_AMPLITUDE_DEG)})*PI/180`
    : `${staticDeg}*PI/180`;
  const maxAngleDeg = Math.abs(style.rotationDeg) + (isWiggle ? WIGGLE_AMPLITUDE_DEG : 0);
  const maxAngle = `${n(maxAngleDeg)}*PI/180`;
  return { angle, maxAngle };
}

function buildRotatedDrawTextFilter(params: {
  inputLabel: string;
  bgIndex: number;
  outputLabel: string;
  content: string;
  style: TextStyle;
  clip: Clip;
  fontPathFor: ExportPlanOptions["fontPathFor"];
  drawtextTextAlign?: boolean;
  textFilePathFor: ExportPlanOptions["textFilePathFor"];
  fadeIn?: number;
  fadeOut?: TextFadeOut;
}): string[] {
  const { inputLabel, bgIndex, outputLabel, content, style, clip, fontPathFor, textFilePathFor, fadeIn, fadeOut } = params;
  const geo = buildRotatedDrawTextGeometry(style, fontPathFor, params.drawtextTextAlign);
  const textFile = ffmpegPath(textFilePathFor(clip, content));

  // Same fade/extended-window logic `buildDrawTextFilter` uses — see `buildTextFadeParams`'s own
  // comment. The extended `enable` window applies to BOTH steps below (the `drawtext` and the final
  // `overlay`): the alpha ramp itself only needs to apply to the `drawtext` call (rotate/overlay both
  // just carry the alpha CHANNEL it already wrote through unchanged), but the overlay's own `enable`
  // still has to stay in sync or it would cut the fade off early.
  const { enableEnd, alphaParam } = buildTextFadeParams(clip, fadeIn, fadeOut);
  const enable = `enable='between(t\\,${t(clip.timelineStart)}\\,${t(enableEnd)})'`;

  const { angle, maxAngle } = computeWiggleRotationAngle(clip, style);

  const drawnLabel = `${outputLabel}_drawn`;
  const rotLabel = `${outputLabel}_rot`;

  return [
    `[${bgIndex}:v]drawtext=fontfile=${geo.fontFile}:textfile=${textFile}:fontsize=${n(style.fontSize)}:` +
      `fontcolor=${geo.color}${geo.styleParams}:line_spacing=${geo.lineSpacing}:x=${geo.x}:y=${geo.y}${alphaParam}:${enable}[${drawnLabel}]`,
    `[${drawnLabel}]format=rgba,rotate=a=${angle}:ow=rotw(${maxAngle}):oh=roth(${maxAngle}):c=black@0[${rotLabel}]`,
    `${inputLabel}[${rotLabel}]overlay=x='(W-w)/2+${n(style.offsetX)}':y='(H-h)/2+${n(style.offsetY)}':` +
      `format=auto:${enable}[${outputLabel}]`,
  ];
}

/** `buildKeyframedDrawTextCalls`'s own counterpart for the rotated path — one chained `drawtext`→
 *  `rotate`→`overlay` triple per slice, all sharing the SAME already-pushed `bgIndex` background input
 *  (FFmpeg allows one numbered input to be referenced by multiple filter chains without an explicit
 *  `split`), each slice's own triple gated by its own `enable` window and using that slice's own
 *  `resolveTextStyle`-resolved geometry/rotation angle. The final slice's own `overlay` output IS
 *  `outputLabel` — same chaining shape `buildKeyframedDrawTextCalls` uses. */
function buildKeyframedRotatedDrawTextCalls(params: {
  inputLabel: string;
  bgIndex: number;
  outputLabel: string;
  content: string;
  baseStyle: TextStyle;
  clip: Clip;
  fontPathFor: ExportPlanOptions["fontPathFor"];
  drawtextTextAlign?: boolean;
  textFilePathFor: ExportPlanOptions["textFilePathFor"];
  fadeIn?: number;
  fadeOut?: TextFadeOut;
  fps: number;
}): string[] {
  const { inputLabel, bgIndex, outputLabel, content, baseStyle, clip, fontPathFor, textFilePathFor, fadeIn, fadeOut, fps } = params;
  const textFile = ffmpegPath(textFilePathFor(clip, content));
  const { enableEnd, alphaParam } = buildTextFadeParams(clip, fadeIn, fadeOut);
  const slices = computeTextStyleKeyframeSlices(clip, baseStyle, fps);

  const filters: string[] = [];
  let currentInput = inputLabel;
  slices.forEach((slice, i) => {
    const isLast = i === slices.length - 1;
    const stepOutputLabel = isLast ? outputLabel : `${outputLabel}_kf${i}`;
    const sliceStart = clip.timelineStart + slice.offset;
    const sliceEnd = isLast ? enableEnd : clip.timelineStart + slice.offset + slice.duration;
    const enable = `enable='between(t\\,${t(sliceStart)}\\,${t(sliceEnd)})'`;

    const geo = buildRotatedDrawTextGeometry(slice.style, fontPathFor, params.drawtextTextAlign);
    const { angle, maxAngle } = computeWiggleRotationAngle(clip, slice.style);

    const drawnLabel = `${outputLabel}_kf${i}_drawn`;
    const rotLabel = `${outputLabel}_kf${i}_rot`;

    filters.push(
      `[${bgIndex}:v]drawtext=fontfile=${geo.fontFile}:textfile=${textFile}:fontsize=${n(slice.style.fontSize)}:` +
        `fontcolor=${geo.color}${geo.styleParams}:line_spacing=${geo.lineSpacing}:x=${geo.x}:y=${geo.y}${alphaParam}:${enable}[${drawnLabel}]`
    );
    filters.push(`[${drawnLabel}]format=rgba,rotate=a=${angle}:ow=rotw(${maxAngle}):oh=roth(${maxAngle}):c=black@0[${rotLabel}]`);
    filters.push(
      `${currentInput}[${rotLabel}]overlay=x='(W-w)/2+${n(slice.style.offsetX)}':y='(H-h)/2+${n(slice.style.offsetY)}':` +
        `format=auto:${enable}[${stepOutputLabel}]`
    );
    currentInput = `[${stepOutputLabel}]`;
  });
  return filters;
}

/** `sequenceDuration`'s own per-clip formula (`timelineStart + clipDuration`) has no notion of a text
 *  clip's own REAL crossfade into whatever clip follows it EXTENDING its visible window past its own
 *  nominal end — see `TextFadeOut`'s own doc comment for why that extension is deliberate for a
 *  genuine overlap (and why a SOLO fade-out, by contrast, deliberately does NOT extend past its own
 *  end — so it needs no entry here at all, only `fadeOutByClipId`-sourced crossfades do). Confirmed
 *  live: without this, a text clip's own crossfade silently never became visible at all whenever
 *  nothing else in the project happened to run past its own nominal end — the exported video simply
 *  ENDED mid-ramp, at full opacity, before the fade window even started. This was the "the out
 *  transition isn't applied after export" bug — the fade math itself was always correct, the video was
 *  just too SHORT to ever reach it. Video/image clips need no equivalent: their own
 *  `fade=t=out:st=${sliceDuration - fadeOut}` (`pushClipVideoFilters`) fades out WITHIN the clip's
 *  already-existing duration, never past it — this extension is a text-crossfade-only concern.
 *
 *  Mirrors the main text-track loop's own `fadeOutByClipId` precompute (same `findTransitionPartner`
 *  call) purely to find the LATEST point any text clip's own crossfade could still be visible — a
 *  cheap, side-effect-free duplicate of that lookup, not a second copy of the actual filter-building
 *  logic, and safe to run before any of it (`findTransitionPartner` only ever reads clip/track data).
 *  Returns 0 (no extension) when no text clip has a real crossfade at all — every project that never
 *  uses this feature computes the exact same duration as before it existed. */
function computeTextFadeOutExtendedDuration(project: Project): number {
  let maxEnd = 0;
  for (const track of project.sequence.tracks) {
    if (track.kind !== "text") continue;
    const fadeOutByClipId = new Map<string, number>();
    for (const clip of track.clips) {
      const transition = findTransitionPartner(track, clip);
      if (transition?.partner) fadeOutByClipId.set(transition.partner.id, transition.duration);
    }
    for (const clip of track.clips) {
      const fadeOut = fadeOutByClipId.get(clip.id);
      if (fadeOut) maxEnd = Math.max(maxEnd, clipEnd(clip) + fadeOut);
    }
  }
  return maxEnd;
}

export function buildExportPlan(project: Project, options: ExportPlanOptions): ExportPlan {
  const needsFaceEffectPreprocessing = project.sequence.tracks.some((track) =>
    track.kind === "video" && track.visible && track.clips.some((clip) =>
      clip.faceEffects?.some((effect) => effect.enabled !== false && effect.intensity > 0)
    )
  );
  if (needsFaceEffectPreprocessing && !options.faceEffectInputPathFor) {
    throw new ExportError("This project uses Face Effects, but the Face Effects export provider is not configured.");
  }
  const { fps, crf, audioBitrateKbps } = project.exportSettings;
  // Every position/crop/offset in this whole file (`TEXT_MARGIN_PX`, `TextCrop` fractions, `ClipTransform`
  // pixel offsets, drawtext `x=`/`y=`, wordHighlight's ASS geometry, transition wipe/slide/circle
  // directions — all of it) is authored by a user looking at `PlaybackEngine`'s OWN canvas, which is
  // always sized `project.sequence.width/height` — never `exportSettings`'s own, independently-editable
  // width/height (see `ExportDialog`'s resolution dropdown). Building this file's internal canvas at
  // `exportSettings`'s size instead — the ORIGINAL behavior here — silently broke WYSIWYG the moment
  // those two ever diverged: a raw pixel offset authored against a 1080-wide preview lands at a
  // DIFFERENT proportional position once the internal canvas is actually, say, 720 wide, since nothing
  // scales it. Confirmed live: the exact same `offsetX: 100` text landed at 13.6% from the left edge at
  // matched 1080×1920, but 20.4% at a mismatched (same-aspect, just smaller) 720×1280 export — a real,
  // measurable, silent position shift with zero code error, exactly the shape of "text lands in the
  // wrong place after export" bug reports.
  //
  // The fix: build EVERY internal filter using the SEQUENCE's own width/height (`width`/`height` below)
  // — byte-for-byte the same canvas preview renders against, so nothing here needs to know
  // `exportSettings` exists at all — then, once the whole graph (video + every overlay track + every
  // text clip) is fully composited, conform the FINAL result to whatever OUTPUT size was actually
  // requested (`outputWidth`/`outputHeight`, still `exportSettings`'s own) in ONE closing scale/pad
  // stage, mirroring `pushClipVideoFilters`'s own opaque `scale=...force_original_aspect_ratio=decrease,
  // pad=...` pattern exactly. This keeps "export at a smaller/larger/different-aspect resolution than
  // you designed at" working (a legitimate, common request — smaller files, a different platform's
  // aspect ratio) while fixing the actual bug: every POSITION is now computed once, correctly, against
  // the canvas it was authored on, and only pure, uniform, distortion-free scaling happens afterward.
  const { width, height } = project.sequence;
  const outputWidth = project.exportSettings.width;
  const outputHeight = project.exportSettings.height;
  // See `computeTextFadeOutExtendedDuration`'s own doc comment: a text clip's fade-out can visibly need
  // MORE time than `sequenceDuration`'s plain per-clip formula accounts for.
  const duration = Math.max(sequenceDuration(project), computeTextFadeOutExtendedDuration(project));
  if (duration <= 0) throw new ExportError("There is nothing on the timeline to export");

  // Every visible video track with clips composites, in array order — later tracks drawn ON TOP of
  // earlier ones, the identical rule `PlaybackEngine.drawVideoLayer` uses for the canvas preview (see
  // its own comment for why that side needs no equivalent transparency plumbing: `drawImage` only
  // ever touches its own destination rect, so a gap there naturally shows whatever's underneath for
  // free). FFmpeg has no such "just don't touch those pixels" primitive, so this function has to
  // build that transparency explicitly — see `transparent` below.
  const videoTracks = project.sequence.tracks.filter(
    (track) => track.kind === "video" && track.visible && track.clips.length > 0
  );
  if (videoTracks.length === 0) throw new ExportError("There is no visible video track with clips to export");

  const inputs: string[] = [];
  const filters: string[] = [];
  let inputIndex = 0;

  /** Filter-graph references for inputs that don't feed the graph as their raw `${index}:v` — an
   *  animated sticker's looped input goes through `pushImageInput`'s own trim stage first. */
  const videoInputRefs = new Map<number, string>();
  const mediaRetime = new Map<number, { clip: Clip; elapsedStart: number; timelineDuration: number; sourceDuration: number }>();
  // A final-frame hold may seek slightly before its requested source time to decode a picture.
  // The shared input's audio must discard that preroll instead of replaying it under the blend.
  const audioInputPreroll = new Map<number, number>();
  const audioInputDelay = new Map<number, number>();
  const videoRef = (index: number): string => videoInputRefs.get(index) ?? `${index}:v`;

  /** Every "I need N seconds of silence" request across the whole export — deferred rather than each
   *  becoming its own `anullsrc` input immediately (see `pushSilentAudio`'s own doc comment for why). */
  const pendingSilentAudio: { label: string; duration: number }[] = [];

  /** Reserves `duration` seconds of silence for `outputLabel`. The spec (48kHz stereo) never varies
   *  anywhere in this file, so every request — one per gap, per image/color/text/muted clip needing an
   *  audio leg to concat/mix against real audio elsewhere — shares exactly ONE real `anullsrc` input,
   *  resolved once at the very end (`flushPendingSilentAudio`) via `asplit=` fanned out and trimmed
   *  per request, same "one real source, many independently-trimmed copies" shape
   *  `pushKeyframedClipVideoFilters`'s own `split=`/`trim=` already uses for keyframe slices.
   *
   *  This is what removed the single largest contributor to a REAL, reported hosted export crash:
   *  confirmed live (a container-side `/sys/fs/cgroup/pids.current` trace, idle ~29, spiking toward
   *  this container's cgroup `pids.max` of 1000 — the WHOLE container's process/thread budget) that
   *  FFmpeg's own scheduler spawns roughly one thread PER INPUT (decoder+demuxer) essentially all at
   *  once at startup, independent of any `-threads` cap (which only bounds a given codec's own
   *  INTERNAL worker count, not the scheduler's fixed per-input overhead) — see
   *  `pushKhmerTextOverlay`'s own doc comment for the first time this exact failure (identical
   *  signature: `pthread_create() failed` → `Could not open encoder before EOF` → `-22` on BOTH
   *  encoders) was diagnosed this way, for a different input-count contributor. Reproduced directly
   *  against a real user's own project (79 total inputs, 34 of them otherwise-identical `anullsrc`
   *  legs) before this fix and confirmed fixed after, on the actual bundled FFmpeg binary. */
  function pushSilentAudio(duration: number, outputLabel: string): void {
    pendingSilentAudio.push({ label: outputLabel, duration });
  }

  /** Resolves every `pushSilentAudio` request into the one shared `anullsrc` input — called once,
   *  right before `inputs`/`filters` are assembled into the final args. */
  function flushPendingSilentAudio(): void {
    if (pendingSilentAudio.length === 0) return;
    const maxDuration = Math.max(...pendingSilentAudio.map((p) => p.duration));
    const anullIndex = inputIndex++;
    inputs.push("-f", "lavfi", "-t", t(maxDuration), "-i", "anullsrc=channel_layout=stereo:sample_rate=48000");
    if (pendingSilentAudio.length === 1) {
      const [only] = pendingSilentAudio;
      filters.push(`[${anullIndex}:a]atrim=start=0:end=${t(only.duration)},asetpts=PTS-STARTPTS[${only.label}]`);
      return;
    }
    const pads = pendingSilentAudio.map((_, i) => `silentsplit${i}`);
    filters.push(`[${anullIndex}:a]asplit=${pendingSilentAudio.length}${pads.map((p) => `[${p}]`).join("")}`);
    pendingSilentAudio.forEach((p, i) => {
      filters.push(`[${pads[i]}]atrim=start=0:end=${t(p.duration)},asetpts=PTS-STARTPTS[${p.label}]`);
    });
  }

  /** Adds a still image's input for `duration` seconds, as input number `index` — or, for an ANIMATED
   *  image (a sticker/GIF: `Asset.animation`), its animated PNG looped from wherever `clip` is inside
   *  the animation at source time `sourceStart`. Preview picks a sticker's frame with
   *  `animationFrameIndex(animation, sourceTime)` (see `stickers.ts`); this reproduces exactly that,
   *  verified frame by frame against the real FFmpeg binary for starts on and between frames and across
   *  the loop point:
   *  - `-ss` can't be used to start mid-loop: combined with `-stream_loop` FFmpeg replays from the seek
   *    point instead of the loop start, so the loop is read from its beginning and cut in the graph.
   *  - Timestamps are rebuilt from the frame number first: an animated PNG stores frame delays as
   *    16-bit fractions (1/18s came back as 1389/25000s), which drifts a millisecond every few seconds
   *    — enough to land frames an output frame late on a long clip.
   *  - `trim=start_frame` starts on the frame showing at `sourceStart`; `setpts` then pulls every frame
   *    after it earlier by however far into that frame `sourceStart` already is (the first clamped to
   *    0), so each frame starts exactly when preview switches to it.
   *  - `fps=...:round=up` puts each frame on the first output frame at or after its start (the frame
   *    preview shows at that instant); `trim=duration` then cuts to exactly the length a still gets. */
  /** `-ss start -t duration -i path` for a video source — plus, when the file ends before
   *  `start + duration` (an outgoing transition partner running on past the end of its media, see
   *  `transitionPartnerSourceTime`), a `tpad` that holds its final frame for the rest, so the stream
   *  is still exactly `duration` long. Registered through `videoInputRefs` like `pushImageInput`'s
   *  own loop stage, so every consumer picks it up via `videoRef`. */
  function pushVideoSourceInput(clip: Clip, path: string, start: number, duration: number, index: number, elapsedStart?: number): void {
    const asset = findAsset(project, clip.assetId);
    const sourceDuration = asset?.kind === "video" ? asset.duration : undefined;
    const hasSourceDuration = sourceDuration !== undefined && sourceDuration > 0;
    const canRetime = elapsedStart !== undefined;
    const sourceA = canRetime ? clipSourceTimeAtElapsed(clip, elapsedStart!) : start;
    const sourceB = canRetime ? clipSourceTimeAtElapsed(clip, elapsedStart! + duration) : start + duration;
    const readStart = Math.min(sourceA, sourceB);
    const readDuration = Math.max(1e-6, Math.abs(sourceB - sourceA));
    if (canRetime) mediaRetime.set(index, { clip, elapsedStart: elapsedStart!, timelineDuration: duration, sourceDuration: readDuration });
    start = readStart;
    duration = readDuration;
    const finish = (baseRef: string) => {
      let ref = baseRef;
      if (clip.reverse) {
        const label = `in${index}_reverse`;
        filters.push(`[${ref}]reverse,setpts=PTS-STARTPTS[${label}]`);
        ref = label;
      }
      if (canRetime) {
        const expression = speedSetptsExpression(clip, elapsedStart!, mediaRetime.get(index)!.timelineDuration, readDuration);
        if (expression) {
          const label = `in${index}_speed`;
          filters.push(`[${ref}]setpts='${expression}'[${label}]`);
          ref = label;
        }
      }
      if (ref !== `${index}:v`) videoInputRefs.set(index, ref);
    };
    const headUnderflow = start < -1e-6 ? -start : 0;
    const tailOverflow = hasSourceDuration && (start + duration > sourceDuration + 1e-3);

    if (headUnderflow === 0 && !tailOverflow) {
      inputs.push("-ss", t(start), "-t", t(duration), "-i", path);
      finish(`${index}:v`);
      return;
    }

    if (headUnderflow > 0) {
      const availableDuration = hasSourceDuration ? Math.max(0, sourceDuration!) : duration;
      const readDuration = Math.max(0, Math.min(duration - headUnderflow, availableDuration));
      inputs.push("-ss", "0", "-t", t(readDuration), "-i", path);
      audioInputDelay.set(index, headUnderflow);
      const label = `in${index}_hold`;
      const padParts: string[] = [
        `start_mode=clone:start_duration=${t(headUnderflow)}`,
      ];
      if (tailOverflow) {
        padParts.push(`stop_mode=clone:stop_duration=${t(duration)}`);
      }
      filters.push(`[${index}:v]setpts=PTS-STARTPTS,tpad=${padParts.join(":")},trim=duration=${t(duration)}[${label}]`);
      finish(label);
      return;
    }

    const frame = 1 / (asset?.fps || fps);
    const seek = Math.max(0, Math.min(start, sourceDuration! - 1.5 * frame));
    if (start > seek) audioInputPreroll.set(index, start - seek);
    inputs.push("-ss", t(seek), "-t", t(duration), "-i", path);
    const label = `in${index}_hold`;
    filters.push(`[${index}:v]setpts=PTS-STARTPTS,tpad=stop_mode=clone:stop_duration=${t(duration)},trim=duration=${t(duration)}[${label}]`);
    finish(label);
  }

  function pushImageInput(clip: Clip, path: string, sourceStart: number, duration: number, index: number): void {
    const asset = findAsset(project, clip.assetId);
    // A color-matte asset has no real file at all — `Asset.relPath` is `""` (see that field's own doc
    // comment), so `path` (from `options.inputPathFor`) is never something FFmpeg can actually open;
    // in hosted mode it resolves to the project's own media DIRECTORY, which fails with "Is a
    // directory" (confirmed as a real, reported export failure, not hypothetical — every project with
    // a color-background clip failed to export). Synthesized directly as a `color=` lavfi source
    // instead, `format=rgba` unconditionally: harmless where nothing downstream needs alpha, and
    // required where it does (a transparent overlay track, or `format=rgba` immediately after in
    // `pushClipVideoFilters`'s own "real transform/effects" branch, which otherwise re-adds it anyway).
    if (asset?.kind === "color") {
      inputs.push("-f", "lavfi", "-t", t(duration), "-i", `color=c=${asset.color ?? "#000000"}:s=${width}x${height}:r=${fps},format=rgba`);
      return;
    }
    const animation = asset?.animation;
    if (!animation) {
      inputs.push("-loop", "1", "-framerate", String(fps), "-t", t(duration), "-i", path);
      return;
    }
    const startFrame = animationFrameIndex(animation, sourceStart);
    const loopStart = startFrame / animation.fps;
    // Plus 5µs: `n()` keeps 6 decimals, and a frame whose start lands exactly on an output frame, nudged
    // even 1µs LATE by that rounding, would move a whole output frame later through `round=up`. Real
    // frame starts that aren't on an output frame sit well over 5µs away from one, so starting every
    // frame this much early never moves one onto the wrong output frame.
    const intoFrame = Math.max(0, Math.min(1 / animation.fps, animationLoopOffset(animation, sourceStart) - loopStart)) + 0.000005;
    // A little past what's needed, so the last output frame always has a sticker frame to show.
    inputs.push("-stream_loop", "-1", "-t", t(loopStart + duration + 2 / animation.fps), "-i", path);
    const label = `anim${index}`;
    filters.push(
      `[${index}:v]setpts=N/(${animation.fps}*TB),trim=start_frame=${startFrame},setpts='max(0\\,PTS-STARTPTS-${n(intoFrame)}/TB)',` +
        `fps=fps=${fps}:round=up,trim=duration=${t(duration)}[${label}]`
    );
    videoInputRefs.set(index, label);
  }

  // Pushes one source's own video filter chain — the plain scale+pad path for an untouched clip, or
  // the full crop/eq/scale/blur/rotate/opacity chain for a real transform/effects — shared by a
  // normal "clip" segment AND each half of a "transition" segment's crossfade below, so a
  // transitioning clip's own transform/effects still apply to its share of the blend exactly like
  // they would to a plain cut, not just the two branches independently reimplementing the same logic.
  //
  // `transparent` is true for every track EXCEPT the bottom (base) one — false there keeps the
  // single-track case byte-for-byte identical to before multi-track compositing existed (an opaque
  // `pad=`/background, exactly as today). true swaps in `format=rgba` + a `black@0` fill so a clip's
  // own letterbox bars (or a real transform's rotation-corner/opacity blend) stay genuinely
  // transparent instead of being irreversibly pre-blended against black here — letting whatever's on
  // the track(s) below show through once this track's own stream is later composited over them.
  // `fadeIn`/`fadeOut` are only ever set for a SOLO transition (`Segment["clip"]["fadeIn"]`/
  // `["fadeOut"]`'s own doc comments) — when either is present, the normal chain below is built into
  // an intermediate `_prefade` label instead of `outputLabel` directly, then one or two more `fade`
  // stages (chained — FFmpeg's `fade` filter composes fine applied twice, once `t=in` once `t=out`)
  // bridge it to the real output. `alpha=1` (fade the ALPHA channel toward/from transparent) on a
  // `transparent` track matches `PlaybackEngine`'s own preview behavior there (revealing whatever's
  // on a lower track, since an overlay track's gaps are already transparent) — the plain color fade
  // (default black) on the base track matches its own preview behavior (fading in/out against the
  // opaque black `drawFrame` clears to).
  function pushClipVideoFilters(
    clip: Clip,
    videoIndex: number,
    outputLabel: string,
    sliceDuration: number,
    transparent: boolean,
    fadeIn?: number,
    fadeOut?: number
  ): void {
    const label = fadeIn || fadeOut ? `${outputLabel}_prefade` : outputLabel;
    const transform = clip.transform;
    const effects = clip.effects;
    // A chroma key or non-identity color grading forces the "real" (overlay-composited, alpha-carrying)
    // path below even with an otherwise-identity transform/effects — the plain scale+pad path has no
    // background/overlay machinery for a keyed-out region to show through, and no `curves=` stage,
    // only `buildTransformFilters`'s own does.
    const isPlain =
      (!transform || isIdentityTransform(transform)) &&
      (!effects || isIdentityEffects(effects)) &&
      !clip.chromaKey &&
      (!clip.colorGrading || isIdentityColorGrading(clip.colorGrading)) &&
      !clip.lutId &&
      !clip.pixelEffect &&
      !clip.flipHorizontal &&
      !clip.flipVertical &&
      !clip.mask;

    if (isPlain) {
      filters.push(
        transparent
          ? `[${videoRef(videoIndex)}]format=rgba,scale=${width}:${height}:force_original_aspect_ratio=decrease,` +
              `pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2:color=black@0,setsar=1,fps=${fps},setpts=PTS-STARTPTS[${label}]`
          : `[${videoRef(videoIndex)}]scale=${width}:${height}:force_original_aspect_ratio=decrease,` +
              `pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2,setsar=1,fps=${fps},setpts=PTS-STARTPTS[${label}]`
      );
    } else {
      const bgIndex = inputIndex++;
      const bgColor = transparent ? "black@0" : "black";
      // `,format=rgba` when `transparent`: FFmpeg's `color` lavfi source emits `yuv420p` (no alpha
      // channel) by default regardless of the `@0` alpha spec in the color string — `black@0`'s own
      // transparency is silently discarded at the SOURCE unless the source itself is told to carry
      // alpha. See the rotated-text background input below (this module's other `color=c=...@0` lavfi
      // source) for the full empirical confirmation of this FFmpeg behavior.
      inputs.push(
        "-f",
        "lavfi",
        "-t",
        t(sliceDuration),
        "-i",
        `color=c=${bgColor}:s=${width}x${height}:r=${fps}${transparent ? ",format=rgba" : ""}`
      );
      filters.push(
        ...buildTransformFilters({
          source: videoRef(videoIndex),
          bg: `${bgIndex}:v`,
          outputLabel: label,
          transform: transform ?? IDENTITY_TRANSFORM,
          effects: effects ?? IDENTITY_EFFECTS,
          width,
          height,
          fps,
          chromaKey: clip.chromaKey,
          colorGrading: clip.colorGrading,
          lutPath: clip.lutId ? options.lutPathFor?.(clip.lutId) : undefined,
          pixelEffect: clip.pixelEffect,
          flipHorizontal: clip.flipHorizontal,
          flipVertical: clip.flipVertical,
          mask: clip.mask,
        })
      );
    }

    if (fadeIn || fadeOut) {
      // The clip's own style for its solo fade-in/out — see `pushSoloTransitionStages`. A single very
      // short clip can legitimately have both at once.
      pushSoloTransitionStages(label, outputLabel, clip, sliceDuration, transparent, fadeIn, fadeOut);
    }
  }

  /** `pushClipVideoFilters`'s own counterpart for a clip whose Transform and/or Effects are keyframed
   *  — see `computeKeyframeSlices`'s own doc comment for why segment-slicing (not a live FFmpeg
   *  expression) is what makes this work. Slices the segment via `computeKeyframeSlices`, opens the
   *  real source and the background color source EACH EXACTLY ONCE for the WHOLE segment (not once per
   *  slice — see below for why that matters), `split=`s each into one copy per slice, `trim=`s each
   *  copy down to that slice's own sub-range, and feeds the result through the EXISTING, unmodified
   *  `buildTransformFilters` per slice exactly like a static clip would be — this function adds no new
   *  geometry/effects logic of its own. The slices concatenate back into ONE output label with the
   *  video-only mirror of this file's own audio-track concat (`concat=n=...:v=0:a=1` — see
   *  `buildAudioTrackStream`) — `v=1:a=0` here, since this concat is video-only; `buildTrackStreams`'s
   *  own OUTER per-segment concat (`v=1:a=1`) is a separate, unrelated concat one level up. fadeIn/
   *  fadeOut wrap the CONCATENATED result exactly like `pushClipVideoFilters` wraps its own single
   *  chain — a fade spans the whole segment, not any one slice.
   *
   *  The one-input-per-SEGMENT (not per-slice) design is load-bearing, not a micro-optimization: a
   *  long, richly keyframed clip can produce up to `MAX_KEYFRAME_SLICES_PER_CLIP` slices, and the
   *  earlier one-input-PER-SLICE version of this function pushed a fresh `-i <sourcePath>` (plus a
   *  fresh `-f lavfi -i color=...`) for every single one — confirmed live, on a real 205-second clip
   *  with keyframes spanning nearly its whole duration, this produced 487 separate `-i` arguments,
   *  ~240 of them repeating the same 145-character absolute source path, and Windows' `CreateProcess`
   *  command-line limit (~32,767 characters) threw `spawn ENAMETOOLONG` — synchronously, before FFmpeg
   *  ever ran. `split=`/`trim=` replace N real re-seeks-and-reopens with one real file open and cheap
   *  in-graph fan-out/slicing, making the input count constant regardless of slice count. */
  function pushKeyframedClipVideoFilters(
    clip: Clip,
    path: string,
    isImage: boolean,
    elapsedAtSegmentStart: number,
    outputLabel: string,
    sliceDuration: number,
    transparent: boolean,
    fadeIn?: number,
    fadeOut?: number
  ): void {
    const label = fadeIn || fadeOut ? `${outputLabel}_prefade` : outputLabel;
    if (hasRotationOnlyTransformKeyframes(clip)) {
      const sourceIndex = inputIndex++;
      if (isImage) {
        pushImageInput(clip, path, clip.sourceIn + elapsedAtSegmentStart, sliceDuration, sourceIndex);
      } else {
        pushVideoSourceInput(clip, path, clip.sourceIn + elapsedAtSegmentStart, sliceDuration, sourceIndex, elapsedAtSegmentStart);
      }
      const bgIndex = inputIndex++;
      const bgColor = transparent ? "black@0" : "black";
      inputs.push(
        "-f",
        "lavfi",
        "-t",
        t(sliceDuration),
        "-i",
        `color=c=${bgColor}:s=${width}x${height}:r=${fps}${transparent ? ",format=rgba" : ""}`
      );
      filters.push(
        ...buildTransformFilters({
          source: videoRef(sourceIndex),
          bg: `${bgIndex}:v`,
          outputLabel: label,
          transform: resolveClipTransform(clip, elapsedAtSegmentStart),
          effects: clip.effects ?? IDENTITY_EFFECTS,
          width,
          height,
          fps,
          chromaKey: clip.chromaKey,
          colorGrading: clip.colorGrading,
          lutPath: clip.lutId ? options.lutPathFor?.(clip.lutId) : undefined,
          pixelEffect: clip.pixelEffect,
          flipHorizontal: clip.flipHorizontal,
          flipVertical: clip.flipVertical,
          mask: clip.mask,
          rotationExpressionDegrees: rotationKeyframeExpression(clip, elapsedAtSegmentStart),
        })
      );
      if (fadeIn || fadeOut) pushSoloTransitionStages(label, outputLabel, clip, sliceDuration, transparent, fadeIn, fadeOut);
      return;
    }
    const slices = computeKeyframeSlices(clip, elapsedAtSegmentStart, sliceDuration, fps, options.keyframeSliceTuning);
    const bgColor = transparent ? "black@0" : "black";

    // ONE source input for the whole segment — mirrors `pushClipVideoFilters`'s own convention exactly
    // (same `-ss`/seek formula it already uses at its own call site), instead of one per slice.
    const sourceIndex = inputIndex++;
    if (isImage) {
      pushImageInput(clip, path, clip.sourceIn + elapsedAtSegmentStart, sliceDuration, sourceIndex);
    } else {
      pushVideoSourceInput(clip, path, clip.sourceIn + elapsedAtSegmentStart, sliceDuration, sourceIndex, elapsedAtSegmentStart);
    }
    // ONE background color input for the whole segment too — this was ALSO duplicated per slice
    // before, an independent contributor to the same command-line-length problem.
    const bgIndex = inputIndex++;
    inputs.push(
      "-f",
      "lavfi",
      "-t",
      t(sliceDuration),
      "-i",
      `color=c=${bgColor}:s=${width}x${height}:r=${fps}${transparent ? ",format=rgba" : ""}`
    );

    const srcZeroed = `${label}_kfsrc`;
    const bgZeroed = `${label}_kfbg`;
    filters.push(`[${videoRef(sourceIndex)}]setpts=PTS-STARTPTS[${srcZeroed}]`);
    filters.push(`[${bgIndex}:v]setpts=PTS-STARTPTS[${bgZeroed}]`);

    // `split=` fans the ONE zeroed stream out into N independent copies, one per slice, so each can be
    // `trim=`'d to its own sub-range without affecting the others — skipped entirely for a single-slice
    // segment (a short transition-side segment with no interior keyframe boundary is common), avoiding
    // an untested `split=1` construct for the common case.
    let srcPads = [srcZeroed];
    let bgPads = [bgZeroed];
    if (slices.length > 1) {
      const srcSplit = slices.map((_, i) => `${label}_kfsrcsplit${i}`);
      filters.push(`[${srcZeroed}]split=${slices.length}${srcSplit.map((l) => `[${l}]`).join("")}`);
      srcPads = srcSplit;

      const bgSplit = slices.map((_, i) => `${label}_kfbgsplit${i}`);
      filters.push(`[${bgZeroed}]split=${slices.length}${bgSplit.map((l) => `[${l}]`).join("")}`);
      bgPads = bgSplit;
    }

    const sliceLabels: string[] = [];
    slices.forEach((slice, i) => {
      // `trim=` is relative to the ZEROED input's own PTS (already reset above), not clip-window- or
      // source-media-relative — `slice.offset` is segment-relative, starting exactly at
      // `elapsedAtSegmentStart` (`computeSliceBoundaries`'s own guarantee for the first boundary), so
      // subtracting it back out lands correctly at 0 for the first slice and walks forward from there.
      // `trim=` does NOT reset PTS on its own (it only removes out-of-range frames) — the
      // `setpts=PTS-STARTPTS` right after it is what actually renormalizes each slice to start at 0,
      // which `concat=` below requires.
      const trimStart = slice.offset - elapsedAtSegmentStart;
      const trimEnd = trimStart + slice.duration;
      const srcTrimmed = `${label}_kfsrctrim${i}`;
      const bgTrimmed = `${label}_kfbgtrim${i}`;
      filters.push(`[${srcPads[i]}]trim=start=${t(trimStart)}:end=${t(trimEnd)},setpts=PTS-STARTPTS[${srcTrimmed}]`);
      filters.push(`[${bgPads[i]}]trim=start=${t(trimStart)}:end=${t(trimEnd)},setpts=PTS-STARTPTS[${bgTrimmed}]`);

      const sliceLabel = `${label}_kf${i}`;
      filters.push(
        ...buildTransformFilters({
          source: srcTrimmed,
          bg: bgTrimmed,
          outputLabel: sliceLabel,
          transform: slice.transform,
          effects: slice.effects,
          width,
          height,
          fps,
          chromaKey: clip.chromaKey,
          colorGrading: slice.colorGrading,
          lutPath: clip.lutId ? options.lutPathFor?.(clip.lutId) : undefined,
          pixelEffect: clip.pixelEffect,
          flipHorizontal: clip.flipHorizontal,
          flipVertical: clip.flipVertical,
          mask: clip.mask,
        })
      );
      sliceLabels.push(`[${sliceLabel}]`);
    });

    // Each slice already has the sequence frame rate. Rebuild timestamps by frame count rather than
    // resampling concat's microsecond timestamps with fps: rounding there can drop the final frame.
    // The explicit timebase still matches the other input of a downstream xfade.
    filters.push(`${sliceLabels.join("")}concat=n=${slices.length}:v=1:a=0,settb=1/${fps},setpts=N[${label}]`);

    if (fadeIn || fadeOut) {
      // Same as `pushClipVideoFilters` — a keyframed clip can equally be the first/last on its track.
      pushSoloTransitionStages(label, outputLabel, clip, sliceDuration, transparent, fadeIn, fadeOut);
    }
  }

  /** Pushes a keyframed side's OWN audio — never sliced (keyframes only ever touch Transform/Effects,
   *  never audio; re-slicing/re-concatenating audio into N pieces would risk audible clicks at slice
   *  boundaries for zero benefit) — via one dedicated full-duration source input of its own, pushed
   *  ONLY when actually needed (`pushClipAudioFilters`'s own silent-source branch needs no real input
   *  at all, so skipping this when there's nothing to extract avoids decoding a source clip solely to
   *  throw its audio away). `clip.sourceIn + elapsedAtSegmentStart` is the same source-time formula
   *  every slice's own `-ss` above already uses, evaluated once for the segment's start instead of per
   *  slice — correct for both a plain "clip" segment (`elapsedAtSegmentStart = segment.sourceIn -
   *  clip.sourceIn`, so this simplifies back to `segment.sourceIn`) and a transition's own from/to
   *  half. */
  function pushKeyframedAudio(
    clip: Clip,
    path: string,
    isImage: boolean,
    hasAudio: boolean,
    elapsedAtSegmentStart: number,
    audioLabel: string,
    sliceDuration: number,
    fadeIn?: number,
    fadeOut?: number,
    padToDuration = false
  ): void {
    const needsAudioSource = hasAudio && !clip.mutedAudio;
    let audioSourceIndex = -1;
    if (needsAudioSource) {
      const sourceA = clipSourceTimeAtElapsed(clip, Math.max(0, elapsedAtSegmentStart));
      const sourceB = clipSourceTimeAtElapsed(clip, Math.min(clipDuration(clip), elapsedAtSegmentStart + sliceDuration));
      const sourceStart = Math.min(sourceA, sourceB);
      const sourceReadDuration = Math.max(1e-6, Math.abs(sourceB - sourceA));
      if (isImage) {
        inputs.push("-loop", "1", "-framerate", String(fps), "-t", t(sliceDuration), "-i", path);
      } else if (sourceStart < -1e-6) {
        const underflow = -sourceStart;
        const readDuration = Math.max(0, sliceDuration - underflow);
        inputs.push("-ss", "0", "-t", t(readDuration), "-i", path);
        audioInputDelay.set(inputIndex, underflow);
      } else {
        inputs.push("-ss", t(sourceStart), "-t", t(sourceReadDuration), "-i", path);
      }
      audioSourceIndex = inputIndex++;
      if (!isImage && elapsedAtSegmentStart >= -1e-6 && elapsedAtSegmentStart + sliceDuration <= clipDuration(clip) + 1e-6) {
        mediaRetime.set(audioSourceIndex, { clip, elapsedStart: Math.max(0, elapsedAtSegmentStart), timelineDuration: sliceDuration, sourceDuration: sourceReadDuration });
      }
    }
    pushClipAudioFilters(needsAudioSource, audioSourceIndex, audioLabel, sliceDuration, clip.gain ?? 1, fadeIn, fadeOut, padToDuration, clip, elapsedAtSegmentStart);
  }

  // Pushes one source's own audio — resampled straight through (with an optional `volume=` stage —
  // see `Clip.gain`'s own doc comment) when it has real audio, else a matching-length silent source —
  // shared the same way `pushClipVideoFilters` is above. `gain` is meaningless for the silent-source
  // branch (nothing to scale), so it's simply ignored there rather than needing its own identity check.
  function pushClipAudioFilters(
    hasAudio: boolean,
    videoIndex: number,
    outputLabel: string,
    sliceDuration: number,
    gain = 1,
    fadeIn?: number,
    fadeOut?: number,
    padToDuration = false,
    clip?: Clip,
    // Clip-window-relative seconds this SLICE's own local `t=0` (right after the `asetpts=PTS-
    // STARTPTS` stage below) corresponds to — see `buildGainVolumeExpr`'s own doc comment for exactly
    // what this needs to be and why. Every caller already computes this same value for
    // `pushKeyframedClipVideoFilters`/`clipProgressAtElapsed` — it's simply threaded one step further
    // here. Meaningless (unused) when `clip.gainKeyframes` is absent, so `0` is a safe default for
    // every existing caller that has no reason to pass anything else.
    elapsedAtSegmentStart = 0
  ): void {
    // Silence has nothing to fade (an `afade` on a silent source is a pure no-op), so `fadeIn`/
    // `fadeOut` only ever matter on the `hasAudio` branch — same reasoning `gain`'s own "meaningless
    // for silence" comment below already gives.
    const fadeStages: string[] = [];
    if (fadeIn) fadeStages.push(`afade=t=in:st=0:d=${t(fadeIn)}`);
    if (fadeOut) fadeStages.push(`afade=t=out:st=${t(sliceDuration - fadeOut)}:d=${t(fadeOut)}`);
    const fadeStage = fadeStages.length > 0 ? `,${fadeStages.join(",")}` : "";
    if (hasAudio) {
      // Every segment is resampled to one common rate/layout; concat/acrossfade both refuse to join
      // audio streams whose formats don't match, which is easy to hit when mixing a phone clip with
      // a WAV. `volume=` only appended when it would actually change anything — an unconditional
      // `volume=1.000000` is a harmless no-op filter-graph-wise, but skipping it keeps the untouched
      // (overwhelmingly common) case's generated args byte-for-byte identical to before this feature.
      const volumeStage = gain !== 1 ? `,volume=${n(gain)}` : "";
      // A genuine time-varying volume envelope, used ONLY by the plain (non-speed-curve) branch below
      // — see `Clip.gainKeyframes`'s own doc comment for why the speed-curve/piecewise-concat branch
      // above this one deliberately keeps the flat `volumeStage` instead. `eval=frame` re-evaluates
      // `volume`'s own expression every audio frame instead of once at filter init (FFmpeg's default).
      const dynamicVolumeStage =
        clip?.gainKeyframes && clip.gainKeyframes.length > 0
          ? `,volume=eval=frame:volume='${buildGainVolumeExpr(clip.gainKeyframes, elapsedAtSegmentStart, n)}'`
          : volumeStage;
      // `Clip.pan`'s own per-clip stereo position — static (not time-varying, see its own doc comment
      // for why), so the exact same `buildPanFilterStage` a TRACK's own pan already uses at export
      // works unchanged here, just fed `clip.pan` instead of `track.pan`.
      const panFilterStage = clip ? buildPanFilterStage(clip.pan ?? 0, n) : null;
      const panStage = panFilterStage ? `,${panFilterStage}` : "";
      // `padToDuration`: an outgoing transition partner's audio can run out before the blend does
      // (its source ends — see `pushVideoSourceInput`); `acrossfade` needs the full length.
      const padStage = padToDuration ? `,apad=whole_dur=${t(sliceDuration)}` : "";
      const preroll = audioInputPreroll.get(videoIndex);
      const trimStage = preroll ? `atrim=start=${t(preroll)},` : "";
      const delay = audioInputDelay.get(videoIndex);
      const delayMs = delay ? Math.round(delay * 1000) : 0;
      const delayStage = delayMs ? `adelay=${delayMs}|${delayMs},` : "";
      const reverseStage = clip?.reverse ? "areverse," : "";
      const retime = mediaRetime.get(videoIndex);
      const atempoFilters = (initialRate: number) => {
        const stages: string[] = [];
        let rate = initialRate;
        while (rate > 2 + 1e-6) { stages.push("atempo=2"); rate /= 2; }
        while (rate < 0.5 - 1e-6) { stages.push("atempo=0.5"); rate /= 0.5; }
        if (Math.abs(rate - 1) > 1e-6) stages.push(`atempo=${n(rate)}`);
        return stages;
      };
      const p0 = retime ? clipProgressAtElapsed(retime.clip, retime.elapsedStart) : 0;
      const p1 = retime ? clipProgressAtElapsed(retime.clip, retime.elapsedStart + retime.timelineDuration) : 1;
      const localCurve = retime ? sliceSpeedCurve(retime.clip.speedCurve, Math.min(p0, p1), Math.max(p0, p1)) : undefined;
      if (retime && localCurve && localCurve.length > 1) {
        const base = `${outputLabel}_speedbase`;
        filters.push(`[${videoIndex}:a]${trimStage}${delayStage}${reverseStage}aresample=48000,aformat=channel_layouts=stereo,asetpts=PTS-STARTPTS[${base}]`);
        const pads = localCurve.slice(0, -1).map((_, i) => `${outputLabel}_speedpad${i}`);
        if (pads.length > 1) filters.push(`[${base}]asplit=${pads.length}${pads.map((label) => `[${label}]`).join("")}`);
        const pieces: string[] = [];
        for (let i = 0; i < localCurve.length - 1; i++) {
          const a = localCurve[i], b = localCurve[i + 1];
          const width = b.position - a.position;
          const delta = b.speed - a.speed;
          const sourceSeconds = retime.sourceDuration * width;
          const timelineSeconds = Math.abs(delta) < 1e-8
            ? sourceSeconds / a.speed
            : retime.sourceDuration * width / delta * Math.log(b.speed / a.speed);
          const effectiveRate = sourceSeconds / Math.max(1e-9, timelineSeconds);
          const piece = `${outputLabel}_speedpiece${i}`;
          const sourceLabel = pads.length > 1 ? pads[i] : base;
          const tempo = atempoFilters(effectiveRate);
          filters.push(
            `[${sourceLabel}]atrim=start=${t(a.position * retime.sourceDuration)}:end=${t(b.position * retime.sourceDuration)},` +
              `asetpts=PTS-STARTPTS${tempo.length ? `,${tempo.join(",")}` : ""}[${piece}]`
          );
          pieces.push(`[${piece}]`);
        }
        const suffix = `${volumeStage}${panStage}${fadeStage}${padStage}`;
        filters.push(`${pieces.join("")}concat=n=${pieces.length}:v=0:a=1${suffix}[${outputLabel}]`);
        return;
      }
      const atempoStages: string[] = [];
      if (retime) {
        atempoStages.push(...atempoFilters(retime.sourceDuration / Math.max(1e-9, retime.timelineDuration)));
      }
      const atempoStage = atempoStages.length ? `${atempoStages.join(",")},` : "";
      filters.push(
        `[${videoIndex}:a]${trimStage}${delayStage}${reverseStage}${atempoStage}aresample=48000,aformat=channel_layouts=stereo,asetpts=PTS-STARTPTS${dynamicVolumeStage}${panStage}${fadeStage}${padStage}[${outputLabel}]`
      );
    } else {
      pushSilentAudio(sliceDuration, outputLabel);
    }
  }

  // Composites a Khmer-script text clip's pre-rendered window images (see `khmerTextRenderer.ts`'s own
  // doc comment for why Khmer routes through browser-rendered PNGs instead of `drawtext=`/`subtitles=`
  // at all) onto `videoOut`, entirely replacing that clip's own drawtext/rotated/wordHighlight branches.
  //
  // Each window becomes its own `-itsoffset`-shifted input, chained onto `videoOut` via a sequence of
  // `overlay=...:enable='between(t,...)'` steps — the same per-slice chained-overlay shape the
  // `cropSlices` path below already uses, reused here rather than reinvented. `-itsoffset` shifts an
  // input's OWN timestamps to start at its absolute timeline position (the standard FFmpeg idiom for a
  // later-starting overlay input), which is what lets `enable=` — evaluated against `videoOut`'s own
  // absolute time — and each fade's `st=` line up correctly with no manual `setpts=PTS+offset/TB`
  // expression, and (unlike a plain `setpts=PTS-STARTPTS`, which resets to 0 and would fight the
  // offset) is why NO `setpts` filter runs on these inputs at all.
  //
  // A previous version of this function instead built ONE synthetic transparent `color=...@0` leg to
  // fill [0, clip start) and another for (clip end, sequence end], `concat`-ing those together with
  // every window image into one full-sequence-duration stream so the final overlay needed no `enable=`
  // gate at all. That traded two extra `-i` inputs per Khmer clip to avoid `enable=` — a trade that
  // broke down at real project scale: a real, reported hosted export (a 10-track project with 36 Khmer
  // caption clips) failed with a cascading `[dec:h264] pthread_create() failed: Resource temporarily
  // unavailable` → `Could not open encoder before EOF` → `-22 (Invalid argument)` on BOTH the video and
  // audio encoders. Confirmed via a live container-side `/sys/fs/cgroup/pids.current` trace (idle ~21,
  // spiking to 990 — one short of this container's cgroup `pids.max` of 1000, the WHOLE container's
  // total process/thread budget — then collapsing, all within the same one-second window FFmpeg's own
  // graph-init ran) that FFmpeg's scheduler spawns roughly one thread per pipeline task (decoders AND
  // demuxers) essentially all at once at startup, independent of any `-threads` cap (which only bounds a
  // given codec's own INTERNAL worker count, not the scheduler's per-task overhead). The two filler legs
  // per clip were the single largest contributor to this project's own 271 total inputs — 36 clips × 2
  // legs ≈ 72, ahead of even the 128 real per-window images — so removing them is what actually shrinks
  // the pipeline back under budget; capping decoder threads (`capDecoderThreads`, in the hosted server's
  // own `ffmpeg.ts`) was a real, separately-necessary fix for a smaller-scale case, but insufficient on
  // its own for a project built this large.
  function pushKhmerTextOverlay(
    videoOut: string,
    outputLabel: string,
    clip: Clip,
    windows: KhmerTextWindow[],
    fadeIn: number | undefined,
    fadeOut: TextFadeOut | undefined
  ): void {
    const clipStart = clip.timelineStart;
    const { enableEnd } = buildTextFadeParams(clip, fadeIn, fadeOut);

    let chainInput = videoOut;
    windows.forEach((w, i) => {
      const isFirst = i === 0;
      const isLast = i === windows.length - 1;
      const absStart = clipStart + w.startOffset;
      const hasFade = (isFirst && fadeIn) || (isLast && fadeOut);

      const idx = inputIndex++;
      // A window's own image never changes across its window — no animation lives inside a single
      // `KhmerTextWindow`, only the plain `fade=` ramp a clip's edge windows can carry (below). Decoding
      // it at the real sequence framerate for its own full duration is pure waste UNLESS that ramp is
      // actually running here: a real, reported hosted export (36 Khmer clips, ~190 window inputs after
      // the filler-leg removal above) confirmed this waste is what actually exhausts the container —
      // every `-i` here starts decoding at real wall-clock process start (`-itsoffset` only shifts a
      // stream's own TIMESTAMPS, not when FFmpeg actually opens/reads it), so a window whose `enable=`
      // gate doesn't open until deep into the timeline still immediately decodes and buffers its own
      // `duration * fps` worth of full-frame RGBA copies (1080×1920 RGBA ≈ 8.3MB EACH) with nothing to
      // throttle it until its overlay step is finally reached — confirmed via a live container-side
      // `/sys/fs/cgroup/memory.current` trace climbing ~300MB/s straight to this container's 8GB
      // `memory.max` (`oom_kill: 1`) within ~11 seconds of encoding actually starting.
      //
      // A non-fading window needs only 1 real frame per second, not the sequence's own full framerate
      // — `overlay`'s own `eof_action` defaults to `repeat`: once this (now much shorter) secondary
      // stream reaches EOF, the filter keeps reusing its last frame for every later output frame for as
      // long as `enable=` stays open, indistinguishable on screen from a "real" full-duration source for
      // content that never changes.
      //
      // A NON-FADING window therefore takes no `-loop`/`-t` at all — just the image, read once. That
      // is not a tuning choice, it is the only shape that actually terminates. Measured directly
      // against this repo's own bundled FFmpeg (6.1.1): `-loop 1 -framerate F -t D` bounds the input
      // at `round(D * F)` frames, and when that product rounds to ZERO the `-t` is discarded outright
      // and the image loops FOREVER. At the `-framerate 1` a non-fading window used to pass, that
      // means every `-t` below 0.5s was silently unbounded — i.e. essentially every real spoken word.
      // Measured boundary, `-framerate 1`: `-t` 0.033/0.1/0.3/0.4/0.49 all ran past 350,000 frames
      // (80+ hours of output) before being killed; 0.5 and up stop at 1 frame. That single fact
      // retro-explains this whole area's history:
      //   - the "bare REAL duration is GAP-FREE but OOM-kills the container (`SIGKILL`) at 8GB" result
      //     — of course it did: nearly every window input was an infinite image loop, and the
      //     `/sys/fs/cgroup/memory.current` trace climbing ~300MB/s was those loops, not decode waste;
      //   - why `Math.max(realDuration, 0.5)` and a flat 1.0s "memory padding" both stopped the crash
      //     — 0.5 is not a lucky memory threshold, it is exactly `round(D * 1) >= 1`, the point where
      //     `-t` starts being honoured and the inputs become finite at all;
      //   - and why flooring `-t` at `1 / fps` (≈0.033s) did nothing for either problem: still far
      //     below 0.5, so still unbounded, so still the same symptom.
      // With `-loop` gone the input is finite by construction at any window width, with no rounding
      // cliff to fall off — and `overlay`'s `eof_action=repeat` (already relied on above) holds that
      // one frame for as long as `enable=` stays open. Verified on the same synthetic graph: the
      // looped form never finished, the single-frame form rendered the identical result in 0.18s.
      //
      // A FADING window keeps `-loop 1 -framerate fps -t D`, because `fade=` genuinely needs a frame
      // sequence to ramp across rather than one repeated still. That stays bounded: `D` is floored at
      // `1 / fps` (`khmerTextRenderer.ts` guarantees the window itself is never narrower, and the
      // `Math.max` below re-asserts it here), so `round(D * fps) >= 1` always.
      //
      // `-itsoffset` is pulled back by one frame so the image is already sitting in the filter when
      // the gate opens. Without it the first window of a clip loses its opening frame outright: its
      // lone frame lands at exactly `absStart`, the same instant `enable=` first evaluates true, and
      // the overlay step passes that frame through un-composited — a real one-frame hole, measured as
      // exactly 1 blank frame at the window's own start. Later windows never showed it only because
      // `between()` is INCLUSIVE at both ends, so the previous window's still-open gate happened to
      // paper over the same instant — which is also why this reads as sporadic rather than constant:
      // it is the FIRST window of each clip that goes uncovered. Pre-rolling cannot leak the image
      // early, since `enable=` alone decides visibility and still carries the true `absStart`
      // (verified: no overlay drawn anywhere before the clip's own start).
      if (hasFade) {
        const loopDuration = t(Math.max(w.endOffset - w.startOffset, 1 / fps));
        inputs.push("-itsoffset", t(absStart), "-loop", "1", "-framerate", String(fps), "-t", loopDuration, "-i", w.imagePath);
      } else {
        inputs.push("-itsoffset", t(Math.max(0, absStart - 1 / fps)), "-i", w.imagePath);
      }
      const winLabel = `${outputLabel}_win${i}`;

      // Only the FIRST window carries a fade-in and only the LAST carries a fade-out — a clip's fade is
      // one ramp across its own edge, not something every individual window repeats. `enableEnd`
      // (rather than this window's own nominal `endOffset`) is what the fade-out's `st=` is measured
      // against, same "extends past the clip's own end for a crossfade" reasoning `TextFadeOut` and
      // `buildTextFadeParams` already document for every other text path here.
      const fadeStages: string[] = [];
      if (isFirst && fadeIn) fadeStages.push(`fade=t=in:st=${t(clipStart)}:d=${t(fadeIn)}:alpha=1`);
      if (isLast && fadeOut) fadeStages.push(`fade=t=out:st=${t(enableEnd - fadeOut.duration)}:d=${t(fadeOut.duration)}:alpha=1`);
      const fadeStage = fadeStages.length > 0 ? `,${fadeStages.join(",")}` : "";
      filters.push(`[${idx}:v]format=rgba${fadeStage}[${winLabel}]`);

      // The last window's own gate extends to `enableEnd`, not just its own `endOffset` — same
      // "last slice reaches the real fade-adjusted end" shape the `cropSlices` chain below uses, needed
      // so a crossfade-extended fade-out stays visible for its own full ramp instead of being cut off
      // exactly at the clip's nominal end.
      const stepLabel = isLast ? outputLabel : `${outputLabel}_ov${i}`;
      const gateEnd = isLast ? enableEnd : clipStart + w.endOffset;
      filters.push(
        `${chainInput}[${winLabel}]overlay=format=auto:enable='between(t\\,${t(absStart)}\\,${t(gateEnd)})'[${stepLabel}]`
      );
      chainInput = `[${stepLabel}]`;
    });
  }

  // ---- Transitions -------------------------------------------------------------------------------
  //
  // Every style is built to match `PlaybackEngine.compositeTransitionFrame`/`compositeSoloReveal`
  // frame for frame, sharing their curves through `timeline/transitionMotion.ts`. FFmpeg's own
  // `xfade` shapes are only used where they already ARE the preview's shape (fade, wipe, slide) —
  // its `vuslice`/`vdslice` are horizontal bands rather than the preview's vertical-strip cascade, and
  // its `circleopen`/`circleclose` are a very soft blob that barely moves until late in the blend, so
  // those two are composed from `crop`/`overlay`/a mask instead.
  //
  // Per-pixel expression filters (`xfade=custom`, `geq`) were measured at ~1s and ~0.3s per 1080×1920
  // frame respectively, so everything that runs on BOTH sides of every two-clip transition uses native
  // filters driven by per-frame expressions (`overlay`/`crop`/`scale` accept `t`) or by a `sendcmd`
  // schedule (`gblur`/`rgbashift`/`colorlevels` accept runtime commands — measured working per frame
  // against the bundled FFmpeg 6.1). `geq` is limited to narrow ripple displacement maps and
  // quarter-resolution circle masks, avoiding full-resolution per-pixel expression evaluation.

  /** Timebase the eased `xfade` styles re-time their inputs onto — fine enough that easing squeezes
   *  consecutive frames' timestamps together without any two collapsing onto the same tick. */
  const EASE_TIMEBASE = "1/1000000";

  /** A `sendcmd` filter applying each entry's commands from its `time` onward. Times are nudged
   *  0.5ms early so a command meant for the frame at exactly `n/fps` is always already in effect when
   *  that frame arrives, rather than depending on how its 6-decimal rounding happens to fall. */
  function sendcmd(entries: { time: number; commands: string[] }[]): string {
    const intervals = entries.map((e) => `${Math.max(0, e.time - 0.0005).toFixed(6)} ${e.commands.join(",")}`);
    return `sendcmd=c='${intervals.join(";")}'`;
  }

  /** Output frame times across `[start, start + length)`. */
  function frameTimesIn(start: number, length: number): number[] {
    const first = Math.ceil(start * fps - 1e-6);
    const last = Math.ceil((start + length) * fps - 1e-6) - 1;
    const times: number[] = [];
    for (let frame = Math.max(0, first); frame <= last; frame++) times.push(frame / fps);
    return times;
  }

  /** `if(lt(t,b1),v0,if(lt(t,b2),v1,...vN))` — a piecewise-constant function of time, for values that
   *  hold for a whole glitch burst. Boundaries are nudged early for the same reason `sendcmd`'s are. */
  function piecewiseExpr(boundaries: number[], values: string[]): string {
    let expr = values[values.length - 1];
    for (let i = boundaries.length - 1; i >= 0; i--) expr = `if(lt(t,${(boundaries[i] - 0.0005).toFixed(6)}),${values[i]},${expr})`;
    return expr;
  }

  /** `sum of between(t,a,b)` over the given half-open windows — an `enable=` expression. */
  function windowsExpr(windows: [number, number][]): string {
    if (windows.length === 0) return "0";
    return windows.map(([a, b]) => `between(t,${(a - 0.0005).toFixed(6)},${(b - 0.0006).toFixed(6)})`).join("+");
  }

  /** The glitch-cut corruption (channel split + torn bands) for one stream, over bursts `0..count-1`
   *  starting at stream time `start`, each burst's intensity given by `intensityFor`. Returns the
   *  corrupted label. Matches `applyGlitchCut`: bands tear the already channel-split image, and a
   *  band's vacated edge keeps the un-torn pixels underneath. */
  function pushGlitchCutCorruption(
    label: string,
    name: string,
    start: number,
    burstCount: number,
    intensityFor: (burstIndex: number) => number,
    enable: string | null
  ): string {
    const bursts = Array.from({ length: burstCount }, (_, b) => glitchCutBurst(b, intensityFor(b)));
    const burstStart = (b: number) => start + b * GLITCH_CUT_BURST_SECONDS;
    const entries = bursts.map((burst, b) => ({
      time: burstStart(b),
      commands: [`rgbashift@${name} rh ${Math.round(burst.shiftR * width)}`, `rgbashift@${name} bh ${Math.round(burst.shiftB * width)}`],
    }));
    // Back to untouched once the last burst ends (a solo window sits inside a longer clip).
    entries.push({ time: burstStart(burstCount), commands: [`rgbashift@${name} rh 0`, `rgbashift@${name} bh 0`] });
    const bandHeight = Math.max(1, Math.round(height * GLITCH_CUT_BAND_HEIGHT_FRACTION));
    const boundaries = Array.from({ length: burstCount }, (_, b) => burstStart(b + 1));
    const splitLabels = Array.from({ length: GLITCH_CUT_BAND_COUNT }, (_, i) => `${label}_gb${i}`);
    filters.push(
      `[${label}]format=gbrap,${sendcmd(entries)},rgbashift@${name}=rh=0:bh=0:edge=smear,split=${GLITCH_CUT_BAND_COUNT + 1}[${label}_gs]${splitLabels
        .map((l) => `[${l}]`)
        .join("")}`
    );
    let chain = `${label}_gs`;
    for (let i = 0; i < GLITCH_CUT_BAND_COUNT; i++) {
      const tops = [...bursts.map((burst) => String(Math.round(burst.bands[i].top * height))), "0"];
      const shifts = [...bursts.map((burst) => String(Math.round(burst.bands[i].shift * width))), "0"];
      const yExpr = piecewiseExpr(boundaries, tops);
      const xExpr = piecewiseExpr(boundaries, shifts);
      const next = `${label}_go${i}`;
      filters.push(`[${splitLabels[i]}]crop=w=${width}:h=${bandHeight}:x=0:y='${yExpr}'[${splitLabels[i]}c]`);
      filters.push(`[${chain}][${splitLabels[i]}c]overlay=x='${xExpr}':y='${yExpr}':format=auto${enable ? `:enable='${enable}'` : ""}[${next}]`);
      chain = next;
    }
    return chain;
  }

  /** Sigma per output frame of a blur that ramps with `intensityAt(time)`, as `sendcmd` entries for
   *  `gblur@name` — plus a reset to 0 at `resetAt`, when given. `vertical` false leaves `sigmaV` at
   *  the 0 it was created with (the whip pan's horizontal-only smear); true sends both, since a
   *  runtime `sigma` change does NOT re-derive a `sigmaV` of -1 ("same as sigma") the way the initial
   *  option does — measured: the result smeared horizontally only. */
  function blurSchedule(name: string, times: number[], sigmaAt: (time: number) => number, vertical: boolean, resetAt?: number): string {
    const entries = times.map((time) => {
      const sigma = n(sigmaAt(time));
      return { time, commands: vertical ? [`gblur@${name} sigma ${sigma}`, `gblur@${name} sigmaV ${sigma}`] : [`gblur@${name} sigma ${sigma}`] };
    });
    if (resetAt !== undefined) {
      entries.push({ time: resetAt, commands: vertical ? [`gblur@${name} sigma 0`, `gblur@${name} sigmaV 0`] : [`gblur@${name} sigma 0`] });
    }
    return sendcmd(entries);
  }

  /** A centered zoom whose factor is `1 + ZOOM_BLUR_SCALE × k(t)`, followed by a blur of
   *  `ZOOM_BLUR_SIGMA_PX × k` — `drawZoomedWithBlur`'s shape. `kExpr` is `k` as an FFmpeg expression of
   *  `t`; `kAt` is the same function in JS (for the blur schedule). Scaling up then cropping back to
   *  the sequence size. Both scale size and crop offsets must use the per-frame zoom expression:
   *  crop's default centering retains the initial input dimensions when upstream scale changes,
   *  anchoring the zoom at the top-left. `setsar=1` because rounding each side nudges the
   *  sample aspect ratio off 1:1, which `concat` rejects. */
  function zoomBlurStages(name: string, kExpr: string, kAt: (time: number) => number, times: number[], resetAt?: number, enable?: string): string {
    const factor = `(1+${n(ZOOM_BLUR_SCALE)}*(${kExpr}))`;
    const zoomWidth = `ceil(${width}*${factor}/2)*2`;
    const zoomHeight = `ceil(${height}*${factor}/2)*2`;
    return (
      `scale=w='${zoomWidth}':h='${zoomHeight}':eval=frame,` +
      `crop=w=${width}:h=${height}:x='(${zoomWidth}-${width})/2':y='(${zoomHeight}-${height})/2',setsar=1,` +
      `${blurSchedule(name, times, (time) => ZOOM_BLUR_SIGMA_PX * kAt(time), true, resetAt)},gblur@${name}=sigma=0:sigmaV=0${enable ? `:enable='${enable}'` : ""}`
    );
  }

  /** Build the white pulse as an explicit alpha layer. Evaluating the envelope on a 2x2
   *  image avoids per-pixel expression work at export resolution and runtime color commands
   *  that can leave the flash unchanged on mobile FFmpeg builds. `intensity` uses source time T. */
  function pushFlash(label: string, output: string, length: number, intensity: string, enable?: string): void {
    const index = inputIndex++;
    inputs.push("-f", "lavfi", "-t", t(length), "-i", `color=c=white:s=2x2:r=${fps},format=rgba`);
    const name = `${output}_white`;
    filters.push(
      `[${index}:v]geq=r=255:g=255:b=255:a='255*${n(FLASH_ZOOM_PEAK)}*clip(${intensity},0,1)',` +
      `scale=w=${width}:h=${height}:flags=neighbor[${name}]`
    );
    filters.push(`[${label}][${name}]overlay=format=auto${enable ? `:enable='${enable}'` : ""}[${output}]`);
  }

  /** Whip-pan's horizontal motion blur. The preview smears with a box of radius
   *  `WHIP_PAN_BLUR_RADIUS_PX × k`; a box that wide has a standard deviation of about radius/√3, which
   *  is the Gaussian sigma used here. */
  function whipBlurStages(name: string, kAt: (time: number) => number, times: number[], resetAt?: number, enable?: string): string {
    return (
      `${blurSchedule(name, times, (time) => (WHIP_PAN_BLUR_RADIUS_PX * kAt(time)) / Math.sqrt(3), false, resetAt)},` +
      `gblur@${name}=sigma=0:sigmaV=0${enable ? `:enable='${enable}'` : ""}`
    );
  }

  /** Water-ripples `label` with `displace`: every row shifts sideways by
   *  `WATER_RIPPLE_AMPLITUDE_PX × ramp × sin(y/λ + t·rate)` — `applyWaterRipple`'s formula. The shift
   *  map is generated two pixels wide (the offset only depends on the row; `color` rejects a width
   *  of 1) and stretched across the frame, so the per-pixel `sin` the old `geq=` version evaluated
   *  W×H×3 times a frame (≈5s for a one-second 360×640 blend, far more at full resolution) runs
   *  H times instead. `rampExpr` is an
   *  expression of the map's own `T`, which runs from 0 over `length` seconds; `start` places the map
   *  at that stream time. Maps carry the same value in all four planes, since `displace` offsets each
   *  plane by its own map plane — alpha included. */
  function pushRipple(label: string, outLabel: string, start: number, length: number, rampExpr: string): void {
    const rate = (2 * Math.PI) / WATER_RIPPLE_PERIOD_SECONDS;
    const xIndex = inputIndex++;
    inputs.push("-f", "lavfi", "-t", t(length), "-i", `color=c=gray:s=2x${height}:r=${fps}`);
    const yIndex = inputIndex++;
    inputs.push("-f", "lavfi", "-t", t(length), "-i", `color=c=0x80808080:s=${width}x${height}:r=${fps}`);
    const shift = start > 0 ? `,setpts=PTS+${t(start)}/TB` : "";
    // +128.5 then truncation = round-to-nearest, matching the preview's `Math.round(x + offset)`.
    const value = `128.5+${n(WATER_RIPPLE_AMPLITUDE_PX)}*(${rampExpr})*sin(Y/${n(WATER_RIPPLE_WAVELENGTH_PX)}+(T+${t(start)})*${n(rate)})`;
    filters.push(
      `[${xIndex}:v]format=gbrap,geq=r='${value}':g='${value}':b='${value}':a='${value}',scale=${width}:${height}:flags=neighbor,setsar=1,setpts=PTS-STARTPTS${shift}[${outLabel}_xm]`
    );
    filters.push(`[${yIndex}:v]format=gbrap,setsar=1,setpts=PTS-STARTPTS${shift}[${outLabel}_ym]`);
    filters.push(`[${label}]format=gbrap[${outLabel}_src]`);
    filters.push(`[${outLabel}_src][${outLabel}_xm][${outLabel}_ym]displace=edge=smear[${outLabel}]`);
  }

  /** A grayscale circle mask (255 inside, 1px anti-aliased edge) of radius `radiusExpr` (an expression
   *  of the mask's own `T`, 0 over `length`), placed at stream time `start`. Drawn at a quarter of the
   *  frame's resolution and scaled up — a full-resolution `geq` measured ~1.5s per blend even at
   *  360×640, and the upscale only softens the edge by a couple of pixels. */
  function pushCircleMask(outLabel: string, start: number, length: number, radiusExpr: string): void {
    const scale = 0.25;
    const maskWidth = Math.max(2, Math.round(width * scale));
    const maskHeight = Math.max(2, Math.round(height * scale));
    const index = inputIndex++;
    inputs.push("-f", "lavfi", "-t", t(length), "-i", `color=c=black:s=${maskWidth}x${maskHeight}:r=${fps}`);
    const shift = start > 0 ? `,setpts=PTS+${t(start)}/TB` : "";
    filters.push(
      `[${index}:v]format=gray,geq=lum='255*clip((${radiusExpr})*${n(scale)}-hypot(X-${n(maskWidth / 2)},Y-${n(maskHeight / 2)})+0.5,0,1)',` +
        `scale=${width}:${height}:flags=bilinear,setsar=1,setpts=PTS-STARTPTS${shift}[${outLabel}]`
    );
  }

  /** `label` with its alpha multiplied by the grayscale `maskLabel` — keeps an overlay track's own
   *  transparent letterboxing transparent inside a revealed region. */
  function pushMaskedAlpha(label: string, maskLabel: string, outLabel: string): void {
    filters.push(`[${label}]format=rgba,split=2[${outLabel}_c][${outLabel}_a]`);
    filters.push(`[${outLabel}_a]alphaextract[${outLabel}_al]`);
    filters.push(`[${outLabel}_al][${maskLabel}]blend=all_mode=multiply[${outLabel}_m]`);
    filters.push(`[${outLabel}_c][${outLabel}_m]alphamerge[${outLabel}]`);
  }

  /** Blends `fromLabel` into `toLabel` (both exactly `D` seconds, starting at 0) as `type`, writing
   *  `outLabel`. See the section comment above for how each style is built. */
  function pushTransitionBlend(fromLabel: string, toLabel: string, type: TransitionType, D: number, outLabel: string, transparent: boolean): void {
    const family = transitionFamily(type);
    const q = `clip(t/${t(D)},0,1)`;
    const times = frameTimesIn(0, D);
    const midpointExpr = `4*${q}*(1-${q})`;
    const midpointAt = (time: number) => midpointIntensity(time / D);
    const retime = `settb=${EASE_TIMEBASE},setpts='${t(D)}*(${easeTransitionExpr(`clip(T/${t(D)},0,1)`)})/TB'`;
    // Undo any easing re-time: one frame per `1/fps` again, whatever timestamps the blend produced.
    const finish = `setpts=N/(${fps}*TB)`;

    const easedXfade = (xfadeName: string, from: string, to: string) => {
      filters.push(`[${from}]${retime}[${fromLabel}_e]`);
      filters.push(`[${to}]${retime}[${toLabel}_e]`);
      filters.push(`[${fromLabel}_e][${toLabel}_e]xfade=transition=${xfadeName}:duration=${t(D)}:offset=0,${finish}[${outLabel}]`);
    };

    if (family.kind === "wipe") {
      easedXfade(`wipe${family.edge}`, fromLabel, toLabel);
      return;
    }
    if (family.kind === "slide") {
      easedXfade(`slide${family.edge}`, fromLabel, toLabel);
      return;
    }
    if (family.kind === "whipPan") {
      filters.push(`[${fromLabel}]${whipBlurStages(`${fromLabel}_wb`, midpointAt, times)}[${fromLabel}_w]`);
      filters.push(`[${toLabel}]${whipBlurStages(`${toLabel}_wb`, midpointAt, times)}[${toLabel}_w]`);
      easedXfade(`slide${family.edge}`, `${fromLabel}_w`, `${toLabel}_w`);
      return;
    }

    if (family.kind === "slice") {
      // Each strip of each side is cropped out and overlaid onto a blank frame at its own eased,
      // staggered offset — the preview's per-strip push, column for column (`sliceStripBounds`).
      const sign = family.direction === "up" ? -1 : 1;
      const staggerStep = SLICE_STRIP_COUNT > 1 ? (1 - SLICE_WIPE_FRACTION) / (SLICE_STRIP_COUNT - 1) : 0;
      const bgIndex = inputIndex++;
      inputs.push("-f", "lavfi", "-t", t(D), "-i", `color=c=${transparent ? "black@0" : "black"}:s=${width}x${height}:r=${fps}${transparent ? ",format=rgba" : ""}`);
      const fromStrips = Array.from({ length: SLICE_STRIP_COUNT }, (_, i) => `${fromLabel}_s${i}`);
      const toStrips = Array.from({ length: SLICE_STRIP_COUNT }, (_, i) => `${toLabel}_s${i}`);
      filters.push(`[${fromLabel}]split=${SLICE_STRIP_COUNT}${fromStrips.map((l) => `[${l}]`).join("")}`);
      filters.push(`[${toLabel}]split=${SLICE_STRIP_COUNT}${toStrips.map((l) => `[${l}]`).join("")}`);
      let chain = `${outLabel}_sb`;
      filters.push(`[${bgIndex}:v]setsar=1,setpts=PTS-STARTPTS[${chain}]`);
      for (let i = 0; i < SLICE_STRIP_COUNT; i++) {
        const { x, width: stripWidth } = sliceStripBounds(width, i);
        const local = easeTransitionExpr(`clip((t/${t(D)}-${n(i * staggerStep)})/${n(SLICE_WIPE_FRACTION)},0,1)`);
        filters.push(`[${fromStrips[i]}]crop=w=${stripWidth}:h=${height}:x=${x}:y=0[${fromStrips[i]}c]`);
        filters.push(`[${toStrips[i]}]crop=w=${stripWidth}:h=${height}:x=${x}:y=0[${toStrips[i]}c]`);
        const afterFrom = `${outLabel}_s${i}f`;
        const afterTo = `${outLabel}_s${i}t`;
        filters.push(`[${chain}][${fromStrips[i]}c]overlay=x=${x}:y='${sign}*${height}*(${local})':format=auto[${afterFrom}]`);
        filters.push(`[${afterFrom}][${toStrips[i]}c]overlay=x=${x}:y='${-sign}*${height}*(1-(${local}))':format=auto[${afterTo}]`);
        chain = afterTo;
      }
      filters.push(`[${chain}]${finish}[${outLabel}]`);
      return;
    }

    if (family.kind === "circle") {
      // A crisp circle from a grayscale mask, multiplied into the inner side's own alpha (so an overlay
      // track's transparent letterboxing stays transparent inside the circle), laid over the outer side.
      const maxRadius = Math.hypot(width, height) / 2;
      const eased = easeTransitionExpr(`clip(T/${t(D)},0,1)`);
      pushCircleMask(`${outLabel}_mask`, 0, D, family.opening ? `${n(maxRadius)}*(${eased})` : `${n(maxRadius)}*(1-(${eased}))`);
      pushMaskedAlpha(family.opening ? toLabel : fromLabel, `${outLabel}_mask`, `${outLabel}_im`);
      filters.push(`[${family.opening ? fromLabel : toLabel}][${outLabel}_im]overlay=format=auto,${finish}[${outLabel}]`);
      return;
    }

    if (family.kind === "glitch") {
      // Both sides corrupted by the same bursts, then a hard switch: the incoming side is laid over
      // the outgoing one only during the bursts `glitchCutShowsIncoming` picks.
      const burstCount = Math.ceil(D / GLITCH_CUT_BURST_SECONDS - 1e-6);
      const intensityFor = (b: number) => midpointIntensity(glitchCutBurstProgress(b, D));
      const fromG = pushGlitchCutCorruption(fromLabel, `${fromLabel}_g`, 0, burstCount, intensityFor, null);
      const toG = pushGlitchCutCorruption(toLabel, `${toLabel}_g`, 0, burstCount, intensityFor, null);
      const windows: [number, number][] = [];
      for (let b = 0; b < burstCount; b++) {
        if (!glitchCutShowsIncoming(b, D)) continue;
        const start = b * GLITCH_CUT_BURST_SECONDS;
        const end = Math.min(D + 1, (b + 1) * GLITCH_CUT_BURST_SECONDS);
        const last = windows[windows.length - 1];
        if (last && Math.abs(last[1] - start) < 1e-9) last[1] = end;
        else windows.push([start, end]);
      }
      // The final burst can end before the last frame — anything after it shows the incoming clip.
      const lastWindow = windows[windows.length - 1];
      if (lastWindow && lastWindow[1] >= burstCount * GLITCH_CUT_BURST_SECONDS - 1e-9) lastWindow[1] = D + 1;
      filters.push(`[${fromG}][${toG}]overlay=format=auto:enable='${windowsExpr(windows)}',${finish}[${outLabel}]`);
      return;
    }

    let fromBlend = fromLabel;
    let toBlend = toLabel;
    if (family.kind === "waterRipple") {
      const ramp = `4*clip(T/${t(D)},0,1)*(1-clip(T/${t(D)},0,1))`;
      pushRipple(fromLabel, `${fromLabel}_fx`, 0, D, ramp);
      pushRipple(toLabel, `${toLabel}_fx`, 0, D, ramp);
      fromBlend = `${fromLabel}_fx`;
      toBlend = `${toLabel}_fx`;
    } else if (family.kind === "zoomBlur" || family.kind === "flashZoom") {
      filters.push(`[${fromLabel}]${zoomBlurStages(`${fromLabel}_zb`, midpointExpr, midpointAt, times)}[${fromLabel}_fx]`);
      filters.push(`[${toLabel}]${zoomBlurStages(`${toLabel}_zb`, midpointExpr, midpointAt, times)}[${toLabel}_fx]`);
      fromBlend = `${fromLabel}_fx`;
      toBlend = `${toLabel}_fx`;
    }
    // Crossfade the processed sides, then place the white pulse above the result (also over
    // transparent pixels), matching Canvas fillRect on both base and overlay tracks.
    const hasFlash = family.kind === "flashZoom";
    const blended = hasFlash ? `${outLabel}_preflash` : outLabel;
    filters.push(`[${fromBlend}][${toBlend}]xfade=transition=fade:duration=${t(D)}:offset=0,${finish}[${blended}]`);
    if (hasFlash) pushFlash(blended, outLabel, D, `4*clip(T/${t(D)},0,1)*(1-clip(T/${t(D)},0,1))`);
  }

  /** The solo fade-in/fade-out window(s) of one clip — `compositeSoloReveal`'s export counterpart.
   *  `label` is the clip's fully-built stream (the whole segment, `sliceDuration` long); writes
   *  `outputLabel`.
   *
   *  Every styled window works the same way: the clip is `split`, the main copy is blanked to black (or
   *  to transparent, on an overlay track) for just the window with a timeline-gated `drawbox`, and the
   *  other copy is `trim`med to the window, restyled, and `overlay`ed back on top — so the per-frame
   *  work only ever runs for the window's own frames, never the whole clip (the first version used
   *  window-gated `geq`, which measured ~15-30s of extra export time per clip). Timestamps are left
   *  as-is through `trim`, so every `t` below is the segment's own time. Blending styles then alpha-
   *  fade like a crossfade does; purely geometric ones (wipe/slide/slice/circle) don't, same as the
   *  preview. */
  function pushSoloTransitionStages(
    label: string,
    outputLabel: string,
    clip: Clip,
    sliceDuration: number,
    transparent: boolean,
    fadeIn?: number,
    fadeOut?: number
  ): void {
    const windows: { type: TransitionType; start: number; length: number; fadingOut: boolean; tag: string }[] = [];
    if (fadeIn) windows.push({ type: clip.transitionIn?.type ?? "crossfade", start: 0, length: fadeIn, fadingOut: false, tag: "in" });
    if (fadeOut) windows.push({ type: clip.transitionOut?.type ?? "crossfade", start: sliceDuration - fadeOut, length: fadeOut, fadingOut: true, tag: "out" });

    let current = label;
    const fades: string[] = [];
    // Stages that must come AFTER the alpha fade — the flash pulse is drawn over the fading clip in the
    // preview (`compositeSoloReveal` fills white on top), not faded to black along with it.
    const flashes: { intensity: string; enable: string }[] = [];
    for (const w of windows) {
      const family = transitionFamily(w.type);
      const alphaFade = `fade=t=${w.fadingOut ? "out" : "in"}:st=${t(w.start)}:d=${t(w.length)}${transparent ? ":alpha=1" : ""}`;
      if (family.kind === "dissolve") {
        fades.push(alphaFade);
        continue;
      }

      const name = `${label}_${w.tag}`;
      const end = w.start + w.length;
      // trim excludes the end frame. Blanking must exclude it too or eof_action=pass exposes one
      // blank frame between the styled window and the remainder of the clip.
      const enable = `gte(t,${t(w.start)})*lt(t,${t(end)})`;
      // Reveal (0 hidden → 1 shown) as an expression of stream time, and in JS.
      const reveal = (v: string) => (w.fadingOut ? `clip(1-(${v}-${t(w.start)})/${t(w.length)},0,1)` : `clip((${v}-${t(w.start)})/${t(w.length)},0,1)`);
      const revealAt = (time: number) => Math.min(1, Math.max(0, w.fadingOut ? 1 - (time - w.start) / w.length : (time - w.start) / w.length));
      const eased = easeTransitionExpr(reveal("t"));
      const times = frameTimesIn(w.start, w.length);

      filters.push(`[${current}]${transparent ? "format=rgba," : ""}split=2[${name}_m][${name}_s]`);
      filters.push(
        `[${name}_m]drawbox=x=0:y=0:w=iw:h=ih:color=${transparent ? "black@0" : "black"}:t=fill${transparent ? ":replace=1" : ""}:enable='${enable}'[${name}_mb]`
      );
      filters.push(`[${name}_s]trim=start=${t(w.start)}:end=${t(end)}[${name}_w]`);
      // Layers to place over the blanked window, each at its own (possibly per-frame) position.
      const layers: { label: string; x: string; y: string }[] = [];

      if (family.kind === "wipe") {
        // The clip stays put while the revealed edge moves: pad a blank frame beside it, then take a
        // frame-sized window of that at the edge's position and place it at the same position — the
        // clip's pixels land exactly where they started, and the pad fills what isn't revealed yet.
        const horizontal = family.edge === "left" || family.edge === "right";
        const size = horizontal ? width : height;
        // Offset of the revealed region's leading edge: "left"/"up" reveal from the far edge inward.
        const offset = family.edge === "left" || family.edge === "up" ? `${size}*(1-(${eased}))` : `${size}*(${eased})-${size}`;
        const padColor = transparent ? "black@0" : "black";
        const pad = horizontal
          ? `pad=w=${2 * width}:h=${height}:x=${family.edge === "left" ? 0 : width}:y=0:color=${padColor}`
          : `pad=w=${width}:h=${2 * height}:x=0:y=${family.edge === "up" ? 0 : height}:color=${padColor}`;
        const cropAt = family.edge === "left" || family.edge === "up" ? offset : `${size}+(${offset})`;
        const crop = horizontal ? `crop=w=${width}:h=${height}:x='${cropAt}':y=0` : `crop=w=${width}:h=${height}:x=0:y='${cropAt}'`;
        filters.push(`[${name}_w]${pad},${crop}[${name}_l]`);
        layers.push(horizontal ? { label: `${name}_l`, x: offset, y: "0" } : { label: `${name}_l`, x: "0", y: offset });
      } else if (family.kind === "slide") {
        const horizontal = family.edge === "left" || family.edge === "right";
        const sign = family.edge === "left" || family.edge === "up" ? -1 : 1;
        const shift = `${-sign}*${horizontal ? width : height}*(1-(${eased}))`;
        layers.push(horizontal ? { label: `${name}_w`, x: shift, y: "0" } : { label: `${name}_w`, x: "0", y: shift });
      } else if (family.kind === "slice") {
        const sign = family.direction === "up" ? -1 : 1;
        const staggerStep = SLICE_STRIP_COUNT > 1 ? (1 - SLICE_WIPE_FRACTION) / (SLICE_STRIP_COUNT - 1) : 0;
        const strips = Array.from({ length: SLICE_STRIP_COUNT }, (_, i) => `${name}_s${i}`);
        filters.push(`[${name}_w]split=${SLICE_STRIP_COUNT}${strips.map((l) => `[${l}]`).join("")}`);
        strips.forEach((strip, i) => {
          const { x, width: stripWidth } = sliceStripBounds(width, i);
          const local = easeTransitionExpr(`clip((${reveal("t")}-${n(i * staggerStep)})/${n(SLICE_WIPE_FRACTION)},0,1)`);
          filters.push(`[${strip}]crop=w=${stripWidth}:h=${height}:x=${x}:y=0[${strip}c]`);
          layers.push({ label: `${strip}c`, x: String(x), y: `${-sign}*${height}*(1-(${local}))` });
        });
      } else if (family.kind === "circle") {
        const maxRadius = Math.hypot(width, height) / 2;
        pushCircleMask(`${name}_mask`, w.start, w.length, `${n(maxRadius)}*(${easeTransitionExpr(reveal(`(T+${t(w.start)})`))})`);
        pushMaskedAlpha(`${name}_w`, `${name}_mask`, `${name}_l`);
        layers.push({ label: `${name}_l`, x: "0", y: "0" });
      } else if (family.kind === "glitch") {
        const burstCount = Math.ceil(w.length / GLITCH_CUT_BURST_SECONDS - 1e-6);
        const corrupted = pushGlitchCutCorruption(`${name}_w`, name, w.start, burstCount, (b) => {
          const burstProgress = glitchCutBurstProgress(b, w.length);
          return w.fadingOut ? burstProgress : 1 - burstProgress;
        }, null);
        layers.push({ label: corrupted, x: "0", y: "0" });
      } else if (family.kind === "waterRipple") {
        // Strongest at the hidden end of the window, gone once fully shown — the preview's `1 − reveal`.
        const ramp = w.fadingOut ? `clip(T/${t(w.length)},0,1)` : `(1-clip(T/${t(w.length)},0,1))`;
        pushRipple(`${name}_w`, `${name}_l`, w.start, w.length, ramp);
        layers.push({ label: `${name}_l`, x: "0", y: "0" });
      } else if (family.kind === "zoomBlur" || family.kind === "flashZoom") {
        const kAt = (time: number) => 1 - revealAt(time);
        if (family.kind === "flashZoom") {
          flashes.push({ intensity: `1-(${reveal("T")})`, enable });
        }
        filters.push(`[${name}_w]${zoomBlurStages(`${name}_zb`, `1-${reveal("t")}`, kAt, times)}[${name}_l]`);
        layers.push({ label: `${name}_l`, x: "0", y: "0" });
      } else if (family.kind === "whipPan") {
        // Blurred, then slid in from / out to the named edge — same order as the two-clip whip pan.
        const sign = family.edge === "left" ? -1 : 1;
        filters.push(`[${name}_w]${whipBlurStages(`${name}_wb`, (time) => 1 - revealAt(time), times)}[${name}_l]`);
        layers.push({ label: `${name}_l`, x: `${-sign}*${width}*(1-(${eased}))`, y: "0" });
      }

      let chain = `${name}_mb`;
      layers.forEach((layer, i) => {
        const next = i === layers.length - 1 ? `${name}_x` : `${name}_o${i}`;
        // `eof_action=pass`: once the window's trimmed layer ends, the (un-blanked) clip carries on.
        filters.push(`[${chain}][${layer.label}]overlay=x='${layer.x}':y='${layer.y}':format=auto:eof_action=pass[${next}]`);
        chain = next;
      });
      current = chain;
      if (family.kind !== "wipe" && family.kind !== "slide" && family.kind !== "slice" && family.kind !== "circle") fades.push(alphaFade);
    }

    const stages = fades;
    let faded = flashes.length ? `${outputLabel}_preflash` : outputLabel;
    filters.push(`[${current}]${stages.length > 0 ? stages.join(",") : "null"}[${faded}]`);
    flashes.forEach((flash, i) => {
      const next = i === flashes.length - 1 ? outputLabel : `${outputLabel}_flash${i}`;
      pushFlash(faded, next, sliceDuration, flash.intensity, flash.enable);
      faded = next;
    });
  }

  // Builds ONE video track's own segment-based concat chain — everything the single-track version of
  // this function used to do in its own top-level loop, now run once per visible video track and
  // producing that track's own `[cvT]`/`[caT]` pair instead of the fixed `[cv]`/`[ca]`. `trackIndex`
  // 0 is the base/bottom layer (opaque, unchanged from today); every other index is a layer that
  // composites ON TOP of it later, so its own gaps and letterbox padding need to stay transparent.
  function buildTrackStreams(track: Track, trackIndex: number): void {
    const transparent = trackIndex > 0;
    const segments = buildSegments(project, track, [...track.clips].sort((a, b) => a.timelineStart - b.timelineStart), options, duration);
    const concatLabels: string[] = [];

    for (const [i, segment] of segments.entries()) {
      const videoLabel = `v${trackIndex}_${i}`;
      const audioLabel = `a${trackIndex}_${i}`;

      if (segment.kind === "clip") {
        if (hasTransformKeyframes(segment.clip) || hasEffectsKeyframes(segment.clip) || hasColorGradingKeyframes(segment.clip)) {
          // `sourceIn` (not `segment.clip.sourceIn`) already accounts for a transition-shortened head
          // — see `buildSegments`'s own comment for why — so converting it back to clip-window-
          // relative time (the space `Keyframe.time` itself uses) is a plain subtraction.
          const elapsedAtSegmentStart = segment.elapsedStart;
          pushKeyframedClipVideoFilters(
            segment.clip,
            segment.path,
            segment.isImage,
            elapsedAtSegmentStart,
            videoLabel,
            segment.duration,
            transparent,
            segment.fadeIn,
            segment.fadeOut
          );
          pushKeyframedAudio(segment.clip, segment.path, segment.isImage, segment.hasAudio && !track.muted, elapsedAtSegmentStart, audioLabel, segment.duration, segment.fadeIn, segment.fadeOut);
        } else {
          if (segment.isImage) {
            // A still has no timeline to seek into — `-ss` would be meaningless and `-t` alone would
            // yield a single frame. `-loop 1` repeats the decoded image for the clip's duration, which
            // is what makes an image occupy real time on the timeline.
            pushImageInput(segment.clip, segment.path, segment.sourceIn, segment.duration, inputIndex);
          } else {
            // -ss and -t BEFORE -i: seek-then-decode, so only the needed range is read. `sourceIn` (not
            // `segment.clip.sourceIn`) is what accounts for a transition-shortened clip starting partway
            // into its own footage — see `buildSegments`'s own comment for why.
            pushVideoSourceInput(segment.clip, segment.path, segment.sourceIn, segment.duration, inputIndex, segment.elapsedStart);
          }
          const videoIndex = inputIndex++;
          pushClipVideoFilters(segment.clip, videoIndex, videoLabel, segment.duration, transparent, segment.fadeIn, segment.fadeOut);
          pushClipAudioFilters(
            segment.hasAudio && !segment.clip.mutedAudio && !track.muted,
            videoIndex,
            audioLabel,
            segment.duration,
            segment.clip.gain ?? 1,
            segment.fadeIn,
            segment.fadeOut,
            false,
            segment.clip,
            segment.elapsedStart
          );
        }
      } else if (segment.kind === "transition") {
        // Two small `-ss/-t` slices — the outgoing clip's own tail `D` seconds, the incoming clip's own
        // head `D` seconds — each normalized through the exact same per-clip filter chain a plain
        // segment uses, THEN blended with `xfade`/`acrossfade`. Both slices are already exactly `D`
        // seconds long and start together once prepared, so `offset=0` makes the entire prepared pair
        // the blend window rather than xfade waiting partway into a longer stream first. Empirically
        // verified against the real bundled FFmpeg binary (frame extraction + pixel sampling through
        // the blend) before being trusted, per this feature's own development notes.
        const D = segment.duration;
        const halfD = D / 2;
        const fromVideoLabel = `${videoLabel}_from`;
        const toVideoLabel = `${videoLabel}_to`;
        const fromAudioLabel = `${audioLabel}_from`;
        const toAudioLabel = `${audioLabel}_to`;
        const fromSourceIn = segment.from.sourceIn ?? (segment.from.clip.sourceOut - halfD);
        const toSourceIn = segment.to.sourceIn ?? (segment.to.clip.sourceIn - halfD);

        const fromElapsedAtSegmentStart = segment.from.elapsedStart ?? (fromSourceIn - segment.from.clip.sourceIn);
        const toElapsedAtSegmentStart = segment.to.elapsedStart ?? (toSourceIn - segment.to.clip.sourceIn);

        // Each side of a transition is keyframe-aware independently. The OUTGOING clip carries on past
        // its own out-point holding its final frame if the file runs out first.
        if (hasTransformKeyframes(segment.from.clip) || hasEffectsKeyframes(segment.from.clip) || hasColorGradingKeyframes(segment.from.clip)) {
          pushKeyframedClipVideoFilters(segment.from.clip, segment.from.path, segment.from.isImage, fromElapsedAtSegmentStart, fromVideoLabel, D, transparent);
          pushKeyframedAudio(segment.from.clip, segment.from.path, segment.from.isImage, segment.from.hasAudio && !track.muted, fromElapsedAtSegmentStart, fromAudioLabel, D, undefined, undefined, true);
        } else {
          if (segment.from.isImage) {
            pushImageInput(segment.from.clip, segment.from.path, fromSourceIn, D, inputIndex);
          } else {
            pushVideoSourceInput(segment.from.clip, segment.from.path, fromSourceIn, D, inputIndex, segment.from.elapsedStart);
          }
          const fromIndex = inputIndex++;
          pushClipVideoFilters(segment.from.clip, fromIndex, fromVideoLabel, D, transparent);
          pushClipAudioFilters(
            segment.from.hasAudio && !segment.from.clip.mutedAudio && !track.muted,
            fromIndex,
            fromAudioLabel,
            D,
            segment.from.clip.gain ?? 1,
            undefined,
            undefined,
            true,
            segment.from.clip,
            fromElapsedAtSegmentStart
          );
        }

        if (hasTransformKeyframes(segment.to.clip) || hasEffectsKeyframes(segment.to.clip) || hasColorGradingKeyframes(segment.to.clip)) {
          pushKeyframedClipVideoFilters(segment.to.clip, segment.to.path, segment.to.isImage, toElapsedAtSegmentStart, toVideoLabel, D, transparent);
          pushKeyframedAudio(segment.to.clip, segment.to.path, segment.to.isImage, segment.to.hasAudio && !track.muted, toElapsedAtSegmentStart, toAudioLabel, D);
        } else {
          if (segment.to.isImage) {
            pushImageInput(segment.to.clip, segment.to.path, toSourceIn, D, inputIndex);
          } else {
            pushVideoSourceInput(segment.to.clip, segment.to.path, toSourceIn, D, inputIndex, segment.to.elapsedStart);
          }
          const toIndex = inputIndex++;
          pushClipVideoFilters(segment.to.clip, toIndex, toVideoLabel, D, transparent);
          pushClipAudioFilters(
            segment.to.hasAudio && !segment.to.clip.mutedAudio && !track.muted,
            toIndex,
            toAudioLabel,
            D,
            segment.to.clip.gain ?? 1,
            undefined,
            undefined,
            false,
            segment.to.clip,
            toElapsedAtSegmentStart
          );
        }

        // `segment.to.clip` is the INCOMING side — `transitionIn` describes the blend FROM its partner
        // INTO it (see that field's own doc comment), matching exactly which clip `findTransitionPartner`
        // was resolved against to produce this segment in the first place.
        const transitionType = segment.to.clip.transitionIn?.type ?? "crossfade";
        pushTransitionBlend(fromVideoLabel, toVideoLabel, transitionType, D, videoLabel, transparent);
        filters.push(`[${fromAudioLabel}][${toAudioLabel}]acrossfade=d=${t(D)}[${audioLabel}]`);
      } else {
        const gapColor = transparent ? "black@0" : "black";
        // See `pushClipVideoFilters`'s own identical `,format=rgba` comment — a raw lavfi `color=...@0`
        // INPUT needs to be told to carry alpha itself, or the `@0` is silently dropped at the source.
        inputs.push(
          "-f",
          "lavfi",
          "-t",
          t(segment.duration),
          "-i",
          `color=c=${gapColor}:s=${width}x${height}:r=${fps}${transparent ? ",format=rgba" : ""}`
        );
        filters.push(`[${inputIndex++}:v]setsar=1,setpts=PTS-STARTPTS[${videoLabel}]`);
        pushSilentAudio(segment.duration, audioLabel);
      }

      concatLabels.push(`[${videoLabel}][${audioLabel}]`);
    }

    filters.push(`${concatLabels.join("")}concat=n=${segments.length}:v=1:a=1[cv${trackIndex}][ca${trackIndex}]`);
  }

  // The audio-only counterpart of `buildTrackStreams` above — same `buildSegments` walk, same
  // `pushClipAudioFilters`/`acrossfade` building blocks the video-track transition branch already
  // uses, just with every video-side call (`pushClipVideoFilters`, `xfade`, the video half of each
  // `concatLabels` entry) dropped entirely, since a dedicated audio track has no picture to composite.
  // This is what makes `Clip.transitionIn`/`transitionOut` actually DO something for a clip on an
  // audio track — before this, `audibleClips`-driven mixing below was a flat per-clip `adelay`+`amix`
  // that never consulted `findTransitionPartner`/`findTransitionOut` at all, so setting a transition
  // on a music/voiceover clip silently had zero effect on the export (transition fields aren't gated
  // to any track kind at the TYPE level — see `Clip.transitionIn`'s own doc comment — only certain
  // CONSUMERS of them were, and this was one of the ones that hadn't caught up yet).
  //
  // Only `"crossfade"` is meaningful for audio (confirmed by how every OTHER `TransitionType` renders:
  // `TRANSITION_XFADE_NAME` maps every one of them to a `xfade` VIDEO filter name, and FFmpeg's
  // `acrossfade` has no "shape" concept at all beyond a linear blend) — so unlike the video-track
  // branch above, this never reads `clip.transitionIn?.type` at all; every audio transition is simply
  // `acrossfade`, matching what the Inspector's Transitions tab actually offers an audio clip (no
  // Style picker — see `Inspector.tsx`'s own comment on why that control is hidden for `track.kind
  // === "audio"`).
  function buildAudioTrackStream(track: Track, trackIndex: number): string {
    const segments = buildSegments(project, track, [...track.clips].sort((a, b) => a.timelineStart - b.timelineStart), options, duration);
    const concatLabels: string[] = [];

    for (const [i, segment] of segments.entries()) {
      const audioLabel = `at${trackIndex}_${i}`;

      if (segment.kind === "clip") {
        if (segment.isImage) {
          // A dedicated audio track can never hold an image clip (`trackKindForAsset` refuses it), so
          // this branch is unreachable here — kept only because `Segment["kind"]["clip"]` is the same
          // shared shape `buildTrackStreams` above uses, and TypeScript can't otherwise know `isImage`
          // is always false for a clip that reached an audio track.
          inputs.push("-loop", "1", "-framerate", String(fps), "-t", t(segment.duration), "-i", segment.path);
        } else {
          inputs.push("-ss", t(segment.sourceIn), "-t", t(segment.duration), "-i", segment.path);
        }
        const audioIndex = inputIndex++;
        pushClipAudioFilters(
          segment.hasAudio && !segment.clip.mutedAudio,
          audioIndex,
          audioLabel,
          segment.duration,
          (segment.clip.gain ?? 1) * (track.gain ?? 1),
          segment.fadeIn,
          segment.fadeOut,
          false,
          segment.clip,
          segment.elapsedStart
        );
      } else if (segment.kind === "transition") {
        const D = segment.duration;
        const halfD = D / 2;
        const fromAudioLabel = `${audioLabel}_from`;
        const toAudioLabel = `${audioLabel}_to`;
        const fromSourceIn = segment.from.sourceIn ?? (segment.from.clip.sourceOut - halfD);
        const toSourceIn = segment.to.sourceIn ?? (segment.to.clip.sourceIn - halfD);

        // Same clip-window-relative offset `buildTrackStreams`' own transition branch computes for the
        // video-track case — see `buildGainVolumeExpr`'s own doc comment for why this is what a
        // keyframed gain expression needs to line up against.
        const fromElapsedAtSegmentStart = segment.from.elapsedStart ?? (fromSourceIn - segment.from.clip.sourceIn);
        // The outgoing clip carries on across the centered junction.
        inputs.push("-ss", t(fromSourceIn), "-t", t(D), "-i", segment.from.path);
        const fromIndex = inputIndex++;
        pushClipAudioFilters(
          segment.from.hasAudio && !segment.from.clip.mutedAudio,
          fromIndex,
          fromAudioLabel,
          D,
          (segment.from.clip.gain ?? 1) * (track.gain ?? 1),
          undefined,
          undefined,
          true,
          segment.from.clip,
          fromElapsedAtSegmentStart
        );

        const toIndex = inputIndex++;
        if (toSourceIn < -1e-6) {
          const underflow = -toSourceIn;
          const readDuration = Math.max(0, D - underflow);
          inputs.push("-ss", "0", "-t", t(readDuration), "-i", segment.to.path);
          audioInputDelay.set(toIndex, underflow);
        } else {
          inputs.push("-ss", t(toSourceIn), "-t", t(D), "-i", segment.to.path);
        }
        const toElapsedAtSegmentStart = segment.to.elapsedStart ?? (toSourceIn - segment.to.clip.sourceIn);
        pushClipAudioFilters(
          segment.to.hasAudio && !segment.to.clip.mutedAudio,
          toIndex,
          toAudioLabel,
          D,
          (segment.to.clip.gain ?? 1) * (track.gain ?? 1),
          undefined,
          undefined,
          false,
          segment.to.clip,
          toElapsedAtSegmentStart
        );

        filters.push(`[${fromAudioLabel}][${toAudioLabel}]acrossfade=d=${t(D)}[${audioLabel}]`);
      } else {
        pushSilentAudio(segment.duration, audioLabel);
      }

      concatLabels.push(`[${audioLabel}]`);
    }

    const outputLabel = `at${trackIndex}`;
    filters.push(`${concatLabels.join("")}concat=n=${segments.length}:v=0:a=1[${outputLabel}]`);

    // Applied ONCE on the track's own already-concatenated stream, not per-clip/per-segment above —
    // pan is linear and commutes fine either way, so doing it once here is both correct and cheaper
    // than threading it through every `pushClipAudioFilters` call.
    const panStage = buildPanFilterStage(track.pan ?? 0, n);
    if (panStage) {
      const pannedLabel = `${outputLabel}p`;
      filters.push(`[${outputLabel}]${panStage}[${pannedLabel}]`);
      return `[${pannedLabel}]`;
    }
    return `[${outputLabel}]`;
  }

  const videoTrackIndexMap = new Map<string, number>();
  const videoTrackAudioLabels: string[] = [];
  videoTracks.forEach((track, trackIndex) => {
    videoTrackIndexMap.set(track.id, trackIndex);
    buildTrackStreams(track, trackIndex);
    if (trackIndex > 0) {
      videoTrackAudioLabels.push(`[ca${trackIndex}]`);
    }
  });

  // Layers visual tracks in sequence order so text tracks placed under a cutout/overlay video track
  // render behind it, matching PlaybackEngine's drawVisualLayers order. Base video track [cv0] seeds
  // videoOut (guaranteed fully opaque everywhere). Later video tracks overlay over the accumulated
  // stream, and text tracks chain drawtext onto the accumulated stream.
  let videoOut = "[cv0]";
  let textIndex = 0;

  /** Composites one upper video track over the accumulated lower frame. The identity-only path stays
   * byte-for-byte identical. For a non-Normal mode, FFmpeg's `blend` computes the RGB result, then the
   * upper track's original alpha is restored before overlaying it. That last step is essential for
   * crops/rotation/masks/opacity: `blend=darken` treats transparent black as black and would otherwise
   * paint a black rectangle around the real clip, unlike Canvas compositing in preview. */
  function compositeVideoTrack(base: string, track: Track, trackIndex: number): string {
    const modes: ClipBlendMode[] = ["normal", "overlay", "screen", "darken", "lighten"];
    const groups = modes.flatMap((mode) => {
      const windows = track.clips
        .filter((clip) => (clip.blendMode ?? "normal") === mode)
        .map((clip) => [clip.timelineStart, clipEnd(clip)] as [number, number]);
      return windows.length ? [{ mode, windows }] : [];
    });

    if (groups.length === 1 && groups[0].mode === "normal") {
      const label = `layer${trackIndex}`;
      filters.push(`${base}[cv${trackIndex}]overlay=format=auto[${label}]`);
      return `[${label}]`;
    }

    const copies = groups.map((_, i) => `blend${trackIndex}_src${i}`);
    if (copies.length > 1) filters.push(`[cv${trackIndex}]split=${copies.length}${copies.map((label) => `[${label}]`).join("")}`);
    else copies[0] = `cv${trackIndex}`;

    let chain = base;
    groups.forEach(({ mode, windows }, groupIndex) => {
      const source = copies[groupIndex];
      const enable = windowsExpr(windows);
      const output = `layer${trackIndex}_${groupIndex}`;
      if (mode === "normal") {
        filters.push(`${chain}[${source}]overlay=format=auto:enable='${enable}'[${output}]`);
      } else {
        const prefix = `blend${trackIndex}_${groupIndex}`;
        filters.push(`${chain}split=2[${prefix}_base][${prefix}_fxbase]`);
        filters.push(`[${source}]format=rgba,split=2[${prefix}_upper][${prefix}_alpha_src]`);
        filters.push(`[${prefix}_fxbase][${prefix}_upper]blend=all_mode=${mode}[${prefix}_rgb]`);
        filters.push(`[${prefix}_alpha_src]alphaextract[${prefix}_alpha]`);
        filters.push(`[${prefix}_rgb]format=rgba,colorchannelmixer=aa=0[${prefix}_clear]`);
        filters.push(`[${prefix}_clear][${prefix}_alpha]alphamerge[${prefix}_masked]`);
        filters.push(`[${prefix}_base][${prefix}_masked]overlay=format=auto:enable='${enable}'[${output}]`);
      }
      chain = `[${output}]`;
    });
    return chain;
  }

  for (const track of project.sequence.tracks) {
    if (!track.visible) continue;

    if (track.kind === "video") {
      const vIdx = videoTrackIndexMap.get(track.id);
      if (vIdx !== undefined && vIdx > 0) {
        videoOut = compositeVideoTrack(videoOut, track, vIdx);
      }
    } else if (track.kind === "text") {
      if (track.clips.length === 0) continue;

    // Precomputed once per track: which clip is the OUTGOING side of some other clip's active
    // transition, and for how long — `findTransitionPartner` only ever answers "what do I blend FROM"
    // (a clip's own `transitionIn`), so the fade-OUT side has to be discovered by resolving every
    // clip's own partner and recording it against THAT partner's id instead. Mirrors how
    // `PlaybackEngine.drawTextLayer` finds the same relationship per-frame instead — this is the
    // export-time, whole-track equivalent, computed once rather than per frame.
    const fadeOutByClipId = new Map<string, number>();
    for (const clip of track.clips) {
      const transition = findTransitionPartner(track, clip);
      // A `null` partner is a solo fade-IN (see `findTransitionPartner`'s own doc comment) — there's
      // no OUTGOING clip to attribute a fade-out to in that case, so it contributes nothing here.
      if (transition?.partner) fadeOutByClipId.set(transition.partner.id, transition.duration);
    }

    for (const clip of track.clips) {
      const asset = findAsset(project, clip.assetId);
      if (!asset || asset.kind !== "text" || !asset.textStyle) continue;
      // `clip.textStyleKeyframes`, when armed, animates on EXPORT too, not just the preview — see
      // `buildKeyframedDrawTextCalls`/`buildKeyframedRotatedDrawTextCalls`'s own doc comments for how
      // (short static per-slice `drawtext` calls chained onto the stream, mirroring
      // `buildTypewriterDrawTextCalls`'s own shape, not video's `concat=`-based slicing — text has no
      // source media to re-cut). One deliberate priority decision: `textStyleKeyframes` wins over
      // `typewriter` when a clip somehow has both armed (checked via `hasTextStyleKeyframes` below,
      // reached before `buildDrawTextFilter`'s own internal typewriter branch ever would be) — combining
      // keyframe-slicing's position-driven chaining with typewriter's character-reveal-driven chaining
      // would need a genuine cross-product of two independent timing mechanisms, real scope beyond this
      // pass, same spirit as the `wordHighlight`-has-no-export-equivalent scope cut already documented
      // on `buildDrawTextFilter` itself. A keyframed+typewriter clip exports with full static text per
      // slice, motion intact, character-reveal ignored.
      const outputLabel = `txt${textIndex++}`;
      const fadeIn = findTransitionPartner(track, clip)?.duration;
      // Two independent sources for a text clip's own fade-out — never both at once (`findTransitionOut`
      // already returns `null` whenever a genuine successor exists at all) — but needing DIFFERENT
      // timing, so each is tagged with its own `extendsPastEnd`; see `TextFadeOut`'s own doc comment for
      // the full reasoning (a real crossfade into the next clip must stay visible past this clip's own
      // end to genuinely overlap the incoming clip's fade-in; a solo fade to nothing must NOT, fading
      // out during this clip's own existing tail instead, matching `PlaybackEngine`'s own solo-reveal
      // timing exactly).
      const crossfadeOutDuration = fadeOutByClipId.get(clip.id);
      const soloFadeOutDuration = crossfadeOutDuration === undefined ? findTransitionOut(track, clip)?.duration : undefined;
      const fadeOut: TextFadeOut | undefined =
        crossfadeOutDuration !== undefined
          ? { duration: crossfadeOutDuration, extendsPastEnd: true }
          : soloFadeOutDuration !== undefined
            ? { duration: soloFadeOutDuration, extendsPastEnd: false }
            : undefined;

      // A Khmer-script text clip (any `textAnimation`, including `wordHighlight`) renders through
      // pre-rendered browser images instead of any FFmpeg-side text path — see `khmerTextRenderer.ts`'s
      // own doc comment for why: every FFmpeg text path (`drawtext`, and the libass `subtitles=` filter
      // this used to route Khmer through) fails to correctly stack certain subscript-consonant clusters,
      // confirmed empirically. Checked FIRST, ahead of `wordHighlight`/rotated/plain, so a Khmer
      // `wordHighlight` clip takes this path too rather than the ASS one below (kept only for non-Khmer
      // `wordHighlight` now). Excludes keyframed style and crop — the render harness doesn't cover
      // either yet, the same real, documented scope cut the old libass Khmer path also had — but NOT
      // rotation: unlike the old path's unverified libass `\frz` sign convention, the harness draws
      // through the exact same `drawAnimatedTextFrame` the preview uses, rotation included, so a
      // rotated Khmer clip is fully supported here. `khmerTextWindowsFor` returns `undefined` for
      // anything not pre-rendered (a non-Khmer clip, or a caller — `nativeExport.ts` — that doesn't
      // support this path), falling through to the untouched paths below exactly like every other
      // optional resolver here degrades when omitted.
      const clipTextContent = applyTextTransform(asset.textContent ?? "", asset.textStyle.textTransform);
      const khmerWindows =
        !hasTextStyleKeyframes(clip) &&
        !((clip.textCrop && !isIdentityTextCrop(clip.textCrop)) || hasTextCropKeyframes(clip)) &&
        containsKhmerScript(clipTextContent)
          ? options.khmerTextWindowsFor?.(clip)
          : undefined;
      if (khmerWindows && khmerWindows.length > 0) {
        pushKhmerTextOverlay(videoOut, outputLabel, clip, khmerWindows, fadeIn, fadeOut);
        videoOut = `[${outputLabel}]`;
        continue;
      }

      // `wordHighlight` is checked next, ahead of the rotated/plain split below — it renders through a
      // completely different filter (`subtitles=`, not `drawtext`) regardless of `style.rotationDeg`,
      // and `buildWordHighlightSubtitlesFilter` itself returns `null` (falling through to the ordinary
      // plain/rotated path below, same as before this capability existed) whenever the three
      // `ExportPlanOptions` it needs aren't ALL supplied, or a specific clip's font metrics can't be
      // resolved — see that function's own comment.
      const wordHighlightFilter =
        clip.textAnimation?.type === "wordHighlight" && options.assFilePathFor && options.fontMetricsFor && options.fontsDirFor
          ? buildWordHighlightSubtitlesFilter({
              inputLabel: videoOut,
              outputLabel,
              content: clipTextContent,
              style: asset.textStyle,
              clip,
              frameWidth: width,
              frameHeight: height,
              assFilePathFor: options.assFilePathFor,
              fontMetricsFor: options.fontMetricsFor,
              fontsDirFor: options.fontsDirFor,
              fadeIn,
              fadeOut,
            })
          : null;

      // `wiggle` needs the ROTATED path even for a clip with no STATIC rotation of its own — it's the
      // only branch that can drive FFmpeg's `rotate` filter's angle from a per-frame expression. See
      // `buildRotatedDrawTextFilter`'s own comment for how it folds a zero `style.rotationDeg` in.
      // Keyframed clips ALSO need it whenever any keyframe (not just the static base style) could ever
      // produce a nonzero rotation — `rotationDeg` is one of `lerpTextStyle`'s interpolated numeric
      // fields, so it can legitimately vary per slice, and a single clip's own slice sequence must never
      // mix the plain and rotated chains. Safe for the common (never-rotated) case: `buildRotatedDrawTextFilter`
      // already degrades byte-identically at `rotationDeg = 0`.
      const needsRotatedPath =
        asset.textStyle.rotationDeg !== 0 ||
        clip.textAnimation?.type === "wiggle" ||
        (hasTextStyleKeyframes(clip) && clip.textStyleKeyframes!.some((k) => k.value.rotationDeg !== 0));
      if (wordHighlightFilter) {
        filters.push(...wordHighlightFilter);
      } else {
        // `TextCrop` (frame-space overflow mask, see its own doc comment) is NOT reachable from
        // `wordHighlight` in v1 — that path renders through `subtitles=`/libass, not `drawtext=`, and
        // whether libass draws correctly onto a genuinely transparent isolated buffer (rather than the
        // opaque composited stream every existing use of `subtitles=` here draws onto) is unverified;
        // out of scope for this feature, independent of crop itself.
        //
        // For the plain/rotated `drawtext` paths below: a clip with a real crop gets its ENTIRE existing
        // builder call (unchanged internally — same `buildDrawTextFilter`/`buildRotatedDrawTextFilter`,
        // same bounce/pulse/wiggle/typewriter expression math) redirected onto a fresh isolated
        // transparent buffer instead of the shared `videoOut`, then crop→pad→overlay's the result onto
        // the real `videoOut` afterward. A crop-less clip takes the exact byte-for-byte original path —
        // `drawInputLabel`/`drawOutputLabel` just equal `videoOut`/`outputLabel` unchanged.
        const hasCrop = (clip.textCrop && !isIdentityTextCrop(clip.textCrop)) || hasTextCropKeyframes(clip);
        let drawInputLabel = videoOut;
        const drawOutputLabel = hasCrop ? `${outputLabel}_iso` : outputLabel;

        if (hasCrop) {
          const isoIndex = inputIndex++;
          // Spans the full SEQUENCE duration (not just this clip's own), same reasoning as
          // `buildRotatedDrawTextFilter`'s own `bgIndex` input just below: the animation-type builders'
          // `enable='between(t,...)'` gates are written against ABSOLUTE timeline seconds, so this
          // buffer's own PTS must start at 0 for those gates to ever evaluate true. Same `format=rgba`-
          // chained-into-the-lavfi-source trick as `bgIndex` uses, for the identical reason (`color`'s
          // own `@0` alpha spec is silently discarded at the source otherwise — see that input's own
          // comment for the full empirical confirmation).
          inputs.push("-f", "lavfi", "-t", t(duration), "-i", `color=c=black@0:s=${width}x${height}:r=${fps},format=rgba`);
          drawInputLabel = `[${isoIndex}:v]`;
        }

        if (!needsRotatedPath) {
          filters.push(
            ...(hasTextStyleKeyframes(clip)
              ? buildKeyframedDrawTextCalls({
                  inputLabel: drawInputLabel,
                  outputLabel: drawOutputLabel,
                  content: clipTextContent,
                  baseStyle: asset.textStyle,
                  clip,
                  fontPathFor: options.fontPathFor,
                  drawtextTextAlign: options.drawtextTextAlign,
                  textFilePathFor: options.textFilePathFor,
                  fadeIn,
                  fadeOut,
                  fps,
                })
              : buildDrawTextFilter({
                  inputLabel: drawInputLabel,
                  outputLabel: drawOutputLabel,
                  content: clipTextContent,
                  style: asset.textStyle,
                  clip,
                  fontPathFor: options.fontPathFor,
                  drawtextTextAlign: options.drawtextTextAlign,
                  textFilePathFor: options.textFilePathFor,
                  fadeIn,
                  fadeOut,
                }))
          );
        } else {
          // A rotated text clip needs its own full-sequence-duration transparent background input to
          // draw and rotate onto — see `buildRotatedDrawTextFilter`'s own comment for why. Duration
          // matches `[cv]`'s (not just this clip's own) so the two stay trivially PTS-aligned.
          //
          // The trailing `,format=rgba` is load-bearing, not decorative: FFmpeg's `color` lavfi source
          // emits `yuv420p` (no alpha channel at all) by default regardless of the `@0` alpha spec in the
          // color string — `black@0`'s transparency is silently discarded at the SOURCE, before
          // `buildRotatedDrawTextFilter`'s own `format=rgba` filter (applied downstream, after drawtext)
          // ever gets a chance to see it, so without this the "transparent" background renders as a solid
          // OPAQUE black rectangle once overlaid — confirmed empirically (isolated `color=...@0` → overlay
          // test produced a fully opaque result) after the rotated-text/overlay chain was actually run
          // against a real video for the first time (this feature's own original verification exercised
          // `rotate` on its own, never the full chain through `overlay`). Chaining `format=rgba` directly
          // into the lavfi source string (lavfi accepts a small filter chain, not just one filter) forces
          // the alpha channel to exist from frame one, which is what actually makes it possible for
          // `black@0` to mean something by the time downstream filters touch it.
          //
          // This is a SEPARATE input from the crop-isolation buffer above (when `hasCrop`) — this one is
          // the rotated path's own pre-rotation canvas, an unrelated purpose; only `inputLabel` (what its
          // OWN final overlay step composites onto) changes when cropped, not this.
          const bgIndex = inputIndex++;
          inputs.push("-f", "lavfi", "-t", t(duration), "-i", `color=c=black@0:s=${width}x${height}:r=${fps},format=rgba`);
          filters.push(
            ...(hasTextStyleKeyframes(clip)
              ? buildKeyframedRotatedDrawTextCalls({
                  inputLabel: drawInputLabel,
                  bgIndex,
                  outputLabel: drawOutputLabel,
                  content: clipTextContent,
                  baseStyle: asset.textStyle,
                  clip,
                  fontPathFor: options.fontPathFor,
                  drawtextTextAlign: options.drawtextTextAlign,
                  textFilePathFor: options.textFilePathFor,
                  fadeIn,
                  fadeOut,
                  fps,
                })
              : buildRotatedDrawTextFilter({
                  inputLabel: drawInputLabel,
                  bgIndex,
                  outputLabel: drawOutputLabel,
                  content: clipTextContent,
                  style: asset.textStyle,
                  clip,
                  fontPathFor: options.fontPathFor,
                  drawtextTextAlign: options.drawtextTextAlign,
                  textFilePathFor: options.textFilePathFor,
                  fadeIn,
                  fadeOut,
                }))
          );
        }

        if (hasCrop) {
          // `crop`'s own w/h are evaluated ONCE at filter-graph configuration time (confirmed against
          // FFmpeg's own documented behavior — same "buffer-geometry parameters can't themselves depend
          // on `t`" constraint `pushKeyframedClipVideoFilters`'s own doc comment already establishes for
          // `rotate`'s `ow=`/`oh=`), so an ANIMATING crop rectangle needs the same "many short static
          // slices, not one continuously-varying expression" strategy every other keyframed property in
          // this file already uses — see `computeTextCropKeyframeSlices`'s own doc comment. A clip with
          // exactly one crop slice (a genuinely static crop, keyframed or not) takes the plain single
          // crop/pad/overlay path unchanged; `split=` only appears once there are actually multiple
          // slices to fan the ALREADY-fully-rendered text stream out to — same "avoid an untested
          // `split=1` construct" caution `pushKeyframedClipVideoFilters`'s own fix already applied.
          const cropKeyframed = hasTextCropKeyframes(clip);
          const cropSlices = cropKeyframed ? computeTextCropKeyframeSlices(clip, fps) : null;
          const { enableEnd } = buildTextFadeParams(clip, fadeIn, fadeOut);

          if (!cropSlices || cropSlices.length === 1) {
            const crop = cropSlices ? cropSlices[0].crop : clip.textCrop!;
            filters.push(buildTextCropFilter(drawOutputLabel, crop, `${outputLabel}_padded`, width, height));
            // No explicit `x=`/`y=` — `pad` already positioned the visible content correctly within a
            // frame-sized buffer, so this is the same plain "two frame-sized buffers, stack one on the
            // other" shape the multi-video-track layering overlay above already uses (`overlay=format=auto`,
            // no position), not the offset overlays elsewhere whose content is smaller than the background.
            filters.push(
              `${videoOut}[${outputLabel}_padded]overlay=format=auto:enable='between(t\\,${t(clip.timelineStart)}\\,${t(enableEnd)})'[${outputLabel}]`
            );
          } else {
            // Fan the ONE already-rendered text stream out into N independent pads — same `split=`
            // fan-out mechanism (and reasoning: a filter-graph pad can only be consumed ONCE) this
            // session's own `pushKeyframedClipVideoFilters` fix already established and proved live
            // against the real FFmpeg binary — then crop/pad EACH pad to its own slice's own rectangle,
            // and chain N sequential `overlay`s onto the accumulating `videoOut`, each confined to its
            // own ABSOLUTE-timeline window via `enable=`, exactly mirroring `buildKeyframedDrawTextCalls`'s
            // own per-slice `enable` windows (last slice extends to the real fade-adjusted `enableEnd`,
            // not its own nominal boundary — same reasoning that function's own comment gives).
            const splitLabels = cropSlices.map((_, i) => `${outputLabel}_cropsplit${i}`);
            filters.push(`[${drawOutputLabel}]split=${cropSlices.length}${splitLabels.map((l) => `[${l}]`).join("")}`);

            let chainInput = videoOut;
            cropSlices.forEach((slice, i) => {
              const isLast = i === cropSlices.length - 1;
              const paddedLabel = `${outputLabel}_padded${i}`;
              filters.push(buildTextCropFilter(splitLabels[i], slice.crop, paddedLabel, width, height));
              const stepLabel = isLast ? outputLabel : `${outputLabel}_cropov${i}`;
              const sliceStart = clip.timelineStart + slice.offset;
              const sliceEnd = isLast ? enableEnd : clip.timelineStart + slice.offset + slice.duration;
              filters.push(
                `${chainInput}[${paddedLabel}]overlay=format=auto:enable='between(t\\,${t(sliceStart)}\\,${t(sliceEnd)})'[${stepLabel}]`
              );
              chainInput = `[${stepLabel}]`;
            });
          }
        }
      }
      videoOut = `[${outputLabel}]`;
    }
  }
}

  // Audio-track clips (voiceover, music) are mixed over the video track's own audio — one stream per
  // audio track, via `buildAudioTrackStream` (its own comment explains why this replaced a flat
  // per-clip `adelay`+`amix`: that never gave `transitionIn`/`transitionOut` any effect at all).
  // Track-level mute/solo resolved once here, per track — the exact same rule `audibleClips` (used
  // elsewhere for the live preview) applies, just against a whole track up front instead of filtering
  // an already-flattened clip list, since a track this excludes needs to skip `buildAudioTrackStream`
  // entirely rather than contribute a silent placeholder stream to the mix.
  const audioTracks = project.sequence.tracks.filter((track) => track.kind === "audio");
  const anySoloAudioTrack = audioTracks.some((track) => track.solo);
  const overlayAudio: string[] = [];
  for (const [trackIndex, track] of audioTracks.entries()) {
    if (anySoloAudioTrack ? !track.solo : track.muted) continue;
    // Skip the whole track — not just an individually-muted clip within it — when NOTHING on it could
    // ever produce real audio (every clip missing/offline/silent-asset/muted). The old flat per-clip
    // loop this replaced got this for free (a muted clip just never contributed a label at all); a
    // per-track stream has to check up front instead, or a track that's ENTIRELY muted clips would
    // still get mixed in as a pointless, fully-silent `amix` input — harmless to the actual audio, but
    // exactly the kind of no-op filter stage this codebase otherwise takes care not to emit (see
    // `pushClipAudioFilters`'s own `volumeStage` comment on the same principle).
    const hasAudibleClip = track.clips.some((clip) => {
      const asset = findAsset(project, clip.assetId);
      return asset ? !asset.offline && asset.hasAudio && !clip.mutedAudio : false;
    });
    if (!hasAudibleClip) continue;
    overlayAudio.push(buildAudioTrackStream(track, trackIndex));
  }

  // Every additional video track's own audio (already a full-timeline-duration stream, silent in its
  // own gaps, exactly like the base track's `[ca0]`) mixes in through the SAME mechanism as an
  // audio-track overlay clip — no separate mixing stage needed for "a second video track's sound".
  let audioOut = "[ca0]";
  const allExtraAudio = [...videoTrackAudioLabels, ...overlayAudio];
  if (allExtraAudio.length > 0) {
    // normalize=0 keeps amix from quietly attenuating every input as more are added, which would
    // make adding a music track mysteriously duck the narration.
    filters.push(
      `${audioOut}${allExtraAudio.join("")}amix=inputs=${allExtraAudio.length + 1}:normalize=0:dropout_transition=0[mixa]`
    );
    audioOut = "[mixa]";
  }

  // Master fader — applied once, after every track/clip gain has already been mixed together, same
  // "only emit a volume= stage when it would do something" principle `pushClipAudioFilters`'s own
  // `volumeStage` uses.
  const masterGain = project.sequence.masterGain ?? 1;
  if (masterGain !== 1) {
    filters.push(`${audioOut}volume=${n(masterGain)}[mastered]`);
    audioOut = "[mastered]";
  }

  // Conform the fully-composited sequence-sized frame to the REQUESTED output size — see this
  // function's own opening comment for why this has to be a closing step, not the canvas size used
  // throughout. Skipped entirely (byte-for-byte identical graph to before this fix) for the
  // overwhelmingly common case where they already match, which every project does until a user
  // explicitly picks a different export resolution.
  if (outputWidth !== width || outputHeight !== height) {
    filters.push(
      `${videoOut}scale=${outputWidth}:${outputHeight}:force_original_aspect_ratio=decrease,` +
        `pad=${outputWidth}:${outputHeight}:(ow-iw)/2:(oh-ih)/2,setsar=1[conformed]`
    );
    videoOut = "[conformed]";
  }

  flushPendingSilentAudio();

  return {
    duration,
    args: [
      ...inputs,
      "-filter_complex",
      filters.join(";"),
      "-map",
      videoOut,
      "-map",
      audioOut,
      // `veryfast`, not libx264's own `medium` default: `-crf` already targets a specific, user-chosen
      // quality level (the "Quality" dropdown) regardless of preset — preset only trades encoder
      // EFFORT for how efficiently it hits that same target, not the target itself, so this is a real
      // "faster for the same picture," not a quality cut. Measured directly on this app's own machine,
      // matched workload: `medium` took 29.7s where `veryfast` took 16.3s — a ~45% wall-clock cut,
      // exactly what "export feels slow" was actually asking to fix, for every export regardless of
      // hardware. (A hardware encoder — Quick Sync/NVENC/AMF — measured only ~20% faster again on TOP
      // of that here, for the cost of runtime GPU detection, a software fallback, and a separate
      // quality-parameter mapping since `-crf` doesn't apply to any of them — not worth that
      // complexity for a smaller marginal win, and it wouldn't help at all on hardware without one.)
      ...(options.videoEncoderArgs ?? ["-c:v", "libx264", "-preset", "veryfast", "-crf", String(crf)]),
      "-pix_fmt",
      "yuv420p",
      "-c:a",
      "aac",
      "-b:a",
      `${audioBitrateKbps}k`,
      // Puts the MP4 index at the front so the file can start playing before it's fully downloaded —
      // what every social platform expects of an upload.
      "-movflags",
      "+faststart",
      // Guards against a filter-graph rounding difference making the output a few frames longer than
      // the timeline.
      "-t",
      t(duration),
      "-y",
      options.outputPath,
    ],
  };
}
