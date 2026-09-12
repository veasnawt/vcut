/** Pure logic for turning ASR (Kiri/WhisperX) output into timed caption chunks — extracted out of
 *  `studios/vcut/app/api/vcut/captions/route.ts` (which still owns everything I/O-bound: the actual
 *  Kiri/Replicate network calls, ffmpeg audio extraction, real voice-activity detection, and the job
 *  orchestration around all of it) so this specific logic can live where the project's OWN test
 *  runner already is (`packages/vcut/tests/*.test.ts`, `node --test`) instead of in a route file with
 *  zero test coverage.
 *
 *  Worth the move: every one of the three real bugs found while building Auto Captions' pause
 *  detection (the fixed threshold being un-tunable across speakers, Kiri's flat `words` array being
 *  silently discarded, and `repairGapsWithRealSilence`'s own first version picking the WRONG caption
 *  to adjust) was only caught by manually re-deploying and reading production logs — real, working
 *  test cases for this exact logic already existed as throwaway verification scripts during that
 *  investigation; `packages/vcut/tests/captionsChunking.test.ts` is those, made permanent. */

import { segmentLine } from "../timeline/textAnimation.ts";

/** One finished caption clip. `start`/`end` are either CLIP-RELATIVE (before the route's own
 *  `mapToRealTime` runs) or absolute sequence-timeline seconds (after) — this module only ever
 *  produces the relative form; the route is what maps it to absolute. */
export interface CaptionSegment {
  content: string;
  start: number;
  end: number;
  /** Real per-word timing, relative to THIS segment's own `start` — present only when `chunkSegment`
   *  had genuine per-word timestamps to work with, never for the ESTIMATED-fallback branch (its own
   *  timing is invented, not real, so it would be dishonest to hand it to the client as if it were). */
  words?: { text: string; start: number; end: number }[];
}

/** A caption clip should read as one short line, not a whole paragraph — past either threshold, a
 *  segment gets split further (see `chunkSegment`). `*_SECONDS` catches the OTHER shape of "too long":
 *  a segment that's short in text but slow, drawled speech (rare, but a 40-char segment spanning 15s
 *  of silence-punctuated speech would otherwise sit on screen doing nothing for most of that time).
 *  The `WORD_HIGHLIGHT_*` pair is deliberately tighter (by WORD count, not characters — word length
 *  varies too much across scripts for a character budget to mean "about N words" consistently) —
 *  see `chunkSegment`'s own comment for why Word Highlight specifically benefits from shorter chunks
 *  even though every OTHER animation is fine with the longer, more reading-friendly default. */
export const MAX_CAPTION_CHARS = 42;
export const MAX_CAPTION_SECONDS = 5;
export const WORD_HIGHLIGHT_MAX_WORDS = 4;
export const WORD_HIGHLIGHT_MAX_SECONDS = 2.2;

/** A real per-word gap longer than the job's own `pauseThreshold` (see `computePauseThreshold` below)
 *  forces a chunk break, REGARDLESS of the char/word/second budgets above — a caption clip's own
 *  `[start, end]` otherwise spans straight through a genuine pause in the speech (a whole ASR segment
 *  CAN legitimately cover one: WhisperX/Kiri split by VAD/sentence, not by every brief silence), which
 *  reads as one caption sitting on screen doing nothing for the pause's own duration instead of the
 *  screen genuinely going blank between two separate thoughts — confirmed as a real, reported gap, not
 *  a hypothetical one. Only ever checked against REAL per-word timing (see
 *  `includeWordTimings`/`hasInternalPause`) — the estimated fallback's synthetic, evenly-spread word
 *  positions have no genuine silence to detect at all.
 *
 *  This used to be one hardcoded constant shared by every job ever run (0.5s, then lowered to 0.3s
 *  after a live report that captions still showed no gaps at all — a real captured Kiri sample's own
 *  MAX real inter-word gap across a whole 10s clip of continuous speech was only 0.34s, meaning normal
 *  conversational pacing regularly never crossed 0.5s in the first place). That fix was itself fragile
 *  in the same way the first constant was: "normal word-to-word gap" isn't one universal number — it
 *  varies by speaker, language, mic quality, and even provider timestamp quantization, so any single
 *  fixed cutoff will eventually be wrong again for the next recording (too high for a slow, deliberate
 *  speaker whose normal gaps regularly approach it; too low for a fast, dense speaker whose real pauses
 *  never get that large in absolute terms). `computePauseThreshold` replaces the fixed constant with a
 *  threshold computed FROM each job's own real gap distribution — adaptive per recording instead of
 *  requiring a human to keep re-guessing a shared global number as new samples come in. */
export const PAUSE_GAP_FLOOR_SECONDS = 0.2;

/** How many "typical gap units" above the job's own median counts as a genuine outlier — see
 *  `computePauseThreshold`'s own doc comment. 3 is a standard robust-statistics convention (a "modified
 *  z-score" of 3 using MAD in place of standard deviation is the widely-used default for flagging
 *  outliers, e.g. Iglewicz & Hoaglin's rule of thumb) — comfortably past ordinary variance in
 *  conversational pacing without requiring a dramatic, multi-second silence to fire. */
export const PAUSE_OUTLIER_MULTIPLIER = 3;

/** Floor under the job's own median-absolute-deviation spread — a recording with extremely uniform
 *  inter-word gaps (near-zero variance, e.g. a very clean, evenly-paced reading) would otherwise collapse
 *  `PAUSE_OUTLIER_MULTIPLIER * mad` to almost nothing, making the adaptive threshold MORE sensitive than
 *  intended instead of less. Keeps the multiplier meaningful even when a recording's own gaps genuinely
 *  don't vary much. */
export const MIN_GAP_SPREAD_SECONDS = 0.05;

/** Below this many real inter-word gap samples, a per-job median/MAD is too noisy to trust (a "typical
 *  gap" computed from 2-3 data points isn't a real distribution) — falls back to the plain floor instead
 *  of possibly building an adaptive threshold that's actively worse than a fixed one. A short clip or a
 *  segment-sparse transcript can easily land here; the floor alone is still a reasonable, conservative
 *  default in that case (see `PAUSE_GAP_FLOOR_SECONDS`'s own value). */
export const MIN_GAP_SAMPLES_FOR_ADAPTIVE = 12;

/** Computes ONE pause threshold for an entire transcription job from every REAL inter-word gap that
 *  job's provider reported (across ALL segments, not per-segment — a single ASR segment often has too
 *  few words for a reliable median/MAD on its own, while pacing is generally consistent across one
 *  speaker/recording, so pooling the whole job's gaps gives a much more stable per-recording baseline
 *  while still adapting per speaker/recording instead of using one number for every job ever run).
 *
 *  Uses the MEDIAN (not mean) as the "typical gap" baseline and MAD (median absolute deviation, not
 *  standard deviation) as the spread — both are robust to the outliers this function exists to detect
 *  in the first place: a handful of genuine multi-second pauses in an otherwise fast-paced recording
 *  would drag a MEAN/stddev-based baseline upward, making the resulting threshold LESS sensitive to
 *  exactly the pauses it's supposed to catch. Final threshold is `max(floor, median + K * spread)` —
 *  never below the floor even for a recording with almost no real gap variance at all, always adaptive
 *  above it for a recording whose own pacing runs unusually slow (median well above the floor) or
 *  unusually punctuated (spread genuinely wide). */
export function computePauseThreshold(segments: { words?: { word: string; start?: number; end?: number }[] }[]): number {
  const gaps: number[] = [];
  for (const segment of segments) {
    const words = segment.words ?? [];
    let previousEnd: number | undefined;
    for (const w of words) {
      if (typeof w.start !== "number" || typeof w.end !== "number") continue;
      if (previousEnd !== undefined) {
        const gap = w.start - previousEnd;
        if (gap >= 0) gaps.push(gap);
      }
      previousEnd = w.end;
    }
  }
  if (gaps.length < MIN_GAP_SAMPLES_FOR_ADAPTIVE) return PAUSE_GAP_FLOOR_SECONDS;

  const sorted = [...gaps].sort((a, b) => a - b);
  const median = sorted[Math.floor(sorted.length / 2)];
  const deviations = sorted.map((g) => Math.abs(g - median)).sort((a, b) => a - b);
  const mad = deviations[Math.floor(deviations.length / 2)];
  const spread = Math.max(mad, MIN_GAP_SPREAD_SECONDS);
  return Math.max(PAUSE_GAP_FLOOR_SECONDS, median + PAUSE_OUTLIER_MULTIPLIER * spread);
}

/** Re-nests a transcription provider's flat top-level `words` array back into each segment's own
 *  `words` field — exists because Kiri's verbose_json response does NOT nest per-word timing inside
 *  each segment the way WhisperX's does: Kiri returns one FLAT top-level `words` array, a SIBLING of
 *  `segments`, with each segment object carrying no `words` field of its own at all. Every downstream
 *  consumer in this module (`chunkSegment`, `computePauseThreshold`, `hasInternalPause`) only ever
 *  reads `segment.words` — without this, a Kiri-routed job has ZERO real per-word timing available
 *  downstream despite the raw response genuinely containing real, well-formed per-word timestamps the
 *  entire time (confirmed as a real production bug, not hypothetical: a live job's own diagnostic log
 *  reported "0 real inter-word gaps" despite real speech with a genuine pause in it, traced back to
 *  exactly this).
 *
 *  Segments are contiguous, non-overlapping ASR spans covering the whole file, so assigning each word
 *  to whichever segment's `[start, end)` window contains its own `start` is a plain interval lookup,
 *  not a fuzzy match. Falls back to the LAST segment for a word landing a hair past the final
 *  segment's own end (encoder/ASR rounding, not a real content gap) rather than ever silently losing a
 *  real word's timing. */
export function attachWordsToSegments<S extends { start: number; end: number; text: string }>(
  segments: S[],
  words: { word: string; start: number; end: number }[]
): (S & { words: { word: string; start: number; end: number }[] })[] {
  const bySegment: { word: string; start: number; end: number }[][] = segments.map(() => []);
  for (const w of words) {
    let idx = segments.findIndex((s) => w.start >= s.start && w.start < s.end);
    if (idx === -1) idx = segments.length - 1;
    if (idx >= 0) bySegment[idx].push(w);
  }
  return segments.map((s, i) => ({ ...s, words: bySegment[i] }));
}

/** Tightens caption boundaries toward REAL detected silence (voice-activity gaps measured directly
 *  from the audio waveform, independent of anything a transcription provider's own per-word
 *  timestamps claim — see `studios/vcut/app/api/vcut/captions/route.ts`'s own `detectSilences` for
 *  where `silences` actually comes from).
 *
 *  For each real silence interval, finds the ADJACENT caption pair `(before, after)` whose COMBINED
 *  span (`before.start` to `after.end`) contains it, and — among however many adjacent pairs happen to
 *  qualify — picks the TIGHTEST-containing one (smallest combined span), then pulls `before.end` back
 *  to the silence's own start and pushes `after.start` forward to the silence's own end.
 *
 *  A naive "which caption's reported START already precedes this silence" search was tried first and
 *  is WRONG for exactly the failure mode this exists to fix: when the reported gap between two
 *  captions has been smeared to (near) zero — a real, reported case, "reflection" immediately followed
 *  by `next.start` identical to `reflection.end` — `next`'s own reported `start` is ALREADY inside
 *  where the real silence should be, so a search for "the last caption starting before the silence
 *  ends" incorrectly picks `next` itself as `before`, moving the WRONG edge and either no-op'ing or
 *  (worse) collapsing `next` to a zero-length clip. Matching by which PAIR's combined span contains the
 *  silence, rather than searching by either caption's own individual (possibly wrong) timestamp,
 *  sidesteps that entirely — `before`/`after` are chosen by their fixed POSITION in the array (`i`,
 *  `i+1`), never by comparing an unreliable value.
 *
 *  Deliberately one-directional: only ever SHRINKS `before`'s end and pushes `after`'s start FORWARD
 *  toward a real, independently-measured silence, never invents a split the transcription didn't
 *  already produce as an adjacent pair. Worst case (a false-positive silence detection, or a
 *  configuration this can't confidently match to one pair) is a no-op, never new corruption.
 *
 *  Runs on the flattened `captions` array BEFORE the route's own `mapToRealTime` — `silences` must be
 *  measured against the same combined-extracted-audio coordinate space the raw segment/word timestamps
 *  are still in at that point, exactly like `pauseThreshold`. Mutates `captions` in place. */
export function repairGapsWithRealSilence(
  captions: { start: number; end: number }[],
  silences: { start: number; end: number }[]
): void {
  for (const silence of silences) {
    let bestIdx = -1;
    let bestSpan = Infinity;
    for (let i = 0; i < captions.length - 1; i++) {
      const before = captions[i];
      const after = captions[i + 1];
      if (before.start <= silence.start && after.end >= silence.end) {
        const span = after.end - before.start;
        if (span < bestSpan) {
          bestSpan = span;
          bestIdx = i;
        }
      }
    }
    if (bestIdx === -1) continue;
    const before = captions[bestIdx];
    const after = captions[bestIdx + 1];
    if (silence.start > before.start) before.end = Math.min(before.end, silence.start);
    if (silence.end < after.end) after.start = Math.max(after.start, silence.end);
  }
}

/** Whether any two REAL, consecutive per-word timestamps in `words` are separated by more than
 *  `pauseThreshold` — used to veto `chunkSegment`'s "fits as one chunk" shortcut, which otherwise has no
 *  way to know a segment it would leave whole actually contains a pause worth splitting on (see
 *  `computePauseThreshold`'s own doc comment for where `pauseThreshold` itself comes from). Entries
 *  without a real `start`/`end` (alignment failed for that specific word) are simply skipped rather than
 *  treated as a gap — same "not every word aligns" tolerance `chunkSegment`'s own `rawWords` filter
 *  already has. */
export function hasInternalPause(words: { word: string; start?: number; end?: number }[], pauseThreshold: number): boolean {
  let previousEnd: number | undefined;
  for (const w of words) {
    if (typeof w.start !== "number" || typeof w.end !== "number") continue;
    if (previousEnd !== undefined && w.start - previousEnd > pauseThreshold) return true;
    previousEnd = w.end;
  }
  return false;
}

export interface TimedWord {
  text: string;
  start: number;
  end: number;
  /** Raw text that appeared between this word and the PREVIOUS one in the real source text — "" for
   *  a word that starts a chunk fresh, otherwise copied VERBATIM from the real source rather than
   *  guessed by any per-language or per-script rule. An earlier version of this tried exactly that (a
   *  per-language flag, then a per-adjacent-pair Unicode-script check) and both were proven wrong
   *  live: a real Kiri Khmer segment mixes in a bare Latin word ("reflection") WITH a real space
   *  around it, AND — the script check's own blind spot — a single Khmer segment can carry an
   *  internal clause-boundary space between two Khmer-script words that no per-word script rule can
   *  ever tell apart from a genuine no-space Khmer word boundary. The real fix is to stop guessing:
   *  this field is populated by literally reading the separator that was really there, per branch
   *  below — `chunkSegment`'s real-word branch finds each word's own position in `segment.text` and
   *  takes whatever's actually between them; its estimated-fallback branch already has this for free,
   *  since `segmentLine`'s non-word pieces (spaces, punctuation) ARE the real separators, just
   *  previously discarded by an `isWord`-only filter instead of kept. */
  leadingJoiner: string;
}

/** Locates each `rawWords` entry's own position in `text`, in order, and returns a `TimedWord[]` whose
 *  `leadingJoiner` is copied verbatim from whatever real text actually separated it from the PREVIOUS
 *  word — see `TimedWord.leadingJoiner`'s own doc comment for why this replaced a script-based guess.
 *  Search starts from just past the previous match each time (never re-scans from 0), so a word that
 *  happens to repeat earlier in the segment can't be mismatched to its own earlier occurrence. A word
 *  that can't be found from that point on (case mismatch, punctuation Kiri/WhisperX stripped
 *  differently than it appears in `text`, ...) falls back to a plain space — the common-case default —
 *  rather than dropping the word or throwing. */
export function alignWordsToText(text: string, rawWords: { word: string; start: number; end: number }[]): TimedWord[] {
  const result: TimedWord[] = [];
  let cursor = 0;
  for (const w of rawWords) {
    const word = w.word.trim();
    if (!word) continue;
    const idx = text.indexOf(word, cursor);
    const leadingJoiner = result.length === 0 ? "" : idx === -1 ? " " : text.slice(cursor, idx);
    if (idx !== -1) cursor = idx + word.length;
    result.push({ text: word, start: w.start, end: w.end, leadingJoiner });
  }
  return result;
}

/** Groups already-timed words into chunks, cutting whenever the NEXT word would push the current
 *  chunk past `maxChars` (if given), `maxWords` (if given), or `maxSeconds` since the chunk's own
 *  first word — whichever limit is actually configured for this call. Each chunk's own `start`/`end`
 *  comes directly from its first/last word's real timestamp, never recomputed — this is the one place
 *  both `chunkSegment` branches below (real per-word timing and the estimated fallback) converge, so
 *  there's only one grouping/capping algorithm to keep correct. Each word's own `leadingJoiner` (see
 *  that field's own doc comment) is simply used as-is — EXCEPT for whichever word ends up first in a
 *  chunk after a `flush()`, which never gets a leading joiner charged against it (that word starts a
 *  fresh line; its `leadingJoiner` describes its relationship to the PREVIOUS chunk, not this one). */
export function groupTimedWords(
  words: TimedWord[],
  limits: { maxChars?: number; maxWords?: number; maxSeconds: number },
  includeWordTimings: boolean,
  pauseThreshold: number
): CaptionSegment[] {
  const chunks: CaptionSegment[] = [];
  let current: TimedWord[] = [];
  let currentChars = 0;

  function flush() {
    if (current.length === 0) return;
    let content = current[0].text;
    for (let i = 1; i < current.length; i++) content += current[i].leadingJoiner + current[i].text;
    // Clip-relative (relative to THIS chunk's own start) even though the route's own `mapToRealTime`
    // hasn't run yet — safe because that mapping is a constant per-range OFFSET, so subtracting two
    // not-yet-mapped timestamps in the SAME range already equals subtracting the mapped ones would.
    // Only emitted for the real-word branch (`includeWordTimings`) — see `CaptionSegment.words`'s own
    // doc comment for why the estimated fallback's invented timing shouldn't be handed to the client
    // as if real.
    const words = includeWordTimings
      ? current.map((w) => ({ text: w.text, start: w.start - current[0].start, end: w.end - current[0].start }))
      : undefined;
    chunks.push({ content, start: current[0].start, end: current[current.length - 1].end, ...(words ? { words } : null) });
    current = [];
    currentChars = 0;
  }

  for (const word of words) {
    if (current.length > 0) {
      const nextChars = currentChars + word.leadingJoiner.length + word.text.length;
      const overChars = limits.maxChars !== undefined && nextChars > limits.maxChars;
      const overWords = limits.maxWords !== undefined && current.length + 1 > limits.maxWords;
      const overSeconds = word.end - current[0].start > limits.maxSeconds;
      // Only against REAL timing (see `computePauseThreshold`'s own doc comment) — the estimated
      // fallback's synthetic word positions are contiguous by construction, so this would never fire for
      // them anyway, but gating it explicitly keeps the intent honest rather than relying on that
      // coincidence.
      const overGap = includeWordTimings && word.start - current[current.length - 1].end > pauseThreshold;
      if (overChars || overWords || overSeconds || overGap) flush();
    }
    current.push(word);
    currentChars = current.length === 1 ? word.text.length : currentChars + word.leadingJoiner.length + word.text.length;
  }
  flush();
  return chunks;
}

/** Splits ONE ASR segment into shorter, timed caption chunks whenever it runs past a comfortable
 *  length. `align_output: true` (WhisperX's own option, set by the route) already gets WhisperX to
 *  segment by SENTENCE rather than by its own internal 30s decode window — a real fix for the common
 *  case on its own — but a single long sentence (or, for a language alignment isn't available for, a
 *  whole un-split ASR segment) can still run past a comfortable caption length, and even a short
 *  segment benefits from REAL per-word timing here when it's available: a fixed per-chunk time budget
 *  can't tell fast speech from slow, which is exactly the "sometimes fast, sometimes slow" sync
 *  complaint this fixes — confirmed real, not hypothetical, from actually comparing generated captions
 *  against the source audio.
 *
 *  Prefers `segment.words` (real per-word timestamps, present whenever alignment succeeded for this
 *  segment's language) over the ESTIMATED fallback below — using `segment.words` as the ONLY source of
 *  both TEXT and TIMING (never cross-referencing `segmentLine` for the same segment) means there's no
 *  second tokenization for WhisperX's own to disagree with. `wordHighlight` picks which cap
 *  (`WORD_HIGHLIGHT_*` vs. the longer, reading-friendly default) chunking uses — passed through from
 *  the client's own chosen animation — since a highlighted word tracking real speech pace is what
 *  actually benefits from short chunks; a plain caption line reads better a little longer.
 *
 *  Falls back to spreading `segment`'s own real `[start, end]` interval EVENLY across however many
 *  words `segmentLine` finds whenever `words` is absent or every entry in it failed to align (Khmer,
 *  Thai, and every other language `victor-upmeet/whisperx` has no alignment model for at all) — the
 *  same "even distribution" approximation `timeline/textAnimation.ts`'s `activeWordIndex` already uses
 *  for `wordHighlight` playback when it has nothing better to go on, so this isn't a new kind of
 *  imprecision the app doesn't already rely on elsewhere; shorter chunks (from `wordHighlight`'s own
 *  tighter cap) shrink that estimation error too, even without real timing to work from. */
export function chunkSegment(
  segment: { start: number; end: number; text: string; words?: { word: string; start?: number; end?: number }[] },
  wordHighlight: boolean,
  pauseThreshold: number
): CaptionSegment[] {
  const text = segment.text.trim();
  if (!text) return [];
  const duration = segment.end - segment.start;
  const limits = wordHighlight
    ? { maxWords: WORD_HIGHLIGHT_MAX_WORDS, maxSeconds: WORD_HIGHLIGHT_MAX_SECONDS }
    : { maxChars: MAX_CAPTION_CHARS, maxSeconds: MAX_CAPTION_SECONDS };
  const fitsAsOneChunk =
    duration <= limits.maxSeconds &&
    (limits.maxChars === undefined || text.length <= limits.maxChars) &&
    !wordHighlight &&
    !hasInternalPause(segment.words ?? [], pauseThreshold);
  if (fitsAsOneChunk) return [{ content: text, start: segment.start, end: segment.end }];

  const rawWords = (segment.words ?? []).filter(
    (w): w is { word: string; start: number; end: number } => typeof w.start === "number" && typeof w.end === "number" && w.word.trim().length > 0
  );

  if (rawWords.length > 0) {
    return groupTimedWords(alignWordsToText(text, rawWords), limits, true, pauseThreshold);
  }

  // Estimated fallback — no real per-word timing to go on for this segment/language at all.
  // `segmentLine` returns EVERY piece of `text`, word and non-word alike, in order — non-word pieces
  // (spaces, punctuation) ARE the real separators, so they're accumulated into `pendingJoiner` and
  // attached to the NEXT word piece as its `leadingJoiner`, rather than discarded and reconstructed by
  // a guess (see `TimedWord.leadingJoiner`'s own doc comment for why a guess isn't good enough here).
  const pieces = segmentLine(text);
  const wordPieces: { text: string; leadingJoiner: string }[] = [];
  let pendingJoiner = "";
  for (const piece of pieces) {
    if (piece.isWord) {
      wordPieces.push({ text: piece.text, leadingJoiner: wordPieces.length === 0 ? "" : pendingJoiner });
      pendingJoiner = "";
    } else {
      pendingJoiner += piece.text;
    }
  }
  if (wordPieces.length === 0) return [{ content: text, start: segment.start, end: segment.end }];
  const secondsPerWord = duration / wordPieces.length;
  let index = 0;
  const estimatedWords: TimedWord[] = wordPieces.map((p) => {
    const start = segment.start + index * secondsPerWord;
    index += 1;
    return { text: p.text, leadingJoiner: p.leadingJoiner, start, end: segment.start + index * secondsPerWord };
  });
  return groupTimedWords(estimatedWords, limits, false, pauseThreshold);
}
