import type { TextAnimationType, TextInOutAnimation, TextInOutType } from "../project/types.ts";

/** Every `TextAnimationType`, in the order shown in the Inspector's Animation picker — mirrors
 *  `TRANSITION_TYPE_OPTIONS`'s own role in `timeline/transitions.ts` as the one shared source of truth
 *  a UI iterates rather than hardcoding its own copy of the union's values. */
export const TEXT_ANIMATION_TYPE_OPTIONS: TextAnimationType[] = ["bounce", "pulse", "wiggle", "float", "shake", "heartbeat", "typewriter", "wordHighlight"];

export const TEXT_ANIMATION_TYPE_LABEL: Record<TextAnimationType, string> = {
  bounce: "Bounce",
  pulse: "Pulse",
  wiggle: "Wiggle",
  float: "Float",
  shake: "Shake",
  heartbeat: "Heartbeat",
  typewriter: "Typewriter",
  wordHighlight: "Word Highlight",
};

/** `Clip.textAnimation.highlightColor`'s own fallback when a clip has `type: "wordHighlight"` but no
 *  color saved yet (a freshly-picked animation, or an older project) — matches the Karaoke text-style
 *  preset's color, since the two are the same visual idea (a bright accent color picking out the
 *  "current" word) and picking the same default keeps them from clashing if used together. */
export const DEFAULT_WORD_HIGHLIGHT_COLOR = "#ffe600";

/** What `computeTextAnimationTransform` adds on TOP of a text clip's own already-resolved position —
 *  a pure delta, not a replacement, so the caller composes it with `style.offsetX/offsetY`/
 *  `rotationDeg` the exact same way `PlaybackEngine.drawText` already composes THOSE onto the frame
 *  center (see its own comment). `scale`/`rotationDeg` pivot around the text's own anchor point, not
 *  the frame's — the caller is responsible for translating there first. */
export interface TextAnimationTransform {
  dx: number;
  dy: number;
  scale: number;
  rotationDeg: number;
}

const IDENTITY_TEXT_ANIMATION_TRANSFORM: TextAnimationTransform = { dx: 0, dy: 0, scale: 1, rotationDeg: 0 };

// Exported (not just used locally) so `buildExportPlan.ts` can build the exact same sine expressions
// as FFmpeg-level `y=`/`fontsize=`/`rotate a=` formulas — export and preview sharing these numbers
// directly rules out the two ever silently drifting apart the way two independently-typed copies could.
export const BOUNCE_AMPLITUDE_PX = 14;
export const BOUNCE_PERIOD_SECONDS = 0.9;
export const PULSE_AMPLITUDE = 0.08;
export const PULSE_PERIOD_SECONDS = 1.1;
export const WIGGLE_AMPLITUDE_DEG = 6;
export const WIGGLE_PERIOD_SECONDS = 1.3;
export const FLOAT_AMPLITUDE_PX = 10;
export const FLOAT_PERIOD_SECONDS = 2.4;
export const SHAKE_AMPLITUDE_PX = 5;
export const SHAKE_PERIOD_SECONDS = 0.18;
export const HEARTBEAT_AMPLITUDE = 0.14;
export const HEARTBEAT_PERIOD_SECONDS = 0.9;
/** Sharpens the heartbeat's |sin| into two quick beats with a rest between, rather than a smooth pulse. */
export const HEARTBEAT_SHARPNESS = 6;

/** Resolves `type` + however many seconds this clip has been on screen into the transform delta to
 *  apply for THIS frame — a pure function of elapsed time (no internal clock/state), so scrubbing the
 *  playhead backward looks identical to having played forward to the same instant, the same
 *  determinism `compositeTransitionFrame`'s own `progress` parameter already guarantees for
 *  transitions. Amplitudes/periods are fixed constants, not user-tunable — same "the capability exists,
 *  fine-tuning it is a later ask" scope line `DEFAULT_TRANSITION`'s own fixed 0.5s duration draws.
 *
 *  `typewriter` returns the identity transform — it doesn't move/scale/rotate the text at all, it
 *  reveals a progressively longer PREFIX of the content instead (see `typewriterVisibleContent`), an
 *  orthogonal kind of change this shape can't express. */
export function computeTextAnimationTransform(type: TextAnimationType, elapsedSeconds: number): TextAnimationTransform {
  switch (type) {
    case "bounce": {
      // `abs(sin(...))` — always a hop UPWARD from rest and back, never below it, so this reads as a
      // repeated bounce rather than a smooth up-and-down sway (the feel `wiggle`'s rotation already
      // covers, via a different axis).
      const phase = (elapsedSeconds / BOUNCE_PERIOD_SECONDS) * Math.PI * 2;
      return { ...IDENTITY_TEXT_ANIMATION_TRANSFORM, dy: -Math.abs(Math.sin(phase)) * BOUNCE_AMPLITUDE_PX };
    }
    case "pulse": {
      const phase = (elapsedSeconds / PULSE_PERIOD_SECONDS) * Math.PI * 2;
      return { ...IDENTITY_TEXT_ANIMATION_TRANSFORM, scale: 1 + Math.sin(phase) * PULSE_AMPLITUDE };
    }
    case "wiggle": {
      const phase = (elapsedSeconds / WIGGLE_PERIOD_SECONDS) * Math.PI * 2;
      return { ...IDENTITY_TEXT_ANIMATION_TRANSFORM, rotationDeg: Math.sin(phase) * WIGGLE_AMPLITUDE_DEG };
    }
    case "float": {
      // A slow, gentle sway — sin (up AND down of rest), unlike bounce's hop-only abs(sin).
      const phase = (elapsedSeconds / FLOAT_PERIOD_SECONDS) * Math.PI * 2;
      return { ...IDENTITY_TEXT_ANIMATION_TRANSFORM, dy: Math.sin(phase) * FLOAT_AMPLITUDE_PX };
    }
    case "shake": {
      const phase = (elapsedSeconds / SHAKE_PERIOD_SECONDS) * Math.PI * 2;
      return { ...IDENTITY_TEXT_ANIMATION_TRANSFORM, dx: Math.sin(phase) * SHAKE_AMPLITUDE_PX };
    }
    case "heartbeat": {
      const beat = Math.pow(Math.abs(Math.sin((Math.PI * elapsedSeconds) / HEARTBEAT_PERIOD_SECONDS)), HEARTBEAT_SHARPNESS);
      return { ...IDENTITY_TEXT_ANIMATION_TRANSFORM, scale: 1 + beat * HEARTBEAT_AMPLITUDE };
    }
    case "typewriter":
    case "wordHighlight":
      // Neither moves/scales/rotates the text — `typewriter` changes which CHARACTERS are visible
      // (`typewriterVisibleContent`), `wordHighlight` changes which WORD is drawn in the highlight
      // color (`activeWordIndex`, below) — both orthogonal to this shape.
      return IDENTITY_TEXT_ANIMATION_TRANSFORM;
  }
}

/** One piece of a line, in reading order — either a real word or the whitespace/punctuation between
 *  two words. Concatenating every segment's own `text` in order reproduces the original line exactly,
 *  so a caller drawing/positioning each piece in sequence never has to re-derive spacing separately —
 *  it just skips coloring/counting the non-word ones. */
export interface TextSegment {
  text: string;
  isWord: boolean;
}

/** Splits ONE line into its ordered words-and-separators via `Intl.Segmenter`'s dictionary-based word
 *  boundary detection — the ONE place `wordHighlight` decides what counts as "a word", shared by
 *  `splitWords`/`activeWordIndex` below (which word is CURRENTLY highlighted), `PlaybackEngine.drawText`'s
 *  own fill loop (which pixels actually get drawn in the highlight color), and `buildExportPlan.ts`'s
 *  `buildWordHighlightAss` (the export equivalent, via libass instead of canvas) — all three MUST agree
 *  on the exact same word boundaries and ordering, or the index computed here would highlight a
 *  DIFFERENT word than whichever one those two actually color.
 *
 *  This exists at all — instead of every caller doing its own `line.split(/\s+/)` — because a plain
 *  whitespace split is flatly WRONG for Khmer (and Thai, Lao, Myanmar, Chinese, Japanese): those
 *  scripts don't put spaces between words at all, so `"សួស្តីអ្នករាល់គ្នា".split(/\s+/)` returns the
 *  ENTIRE sentence as one "word", and `wordHighlight` would only ever be able to highlight the whole
 *  line at once. `Intl.Segmenter` (the ECMAScript Internationalization API, backed by ICU) does real
 *  dictionary-based word segmentation for exactly these scripts — confirmed empirically (not assumed
 *  from spec text) that it correctly splits real Khmer sentences into their actual words, and that
 *  this holds regardless of which `locale` argument is passed, since ICU's break iterator selects its
 *  rule set from the SCRIPT of the text being segmented, not the caller's requested locale — so this
 *  passes `undefined` (the runtime's default) rather than hardcoding a locale this app has no reliable
 *  way to know for arbitrary caption content anyway. Ordinary space-delimited text (English and
 *  friends) segments correctly through the exact same call, no branching needed for "which kind of
 *  text is this". Available in both the browser (preview) and Node 22 (export) without any polyfill —
 *  confirmed against this project's own bundled Node version, which ships full ICU data by default. */
export function segmentLine(line: string): TextSegment[] {
  const segmenter = new Intl.Segmenter(undefined, { granularity: "word" });
  const segments: TextSegment[] = [];
  for (const { segment, isWordLike } of segmenter.segment(line)) {
    segments.push({ text: segment, isWord: Boolean(isWordLike) });
  }
  return segments;
}

/** Splits `content` into its individual words, in reading order across every line (line breaks
 *  themselves never count as part of a word, same as whitespace within a line) — the SAME order
 *  `PlaybackEngine.drawText`'s own word-by-word fill loop walks when `wordHighlight` is active, so an
 *  index from this function always means the same word there. Whitespace-only content yields an empty
 *  array (0 words), not an array containing an empty string. Built from `segmentLine`, one line at a
 *  time, so this can never disagree with a renderer that's ALSO walking `segmentLine` per line (see
 *  its own comment) — a single `Intl.Segmenter` pass over the whole multi-line string would very
 *  likely agree too, but there's no reason to rely on that when going line-by-line costs nothing and
 *  removes the question entirely. */
export function splitWords(content: string): string[] {
  const words: string[] = [];
  for (const line of content.split("\n")) {
    for (const segment of segmentLine(line)) {
      if (segment.isWord) words.push(segment.text);
    }
  }
  return words;
}

/** Which word (a 0-based index into `splitWords(content)`) should be drawn in the highlight color
 *  `elapsedSeconds` into a `wordHighlight`-animated clip whose own nominal duration is
 *  `clipDurationSeconds` — spread EVENLY across the clip's own length, not a fixed words-per-second
 *  rate the way `typewriterVisibleContent` uses for characters, so a caption's last word finishes
 *  highlighting right as the clip itself ends regardless of how many words it has or how long the clip
 *  is. Returns `-1` (nothing highlighted) for empty content or a non-positive duration — both mean
 *  there's no meaningful "current word" to compute. */
export function activeWordIndex(wordCount: number, elapsedSeconds: number, clipDurationSeconds: number): number {
  if (wordCount <= 0 || clipDurationSeconds <= 0) return -1;
  const secondsPerWord = clipDurationSeconds / wordCount;
  return Math.min(wordCount - 1, Math.max(0, Math.floor(elapsedSeconds / secondsPerWord)));
}

export interface WordTiming {
  start: number;
  end: number;
}

/** `wordCount + 1` clip-relative second boundaries — `boundaries[i]` is when word `i` begins,
 *  `boundaries[wordCount]` is the clip's own end. Built from `wordTimings` (real per-word data, see
 *  `Clip.wordTimings`'s own doc comment) whenever its length actually matches `wordCount`; a mismatch
 *  (most likely the caption text was hand-edited after landing, adding/removing a word — real timing
 *  for the OLD word list can't be trusted to still line up) falls back to spreading evenly across
 *  `clipDurationSeconds`, `activeWordIndex`'s own historic behavior and still the only option for
 *  content with no real per-word timing at all (manually typed word-highlight text; a provider/language
 *  with no real per-word alignment). Shared by BOTH `drawAnimatedTextFrame` (live preview,
 *  `playback/textLayout.ts`) and `khmerTextRenderer.ts`'s export-window slicing so the two can never
 *  disagree about where one word's window ends and the next begins — see that render harness's own
 *  doc comment for why staying in lockstep with the preview matters here specifically. */
export function wordBoundaries(wordCount: number, clipDurationSeconds: number, wordTimings?: WordTiming[]): number[] {
  if (wordTimings && wordTimings.length === wordCount) {
    return [...wordTimings.map((w) => Math.max(0, w.start)), Math.max(0, clipDurationSeconds)];
  }
  const secondsPerWord = wordCount > 0 ? clipDurationSeconds / wordCount : 0;
  return Array.from({ length: wordCount + 1 }, (_, i) => i * secondsPerWord);
}

/** Which word (a 0-based index into `splitWords(content)`) is active at `elapsedSeconds`, given its
 *  own `wordBoundaries` — the last boundary at or before `elapsedSeconds`, clamped into range. For
 *  EVENLY-spread boundaries (no real timing available) this is mathematically identical to
 *  `activeWordIndex`'s own floor-division formula, just expressed as a lookup instead — so nothing
 *  with no real per-word timing changes behavior at all, only content that now HAS real timing to
 *  consult actually renders differently. */
export function activeWordIndexFromBoundaries(boundaries: number[], elapsedSeconds: number): number {
  const wordCount = boundaries.length - 1;
  if (wordCount <= 0) return -1;
  let index = 0;
  for (let i = 1; i < wordCount; i++) {
    if (elapsedSeconds < boundaries[i]) break;
    index = i;
  }
  return index;
}

/** Characters per second the `typewriter` animation reveals content at — fast enough to finish a short
 *  caption line well within a normal clip's duration, slow enough to actually read as a typing effect
 *  rather than a near-instant cut. */
export const TYPEWRITER_CHARS_PER_SECOND = 18;

/** The prefix of `content` that should be visible `elapsedSeconds` into a `typewriter`-animated clip —
 *  clamped to the full string once enough time has passed, so the clip settles on showing everything
 *  for its remaining duration rather than looping or vanishing. */
export function typewriterVisibleContent(content: string, elapsedSeconds: number): string {
  const visibleCount = Math.max(0, Math.floor(elapsedSeconds * TYPEWRITER_CHARS_PER_SECOND));
  return content.slice(0, visibleCount);
}

// ---------------------------------------------------------------------------------------------------
// In / Out (entrance / exit) animations
// ---------------------------------------------------------------------------------------------------

export const TEXT_INOUT_TYPE_OPTIONS: TextInOutType[] = ["fade", "slideUp", "slideDown", "slideLeft", "slideRight", "rise", "drop", "pop", "zoomIn", "zoomOut"];

export const TEXT_INOUT_TYPE_LABEL: Record<TextInOutType, string> = {
  fade: "Fade",
  slideUp: "Slide Up",
  slideDown: "Slide Down",
  slideLeft: "Slide Left",
  slideRight: "Slide Right",
  rise: "Rise",
  drop: "Drop",
  pop: "Pop",
  zoomIn: "Zoom In",
  zoomOut: "Zoom Out",
};

export const TEXT_INOUT_DEFAULT_DURATION = 0.6;
/** Shortest an In/Out may be — anything quicker just reads as a glitch, and a zero duration would divide by 0. */
export const TEXT_INOUT_MIN_DURATION = 0.1;

/** The seconds an In or Out actually plays for on a clip `clipDurationSeconds` long: the requested
 *  duration (or the default), clamped so the two can never overlap (each at most half the clip). One
 *  definition shared by preview and export. */
export function textInOutDuration(spec: TextInOutAnimation | undefined, clipDurationSeconds: number): number {
  if (!spec) return 0;
  const requested = Number.isFinite(spec.duration) && (spec.duration as number) > 0 ? (spec.duration as number) : TEXT_INOUT_DEFAULT_DURATION;
  return Math.max(0, Math.min(Math.max(TEXT_INOUT_MIN_DURATION, requested), clipDurationSeconds / 2));
}

/** What an In/Out contributes at one instant. `dx`/`dy` are pixel offsets (sequence space), `scale` a
 *  multiplier, `alpha` a 0..1 opacity multiplier — the neutral values (0, 0, 1, 1) mean "settled". */
export interface TextInOutTransform {
  dx: number;
  dy: number;
  scale: number;
  alpha: number;
}

const BACK_OVERSHOOT = 1.70158;
/** Scale never reaches exactly 0: FFmpeg's `drawtext` rejects a zero font size, and the difference is
 *  invisible (a 0.02x glyph is sub-pixel). */
const MIN_SCALE = 0.02;

const easeOutCubic = (p: number): number => 1 - Math.pow(1 - p, 3);
/** Overshoots past 1 and settles — the springy feel behind Pop / Rise / Drop. */
const easeOutBack = (p: number): number => 1 + (BACK_OVERSHOOT + 1) * Math.pow(p - 1, 3) + BACK_OVERSHOOT * Math.pow(p - 1, 2);
/** Opacity comes in faster than the motion so the text is readable before it finishes moving. */
const alphaRamp = (p: number): number => Math.min(1, p * 3);

/** `type`'s entrance at `progress` (0 = just started, 1 = settled), for text whose font size is
 *  `distance` px (slides travel one font-size, so they scale with the text). An exit is the same curve fed
 *  a progress that runs 1 -> 0 over the clip's last seconds — callers do that mirroring, not this function. */
export function computeTextInOutTransform(type: TextInOutType, progress: number, distance: number): TextInOutTransform {
  const p = Math.min(1, Math.max(0, progress));
  const eo = easeOutCubic(p);
  const eb = easeOutBack(p);
  switch (type) {
    case "fade":
      return { dx: 0, dy: 0, scale: 1, alpha: eo };
    case "slideUp":
      return { dx: 0, dy: distance * (1 - eo), scale: 1, alpha: alphaRamp(p) };
    case "slideDown":
      return { dx: 0, dy: -distance * (1 - eo), scale: 1, alpha: alphaRamp(p) };
    case "slideLeft":
      return { dx: distance * (1 - eo), dy: 0, scale: 1, alpha: alphaRamp(p) };
    case "slideRight":
      return { dx: -distance * (1 - eo), dy: 0, scale: 1, alpha: alphaRamp(p) };
    case "rise":
      return { dx: 0, dy: distance * (1 - eb), scale: 1, alpha: alphaRamp(p) };
    case "drop":
      return { dx: 0, dy: -distance * (1 - eb), scale: 1, alpha: alphaRamp(p) };
    case "pop":
      return { dx: 0, dy: 0, scale: Math.max(MIN_SCALE, eb), alpha: alphaRamp(p) };
    case "zoomIn":
      return { dx: 0, dy: 0, scale: 0.5 + 0.5 * eo, alpha: alphaRamp(p) };
    case "zoomOut":
      return { dx: 0, dy: 0, scale: 1.6 - 0.6 * eo, alpha: alphaRamp(p) };
  }
}

/** The In/Out contribution for a clip at `elapsedSeconds` (clip-relative): the entrance and exit
 *  transforms composed — offsets add, scales and opacities multiply. Either being absent leaves that side
 *  neutral. This is the single function preview draws from; export builds the equivalent expressions
 *  (`buildTextInOutExpressions`) and a test evaluates them against this to keep the two in lockstep. */
export function computeClipTextInOut(
  animationIn: TextInOutAnimation | undefined,
  animationOut: TextInOutAnimation | undefined,
  elapsedSeconds: number,
  clipDurationSeconds: number,
  distance: number
): TextInOutTransform {
  let result: TextInOutTransform = { dx: 0, dy: 0, scale: 1, alpha: 1 };
  const dIn = textInOutDuration(animationIn, clipDurationSeconds);
  if (animationIn && dIn > 0) {
    const tr = computeTextInOutTransform(animationIn.type, elapsedSeconds / dIn, distance);
    result = { dx: result.dx + tr.dx, dy: result.dy + tr.dy, scale: result.scale * tr.scale, alpha: result.alpha * tr.alpha };
  }
  const dOut = textInOutDuration(animationOut, clipDurationSeconds);
  if (animationOut && dOut > 0) {
    const tr = computeTextInOutTransform(animationOut.type, (clipDurationSeconds - elapsedSeconds) / dOut, distance);
    result = { dx: result.dx + tr.dx, dy: result.dy + tr.dy, scale: result.scale * tr.scale, alpha: result.alpha * tr.alpha };
  }
  return result;
}

/** FFmpeg-expression twins of `computeTextInOutTransform`, for one side (In or Out). `progressExpr` is an
 *  expression that evaluates to the 0..1 progress (already clamped by the caller); `distance` is the same
 *  pixel distance. Each returned string is a self-contained expression (commas unescaped — the caller
 *  quotes/escapes it for its context) or the neutral literal "0" / "1". Kept beside the JS version so
 *  the two are edited together; `tests/textAnimation.test.ts` evaluates these strings and compares. */
export function buildTextInOutExpressions(type: TextInOutType, progressExpr: string, distance: number): { dx: string; dy: string; scale: string; alpha: string } {
  const p = `(${progressExpr})`;
  const eo = `(1-pow(1-${p},3))`;
  const eb = `(1+${BACK_OVERSHOOT + 1}*pow(${p}-1,3)+${BACK_OVERSHOOT}*pow(${p}-1,2))`;
  const ramp = `min(1,${p}*3)`;
  const d = String(Math.round(distance * 1000) / 1000);
  const neutral = { dx: "0", dy: "0", scale: "1", alpha: "1" };
  switch (type) {
    case "fade":
      return { ...neutral, alpha: eo };
    case "slideUp":
      return { ...neutral, dy: `${d}*(1-${eo})`, alpha: ramp };
    case "slideDown":
      return { ...neutral, dy: `-${d}*(1-${eo})`, alpha: ramp };
    case "slideLeft":
      return { ...neutral, dx: `${d}*(1-${eo})`, alpha: ramp };
    case "slideRight":
      return { ...neutral, dx: `-${d}*(1-${eo})`, alpha: ramp };
    case "rise":
      return { ...neutral, dy: `${d}*(1-${eb})`, alpha: ramp };
    case "drop":
      return { ...neutral, dy: `-${d}*(1-${eb})`, alpha: ramp };
    case "pop":
      return { ...neutral, scale: `max(${MIN_SCALE},${eb})`, alpha: ramp };
    case "zoomIn":
      return { ...neutral, scale: `(0.5+0.5*${eo})`, alpha: ramp };
    case "zoomOut":
      return { ...neutral, scale: `(1.6-0.6*${eo})`, alpha: ramp };
  }
}
