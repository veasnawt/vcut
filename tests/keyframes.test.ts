import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createClip } from "../src/project/createProject.ts";
import { IDENTITY_COLOR_GRADING, IDENTITY_EFFECTS, IDENTITY_TEXT_CROP, IDENTITY_TRANSFORM } from "../src/project/types.ts";
import type { Clip, ClipTransform, ColorGradingKeyframe, EffectsKeyframe, GainKeyframe, TextCropKeyframe, TransformKeyframe } from "../src/project/types.ts";
import { clipHasAnyKeyframes, hasColorGradingKeyframes, hasEffectsKeyframes, hasGainKeyframes, hasTextCropKeyframes, hasTransformKeyframes, resolveClipColorGrading, resolveClipEffects, resolveClipGain, resolveClipTransform, resolveTextCrop, upsertKeyframe } from "../src/timeline/keyframes.ts";

function clip(overrides: Partial<Clip> = {}): Clip {
  return { ...createClip({ assetId: "asset1", sourceIn: 0, sourceOut: 10, timelineStart: 0 }), ...overrides };
}

function transform(overrides: Partial<ClipTransform> = {}): ClipTransform {
  return { ...IDENTITY_TRANSFORM, ...overrides };
}

describe("resolveClipTransform", () => {
  it("falls back to clip.transform when no keyframes exist", () => {
    const c = clip({ transform: transform({ scale: 1.5 }) });
    assert.deepEqual(resolveClipTransform(c, 3), transform({ scale: 1.5 }));
  });

  it("falls back to IDENTITY_TRANSFORM when neither transform nor keyframes exist", () => {
    assert.deepEqual(resolveClipTransform(clip(), 3), IDENTITY_TRANSFORM);
  });

  it("a single keyframe holds constant across the whole clip", () => {
    const kfs: TransformKeyframe[] = [{ id: "kf1", time: 2, value: transform({ scale: 2 }) }];
    const c = clip({ transformKeyframes: kfs });
    assert.deepEqual(resolveClipTransform(c, 0), transform({ scale: 2 }));
    assert.deepEqual(resolveClipTransform(c, 2), transform({ scale: 2 }));
    assert.deepEqual(resolveClipTransform(c, 9), transform({ scale: 2 }));
  });

  it("two keyframes interpolate linearly at the exact midpoint", () => {
    const kfs: TransformKeyframe[] = [
      { id: "kf1", time: 0, value: transform({ offsetX: 0, scale: 1 }) },
      { id: "kf2", time: 4, value: transform({ offsetX: 100, scale: 2 }) },
    ];
    const c = clip({ transformKeyframes: kfs });
    assert.deepEqual(resolveClipTransform(c, 2), transform({ offsetX: 50, scale: 1.5 }));
    // A non-midpoint sample too, to confirm this isn't just an average.
    assert.deepEqual(resolveClipTransform(c, 1), transform({ offsetX: 25, scale: 1.25 }));
  });

  it("holds the first/last keyframe's value outside the keyframed range, never extrapolates", () => {
    const kfs: TransformKeyframe[] = [
      { id: "kf1", time: 2, value: transform({ offsetX: 10 }) },
      { id: "kf2", time: 5, value: transform({ offsetX: 40 }) },
    ];
    const c = clip({ transformKeyframes: kfs });
    assert.deepEqual(resolveClipTransform(c, 0), transform({ offsetX: 10 }));
    assert.deepEqual(resolveClipTransform(c, 9), transform({ offsetX: 40 }));
  });

  it("lerps crop's nested fields the same way as the top-level fields", () => {
    const kfs: TransformKeyframe[] = [
      { id: "kf1", time: 0, value: transform({ crop: { top: 0, right: 0, bottom: 0, left: 0 } }) },
      { id: "kf2", time: 2, value: transform({ crop: { top: 0.2, right: 0.4, bottom: 0.6, left: 0.8 } }) },
    ];
    const c = clip({ transformKeyframes: kfs });
    const result = resolveClipTransform(c, 1);
    assert.deepEqual(result.crop, { top: 0.1, right: 0.2, bottom: 0.3, left: 0.4 });
  });

  it("rotationDeg lerps as a plain unwrapped number — a multi-turn spin, not a shortest-arc wrap", () => {
    const kfs: TransformKeyframe[] = [
      { id: "kf1", time: 0, value: transform({ rotationDeg: 0 }) },
      { id: "kf2", time: 2, value: transform({ rotationDeg: 450 }) },
    ];
    const c = clip({ transformKeyframes: kfs });
    // A shortest-arc/wrapped interpolation would land near -45 or 45 at the midpoint; the correct
    // unwrapped answer is exactly halfway through the full 450-degree sweep.
    assert.equal(resolveClipTransform(c, 1).rotationDeg, 225);
  });
});

describe("resolveClipEffects", () => {
  it("falls back to clip.effects, then IDENTITY_EFFECTS, when no keyframes exist", () => {
    assert.deepEqual(resolveClipEffects(clip({ effects: { ...IDENTITY_EFFECTS, opacity: 0.5 } }), 3), { ...IDENTITY_EFFECTS, opacity: 0.5 });
    assert.deepEqual(resolveClipEffects(clip(), 3), IDENTITY_EFFECTS);
  });

  it("two keyframes interpolate opacity linearly at the exact midpoint (a fade)", () => {
    const kfs: EffectsKeyframe[] = [
      { id: "kf1", time: 0, value: { ...IDENTITY_EFFECTS, opacity: 1 } },
      { id: "kf2", time: 2, value: { ...IDENTITY_EFFECTS, opacity: 0 } },
    ];
    const c = clip({ effectsKeyframes: kfs });
    assert.equal(resolveClipEffects(c, 1).opacity, 0.5);
    assert.equal(resolveClipEffects(c, 0).opacity, 1);
    assert.equal(resolveClipEffects(c, 2).opacity, 0);
  });
});

describe("resolveClipColorGrading", () => {
  it("falls back to clip.colorGrading, then IDENTITY_COLOR_GRADING, when no keyframes exist", () => {
    const grading = { ...IDENTITY_COLOR_GRADING, master: [{ x: 0, y: 0.2 }, { x: 1, y: 1 }] };
    assert.deepEqual(resolveClipColorGrading(clip({ colorGrading: grading }), 3), grading);
    assert.deepEqual(resolveClipColorGrading(clip(), 3), IDENTITY_COLOR_GRADING);
  });

  it("holds — never interpolates — between two keyframes with different-shaped curves", () => {
    const identityValue = IDENTITY_COLOR_GRADING;
    const raisedValue = { ...IDENTITY_COLOR_GRADING, master: [{ x: 0, y: 0.2 }, { x: 0.5, y: 0.6 }, { x: 1, y: 1 }] };
    const kfs: ColorGradingKeyframe[] = [
      { id: "kf1", time: 0, value: identityValue },
      { id: "kf2", time: 4, value: raisedValue },
    ];
    const c = clip({ colorGradingKeyframes: kfs });
    // Anywhere strictly between the two keyframes, the result must be the EARLIER keyframe's exact
    // object reference — not a blend of the two (which wouldn't even be well-defined here, since the
    // two curves have different point counts).
    assert.equal(resolveClipColorGrading(c, 2), identityValue);
    assert.equal(resolveClipColorGrading(c, 0.01), identityValue);
    // At and after the last keyframe's own time, it holds THAT keyframe's value instead.
    assert.equal(resolveClipColorGrading(c, 4), raisedValue);
    assert.equal(resolveClipColorGrading(c, 9), raisedValue);
  });

  it("a single keyframe holds constant across the whole clip", () => {
    const value = { ...IDENTITY_COLOR_GRADING, master: [{ x: 0, y: 0.1 }, { x: 1, y: 1 }] };
    const kfs: ColorGradingKeyframe[] = [{ id: "kf1", time: 2, value }];
    const c = clip({ colorGradingKeyframes: kfs });
    assert.equal(resolveClipColorGrading(c, 0), value);
    assert.equal(resolveClipColorGrading(c, 2), value);
    assert.equal(resolveClipColorGrading(c, 9), value);
  });
});

describe("resolveTextCrop", () => {
  it("falls back to clip.textCrop, then IDENTITY_TEXT_CROP, when no keyframes exist", () => {
    const crop = { ...IDENTITY_TEXT_CROP, top: 0.2 };
    assert.deepEqual(resolveTextCrop(clip({ textCrop: crop }), 3), crop);
    assert.deepEqual(resolveTextCrop(clip(), 3), IDENTITY_TEXT_CROP);
  });

  it("a single keyframe holds constant across the whole clip", () => {
    const kfs: TextCropKeyframe[] = [{ id: "kf1", time: 2, value: { ...IDENTITY_TEXT_CROP, top: 0.3 } }];
    const c = clip({ textCropKeyframes: kfs });
    assert.deepEqual(resolveTextCrop(c, 0), { ...IDENTITY_TEXT_CROP, top: 0.3 });
    assert.deepEqual(resolveTextCrop(c, 9), { ...IDENTITY_TEXT_CROP, top: 0.3 });
  });

  it("LERPs every field linearly at the exact midpoint — unlike ColorGrading, crop has no hold-not-blend problem", () => {
    const kfs: TextCropKeyframe[] = [
      { id: "kf1", time: 0, value: { top: 0, right: 0, bottom: 0, left: 0 } },
      { id: "kf2", time: 4, value: { top: 0.2, right: 0.4, bottom: 0.6, left: 0.8 } },
    ];
    const c = clip({ textCropKeyframes: kfs });
    assert.deepEqual(resolveTextCrop(c, 2), { top: 0.1, right: 0.2, bottom: 0.3, left: 0.4 });
    // A non-midpoint sample too, to confirm this isn't just an average.
    assert.deepEqual(resolveTextCrop(c, 1), { top: 0.05, right: 0.1, bottom: 0.15, left: 0.2 });
  });

  it("holds the first/last keyframe's value outside the keyframed range, never extrapolates", () => {
    const kfs: TextCropKeyframe[] = [
      { id: "kf1", time: 2, value: { ...IDENTITY_TEXT_CROP, top: 0.1 } },
      { id: "kf2", time: 5, value: { ...IDENTITY_TEXT_CROP, top: 0.4 } },
    ];
    const c = clip({ textCropKeyframes: kfs });
    assert.deepEqual(resolveTextCrop(c, 0), { ...IDENTITY_TEXT_CROP, top: 0.1 });
    assert.deepEqual(resolveTextCrop(c, 9), { ...IDENTITY_TEXT_CROP, top: 0.4 });
  });
});

describe("hasTransformKeyframes / hasEffectsKeyframes / hasColorGradingKeyframes / hasTextCropKeyframes", () => {
  it("false for absent or empty, true once at least one keyframe exists", () => {
    assert.equal(hasTransformKeyframes(clip()), false);
    assert.equal(hasTransformKeyframes(clip({ transformKeyframes: [] })), false);
    assert.equal(hasTransformKeyframes(clip({ transformKeyframes: [{ id: "kf1", time: 0, value: transform() }] })), true);
    assert.equal(hasEffectsKeyframes(clip()), false);
    assert.equal(hasEffectsKeyframes(clip({ effectsKeyframes: [{ id: "kf1", time: 0, value: IDENTITY_EFFECTS }] })), true);
    assert.equal(hasColorGradingKeyframes(clip()), false);
    assert.equal(hasColorGradingKeyframes(clip({ colorGradingKeyframes: [] })), false);
    assert.equal(hasColorGradingKeyframes(clip({ colorGradingKeyframes: [{ id: "kf1", time: 0, value: IDENTITY_COLOR_GRADING }] })), true);
    assert.equal(hasTextCropKeyframes(clip()), false);
    assert.equal(hasTextCropKeyframes(clip({ textCropKeyframes: [] })), false);
    assert.equal(hasTextCropKeyframes(clip({ textCropKeyframes: [{ id: "kf1", time: 0, value: IDENTITY_TEXT_CROP }] })), true);
  });
});

describe("resolveClipGain", () => {
  it("falls back to clip.gain, then 1, when no keyframes exist", () => {
    assert.equal(resolveClipGain(clip({ gain: 2 }), 3), 2);
    assert.equal(resolveClipGain(clip(), 3), 1);
  });

  it("two keyframes interpolate linearly at the exact midpoint (a duck/fade)", () => {
    const kfs: GainKeyframe[] = [
      { id: "kf1", time: 0, value: 1 },
      { id: "kf2", time: 2, value: 0 },
    ];
    const c = clip({ gainKeyframes: kfs });
    assert.equal(resolveClipGain(c, 1), 0.5);
    assert.equal(resolveClipGain(c, 0), 1);
    assert.equal(resolveClipGain(c, 2), 0);
  });

  it("holds the nearest keyframe's value outside the keyframed range", () => {
    const kfs: GainKeyframe[] = [
      { id: "kf1", time: 1, value: 0.2 },
      { id: "kf2", time: 3, value: 1 },
    ];
    const c = clip({ gainKeyframes: kfs });
    assert.equal(resolveClipGain(c, 0), 0.2);
    assert.equal(resolveClipGain(c, 10), 1);
  });

  it("ignores clip.gain entirely once keyframes exist — keyframes are the whole story, not a patch", () => {
    const c = clip({ gain: 4, gainKeyframes: [{ id: "kf1", time: 0, value: 1 }] });
    assert.equal(resolveClipGain(c, 5), 1);
  });
});

describe("hasGainKeyframes", () => {
  it("false for absent or empty, true once at least one keyframe exists", () => {
    assert.equal(hasGainKeyframes(clip()), false);
    assert.equal(hasGainKeyframes(clip({ gainKeyframes: [] })), false);
    assert.equal(hasGainKeyframes(clip({ gainKeyframes: [{ id: "kf1", time: 0, value: 1 }] })), true);
  });
});

describe("upsertKeyframe", () => {
  const fps = 30;
  const tolerance = 1 / fps / 2; // half a frame

  it("inserts a new keyframe when editing far from any existing one, leaving others untouched", () => {
    const existing: TransformKeyframe[] = [{ id: "kf1", time: 0, value: transform({ scale: 1 }) }];
    const next = upsertKeyframe(existing, 5, transform({ scale: 3 }), fps);
    assert.equal(next.length, 2);
    assert.equal(next[0].id, "kf1");
    assert.deepEqual(next[0].value, transform({ scale: 1 }));
    assert.deepEqual(next[1].value, transform({ scale: 3 }));
  });

  it("replaces the existing keyframe's value in place when editing well within tolerance", () => {
    const existing: TransformKeyframe[] = [
      { id: "kf1", time: 0, value: transform({ scale: 1 }) },
      { id: "kf2", time: 2, value: transform({ scale: 2 }) },
    ];
    const next = upsertKeyframe(existing, 2.001, transform({ scale: 9 }), fps);
    assert.equal(next.length, 2);
    assert.equal(next[1].id, "kf2");
    assert.deepEqual(next[1].value, transform({ scale: 9 }));
    // The time doesn't move, only the value.
    assert.equal(next[1].time, 2);
  });

  it("the tolerance boundary is exactly frameDuration(fps)/2 — inside replaces, outside inserts", () => {
    const existing: TransformKeyframe[] = [{ id: "kf1", time: 1, value: transform({ scale: 1 }) }];

    const justInside = upsertKeyframe(existing, 1 + tolerance - 1e-9, transform({ scale: 5 }), fps);
    assert.equal(justInside.length, 1, "within tolerance should replace, not insert");

    const justOutside = upsertKeyframe(existing, 1 + tolerance + 1e-9, transform({ scale: 5 }), fps);
    assert.equal(justOutside.length, 2, "beyond tolerance should insert a new keyframe");
  });

  it("returns a time-sorted array regardless of insertion order", () => {
    let kfs: TransformKeyframe[] = [];
    kfs = upsertKeyframe(kfs, 5, transform({ scale: 1 }), fps);
    kfs = upsertKeyframe(kfs, 1, transform({ scale: 2 }), fps);
    kfs = upsertKeyframe(kfs, 3, transform({ scale: 3 }), fps);
    assert.deepEqual(kfs.map((k) => k.time), [1, 3, 5]);
  });

  it("snaps a newly-inserted keyframe's time to the frame grid", () => {
    const kfs = upsertKeyframe<ClipTransform>([], 1.0037, transform(), fps);
    assert.equal(kfs[0].time, Math.round(1.0037 * fps) / fps);
  });
});

// `Inspector` subscribes to the playhead only for a clip where this is true (a clip with none has no
// value that can change as the playhead moves) -- a property group missing from this predicate would
// leave that group's Inspector display frozen during playback, with no error. One case per field.
describe("clipHasAnyKeyframes", () => {
  const kf = [{ id: "k1", time: 1, value: {} }];
  const fields = ["transformKeyframes", "effectsKeyframes", "colorGradingKeyframes", "textStyleKeyframes", "textCropKeyframes", "gainKeyframes"] as const;

  it("is false for a clip with no keyframes, or only empty arrays", () => {
    assert.equal(clipHasAnyKeyframes(clip()), false);
    for (const field of fields) assert.equal(clipHasAnyKeyframes(clip({ [field]: [] } as Partial<Clip>)), false, `${field}: []`);
  });

  for (const field of fields) {
    it(`is true when only ${field} has entries`, () => {
      assert.equal(clipHasAnyKeyframes(clip({ [field]: kf } as Partial<Clip>)), true);
    });
  }
});
