import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import { buildExportPlan } from "../src/export/buildExportPlan.ts";
import type { ClipTransform, Keyframe, Project } from "../src/project/types.ts";
import { IDENTITY_TRANSFORM } from "../src/project/types.ts";
import { addClip, setClipTransformKeyframes, setClipTransitionIn, trimClip } from "../src/timeline/operations.ts";
import { clipsOf, colorAsset, emptyProject, videoTrackId } from "./fixture.ts";

function bundledFfmpeg(): string | null {
  try {
    const require = createRequire(path.resolve(import.meta.dirname, "../../../studios/vcut/package.json"));
    const binary = require("ffmpeg-static") as string;
    return fs.existsSync(binary) ? binary : null;
  } catch {
    return null;
  }
}

const W = 320;
const H = 180;
const FPS = 30;
const DURATION = 2;

function project(points: { time: number; value: ClipTransform }[]): Project {
  const keyframes: Keyframe<ClipTransform>[] = points.map((point, i) => ({ id: `k${i}`, ...point }));
  let p = emptyProject([colorAsset("c", "#ffffff")]);
  p.sequence.width = W;
  p.sequence.height = H;
  p.exportSettings = { ...p.exportSettings, width: W, height: H, fps: FPS };
  const track = videoTrackId(p);
  p = addClip(p, track, "c", 0);
  p = trimClip(p, clipsOf(p, track)[0].id, "out", DURATION);
  return setClipTransformKeyframes(p, clipsOf(p, track)[0].id, keyframes);
}

/** Renders `p` and returns the bounding box of the white pixels in every frame. */
function frameBoxes(ffmpeg: string, p: Project) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "vcut-kf-smooth-"));
  try {
    const outputPath = path.join(dir, "out.mp4");
    const { args } = buildExportPlan(p, { inputPathFor: () => dir, outputPath, fontPathFor: (f) => f, textFilePathFor: (c) => path.join(dir, `${c.id}.txt`) });
    execFileSync(ffmpeg, args, { stdio: "pipe" });
    const raw = execFileSync(ffmpeg, ["-hide_banner", "-loglevel", "error", "-i", outputPath, "-f", "rawvideo", "-pix_fmt", "gray", "-"], { maxBuffer: 1 << 26 });
    const frames = Math.floor(raw.length / (W * H));
    const boxes: { width: number; height: number; cx: number; cy: number }[] = [];
    for (let f = 0; f < frames; f++) {
      const base = f * W * H;
      let minX = W, maxX = -1, minY = H, maxY = -1;
      for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) if (raw[base + y * W + x] > 128) { if (x < minX) minX = x; if (x > maxX) maxX = x; if (y < minY) minY = y; if (y > maxY) maxY = y; }
      boxes.push(maxX < 0 ? { width: 0, height: 0, cx: NaN, cy: NaN } : { width: maxX - minX + 1, height: maxY - minY + 1, cx: (minX + maxX) / 2, cy: (minY + maxY) / 2 });
    }
    return boxes;
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

/** The longest run of consecutive frames sharing one value — a "staircase" plateau. */
function longestPlateau(values: number[]): number {
  let best = 1, run = 1;
  for (let i = 1; i < values.length; i++) {
    run = Math.abs(values[i] - values[i - 1]) < 0.5 ? run + 1 : 1;
    if (run > best) best = run;
  }
  return best;
}

describe("keyframed zoom and pan export smoothly, one step per frame (real FFmpeg)", () => {
  const ffmpeg = bundledFfmpeg();
  const skip = !ffmpeg && "bundled FFmpeg not found";

  it("a zoom (scale 0.4 -> 1.0) grows every few frames instead of holding for ~4-5 frame steps", { skip }, () => {
    const boxes = frameBoxes(
      ffmpeg!,
      project([
        { time: 0, value: { ...IDENTITY_TRANSFORM, scale: 0.4 } },
        { time: DURATION, value: { ...IDENTITY_TRANSFORM, scale: 1 } },
      ])
    );
    assert.ok(boxes.length >= 55, `expected ~60 frames, got ${boxes.length}`);
    const widths = boxes.map((b) => b.width);
    // Preview interpolates linearly: width follows 0.4*W -> 1.0*W over the clip. Check the ends and middle.
    assert.ok(Math.abs(widths[0] - W * 0.4) <= 3, `start width ${widths[0]}`);
    assert.ok(Math.abs(widths[Math.floor(widths.length / 2)] - W * 0.7) <= 4, `mid width ${widths[Math.floor(widths.length / 2)]}`);
    // The last frame is one frame BEFORE the final keyframe's time (59/60 of the way), so ~98.3% of full size.
    assert.ok(widths[widths.length - 1] >= W - 6, `end width ${widths[widths.length - 1]}`);
    // Smooth: the old 0.15s slices held width constant for ~4-5 consecutive frames; a per-frame ramp of ~3.2px/frame never does.
    assert.ok(longestPlateau(widths) <= 2, `zoom is stepped: a plateau of ${longestPlateau(widths)} frames`);
    // …and it never shrinks while zooming in.
    for (let i = 1; i < widths.length; i++) assert.ok(widths[i] >= widths[i - 1] - 1, `width dropped at frame ${i}`);
  });

  it("a pan (offsetX 0 -> 60) moves every few frames and lands on the right spot", { skip }, () => {
    const boxes = frameBoxes(
      ffmpeg!,
      project([
        { time: 0, value: { ...IDENTITY_TRANSFORM, scale: 0.5, offsetX: 0 } },
        { time: DURATION, value: { ...IDENTITY_TRANSFORM, scale: 0.5, offsetX: 60 } },
      ])
    );
    const centers = boxes.map((b) => b.cx);
    assert.ok(Math.abs(centers[0] - (W - 1) / 2) <= 2, `start centre ${centers[0]}`);
    // 59/60 of the way to +60 (kept well inside the frame so the box is never clipped by the edge).
    assert.ok(Math.abs(centers[centers.length - 1] - ((W - 1) / 2 + 60 * (59 / 60))) <= 3, `end centre ${centers[centers.length - 1]}`);
    assert.ok(longestPlateau(centers) <= 2, `pan is stepped: a plateau of ${longestPlateau(centers)} frames`);
    // Size is untouched by a pure pan.
    assert.ok(boxes.every((b) => Math.abs(b.width - W * 0.5) <= 2));
  });

  it("zoom and pan together (Ken Burns), with a hold before the first keyframe and after the last", { skip }, () => {
    const boxes = frameBoxes(
      ffmpeg!,
      project([
        { time: 0.5, value: { ...IDENTITY_TRANSFORM, scale: 0.5, offsetX: -40 } },
        { time: 1.5, value: { ...IDENTITY_TRANSFORM, scale: 0.9, offsetX: 40 } },
      ])
    );
    const at = (seconds: number) => boxes[Math.min(boxes.length - 1, Math.round(seconds * FPS))];
    assert.ok(Math.abs(at(0.1).width - at(0.4).width) <= 2, "held at the first keyframe's value before it");
    assert.ok(Math.abs(at(1.7).width - at(1.9).width) <= 2, "held at the last keyframe's value after it");
    assert.ok(at(1.0).width > at(0.6).width + 15 && at(1.4).width > at(1.0).width + 15, "grows through the keyframed span");
    assert.ok(at(1.4).cx > at(0.6).cx + 30, "pans right through the keyframed span");
  });

  it("a static clip (no keyframes) is unchanged by the feature", { skip }, () => {
    let p = emptyProject([colorAsset("c", "#ffffff")]);
    p.sequence.width = W;
    p.sequence.height = H;
    p.exportSettings = { ...p.exportSettings, width: W, height: H, fps: FPS };
    p = addClip(p, videoTrackId(p), "c", 0);
    p = trimClip(p, clipsOf(p, videoTrackId(p))[0].id, "out", 1);
    const boxes = frameBoxes(ffmpeg!, p);
    assert.ok(boxes.every((b) => b.width === W && b.height === H));
  });

  it("keeps the zoom continuous across a transition boundary (the clip is cut into segments with their own local clocks)", { skip }, () => {
    let p = emptyProject([colorAsset("a", "#ffffff"), colorAsset("b", "#ffffff")]);
    p.sequence.width = W;
    p.sequence.height = H;
    p.exportSettings = { ...p.exportSettings, width: W, height: H, fps: FPS };
    const track = videoTrackId(p);
    p = addClip(p, track, "a", 0);
    p = trimClip(p, clipsOf(p, track)[0].id, "out", 2);
    p = addClip(p, track, "b", 2);
    const clipB = clipsOf(p, track)[1];
    p = trimClip(p, clipB.id, "out", 4); // `out` is a TIMELINE time: B starts at 2s and runs to 4s
    p = setClipTransformKeyframes(p, clipB.id, [
      { id: "k0", time: 0, value: { ...IDENTITY_TRANSFORM, scale: 0.4 } },
      { id: "k1", time: 2, value: { ...IDENTITY_TRANSFORM, scale: 1 } },
    ]);
    p = setClipTransitionIn(p, clipB.id, { duration: 1, type: "crossfade" });

    const boxes = frameBoxes(ffmpeg!, p);
    // Once the crossfade is over only B is on screen, and B's zoom keeps running on its own clock (it started
    // partway through the transition, in a different segment). The tail of the render must keep growing
    // smoothly to ~full size — no plateaus, and no jump where the segments meet.
    assert.ok(boxes.length >= 80, `expected the crossfaded timeline, got ${boxes.length} frames`);
    const tail = boxes.slice(-40).map((b) => b.width);
    assert.ok(tail[tail.length - 1] >= W * 0.93, `final width ${tail[tail.length - 1]}`);
    for (let i = 1; i < tail.length; i++) {
      assert.ok(tail[i] >= tail[i - 1] - 1, `width shrank at tail frame ${i}`);
      assert.ok(tail[i] - tail[i - 1] <= 8, `jump of ${tail[i] - tail[i - 1]}px at tail frame ${i}`);
    }
    assert.ok(longestPlateau(tail) <= 2, `stepped after the transition: plateau ${longestPlateau(tail)}`);
  });
});
