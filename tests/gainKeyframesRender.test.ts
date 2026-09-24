import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import { buildExportPlan } from "../src/export/buildExportPlan.ts";
import { addClip, setClipGainKeyframes } from "../src/timeline/operations.ts";
import { audioAsset, audioTrackId, clipsOf, colorAsset, emptyProject, videoAsset, videoTrackId } from "./fixture.ts";

/** Same pattern `colorMatteRender.test.ts`'s own `bundledFfmpeg` uses. */
function bundledFfmpeg(): string | null {
  try {
    const require = createRequire(path.resolve(import.meta.dirname, "../../../studios/vcut/package.json"));
    const binary = require("ffmpeg-static") as string;
    return fs.existsSync(binary) ? binary : null;
  } catch {
    return null;
  }
}

/** RMS amplitude (0..1, relative to full-scale) of a window of 16-bit PCM samples — a real,
 *  decoded-audio proxy for "how loud is this part of the file", used below to prove a keyframed
 *  `volume=` envelope actually changed the ENCODED output, not just the generated FFmpeg args. */
function rms(pcm: Buffer, startSample: number, sampleCount: number, channels: number): number {
  let sumSquares = 0;
  let n = 0;
  // 2 bytes per 16-bit sample — `i` below is a BYTE offset (what `readInt16LE` takes), not a sample
  // index, so both the loop bounds and the sample-index-to-byte-offset conversion need that factor.
  const startByte = startSample * channels * 2;
  const endByte = (startSample + sampleCount) * channels * 2;
  for (let i = startByte; i < endByte && i + 1 < pcm.length; i += 2) {
    const sample = pcm.readInt16LE(i) / 32768;
    sumSquares += sample * sample;
    n++;
  }
  return n > 0 ? Math.sqrt(sumSquares / n) : 0;
}

describe("gainKeyframes export render (real FFmpeg)", () => {
  const ffmpeg = bundledFfmpeg();

  it("a full-volume-to-silent ramp on an audio-track clip is audible in the real encoded output", { skip: !ffmpeg && "bundled FFmpeg not found" }, () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "vcut-gain-keyframes-audio-track-"));
    try {
      const sourcePath = path.join(dir, "tone.wav");
      // A constant, full-amplitude 440Hz tone — any loudness DIFFERENCE the assertions below see is
      // entirely the keyframed `volume=` filter's own doing, not anything already baked into the source.
      execFileSync(ffmpeg!, [
        "-hide_banner", "-loglevel", "error", "-f", "lavfi", "-i", "sine=frequency=440:duration=4",
        "-ar", "48000", "-ac", "2", sourcePath,
      ]);

      // `buildExportPlan` requires a visible video track with clips even when the thing under test is
      // a pure audio-track clip — a plain color background, unrelated to any assertion below, covers
      // that requirement without adding a second real source file to decode.
      let project = emptyProject([{ ...audioAsset("tone", 4), hasAudio: true }, colorAsset("bg", "#000000")]);
      project = addClip(project, videoTrackId(project), "bg", 0);
      const track = audioTrackId(project);
      project = addClip(project, track, "tone", 0);
      const clip = clipsOf(project, track)[0];
      project = setClipGainKeyframes(project, clip.id, [
        { id: "start", time: 0, value: 1 },
        { id: "end", time: 4, value: 0 },
      ]);

      const outputPath = path.join(dir, "out.mp4");
      const { args } = buildExportPlan(project, {
        inputPathFor: () => sourcePath,
        outputPath,
        fontPathFor: (f) => f,
        textFilePathFor: (c) => path.join(dir, `${c.id}.txt`),
      });
      execFileSync(ffmpeg!, args, { stdio: "pipe" });

      // The `sine` lavfi source's own default amplitude is NOT full-scale (measured well under
      // 0.707, the RMS a true full-scale sine would have) — so "loud" is only meaningful relative to
      // the UNTOUCHED source's own RMS, decoded through the exact same pipeline, not an assumed
      // absolute level.
      const referencePcm = execFileSync(ffmpeg!, [
        "-hide_banner", "-loglevel", "error", "-i", sourcePath,
        "-f", "s16le", "-acodec", "pcm_s16le", "-ar", "48000", "-ac", "2", "-",
      ], { maxBuffer: 1 << 26 });
      const sampleRate = 48000;
      const channels = 2;
      const windowSamples = sampleRate * 0.25; // 250ms windows, well clear of the fade's own endpoints
      const referenceRms = rms(referencePcm, sampleRate * 0.25, windowSamples, channels);

      const pcm = execFileSync(ffmpeg!, [
        "-hide_banner", "-loglevel", "error", "-i", outputPath,
        "-f", "s16le", "-acodec", "pcm_s16le", "-ar", "48000", "-ac", "2", "-",
      ], { maxBuffer: 1 << 26 });

      const startRms = rms(pcm, sampleRate * 0.25, windowSamples, channels);
      const endRms = rms(pcm, sampleRate * 3.5, windowSamples, channels);
      const midRms = rms(pcm, sampleRate * 2 - windowSamples / 2, windowSamples, channels);

      assert.ok(startRms > referenceRms * 0.75, `expected near-full (reference) volume near the start, got RMS ${startRms} vs reference ${referenceRms}`);
      assert.ok(endRms < referenceRms * 0.1, `expected near-silence near the end, got RMS ${endRms} vs reference ${referenceRms}`);
      // The midpoint of a linear 1→0 ramp should read roughly half the start's own loudness — proves
      // this is a real RAMP (matching `resolveClipGain`'s own lerp), not a late step-down to silence.
      assert.ok(midRms < startRms * 0.75 && midRms > startRms * 0.25, `expected a mid-ramp loudness, got start ${startRms} mid ${midRms} end ${endRms}`);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("the same ramp is also audible on a video clip's own embedded audio", { skip: !ffmpeg && "bundled FFmpeg not found" }, () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "vcut-gain-keyframes-video-track-"));
    try {
      const size = 64;
      const sourcePath = path.join(dir, "source.mp4");
      execFileSync(ffmpeg!, [
        "-hide_banner", "-loglevel", "error",
        "-f", "lavfi", "-i", `color=c=blue:s=${size}x${size}:r=30`,
        "-f", "lavfi", "-i", "sine=frequency=440:duration=4",
        "-t", "4", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", "-shortest", sourcePath,
      ]);

      let project = emptyProject([{ ...videoAsset("clip", 4), width: size, height: size, hasAudio: true }]);
      project.sequence.width = size;
      project.sequence.height = size;
      project.exportSettings = { ...project.exportSettings, width: size, height: size, fps: 30 };
      const track = videoTrackId(project);
      project = addClip(project, track, "clip", 0);
      const clip = clipsOf(project, track)[0];
      project = setClipGainKeyframes(project, clip.id, [
        { id: "start", time: 0, value: 1 },
        { id: "end", time: 4, value: 0 },
      ]);

      const outputPath = path.join(dir, "out.mp4");
      const { args } = buildExportPlan(project, {
        inputPathFor: () => sourcePath,
        outputPath,
        fontPathFor: (f) => f,
        textFilePathFor: (c) => path.join(dir, `${c.id}.txt`),
      });
      execFileSync(ffmpeg!, args, { stdio: "pipe" });

      const referencePcm = execFileSync(ffmpeg!, [
        "-hide_banner", "-loglevel", "error", "-i", sourcePath,
        "-f", "s16le", "-acodec", "pcm_s16le", "-ar", "48000", "-ac", "2", "-",
      ], { maxBuffer: 1 << 26 });
      const sampleRate = 48000;
      const channels = 2;
      const windowSamples = sampleRate * 0.25;
      const referenceRms = rms(referencePcm, sampleRate * 0.25, windowSamples, channels);

      const pcm = execFileSync(ffmpeg!, [
        "-hide_banner", "-loglevel", "error", "-i", outputPath,
        "-f", "s16le", "-acodec", "pcm_s16le", "-ar", "48000", "-ac", "2", "-",
      ], { maxBuffer: 1 << 26 });

      const startRms = rms(pcm, sampleRate * 0.25, windowSamples, channels);
      // Same 3.5s position `audio-track` test above uses — a window this close to the very end (4s)
      // sits well past the `sine` source's own encoder padding/priming, but the gain envelope there
      // (1 - 3.625/4 ≈ 0.09) is itself still small-but-nonzero, so this needs the same generous
      // `< 0.1×reference` bound, not a stricter one.
      const endRms = rms(pcm, sampleRate * 3.5, windowSamples, channels);

      assert.ok(startRms > referenceRms * 0.75, `expected near-full (reference) volume near the start, got RMS ${startRms} vs reference ${referenceRms}`);
      assert.ok(endRms < referenceRms * 0.1, `expected near-silence near the end, got RMS ${endRms} vs reference ${referenceRms}`);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
