import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  alignWordsToText,
  attachWordsToSegments,
  chunkSegment,
  computePauseThreshold,
  groupTimedWords,
  MIN_GAP_SAMPLES_FOR_ADAPTIVE,
  PAUSE_GAP_FLOOR_SECONDS,
  repairGapsWithRealSilence,
} from "../src/captions/chunking.ts";

/** The exact real Kiri response captured from a live production job during the Auto Captions pause-
 *  detection investigation (2026-09-12) — a Khmer sentence with a genuine English loanword
 *  ("reflection") mid-sentence and two real speech pauses. Kept as a realistic fixture rather than
 *  synthetic data because the investigation's real bugs (Kiri's flat `words` array being discarded,
 *  `repairGapsWithRealSilence`'s first version picking the wrong caption to adjust) were only ever
 *  found against data shaped exactly like this — a fabricated fixture could easily miss the same
 *  edge cases a second time. */
const REAL_KIRI_SEGMENTS = [
  {
    start: 0.06,
    end: 4.323,
    text: "ពេលដែលអ្នកទាំងអស់គ្នាមើលឃើញមុខខ្លួនឯង អ្នកទាំងអស់គ្នាតែងតែមើលឃើញ reflection",
  },
  {
    start: 4.323,
    end: 10.387,
    text: "អ្នកទាំងអស់គ្នាតែងតែមើលឃើញរូបថត ឬក៏អ្នកទាំងអស់គ្នាមើលឃើញមុខខ្លួនឯងតាមវីដេអូ",
  },
];
const REAL_KIRI_WORDS = [
  { word: "ពេល", start: 0.06, end: 0.2 },
  { word: "ដែល", start: 0.2, end: 0.32 },
  { word: "អ្នក", start: 0.32, end: 0.44 },
  { word: "ទាំងអស់", start: 0.44, end: 0.72 },
  { word: "គ្នា", start: 0.74, end: 0.901 },
  { word: "មើលឃើញ", start: 0.981, end: 1.341 },
  { word: "មុខ", start: 1.361, end: 1.501 },
  { word: "ខ្លួន", start: 1.501, end: 1.721 },
  { word: "ឯង", start: 1.741, end: 1.981 },
  { word: "អ្នក", start: 1.981, end: 2.121 },
  { word: "ទាំងអស់", start: 2.121, end: 2.361 },
  { word: "គ្នា", start: 2.361, end: 2.542 },
  { word: "តែងតែ", start: 2.602, end: 2.902 },
  { word: "មើលឃើញ", start: 2.942, end: 3.442 },
  { word: "reflection", start: 3.782, end: 4.323 },
  { word: "អ្នក", start: 4.323, end: 5.824 },
  { word: "ទាំងអស់", start: 5.824, end: 6.124 },
  { word: "គ្នា", start: 6.124, end: 6.284 },
  { word: "តែងតែ", start: 6.364, end: 6.684 },
  { word: "មើលឃើញ", start: 6.724, end: 7.104 },
  { word: "រូបថត", start: 7.145, end: 7.665 },
  { word: "ឬក៏", start: 7.965, end: 8.185 },
  { word: "អ្នក", start: 8.185, end: 8.285 },
  { word: "ទាំងអស់", start: 8.285, end: 8.545 },
  { word: "គ្នា", start: 8.545, end: 8.726 },
  { word: "មើលឃើញ", start: 8.786, end: 9.186 },
  { word: "មុខ", start: 9.186, end: 9.326 },
  { word: "ខ្លួន", start: 9.326, end: 9.546 },
  { word: "ឯង", start: 9.546, end: 9.746 },
  { word: "តាម", start: 9.766, end: 9.966 },
  { word: "វីដេអូ", start: 9.986, end: 10.387 },
];

describe("attachWordsToSegments", () => {
  it("assigns each word to the segment whose [start, end) window contains it", () => {
    const segments = [
      { start: 0, end: 5, text: "a" },
      { start: 5, end: 10, text: "b" },
    ];
    const words = [
      { word: "w1", start: 1, end: 2 },
      { word: "w2", start: 4.9, end: 5 },
      { word: "w3", start: 5, end: 6 },
      { word: "w4", start: 9, end: 9.5 },
    ];
    const result = attachWordsToSegments(segments, words);
    assert.deepEqual(
      result.map((s) => s.words.map((w) => w.word)),
      [["w1", "w2"], ["w3", "w4"]]
    );
  });

  it("falls back to the LAST segment for a word landing past the final segment's own end", () => {
    const segments = [{ start: 0, end: 5, text: "a" }];
    const words = [{ word: "late", start: 5.2, end: 5.4 }];
    const result = attachWordsToSegments(segments, words);
    assert.deepEqual(
      result[0].words.map((w) => w.word),
      ["late"]
    );
  });

  it("matches the real captured Kiri fixture's own word count split (15 + 16)", () => {
    const result = attachWordsToSegments(REAL_KIRI_SEGMENTS, REAL_KIRI_WORDS);
    assert.equal(result[0].words.length, 15);
    assert.equal(result[1].words.length, 16);
    assert.equal(result[0].words[result[0].words.length - 1].word, "reflection");
  });
});

describe("computePauseThreshold", () => {
  it("falls back to the plain floor with too few real gap samples to trust a median/MAD", () => {
    const segments = [{ words: [{ word: "a", start: 0, end: 0.1 }, { word: "b", start: 0.7, end: 0.8 }] }];
    assert.equal(computePauseThreshold(segments), PAUSE_GAP_FLOOR_SECONDS);
  });

  it("adapts UP for a slow speaker whose own normal word gaps run close to the fixed floor, without losing real pauses", () => {
    // A speaker whose ordinary word-to-word gap runs 0.15-0.25s — dangerously close to the OLD fixed
    // 0.3s constant this replaced — with two genuine pauses at 0.9s/1.1s mixed in. 13 words (not 12):
    // the first entry is a leading offset with no PRIOR word to pair with, so N words produce N-1
    // counted inter-word gaps — 13 is what actually reaches MIN_GAP_SAMPLES_FOR_ADAPTIVE (12).
    const gaps = [0.18, 0.22, 0.15, 0.9, 0.2, 0.25, 0.18, 1.1, 0.16, 0.2, 0.22, 0.19, 0.2];
    let t = 0;
    const words = gaps.map((gap, i) => {
      t += gap;
      const w = { word: `w${i}`, start: t, end: t + 0.15 };
      t += 0.15;
      return w;
    });
    assert.equal(words.length - 1, MIN_GAP_SAMPLES_FOR_ADAPTIVE, "fixture must produce exactly the minimum sample count the adaptive path needs");
    const threshold = computePauseThreshold([{ words }]);
    // Must clear this speaker's own normal cadence (else every sentence would get falsely split)...
    assert.ok(threshold > 0.25, `threshold ${threshold} should exceed this speaker's own normal 0.25s gaps`);
    // ...but still catch both real pauses.
    assert.ok(threshold < 0.9, `threshold ${threshold} should still be below the real 0.9s/1.1s pauses`);
  });

  it("stays at the floor for a fast speaker whose real pauses are small in absolute terms", () => {
    // Tiny normal gaps (0.02-0.06s) with two real pauses at 0.35s/0.40s — the OLD fixed 0.3s constant
    // barely (or didn't) catch these; a threshold that adapted UPWARD here would miss them entirely.
    const gaps = [0.03, 0.05, 0.02, 0.04, 0.35, 0.03, 0.05, 0.06, 0.02, 0.4, 0.03, 0.05, 0.04];
    let t = 0;
    const words = gaps.map((gap, i) => {
      t += gap;
      const w = { word: `w${i}`, start: t, end: t + 0.05 };
      t += 0.05;
      return w;
    });
    const threshold = computePauseThreshold([{ words }]);
    assert.equal(threshold, PAUSE_GAP_FLOOR_SECONDS);
    assert.ok(threshold < 0.35 && threshold < 0.4, "floor threshold must still be below both real pauses");
  });

  it("computes a real, non-floor threshold from the real captured Kiri fixture (>= minimum sample size)", () => {
    const withWords = attachWordsToSegments(REAL_KIRI_SEGMENTS, REAL_KIRI_WORDS);
    // 30 gaps total across both segments (31 words - 1 per-segment boundary not counted across
    // segments) — comfortably above MIN_GAP_SAMPLES_FOR_ADAPTIVE, so this exercises the real
    // median/MAD path, not the floor fallback.
    let gapCount = 0;
    for (const s of withWords) gapCount += Math.max(0, s.words.length - 1);
    assert.ok(gapCount >= MIN_GAP_SAMPLES_FOR_ADAPTIVE, `expected >= ${MIN_GAP_SAMPLES_FOR_ADAPTIVE} samples, got ${gapCount}`);
    const threshold = computePauseThreshold(withWords);
    // The real gap distribution here is mostly near-zero with two outliers (0.34s, 0.30s) — the
    // adaptive threshold should land at or near the floor (median is 0), and must clear neither real
    // pause by being too high.
    assert.ok(threshold < 0.3, `threshold ${threshold} must stay below the real 0.30s/0.34s pauses in this fixture`);
  });
});

describe("alignWordsToText", () => {
  it("reads the REAL separator between two words directly from source text, including a foreign loanword's own spacing", () => {
    const result = alignWordsToText("hello reflection world", [
      { word: "hello", start: 0, end: 1 },
      { word: "reflection", start: 1, end: 2 },
      { word: "world", start: 2, end: 3 },
    ]);
    assert.equal(result[0].leadingJoiner, "");
    assert.equal(result[1].leadingJoiner, " ");
    assert.equal(result[2].leadingJoiner, " ");
  });

  it("falls back to a plain space when a word can't be located from the current cursor onward", () => {
    const result = alignWordsToText("abc", [
      { word: "abc", start: 0, end: 1 },
      { word: "zzz", start: 1, end: 2 }, // not present in text at all
    ]);
    assert.equal(result[1].leadingJoiner, " ");
  });
});

describe("groupTimedWords", () => {
  const w = (text: string, start: number, end: number, leadingJoiner = " ") => ({ text, start, end, leadingJoiner });

  it("splits on a real per-word gap exceeding pauseThreshold when includeWordTimings is true", () => {
    const words = [w("a", 0, 0.1, ""), w("b", 0.15, 0.25), w("c", 1.5, 1.6)];
    const chunks = groupTimedWords(words, { maxSeconds: 100 }, true, 0.3);
    assert.equal(chunks.length, 2);
    assert.equal(chunks[0].content, "a b");
    assert.equal(chunks[1].content, "c");
  });

  it("does NOT split on a gap when includeWordTimings is false (estimated fallback has no real silence to detect)", () => {
    const words = [w("a", 0, 0.1, ""), w("b", 0.15, 0.25), w("c", 1.5, 1.6)];
    const chunks = groupTimedWords(words, { maxSeconds: 100 }, false, 0.3);
    assert.equal(chunks.length, 1);
  });

  it("splits on the word-count budget regardless of timing", () => {
    const words = [w("a", 0, 1, ""), w("b", 1, 2), w("c", 2, 3), w("d", 3, 4), w("e", 4, 5)];
    const chunks = groupTimedWords(words, { maxWords: 2, maxSeconds: 100 }, false, 100);
    assert.deepEqual(chunks.map((c) => c.content), ["a b", "c d", "e"]);
  });

  it("splits on the character budget regardless of timing", () => {
    const words = [w("aaaa", 0, 1, ""), w("bbbb", 1, 2), w("cccc", 2, 3)];
    const chunks = groupTimedWords(words, { maxChars: 9, maxSeconds: 100 }, false, 100);
    assert.deepEqual(chunks.map((c) => c.content), ["aaaa bbbb", "cccc"]);
  });
});

describe("chunkSegment (end-to-end against the real captured Kiri fixture)", () => {
  const withWords = attachWordsToSegments(REAL_KIRI_SEGMENTS, REAL_KIRI_WORDS);

  it("plain captions: splits on the two real pauses, landing 'reflection' as its own chunk with a real gap before it", () => {
    const pauseThreshold = computePauseThreshold(withWords);
    const chunks = withWords.flatMap((s) => chunkSegment(s, false, pauseThreshold));
    const reflectionIdx = chunks.findIndex((c) => c.content === "reflection");
    assert.ok(reflectionIdx > 0, "'reflection' should land as its own chunk, not merged into a longer line");
    const gapBefore = chunks[reflectionIdx].start - chunks[reflectionIdx - 1].end;
    assert.ok(gapBefore > 0.3, `expected a real ~0.34s gap before 'reflection', got ${gapBefore}`);
  });

  it("word highlight: 'reflection' is isolated as a short chunk (tight word-count cap)", () => {
    const pauseThreshold = computePauseThreshold(withWords);
    const chunks = withWords.flatMap((s) => chunkSegment(s, true, pauseThreshold));
    const reflectionChunk = chunks.find((c) => c.content === "reflection");
    assert.ok(reflectionChunk, "'reflection' should exist as an isolated word-highlight chunk");
    assert.ok(reflectionChunk!.words && reflectionChunk!.words.length === 1, "should carry its own real per-word timing");
  });

  it("falls back to even-spread estimated timing when a segment has no real per-word data at all", () => {
    const chunks = chunkSegment({ start: 0, end: 2, text: "hello world" }, false, 0.2);
    assert.equal(chunks.length, 1);
    assert.equal(chunks[0].content, "hello world");
    assert.equal(chunks[0].words, undefined, "estimated timing must never be reported as if it were real");
  });
});

describe("repairGapsWithRealSilence", () => {
  it("regression: widens the gap AFTER the correct caption when the reported boundary was smeared to zero", () => {
    // The exact real reported failure shape: Kiri's own timestamp claimed the sentence after
    // "reflection" starts at the identical instant "reflection" itself ends (zero reported gap),
    // when the real audio (independently VAD-measured) has a ~1s pause there.
    const captions = [
      { content: "តែងតែមើលឃើញ", start: 2.602, end: 3.442 },
      { content: "reflection", start: 3.782, end: 4.323 },
      { content: "អ្នកទាំងអស់គ្នា", start: 4.323, end: 6.284 },
    ];
    const realSilences = [{ start: 4.323, end: 5.32 }];
    repairGapsWithRealSilence(captions, realSilences);

    // "reflection" itself must be UNTOUCHED — a first (buggy) version of this function moved
    // "reflection"'s own start instead, since its reported start already looked like it was "before"
    // the silence ended.
    assert.deepEqual(captions[1], { content: "reflection", start: 3.782, end: 4.323 });
    assert.equal(captions[2].start, 5.32, "the NEXT caption's start should be pushed to the real silence's end");
    const gap = captions[2].start - captions[1].end;
    assert.ok(Math.abs(gap - 0.997) < 0.001, `expected ~1s real gap, got ${gap}`);
  });

  it("is a safe no-op when no adjacent pair's combined span contains the silence", () => {
    const captions = [{ start: 5, end: 6, content: "a" }];
    const before = JSON.stringify(captions);
    repairGapsWithRealSilence(captions, [{ start: 0, end: 1 }]);
    assert.equal(JSON.stringify(captions), before);
  });

  it("is a safe no-op when the gap is already correctly reflected in the data", () => {
    const captions = [
      { content: "a", start: 0, end: 1 },
      { content: "b", start: 2, end: 3 },
    ];
    const before = JSON.stringify(captions);
    repairGapsWithRealSilence(captions, [{ start: 1, end: 2 }]);
    assert.equal(JSON.stringify(captions), before);
  });

  it("never produces an inverted (end <= start) caption even for a silence overlapping most of a short clip", () => {
    const captions = [
      { content: "a", start: 0, end: 1 },
      { content: "b", start: 1, end: 1.1 },
      { content: "c", start: 1.1, end: 3 },
    ];
    // A silence spanning almost the entire tiny middle caption.
    repairGapsWithRealSilence(captions, [{ start: 0.95, end: 1.09 }]);
    for (const c of captions) assert.ok(c.end > c.start, `caption "${c.content}" must never invert: [${c.start}, ${c.end}]`);
  });
});
