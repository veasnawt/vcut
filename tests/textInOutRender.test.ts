import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import { buildExportPlan } from "../src/export/buildExportPlan.ts";
import { setClipTextAnimation, setClipTextInOut } from "../src/timeline/operations.ts";
import { addClip, addTrack, trimClip } from "../src/timeline/operations.ts";
import type { Project } from "../src/project/types.ts";
import { clipsOf, colorAsset, emptyProject, textAsset, textTrackId, videoTrackId } from "./fixture.ts";

function bundledFfmpeg(): string | null {
  try {
    const require = createRequire(path.resolve(import.meta.dirname, "../../../studios/vcut/package.json"));
    const binary = require("ffmpeg-static") as string;
    return fs.existsSync(binary) ? binary : null;
  } catch {
    return null;
  }
}

const FONT_DIR = path.resolve(import.meta.dirname, "../assets/fonts");
const W = 320;
const H = 180;
const DURATION = 2;

/** A 2s black 320x180 project with one white "HELLO" text clip; `configure` adds its animations. */
function textProject(configure: (project: Project, clipId: string) => Project): Project {
  let project = addTrack(emptyProject([colorAsset("bg", "#000000"), textAsset("txt", "HELLO")]), "text");
  project.sequence.width = W;
  project.sequence.height = H;
  project.exportSettings = { ...project.exportSettings, width: W, height: H, fps: 30 };
  const asset = project.assets.find((a) => a.id === "txt")!;
  asset.textStyle = { ...asset.textStyle!, fontSize: 40, color: "#ffffff", fontFamily: "lato" };
  const base = videoTrackId(project);
  project = addClip(project, base, "bg", 0);
  project = trimClip(project, clipsOf(project, base)[0].id, "out", DURATION);
  const track = textTrackId(project);
  project = addClip(project, track, "txt", 0);
  const clip = clipsOf(project, track)[0];
  // pin the length regardless of the default text duration
  project = {
    ...project,
    sequence: { ...project.sequence, tracks: project.sequence.tracks.map((t) => (t.id === track ? { ...t, clips: t.clips.map((c) => ({ ...c, sourceOut: c.sourceIn + DURATION })) } : t)) },
  };
  return configure(project, clip.id);
}

/** Renders `project` and returns, per requested time, the white-pixel count and the vertical / horizontal centroid of the text. */
function measure(ffmpeg: string, project: Project, times: number[]) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "vcut-text-inout-"));
  try {
    const outputPath = path.join(dir, "out.mp4");
    const { args } = buildExportPlan(project, {
      inputPathFor: () => dir,
      outputPath,
      fontPathFor: (fileName) => path.join(FONT_DIR, fileName).replace(/\\/g, "/"),
      textFilePathFor: (clip, content) => {
        const file = path.join(dir, `${clip.id}.txt`);
        fs.writeFileSync(file, content, "utf8");
        return file;
      },
    });
    execFileSync(ffmpeg, args, { stdio: "pipe" });
    return times.map((time) => {
      const raw = execFileSync(ffmpeg, ["-hide_banner", "-loglevel", "error", "-ss", String(time), "-i", outputPath, "-frames:v", "1", "-f", "rawvideo", "-pix_fmt", "gray", "-"], { maxBuffer: 1 << 22 });
      let count = 0;
      let sumX = 0;
      let sumY = 0;
      let maxLuma = 0;
      for (let y = 0; y < H; y++) {
        for (let x = 0; x < W; x++) {
          const v = raw[y * W + x];
          if (v > maxLuma) maxLuma = v;
          if (v > 96) {
            count++;
            sumX += x;
            sumY += y;
          }
        }
      }
      return { time, count, cx: count ? sumX / count : NaN, cy: count ? sumY / count : NaN, maxLuma };
    });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

describe("text In/Out animations in a real export (real FFmpeg)", () => {
  const ffmpeg = bundledFfmpeg();
  const skip = !ffmpeg && "bundled FFmpeg not found";

  it("Slide Up in + Fade out: starts low and faint, is settled mid-clip, and fades to nothing at the end", { skip }, () => {
    const project = textProject((p, id) => setClipTextInOut(setClipTextInOut(p, id, "in", { type: "slideUp", duration: 0.6 }), id, "out", { type: "fade", duration: 0.6 }));
    const [start, mid, late, end] = measure(ffmpeg!, project, [0.05, 1.0, 1.75, 1.97]);

    assert.ok(mid.count > 200, `settled text should be clearly visible, got ${mid.count} px`);
    assert.ok(start.maxLuma < mid.maxLuma, "the entrance starts fainter than settled text");
    assert.ok(start.count < mid.count, "…and with less of it lit");
    if (start.count > 20) assert.ok(start.cy > mid.cy + 5, `entrance should start BELOW its resting spot (start cy ${start.cy}, mid cy ${mid.cy})`);
    assert.ok(late.maxLuma < mid.maxLuma, "the exit is already fading at 1.75s");
    assert.ok(end.count < mid.count * 0.5, `nearly gone on the last frame, got ${end.count} vs ${mid.count}`);
  });

  it("Pop in: text grows from tiny to full size (fontsize expression evaluates every frame)", { skip }, () => {
    const project = textProject((p, id) => setClipTextInOut(p, id, "in", { type: "pop", duration: 0.6 }));
    const [tiny, part, full] = measure(ffmpeg!, project, [0.04, 0.25, 1.2]);
    assert.ok(full.count > 200);
    assert.ok(tiny.count < part.count && part.count < full.count * 1.6, `growing: ${tiny.count} < ${part.count}, full ${full.count}`);
    assert.ok(tiny.count < full.count * 0.3, `starts small, got ${tiny.count} vs ${full.count}`);
  });

  it("Shake / Float / Heartbeat loops render (their expressions are valid FFmpeg)", { skip }, () => {
    for (const type of ["shake", "float", "heartbeat"] as const) {
      const project = textProject((p, id) => setClipTextAnimation(p, id, { type }));
      const [a, b] = measure(ffmpeg!, project, [0.3, 0.7]);
      assert.ok(a.count > 200 && b.count > 200, `${type} keeps the text visible`);
    }
  });

  it("A clip with no In/Out is unchanged by the feature", { skip }, () => {
    const project = textProject((p) => p);
    const [early, mid] = measure(ffmpeg!, project, [0.02, 1.0]);
    assert.ok(early.count > 200 && Math.abs(early.count - mid.count) < 5, "static text is fully visible from the first frame");
  });
});
