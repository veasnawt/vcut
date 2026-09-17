import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { isAppleWebKit, planMediaSync, shouldHoldClockForMedia } from "../src/playback/PlaybackEngine.ts";

describe("isAppleWebKit", () => {
  const cases: [string, string, boolean][] = [
    ["iPad (desktop-class, reports as Mac)", "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/27.0 Safari/605.1.15", true],
    ["iPhone Safari", "Mozilla/5.0 (iPhone; CPU iPhone OS 18_7 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/27.0 Mobile/15E148 Safari/604.1", true],
    ["Chrome on iPhone (still WebKit)", "Mozilla/5.0 (iPhone; CPU iPhone OS 18_7 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/140.0.0.0 Mobile/15E148 Safari/604.1", true],
    ["Android Chrome", "Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/153.0.0.0 Mobile Safari/537.36", false],
    ["desktop Chrome", "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/153.0.0.0 Safari/537.36", false],
    ["desktop Edge", "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/153.0.0.0 Safari/537.36 Edg/153.0.0.0", false],
    ["Firefox", "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:140.0) Gecko/20100101 Firefox/140.0", false],
  ];
  for (const [label, ua, expected] of cases) {
    it(`${label} -> ${expected}`, () => assert.equal(isAppleWebKit(ua), expected));
  }
});

describe("planMediaSync without rate correction (Apple WebKit)", () => {
  const state = { currentTime: 4.5, playbackRate: 1, seeking: false, seekingForMs: 0 };

  it("never writes playbackRate for drift inside the tolerance — each write stalls AVFoundation playback", () => {
    assert.deepEqual(planMediaSync(state, 5, true, false), { playbackRate: null, seekTo: null });
    assert.deepEqual(planMediaSync({ ...state, currentTime: 5.9 }, 5, true, false), { playbackRate: null, seekTo: null });
  });

  it("still closes large drift with a hard seek", () => {
    assert.deepEqual(planMediaSync({ ...state, currentTime: 2 }, 5, true, false), { playbackRate: null, seekTo: 5 });
  });

  it("still restores a rate left off 1", () => {
    assert.deepEqual(planMediaSync({ ...state, playbackRate: 1.3 }, 5, true, false), { playbackRate: 1, seekTo: null });
  });
});

describe("shouldHoldClockForMedia", () => {
  it("advances normally when no video was waiting", () => {
    assert.equal(shouldHoldClockForMedia(false, null, 10_000), false);
  });

  it("holds while a video is seeking, so a slow seek lands where the clock is instead of behind it", () => {
    assert.equal(shouldHoldClockForMedia(true, null, 10_000), true);
    assert.equal(shouldHoldClockForMedia(true, 10_000, 11_500), true);
  });

  it("gives up holding after the cap, so a video that never becomes ready can't freeze the timeline", () => {
    assert.equal(shouldHoldClockForMedia(true, 10_000, 14_000), false);
  });
});

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
