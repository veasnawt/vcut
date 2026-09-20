import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createClip } from "../src/project/createProject.ts";
import type { Track } from "../src/project/types.ts";
import { easeTransition, glitchCutBurst, glitchCutBurstIndex, glitchCutShowsIncoming, midpointIntensity, SLICE_STRIP_COUNT, sliceStripBounds, sliceStripProgress } from "../src/timeline/transitionMotion.ts";
import { transitionPartnerSourceTime, transitionTailExtension } from "../src/timeline/transitions.ts";

describe("transition motion", () => {
  it("eases monotonically with symmetric endpoints and a centered intensity peak", () => {
    assert.equal(easeTransition(-1), 0);
    assert.equal(easeTransition(2), 1);
    let previous = 0;
    for (let i = 0; i <= 100; i++) {
      const q = i / 100;
      const eased = easeTransition(q);
      assert.ok(eased >= previous);
      assert.ok(Math.abs(eased + easeTransition(1 - q) - 1) < 1e-9);
      previous = eased;
    }
    assert.deepEqual([0, 0.5, 1].map(midpointIntensity), [0, 1, 0]);
  });

  it("covers every pixel with contiguous strips, including widths not divisible by ten", () => {
    for (const width of [160, 854, 1080, 1920]) {
      let right = 0;
      for (let i = 0; i < SLICE_STRIP_COUNT; i++) {
        const strip = sliceStripBounds(width, i);
        assert.equal(strip.x, right);
        right += strip.width;
        assert.equal(sliceStripProgress(0, i), 0);
        assert.equal(sliceStripProgress(1, i), 1);
      }
      assert.equal(right, width);
      assert.ok(sliceStripProgress(0.4, 0) > sliceStripProgress(0.4, 9));
    }
  });

  it("keeps glitch bursts stable and switches from outgoing to incoming at the endpoints", () => {
    assert.equal(glitchCutBurstIndex(0.01), glitchCutBurstIndex(0.05));
    assert.notEqual(glitchCutBurstIndex(0.05), glitchCutBurstIndex(0.08));
    assert.deepEqual(glitchCutBurst(3, 0.7), glitchCutBurst(3, 0.7));
    const clean = glitchCutBurst(3, 0);
    assert.equal(Math.abs(clean.shiftR), 0);
    assert.ok(clean.bands.every(b => Math.abs(b.shift) === 0));
    assert.equal(glitchCutShowsIncoming(0, 1), false);
    assert.equal(glitchCutShowsIncoming(14, 1), true);
  });
});

describe("outgoing source handles", () => {
  const outgoing = createClip({ assetId: "a", sourceIn: 2, sourceOut: 5, timelineStart: 0 });
  const incoming = { ...createClip({ assetId: "b", sourceIn: 0, sourceOut: 4, timelineStart: 3 }), transitionIn: { type: "crossfade" as const, duration: 1 } };
  const track: Track = { id: "v", name: "V1", kind: "video", clips: [outgoing, incoming], locked: false, visible: true, muted: false, solo: false };

  it("continues past the out-point and clamps to the available source", () => {
    assert.equal(transitionPartnerSourceTime(outgoing, -1), 5);
    assert.equal(transitionPartnerSourceTime(outgoing, 0.5), 5.5);
    assert.equal(transitionPartnerSourceTime(outgoing, 0.5, 5.2), 5.2);
    assert.equal(transitionPartnerSourceTime(outgoing, 0.5, 5), 5);
  });

  it("extends only clips that feed a real adjacent blend", () => {
    assert.equal(transitionTailExtension(track, outgoing), 1);
    assert.equal(transitionTailExtension(track, incoming), 0);
    assert.equal(transitionTailExtension({ ...track, clips: [outgoing, { ...incoming, timelineStart: 4 }] }, outgoing), 0);
    assert.equal(transitionTailExtension({ ...track, clips: [outgoing, { ...incoming, transitionIn: undefined }] }, outgoing), 0);
    assert.equal(transitionTailExtension({ ...track, clips: [outgoing, { ...incoming, sourceOut: 0.2 }] }, outgoing), 0.2);
  });
});
