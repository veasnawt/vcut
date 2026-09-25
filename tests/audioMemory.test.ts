import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { estimateDecodedBytes, lruEvictByBytes, shouldStreamInsteadOfDecode } from "../src/playback/audioScheduling.ts";

const MB = 1024 * 1024;

describe("estimateDecodedBytes", () => {
  it("is 4 bytes per sample per channel", () => {
    assert.equal(estimateDecodedBytes(1, 48000, 2), 384_000);
    assert.equal(estimateDecodedBytes(10, 44100, 1), 1_764_000);
  });
  it("treats a one-hour stereo 48kHz track as ~1.4GB (the crash the audit found)", () => {
    const bytes = estimateDecodedBytes(3600, 48000);
    assert.ok(bytes > 1.2 * 1024 * MB && bytes < 1.5 * 1024 * MB, `got ${(bytes / MB).toFixed(0)}MB`);
  });
  it("is 0 for junk durations", () => {
    for (const d of [0, -5, Number.NaN, Number.POSITIVE_INFINITY]) assert.equal(estimateDecodedBytes(d, 48000), 0);
  });
});

describe("shouldStreamInsteadOfDecode", () => {
  const threshold = 200 * MB;
  it("decodes an ordinary song and streams a podcast-length file", () => {
    assert.equal(shouldStreamInsteadOfDecode(240, 48000, threshold), false, "4 minutes");
    assert.equal(shouldStreamInsteadOfDecode(480, 48000, threshold), false, "8 minutes is still under");
    assert.equal(shouldStreamInsteadOfDecode(3600, 48000, threshold), true, "one hour");
    assert.equal(shouldStreamInsteadOfDecode(900, 48000, threshold), true, "15 minutes");
  });
  it("decodes when the duration is unknown (the normal path has its own failure fallback)", () => {
    assert.equal(shouldStreamInsteadOfDecode(null, 48000, threshold), false);
    assert.equal(shouldStreamInsteadOfDecode(undefined, 48000, threshold), false);
  });
  it("depends on the sample rate", () => {
    assert.equal(shouldStreamInsteadOfDecode(600, 22050, threshold), false);
    assert.equal(shouldStreamInsteadOfDecode(600, 48000, threshold), true);
  });
});

describe("lruEvictByBytes", () => {
  const e = (key: string, lastUsed: number, mb: number) => ({ key, lastUsed, bytes: mb * MB });

  it("evicts nothing while under both limits", () => {
    assert.deepEqual(lruEvictByBytes([e("a", 1, 50), e("b", 2, 50)], 12, 200 * MB), []);
  });

  it("evicts oldest first until the byte budget is met — even with only a few buffers (the old count limit never noticed)", () => {
    const entries = [e("old", 1, 120), e("mid", 2, 120), e("new", 3, 120)]; // 360MB against a 200MB budget
    assert.deepEqual(lruEvictByBytes(entries, 12, 250 * MB), ["old"]);
    assert.deepEqual(lruEvictByBytes(entries, 12, 100 * MB), ["old", "mid"], "the newest is kept even though it alone exceeds the budget");
  });

  it("still applies the count limit", () => {
    const entries = [e("a", 1, 1), e("b", 2, 1), e("c", 3, 1)];
    assert.deepEqual(lruEvictByBytes(entries, 2, 200 * MB), ["a"]);
  });

  it("never evicts a protected (currently playing) buffer, even when it is the oldest", () => {
    const entries = [e("playing", 1, 150), e("idle", 2, 100), e("recent", 3, 50)];
    assert.deepEqual(lruEvictByBytes(entries, 12, 200 * MB, new Set(["playing"])), ["idle"]);
  });

  it("goes over budget rather than evict something in use", () => {
    assert.deepEqual(lruEvictByBytes([e("playing", 1, 500)], 12, 100 * MB, new Set(["playing"])), []);
  });

  it("does not evict more than needed", () => {
    const entries = [e("a", 1, 30), e("b", 2, 30), e("c", 3, 30), e("d", 4, 30)]; // 120MB
    assert.deepEqual(lruEvictByBytes(entries, 12, 100 * MB), ["a"]);
  });
});
