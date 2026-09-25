import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { buildSilentWav, isIosLike, unlockPlaybackAudio } from "../src/playback/playbackUnlock.ts";
import { canShareVideoFile } from "../src/export/webShare.ts";

describe("buildSilentWav", () => {
  it("is a valid mono 8kHz 16-bit PCM WAV whose header sizes match its length", () => {
    const wav = buildSilentWav(0.5);
    const view = new DataView(wav.buffer);
    const text = (o: number, n: number) => String.fromCharCode(...wav.slice(o, o + n));
    assert.equal(text(0, 4), "RIFF");
    assert.equal(text(8, 4), "WAVE");
    assert.equal(text(12, 4), "fmt ");
    assert.equal(view.getUint16(20, true), 1, "PCM");
    assert.equal(view.getUint16(22, true), 1, "mono");
    assert.equal(view.getUint32(24, true), 8000);
    assert.equal(view.getUint16(34, true), 16);
    assert.equal(text(36, 4), "data");
    const dataBytes = view.getUint32(40, true);
    assert.equal(dataBytes, 8000 * 0.5 * 2);
    assert.equal(wav.length, 44 + dataBytes);
    assert.equal(view.getUint32(4, true), 36 + dataBytes, "RIFF chunk size");
  });

  it("contains only silence", () => {
    const wav = buildSilentWav(0.1);
    assert.ok(wav.slice(44).every((byte) => byte === 0));
  });

  it("never produces an empty data chunk", () => {
    assert.ok(buildSilentWav(0).length > 44);
  });
});

describe("isIosLike", () => {
  it("recognises iPhone/iPad, and an iPad posing as a Mac (has touch), but not a real Mac or Android", () => {
    assert.equal(isIosLike("Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X)", 5), true);
    assert.equal(isIosLike("Mozilla/5.0 (iPad; CPU OS 16_0 like Mac OS X)", 5), true);
    assert.equal(isIosLike("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)", 5), true, "iPadOS desktop mode");
    assert.equal(isIosLike("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)", 0), false, "a real Mac");
    assert.equal(isIosLike("Mozilla/5.0 (Linux; Android 14; Pixel 8)", 5), false);
  });
});

describe("environment guards (run under node: no window, no navigator.share)", () => {
  it("unlockPlaybackAudio is a harmless no-op outside a browser", () => {
    assert.doesNotThrow(() => unlockPlaybackAudio());
  });
  it("canShareVideoFile is false where the Web Share API isn't available", () => {
    assert.equal(canShareVideoFile(), false);
  });
});
