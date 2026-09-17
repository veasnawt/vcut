import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import { buildExportPlan } from "../src/export/buildExportPlan.ts";
import { clipEnd } from "../src/project/createProject.ts";
import { deserializeProject, serializeProject } from "../src/project/serialize.ts";
import { animationFrameIndex, animationFrameRect, parseAssetAnimation, planAnimation, type AssetAnimation } from "../src/project/stickers.ts";
import type { Asset, Project } from "../src/project/types.ts";
import { IDENTITY_TRANSFORM } from "../src/project/types.ts";
import { sanitizeProjectForTemplate, templateClips } from "../src/project/template.ts";
import { addClip, addTrack, setClipTransform, setClipTransformKeyframes, splitClip, trimClip } from "../src/timeline/operations.ts";
import { clipsOf, colorAsset, emptyProject, imageAsset, videoTrackId } from "./fixture.ts";

const ANIMATION: AssetAnimation = { frameCount: 20, fps: 10, spriteRelPath: "st1-sprite.png", columns: 5, rows: 4, frameWidth: 64, frameHeight: 64 };

function stickerAsset(id = "st1"): Asset {
  return { ...imageAsset(id), name: "wave.gif", relPath: `${id}.png`, width: 64, height: 64, animation: ANIMATION };
}

describe("sticker animation timing", () => {
  it("picks the frame whose start is the latest one not after the source time, looping", () => {
    assert.equal(animationFrameIndex(ANIMATION, 0), 0);
    assert.equal(animationFrameIndex(ANIMATION, 0.1), 1);
    assert.equal(animationFrameIndex(ANIMATION, 0.3), 3); // 0.3 * 10 is 2.9999… in floating point
    assert.equal(animationFrameIndex(ANIMATION, 1.99), 19);
    assert.equal(animationFrameIndex(ANIMATION, 1.9999999999), 0); // float noise just under the loop point
    assert.equal(animationFrameIndex(ANIMATION, 2), 0);
    assert.equal(animationFrameIndex(ANIMATION, 4.25), 2);
    // A still's in-edge can be trimmed before 0 (no fixed source length).
    assert.equal(animationFrameIndex(ANIMATION, -0.05), 19);
  });

  it("lays frames out left to right, then top to bottom", () => {
    assert.deepEqual(animationFrameRect(ANIMATION, 0), { x: 0, y: 0, width: 64, height: 64 });
    assert.deepEqual(animationFrameRect(ANIMATION, 7), { x: 128, y: 64, width: 64, height: 64 });
  });

  it("normalizes a GIF-like source to a capped frame rate, size, and sprite grid", () => {
    const plan = planAnimation({ width: 480, height: 270, duration: 2.5, frames: 50 });
    assert.equal(plan.fps, 20);
    assert.equal(plan.frameCount, 50);
    assert.deepEqual([plan.exportWidth, plan.exportHeight], [480, 270]);
    assert.equal(plan.columns * plan.rows >= plan.frameCount, true);
    assert.equal(plan.frameWidth <= 360 && plan.frameWidth * plan.columns <= 4096, true);
    assert.equal(Math.abs(plan.frameWidth / plan.frameHeight - 480 / 270) < 0.02, true);

    // Long and fast: the frame rate drops to keep the frame count bounded; big sources shrink.
    const long = planAnimation({ width: 1200, height: 1200, duration: 18, frames: 900 });
    assert.equal(long.frameCount <= 240, true);
    assert.deepEqual([long.exportWidth, long.exportHeight], [720, 720]);
    assert.equal(long.frameWidth * long.columns <= 4096 && long.frameHeight * long.rows <= 4096, true);
  });

  it("round-trips through a saved project, and ignores a malformed animation", () => {
    const project = emptyProject([stickerAsset()]);
    project.assets[0].stickerSource = { provider: "klipy", type: "stickers", id: "abc" };
    const restored = deserializeProject(serializeProject(project));
    assert.deepEqual(restored.assets[0].animation, ANIMATION);
    assert.deepEqual(restored.assets[0].stickerSource, { provider: "klipy", type: "stickers", id: "abc" });
    assert.equal(parseAssetAnimation({ ...ANIMATION, frameCount: 1 }), undefined);
    assert.equal(parseAssetAnimation({ ...ANIMATION, spriteRelPath: "" }), undefined);
  });
});

describe("sticker export plan", () => {
  it("loops an animated image from where the clip is in the animation; a plain still is unchanged", () => {
    let project = emptyProject([stickerAsset(), imageAsset("img1")]);
    const base = videoTrackId(project);
    project = addClip(project, base, "img1", 0);
    project = addTrack(project, "video", "v2");
    project = addClip(project, "v2", "st1", 0);
    const clip = clipsOf(project, "v2")[0];
    project = trimClip(project, clip.id, "in", 1.5); // sourceIn 1.5 → loop frame 15

    const { args } = buildExportPlan(project, {
      inputPathFor: (id) => `/media/${id}.png`,
      outputPath: "/out/export.mp4",
      fontPathFor: (f) => `/fonts/${f}`,
      textFilePathFor: (c) => `/tmp/${c.id}.txt`,
    });
    const joined = args.join(" ");
    assert.match(joined, /-loop 1 -framerate 30 -t 5\.000000 -i \/media\/img1\.png/);
    assert.match(joined, /-stream_loop -1 -t [0-9.]+ -i \/media\/st1\.png/);
    const graph = args[args.indexOf("-filter_complex") + 1];
    assert.match(graph, /setpts=N\/\(10\*TB\),trim=start_frame=15,setpts='max\(0\\,PTS-STARTPTS-0\.000005\/TB\)',fps=fps=30:round=up,trim=duration=3\.500000\[anim\d+\]/);
  });
});

/** Resolves the same bundled FFmpeg the vcut server uses; `null` skips the render test. */
function bundledFfmpeg(): string | null {
  try {
    const require = createRequire(path.resolve(import.meta.dirname, "../../../studios/vcut/package.json"));
    const binary = require("ffmpeg-static") as string;
    return fs.existsSync(binary) ? binary : null;
  } catch {
    return null;
  }
}

describe("sticker export render (real FFmpeg)", () => {
  const ffmpeg = bundledFfmpeg();

  it("shows the same sticker frame preview would, on every output frame, across plain/transform/keyframed clips", { skip: !ffmpeg && "bundled FFmpeg not found" }, () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "vcut-sticker-"));
    try {
      // 27 frames at 18fps (a rate an animated PNG can't store exactly — see `pushImageInput`), 64×64:
      // each frame's centre square a distinct colour, a transparent border.
      const RENDER_ANIMATION: AssetAnimation = { ...ANIMATION, frameCount: 27, fps: 18, columns: 6, rows: 5 };
      const stickerPath = path.join(dir, "sticker.png");
      execFileSync(ffmpeg!, [
        "-hide_banner", "-loglevel", "error", "-y",
        "-f", "lavfi", "-i", "color=c=black@0:s=64x64:r=18:d=1.5,format=rgba,geq=r='N*9':g='255-N*9':b='128':a='if(between(X,16,47)*between(Y,16,47),255,0)'",
        "-plays", "0", "-f", "apng", stickerPath,
      ]);

      // Export reads a colour matte from a generated image too (the server writes one per colour).
      execFileSync(ffmpeg!, ["-hide_banner", "-loglevel", "error", "-y", "-f", "lavfi", "-i", "color=c=black:s=16x16", "-frames:v", "1", path.join(dir, "bg.png")]);

      const SIZE = 160;
      let project: Project = emptyProject([colorAsset("bg", "#000000"), { ...stickerAsset(), animation: RENDER_ANIMATION }]);
      project.sequence.width = SIZE;
      project.sequence.height = SIZE;
      project.exportSettings = { ...project.exportSettings, width: SIZE, height: SIZE, fps: 30 };
      const base = videoTrackId(project);
      project = addClip(project, base, "bg", 0);
      project = trimClip(project, clipsOf(project, base)[0].id, "out", 3);
      project = addTrack(project, "video", "v2");
      project = addClip(project, "v2", "st1", 0);
      const first = clipsOf(project, "v2")[0];
      project = trimClip(project, first.id, "out", 3);
      // Cut at 1.0s (plain path before, keyframed path after) and 2.0s (transform path).
      project = splitClip(project, first.id, 1.0, "st-b");
      project = splitClip(project, "st-b", 2.0, "st-c");
      // Start both later pieces between two sticker frames, as a trimmed or re-split clip would. The
      // keyframed piece's shift keeps a new sticker frame off its very last output frame: keyframed
      // segments currently export one frame short and repeat the previous frame there (true of video
      // clips too, not specific to stickers), which would otherwise fail this for an unrelated reason.
      for (const [id, shift] of [["st-b", 2 / 30], ["st-c", 1 / 30]] as const) {
        const piece = clipsOf(project, "v2").find((c) => c.id === id)!;
        piece.sourceIn += shift;
        piece.sourceOut += shift;
      }
      project = setClipTransformKeyframes(project, "st-b", [
        { id: "k1", time: 0, value: { ...IDENTITY_TRANSFORM, scale: 1 } },
        { id: "k2", time: 1, value: { ...IDENTITY_TRANSFORM, scale: 0.9 } },
      ]);
      project = setClipTransform(project, "st-c", { ...IDENTITY_TRANSFORM, scale: 0.8 });

      const outputPath = path.join(dir, "out.mp4");
      const { args } = buildExportPlan(project, {
        inputPathFor: (id) => (id === "st1" ? stickerPath : path.join(dir, `${id}.png`)),
        outputPath,
        fontPathFor: (f) => f,
        textFilePathFor: (c) => path.join(dir, `${c.id}.txt`),
      });
      execFileSync(ffmpeg!, args, { stdio: "pipe" });
      const raw = execFileSync(ffmpeg!, ["-hide_banner", "-loglevel", "error", "-i", outputPath, "-f", "rawvideo", "-pix_fmt", "rgb24", "-"], {
        maxBuffer: 256 * 1024 * 1024,
      });

      const frameBytes = SIZE * SIZE * 3;
      const frames = raw.length / frameBytes;
      assert.equal(frames, 90);
      const clips = clipsOf(project, "v2");
      const mismatches: string[] = [];
      for (let k = 0; k < frames; k++) {
        const time = k / 30;
        const clip = clips.find((c) => time >= c.timelineStart - 1e-9 && time < clipEnd(c) - 1e-9)!;
        const expected = animationFrameIndex(RENDER_ANIMATION, clip.sourceIn + (time - clip.timelineStart));
        const i = k * frameBytes + (Math.floor(SIZE / 2) * SIZE + Math.floor(SIZE / 2)) * 3;
        const [r, g] = [raw[i], raw[i + 1]];
        // Nearest of the 27 frame colours (H.264 shifts values by a few units).
        let best = -1;
        let bestDistance = Infinity;
        for (let f = 0; f < 27; f++) {
          const distance = Math.abs(r - f * 9) + Math.abs(g - (255 - f * 9));
          if (distance < bestDistance) [best, bestDistance] = [f, distance];
        }
        if (best !== expected) mismatches.push(`t=${time.toFixed(3)} (${clip.id}): want ${expected}, got ${best}`);
      }
      assert.deepEqual(mismatches, []);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("stickers in templates", () => {
  it("keep a sticker as bundled decoration, not a fill-in slot, and leave it out of the template's clip list", () => {
    let project = emptyProject([imageAsset("img1"), stickerAsset()]);
    const base = videoTrackId(project);
    project = addClip(project, base, "img1", 0);
    project = addTrack(project, "video", "v2");
    project = addClip(project, "v2", "st1", 0);

    const template = sanitizeProjectForTemplate(project);
    const sticker = template.assets.find((a) => a.animation);
    assert.ok(sticker, "the sticker asset is kept");
    assert.equal(sticker.templateBundledAudio, true);
    assert.equal(sticker.templatePlaceholder, undefined);
    assert.equal(template.assets.filter((a) => a.templatePlaceholder).length, 1, "only the photo becomes a slot");
    assert.equal(templateClips(project).some((e) => e.asset.id === "st1"), false);
  });
});
