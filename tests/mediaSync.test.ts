import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { planMediaSync } from "../src/playback/PlaybackEngine.ts";

const base = { currentTime: 5, playbackRate: 1, seeking: false, seekingForMs: 0 };

describe("planMediaSync", () => {
  it("leaves a mid-seek element completely alone, even with the clock well ahead", () => {
    // The on-device report: stuck seeking with currentTime ~1.07s behind the clock. Any rate write or
    // extra seek here is what kept interrupting the seek.
    const action = planMediaSync({ ...base, currentTime: 4.536, seeking: true, seekingForMs: 300 }, 5.603, true);
    assert.deepEqual(action, { playbackRate: null, seekTo: null });
  });

  it("does not nudge playbackRate during a seek even when the rate is already off 1", () => {
    const action = planMediaSync({ ...base, playbackRate: 1.3, seeking: true, seekingForMs: 1000 }, 5.5, true);
    assert.deepEqual(action, { playbackRate: null, seekTo: null });
  });

  it("re-issues a seek that has been pending past the stuck threshold", () => {
    const action = planMediaSync({ ...base, currentTime: 4.536, seeking: true, seekingForMs: 2500 }, 6.9, true);
    assert.equal(action.seekTo, 6.9);
    assert.equal(action.playbackRate, null, "rate already 1, nothing to reset");
  });

  it("hard-seeks on large drift and resets a stale nudge first", () => {
    const action = planMediaSync({ ...base, currentTime: 2, playbackRate: 1.4 }, 5, true);
    assert.deepEqual(action, { playbackRate: 1, seekTo: 5 });
  });

  it("hard-seeks without touching playbackRate when it is already 1", () => {
    const action = planMediaSync({ ...base, currentTime: 2 }, 5, true);
    assert.deepEqual(action, { playbackRate: null, seekTo: 5 });
  });

  it("nudges the rate up when behind and down when ahead, within the drift tolerance", () => {
    const behind = planMediaSync({ ...base, currentTime: 4.5 }, 5, true);
    assert.equal(behind.seekTo, null);
    assert.ok(behind.playbackRate !== null && behind.playbackRate > 1);

    const ahead = planMediaSync({ ...base, currentTime: 5.5 }, 5, true);
    assert.equal(ahead.seekTo, null);
    assert.ok(ahead.playbackRate !== null && ahead.playbackRate < 1);
  });

  it("skips a rate write too small to matter, so the rate isn't rewritten every frame", () => {
    const first = planMediaSync({ ...base, currentTime: 4.5 }, 5, true);
    assert.ok(first.playbackRate !== null);
    const nextFrame = planMediaSync({ ...base, currentTime: 4.5, playbackRate: first.playbackRate }, 5.005, true);
    assert.deepEqual(nextFrame, { playbackRate: null, seekTo: null });
  });

  it("returns the rate to exactly 1 inside the dead zone", () => {
    assert.deepEqual(planMediaSync({ ...base, playbackRate: 1.01 }, 5.01, true), { playbackRate: 1, seekTo: null });
  });

  it("never nudges the rate while paused, only resets it", () => {
    assert.deepEqual(planMediaSync({ ...base, currentTime: 4.5 }, 5, false), { playbackRate: null, seekTo: null });
    assert.deepEqual(planMediaSync({ ...base, currentTime: 4.5, playbackRate: 1.2 }, 5, false), { playbackRate: 1, seekTo: null });
  });

  it("does nothing when already in sync", () => {
    assert.deepEqual(planMediaSync(base, 5, true), { playbackRate: null, seekTo: null });
  });
});
