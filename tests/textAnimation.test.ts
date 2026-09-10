import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  activeWordIndex,
  activeWordIndexFromBoundaries,
  computeTextAnimationTransform,
  segmentLine,
  splitWords,
  typewriterVisibleContent,
  wordBoundaries,
} from "../src/timeline/textAnimation.ts";

describe("computeTextAnimationTransform", () => {
  it("bounce starts at rest (elapsed 0) and only ever moves upward, never below rest", () => {
    const start = computeTextAnimationTransform("bounce", 0);
    // `-Math.abs(Math.sin(0))` is `-0`, not `0` — a harmless floating-point artifact (visually and
    // numerically equal to 0 everywhere else), so compare with `+start.dy` rather than `deepEqual`,
    // which treats `-0`/`0` as distinct.
    assert.deepEqual({ ...start, dy: start.dy + 0 }, { dx: 0, dy: 0, scale: 1, rotationDeg: 0 });

    for (let t = 0; t < 3; t += 0.05) {
      const { dy } = computeTextAnimationTransform("bounce", t);
      assert.ok(dy <= 0, `dy should never be positive (below rest) at t=${t}, got ${dy}`);
    }
  });

  it("pulse oscillates scale symmetrically around 1", () => {
    const start = computeTextAnimationTransform("pulse", 0);
    assert.equal(start.scale, 1);

    let sawAbove = false;
    let sawBelow = false;
    for (let t = 0; t < 3; t += 0.05) {
      const { scale } = computeTextAnimationTransform("pulse", t);
      if (scale > 1) sawAbove = true;
      if (scale < 1) sawBelow = true;
    }
    assert.ok(sawAbove && sawBelow, "pulse should swing both above and below scale 1");
  });

  it("wiggle oscillates rotation symmetrically around 0", () => {
    const start = computeTextAnimationTransform("wiggle", 0);
    assert.equal(start.rotationDeg, 0);

    let sawPositive = false;
    let sawNegative = false;
    for (let t = 0; t < 3; t += 0.05) {
      const { rotationDeg } = computeTextAnimationTransform("wiggle", t);
      if (rotationDeg > 0) sawPositive = true;
      if (rotationDeg < 0) sawNegative = true;
    }
    assert.ok(sawPositive && sawNegative, "wiggle should swing both clockwise and counter-clockwise");
  });

  it("typewriter's transform is always identity — it changes the content, not the geometry", () => {
    assert.deepEqual(computeTextAnimationTransform("typewriter", 0), { dx: 0, dy: 0, scale: 1, rotationDeg: 0 });
    assert.deepEqual(computeTextAnimationTransform("typewriter", 5), { dx: 0, dy: 0, scale: 1, rotationDeg: 0 });
  });

  it("wordHighlight's transform is always identity — it changes fill color per word, not the geometry", () => {
    assert.deepEqual(computeTextAnimationTransform("wordHighlight", 0), { dx: 0, dy: 0, scale: 1, rotationDeg: 0 });
    assert.deepEqual(computeTextAnimationTransform("wordHighlight", 5), { dx: 0, dy: 0, scale: 1, rotationDeg: 0 });
  });

  it("is deterministic — the same elapsed time always produces the same transform (scrub-safe)", () => {
    const a = computeTextAnimationTransform("pulse", 1.234);
    const b = computeTextAnimationTransform("pulse", 1.234);
    assert.deepEqual(a, b);
  });
});

describe("typewriterVisibleContent", () => {
  it("reveals nothing at elapsed 0", () => {
    assert.equal(typewriterVisibleContent("Hello world", 0), "");
  });

  it("reveals a growing prefix as elapsed time increases", () => {
    const content = "Hello world";
    const early = typewriterVisibleContent(content, 0.1);
    const later = typewriterVisibleContent(content, 0.3);
    assert.ok(early.length < later.length);
    assert.ok(content.startsWith(early));
    assert.ok(content.startsWith(later));
  });

  it("clamps to the full string once enough time has passed, never overflowing", () => {
    assert.equal(typewriterVisibleContent("Hello", 100), "Hello");
  });

  it("handles empty content without throwing", () => {
    assert.equal(typewriterVisibleContent("", 1), "");
  });
});

describe("splitWords", () => {
  it("splits on whitespace, in reading order", () => {
    assert.deepEqual(splitWords("Hello world today"), ["Hello", "world", "today"]);
  });

  it("collapses multiple/mixed whitespace, including newlines, into single separators", () => {
    assert.deepEqual(splitWords("Hello   world\ntoday"), ["Hello", "world", "today"]);
  });

  it("returns an empty array for empty or whitespace-only content", () => {
    assert.deepEqual(splitWords(""), []);
    assert.deepEqual(splitWords("   \n  "), []);
  });

  it("splits Khmer text into its real words even though Khmer never spaces words at all", () => {
    // "សួស្តី" (hello) + "អ្នករាល់គ្នា" (everyone) written with NO space between them, exactly how
    // Khmer is actually written — a plain `.split(/\s+/)` would return this whole string as one
    // "word", which is the bug this feature fixes (see `segmentLine`'s own comment).
    assert.deepEqual(splitWords("សួស្តីអ្នករាល់គ្នា"), ["សួស្តី", "អ្នករាល់គ្នា"]);
  });

  it("splits a longer, real Khmer sentence into its correct individual words", () => {
    // "Hello everyone, today the weather is very nice" — six real words, no spaces anywhere.
    assert.deepEqual(splitWords("សួស្តីអ្នករាល់គ្នាថ្ងៃនេះអាកាសធាតុល្អណាស់"), [
      "សួស្តី",
      "អ្នករាល់គ្នា",
      "ថ្ងៃនេះ",
      "អាកាសធាតុ",
      "ល្អ",
      "ណាស់",
    ]);
  });

  it("segments mixed Khmer/Latin/digit content correctly in one pass, no per-script branching needed", () => {
    assert.deepEqual(splitWords("ខ្ញុំចង់ញ៉ាំបាយ Hello World 123"), ["ខ្ញុំ", "ចង់", "ញ៉ាំបាយ", "Hello", "World", "123"]);
  });
});

describe("segmentLine", () => {
  it("reproduces the original line exactly when every segment's text is concatenated back together", () => {
    for (const line of ["Hello   world", "សួស្តីអ្នករាល់គ្នា", "  leading and trailing  ", "no-words-here !!! ,,,"]) {
      const rebuilt = segmentLine(line)
        .map((s) => s.text)
        .join("");
      assert.equal(rebuilt, line);
    }
  });

  it("marks whitespace segments as non-word, words as word", () => {
    const segments = segmentLine("Hello world");
    assert.deepEqual(
      segments.map((s) => ({ text: s.text, isWord: s.isWord })),
      [
        { text: "Hello", isWord: true },
        { text: " ", isWord: false },
        { text: "world", isWord: true },
      ]
    );
  });

  it("marks adjacent Khmer words as separate word segments with no separator between them", () => {
    const segments = segmentLine("សួស្តីអ្នករាល់គ្នា");
    assert.deepEqual(
      segments.map((s) => ({ text: s.text, isWord: s.isWord })),
      [
        { text: "សួស្តី", isWord: true },
        { text: "អ្នករាល់គ្នា", isWord: true },
      ]
    );
  });
});

describe("activeWordIndex", () => {
  it("returns -1 for zero words or a non-positive clip duration", () => {
    assert.equal(activeWordIndex(0, 1, 5), -1);
    assert.equal(activeWordIndex(3, 1, 0), -1);
    assert.equal(activeWordIndex(3, 1, -2), -1);
  });

  it("starts at word 0 and reaches the last word right around the clip's own end", () => {
    // 4 words evenly spread across a 4s clip -> 1s per word.
    assert.equal(activeWordIndex(4, 0, 4), 0);
    assert.equal(activeWordIndex(4, 0.5, 4), 0);
    assert.equal(activeWordIndex(4, 1.1, 4), 1);
    assert.equal(activeWordIndex(4, 2.1, 4), 2);
    assert.equal(activeWordIndex(4, 3.1, 4), 3);
  });

  it("clamps to the last word once elapsed exceeds the clip's own duration, never overflowing", () => {
    assert.equal(activeWordIndex(4, 100, 4), 3);
  });

  it("never returns a negative index once there genuinely is at least one word and duration", () => {
    assert.equal(activeWordIndex(4, -5, 4), 0);
  });
});

describe("wordBoundaries + activeWordIndexFromBoundaries", () => {
  it("with no real timing, matches activeWordIndex's own even-spread behavior exactly at every point tested above", () => {
    const boundaries = wordBoundaries(4, 4);
    assert.deepEqual(boundaries, [0, 1, 2, 3, 4]);
    assert.equal(activeWordIndexFromBoundaries(boundaries, 0), 0);
    assert.equal(activeWordIndexFromBoundaries(boundaries, 0.5), 0);
    assert.equal(activeWordIndexFromBoundaries(boundaries, 1.1), 1);
    assert.equal(activeWordIndexFromBoundaries(boundaries, 2.1), 2);
    assert.equal(activeWordIndexFromBoundaries(boundaries, 3.1), 3);
    assert.equal(activeWordIndexFromBoundaries(boundaries, 100), 3, "clamps to the last word past the clip's own end");
    assert.equal(activeWordIndexFromBoundaries(boundaries, -5), 0, "never negative");
  });

  it("returns -1 for zero words, same as activeWordIndex", () => {
    assert.equal(activeWordIndexFromBoundaries(wordBoundaries(0, 5), 1), -1);
  });

  it("uses REAL, unevenly-spaced per-word timing when given — the actual sync fix", () => {
    // A short word, then a long drawled one, then a short one again — nothing like an even 1s/word split.
    const timings = [
      { start: 0, end: 0.2 },
      { start: 0.2, end: 2.5 },
      { start: 2.5, end: 3 },
    ];
    const boundaries = wordBoundaries(3, 3, timings);
    assert.deepEqual(boundaries, [0, 0.2, 2.5, 3]);
    assert.equal(activeWordIndexFromBoundaries(boundaries, 0.1), 0, "still word 0 just before it ends");
    assert.equal(activeWordIndexFromBoundaries(boundaries, 0.2), 1, "word 1 begins exactly at its own real start");
    assert.equal(activeWordIndexFromBoundaries(boundaries, 2.4), 1, "still word 1 through its whole real (long) span");
    assert.equal(activeWordIndexFromBoundaries(boundaries, 2.6), 2);
    // The even-spread equivalent (1s/word) would have said word 1 at elapsed=2.4 — confirms this
    // genuinely isn't just falling back to the old approximation.
    assert.notEqual(activeWordIndex(3, 2.4, 3), 1);
  });

  it("falls back to even spread when the real timing array's length doesn't match the word count", () => {
    // Simulates hand-edited caption text after landing (a word added/removed) — stale real timing for
    // the OLD word list can't be trusted to still line up with the NEW one.
    const staleTimings = [{ start: 0, end: 1 }, { start: 1, end: 2 }];
    const boundaries = wordBoundaries(4, 4, staleTimings);
    assert.deepEqual(boundaries, [0, 1, 2, 3, 4], "even spread, ignoring the mismatched real timings entirely");
  });
});
