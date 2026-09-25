import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { detectBeats, everyNthBeat, toMonoDownsampled } from "../src/audio/beatDetection.ts";

const RATE = 22050;

/** A drum-like track: a short decaying thump on every beat, an off-beat hi-hat, plus low noise. */
function track(bpm: number, offset: number, seconds: number, noise = 0.02): Float32Array {
  const samples = new Float32Array(Math.floor(seconds * RATE));
  let seed = 7;
  const random = () => ((seed = (seed * 16807) % 2147483647) / 2147483647) * 2 - 1;
  for (let i = 0; i < samples.length; i++) samples[i] = random() * noise;
  const interval = 60 / bpm;
  for (let time = offset; time < seconds; time += interval) {
    const start = Math.floor(time * RATE);
    for (let i = 0; i < 1800 && start + i < samples.length; i++) samples[start + i] += Math.sin(2 * Math.PI * 60 * (i / RATE)) * Math.exp(-i / 500) * 0.9;
    const half = Math.floor((time + interval / 2) * RATE);
    for (let i = 0; i < 400 && half + i < samples.length; i++) samples[half + i] += random() * Math.exp(-i / 90) * 0.25;
  }
  return samples;
}

describe("beat detection", () => {
  for (const [bpm, offset] of [[120, 0.13], [90, 0.4], [140, 0.05], [100, 0.27]] as const) {
    it(`finds ${bpm} BPM and puts the beats on the thumps (offset ${offset}s)`, () => {
      const result = detectBeats(track(bpm, offset, 24), RATE);
      assert.ok(Math.abs(result.bpm - bpm) < 1.2, `bpm ${result.bpm}`);
      assert.ok(result.confidence > 0.2, `confidence ${result.confidence}`);
      const interval = 60 / bpm;
      // Every detected beat is within 30 ms of a true thump.
      let worst = 0;
      for (const beat of result.beats) {
        const sinceStart = beat - offset;
        const nearest = Math.round(sinceStart / interval) * interval;
        worst = Math.max(worst, Math.abs(sinceStart - nearest));
      }
      assert.ok(worst < 0.03, `worst error ${worst}`);
      assert.ok(result.beats.length >= Math.floor((24 - offset) / interval) - 1);
    });
  }

  it("returns nothing for silence or a clip too short to judge", () => {
    assert.deepEqual(detectBeats(new Float32Array(RATE * 10), RATE), { bpm: 0, beats: [], confidence: 0 });
    assert.equal(detectBeats(new Float32Array(RATE), RATE).beats.length, 0);
  });

  it("reports low confidence for steady noise with no pulse", () => {
    const noise = new Float32Array(RATE * 20);
    let seed = 3;
    for (let i = 0; i < noise.length; i++) noise[i] = (((seed = (seed * 16807) % 2147483647) / 2147483647) * 2 - 1) * 0.3;
    assert.ok(detectBeats(noise, RATE).confidence < 0.25);
  });

  it("picks every nth beat", () => {
    assert.deepEqual(everyNthBeat([0, 1, 2, 3, 4, 5, 6, 7, 8], 4), [0, 4, 8]);
    assert.deepEqual(everyNthBeat([0, 1, 2], 1), [0, 1, 2]);
  });

  it("mixes to mono and downsamples", () => {
    const left = new Float32Array(44100).fill(1);
    const right = new Float32Array(44100).fill(-1);
    const out = toMonoDownsampled([left, right], 44100, 11025);
    assert.equal(out.sampleRate, 11025);
    assert.equal(out.samples.length, 11025);
    assert.ok(out.samples.every((v) => v === 0));
  });
});

import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

describe("beat detection on a real encoded file (real FFmpeg)", () => {
  const ffmpeg = (() => {
    try {
      const require = createRequire(path.resolve(import.meta.dirname, "../../../studios/vcut/package.json"));
      const binary = require("ffmpeg-static") as string;
      return fs.existsSync(binary) ? binary : null;
    } catch {
      return null;
    }
  })();

  it("finds the tempo of an MP3 drum-like loop after codec, stereo mix and downsampling", { skip: !ffmpeg }, () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "vcut-beat-"));
    try {
      const mp3 = path.join(dir, "loop.mp3");
      // A thump every 0.5 s (120 BPM) starting at 0.2 s, plus a quieter off-beat tick.
      execFileSync(
        ffmpeg!,
        ["-v", "error", "-f", "lavfi", "-i", "aevalsrc='(sin(2*PI*55*mod(t-0.2,0.5))*exp(-9*mod(t-0.2,0.5))*gte(t,0.2))+0.25*sin(2*PI*3000*t)*exp(-60*mod(t-0.45,0.5))':s=44100:d=30", "-ac", "2", "-b:a", "128k", "-y", mp3],
        { stdio: "ignore" }
      );
      const raw = execFileSync(ffmpeg!, ["-v", "error", "-i", mp3, "-f", "f32le", "-ac", "1", "-ar", "44100", "-"], { maxBuffer: 1 << 28 });
      const mono = new Float32Array(raw.buffer, raw.byteOffset, Math.floor(raw.byteLength / 4));
      const { samples, sampleRate } = toMonoDownsampled([mono], 44100);
      const result = detectBeats(samples, sampleRate);
      assert.ok(Math.abs(result.bpm - 120) < 1.5, `bpm ${result.bpm}`);
      // Beats fall on 0.2 + k*0.5 within 40 ms (MP3 adds a little delay).
      const worst = Math.max(...result.beats.map((b) => { const d = (b - 0.2) / 0.5; return Math.abs(d - Math.round(d)) * 0.5; }));
      assert.ok(worst < 0.04, `worst ${worst}`);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
