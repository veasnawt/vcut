import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import { buildCornerPixelArgs, buildCutoutInputArgs, buildMuxAudioArgs } from "../src/export/ffmpegCommands.ts";
import { ApplyVideoCutoutCommand, CreateTextBehindSubjectCommand } from "../src/commands/index.ts";
import { findClip } from "../src/project/createProject.ts";
import type { Asset, Project } from "../src/project/types.ts";
import { emptyProject } from "./fixture.ts";

function bundledFfmpeg(): string | null {
  try {
    const require = createRequire(path.resolve(import.meta.dirname, "../../../studios/vcut/package.json"));
    const binary = require("ffmpeg-static") as string;
    return fs.existsSync(binary) ? binary : null;
  } catch {
    return null;
  }
}

const asset = (id: string, hasAudio = false): Asset =>
  ({ id, kind: "video", name: id, relPath: `${id}.mp4`, duration: 20, hasAudio, sizeBytes: 1, importedAt: 0, width: 720, height: 1280 }) as Asset;

function projectWithClip(): Project {
  const base = emptyProject();
  const track = { id: "v1", kind: "video" as const, name: "V1", locked: false, visible: true, muted: false, solo: false, clips: [{ id: "c1", assetId: "src", timelineStart: 4, sourceIn: 6, sourceOut: 12, speed: 2 }] };
  return { ...base, assets: [...base.assets, asset("src", true)], sequence: { ...base.sequence, tracks: [track] } };
}

describe("video cutout: clip edits", () => {
  const info = { keyColor: "#78ff9b", windowSeconds: 6 };

  it("replaces the clip in place with the cutout, keyed on its background colour, and undoes cleanly", () => {
    const project = projectWithClip();
    const command = new ApplyVideoCutoutCommand("c1", asset("cut"), info);
    const next = command.apply(project);
    const clip = findClip(next, "c1")!.clip;
    assert.equal(clip.assetId, "cut");
    assert.equal(clip.timelineStart, 4);
    assert.equal(clip.sourceIn, 0);
    assert.equal(clip.sourceOut, 6);
    assert.equal(clip.speed, 2);
    assert.equal(clip.chromaKey?.color, "#78ff9b");
    assert.equal(findClip(command.revert(), "c1")!.clip.assetId, "src");
  });

  it("text behind subject: the cutout layer starts at 0 with the key, and the original clip is untouched", () => {
    const project = projectWithClip();
    const command = new CreateTextBehindSubjectCommand("c1", asset("cut"), "HI", info);
    const next = command.apply(project);
    const cutoutClip = findClip(next, command.createdCutoutClipId!)!.clip;
    assert.equal(cutoutClip.sourceIn, 0);
    assert.equal(cutoutClip.sourceOut, 6);
    assert.equal(cutoutClip.chromaKey?.color, "#78ff9b");
    assert.equal(findClip(next, "c1")!.clip.assetId, "src");
  });

  it("a still (image) cutout keeps the old behaviour: no chroma key", () => {
    const project = projectWithClip();
    const command = new CreateTextBehindSubjectCommand("c1", { ...asset("still"), kind: "image" } as Asset, "HI");
    const next = command.apply(project);
    assert.equal(findClip(next, command.createdCutoutClipId!)!.clip.chromaKey, undefined);
  });
});

describe("video cutout: FFmpeg steps (real FFmpeg)", () => {
  const ffmpeg = bundledFfmpeg();
  it("slices and downsizes the clip, restores its audio, and reads the background colour", { skip: !ffmpeg }, () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "vcut-cutout-"));
    const stderrOf = (args: string[]): string => {
      try {
        execFileSync(ffmpeg!, ["-hide_banner", ...args], { stdio: ["ignore", "pipe", "pipe"] });
        return "";
      } catch (e) {
        return String((e as { stderr?: Buffer | string }).stderr ?? "");
      }
    };
    try {
      const src = path.join(dir, "src.mp4");
      execFileSync(ffmpeg!, ["-v", "error", "-f", "lavfi", "-i", "testsrc2=size=1080x1920:rate=30:duration=4", "-f", "lavfi", "-i", "sine=frequency=440:duration=4", "-shortest", "-pix_fmt", "yuv420p", "-y", src]);
      const slice = path.join(dir, "slice.mp4");
      execFileSync(ffmpeg!, buildCutoutInputArgs(src, slice, { startSeconds: 1, durationSeconds: 2 }), { stdio: "ignore" });
      const sliceInfo = stderrOf(["-i", slice]);
      assert.match(sliceInfo, /Video: h264.*40[56]x720/, sliceInfo.slice(-400));
      assert.ok(!/Audio:/.test(sliceInfo), "the slice has no audio");

      const green = path.join(dir, "green.mp4");
      execFileSync(ffmpeg!, ["-v", "error", "-f", "lavfi", "-i", "color=c=0x78ff9b:size=64x64:rate=24:duration=2", "-pix_fmt", "yuv420p", "-y", green]);
      const muxed = path.join(dir, "muxed.mp4");
      execFileSync(ffmpeg!, buildMuxAudioArgs(green, src, muxed, { startSeconds: 1, durationSeconds: 2 }), { stdio: "ignore" });
      assert.match(stderrOf(["-i", muxed]), /Audio: aac/);

      const [r, g, b] = [...execFileSync(ffmpeg!, buildCornerPixelArgs(green), { stdio: ["ignore", "pipe", "ignore"] })];
      assert.ok(Math.abs(r - 0x78) < 8 && Math.abs(g - 0xff) < 8 && Math.abs(b - 0x9b) < 8, `key colour ${r},${g},${b}`);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

import { applyChromaKey } from "../src/playback/PlaybackEngine.ts";

describe("chroma key despill (AI cutout edges)", () => {
  const key = { color: "#78ff9b", similarity: 0.2, smoothness: 0.08 };
  const pixels = (...rgba: number[]) => ({ data: new Uint8ClampedArray(rgba) }) as unknown as ImageData;

  it("keeps a skin/dark pixel exactly as it was, with or without despill", () => {
    const a = pixels(200, 150, 120, 255, 12, 12, 12, 255);
    const b = pixels(200, 150, 120, 255, 12, 12, 12, 255);
    applyChromaKey(a, key);
    applyChromaKey(b, { ...key, despill: 0.9 });
    assert.deepEqual([...a.data], [...b.data]);
    assert.deepEqual([...a.data], [200, 150, 120, 255, 12, 12, 12, 255]);
  });

  it("removes the key colour entirely, and pulls green out of a surviving edge pixel only when despill is on", () => {
    const edge = [70, 170, 90, 255]; // subject blended with the key colour: kept by the key, but green-tinted
    const off = pixels(120, 255, 155, 255, ...edge);
    const on = pixels(120, 255, 155, 255, ...edge);
    applyChromaKey(off, key);
    applyChromaKey(on, { ...key, despill: 0.9 });
    assert.equal(off.data[3], 0);
    assert.equal(on.data[3], 0);
    assert.ok(on.data[7] > 0, "the edge pixel stays visible");
    assert.equal(off.data[5], 170);
    assert.ok(on.data[5] < 110, `green not reduced: ${on.data[5]}`);
  });
});

import { planMediaSync } from "../src/playback/PlaybackEngine.ts";

describe("cutout layer locked to its original (tight sync)", () => {
  const state = (drift: number) => ({ currentTime: 10 + drift, playbackRate: 1, seeking: false, seekingForMs: 0 });

  it("leaves an ordinary element alone at 0.5 s of drift on Safari (no rate correction, 1.5 s seek limit)", () => {
    assert.deepEqual(planMediaSync(state(-0.5), 10, true, false), { playbackRate: null, seekTo: null });
  });

  it("re-seeks a tight layer that has fallen 0.5 s behind, and eases the rate for small drift even on Safari", () => {
    assert.deepEqual(planMediaSync(state(-0.5), 10, true, false, 0.02, 1, true), { playbackRate: null, seekTo: 10 });
    const eased = planMediaSync(state(-0.1), 10, true, false, 0.02, 1, true);
    assert.ok(eased.seekTo === null && eased.playbackRate !== null && eased.playbackRate > 1, JSON.stringify(eased));
    assert.deepEqual(planMediaSync(state(0.01), 10, true, false, 0.02, 1, true), { playbackRate: null, seekTo: null });
  });
});

import { audioProxyRelPathFor, buildAudioProxyArgs } from "../src/export/proxyCommands.ts";

describe("audio preview proxy", () => {
  it("names the copy next to the original", () => {
    assert.equal(audioProxyRelPathFor("voice.m4a"), "voice-proxy.mp3");
    assert.equal(audioProxyRelPathFor("voice-proxy.m4a"), "voice-proxy.mp3");
  });

  it("turns an AAC .m4a into an MP3 of the same length (real FFmpeg)", { skip: !bundledFfmpeg() }, () => {
    const ffmpeg = bundledFfmpeg()!;
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "vcut-audio-proxy-"));
    try {
      const m4a = path.join(dir, "in.m4a");
      const mp3 = path.join(dir, "out.mp3");
      execFileSync(ffmpeg, ["-v", "error", "-f", "lavfi", "-i", "sine=frequency=440:duration=3", "-c:a", "aac", "-movflags", "+faststart", "-y", m4a]);
      execFileSync(ffmpeg, buildAudioProxyArgs(m4a, mp3), { stdio: "ignore" });
      let info = "";
      try {
        execFileSync(ffmpeg, ["-hide_banner", "-i", mp3], { stdio: ["ignore", "pipe", "pipe"] });
      } catch (error) {
        info = String((error as { stderr?: Buffer | string }).stderr ?? "");
      }
      assert.match(info, /Audio: mp3/);
      const seconds = /Duration: 00:00:0(\d\.\d+)/.exec(info);
      assert.ok(seconds && Math.abs(Number(seconds[1]) - 3) < 0.15, info.slice(0, 300));
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
