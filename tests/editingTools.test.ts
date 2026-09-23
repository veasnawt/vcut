import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { SetClipBlendModeCommand, SetClipFlipHorizontalCommand, SetClipMaskCommand, SetClipReverseCommand, SetClipSpeedCommand, SetClipTransformCommand } from "../src/commands/index.ts";
import { buildExportPlan } from "../src/export/buildExportPlan.ts";
import { clipDuration } from "../src/project/createProject.ts";
import { deserializeProject, serializeProject } from "../src/project/serialize.ts";
import { DEFAULT_CLIP_MASK, IDENTITY_TRANSFORM } from "../src/project/types.ts";
import { clipSourceTimeAtElapsed } from "../src/timeline/clipTiming.ts";
import { addClip, addTrack, splitClip, trimClip } from "../src/timeline/operations.ts";
import { applyClipMask, clipBlendCompositeOperation } from "../src/playback/PlaybackEngine.ts";
import { UndoStack } from "../src/undo/UndoStack.ts";
import { clipsOf, emptyProject, videoTrackId } from "./fixture.ts";
import { videoAsset } from "./fixture.ts";

const options = {
  inputPathFor: (assetId: string) => `/media/${assetId}.mp4`,
  outputPath: "/out/export.mp4",
  fontPathFor: (fileName: string) => `/fonts/${fileName}`,
  textFilePathFor: (clip: { id: string }) => `/tmp/${clip.id}.txt`,
};

function graph(project: ReturnType<typeof emptyProject>): string {
  const args = buildExportPlan(project, options).args;
  return args[args.indexOf("-filter_complex") + 1];
}

function oneClipProject() {
  const base = emptyProject();
  const project = addClip(base, videoTrackId(base), "asset1", 0);
  return { project, clip: clipsOf(project, videoTrackId(project))[0] };
}

describe("end-to-end clip editing tools", () => {
  it("flip horizontal persists, undoes, and exports through hflip", () => {
    const { project, clip } = oneClipProject();
    const stack = new UndoStack();
    const changed = stack.execute(project, new SetClipFlipHorizontalCommand(clip.id, true));
    assert.equal(deserializeProject(serializeProject(changed)).sequence.tracks[0].clips[0].flipHorizontal, true);
    assert.match(graph(changed), /hflip/);
    assert.equal(stack.undo(changed).sequence.tracks[0].clips[0].flipHorizontal, undefined);
  });

  it("reverse maps preview time backward, persists, undoes, and reverses video plus audio export", () => {
    const { project, clip } = oneClipProject();
    const stack = new UndoStack();
    const changed = stack.execute(project, new SetClipReverseCommand(clip.id, true));
    const reversed = deserializeProject(serializeProject(changed));
    const savedClip = reversed.sequence.tracks[0].clips[0];
    assert.equal(savedClip.reverse, true);
    assert.ok(clipSourceTimeAtElapsed(savedClip, 1) > clipSourceTimeAtElapsed(savedClip, 2));
    assert.match(graph(reversed), /reverse,setpts=PTS-STARTPTS/);
    assert.match(graph(reversed), /areverse/);
    assert.equal(stack.undo(changed).sequence.tracks[0].clips[0].reverse, undefined);
  });

  it("mask persists, undoes, and exports a matching alpha mask", () => {
    const { project, clip } = oneClipProject();
    const stack = new UndoStack();
    const mask = { ...DEFAULT_CLIP_MASK, shape: "ellipse" as const, centerX: 0.4, feather: 0.08 };
    const changed = stack.execute(project, new SetClipMaskCommand(clip.id, mask));
    assert.deepEqual(deserializeProject(serializeProject(changed)).sequence.tracks[0].clips[0].mask, mask);
    assert.match(graph(changed), /geq=.*alpha\(X,Y\)/);
    assert.equal(stack.undo(changed).sequence.tracks[0].clips[0].mask, undefined);
  });

  it("constant speed changes duration, ripples later clips, persists, undoes, and retimes video/audio", () => {
    const base = emptyProject();
    let project = addClip(base, videoTrackId(base), "asset1", 0);
    project = addClip(project, videoTrackId(project), "asset1", 10);
    const [first] = clipsOf(project, videoTrackId(project));
    const stack = new UndoStack();
    const changed = stack.execute(project, new SetClipSpeedCommand(first.id, 2));
    const clips = clipsOf(changed, videoTrackId(changed));
    assert.equal(clipDuration(clips[0]), 5);
    assert.equal(clips[1].timelineStart, 5);
    assert.equal(deserializeProject(serializeProject(changed)).sequence.tracks[0].clips[0].speed, 2);
    assert.match(graph(changed), /setpts='\(PTS-STARTPTS\)\/2/);
    assert.match(graph(changed), /atempo=2/);
    assert.equal(clipsOf(stack.undo(changed), videoTrackId(project))[1].timelineStart, 10);
  });

  it("speed curves produce monotonic time remapping and a variable setpts expression", () => {
    const { project, clip } = oneClipProject();
    const curve = [{ position: 0, speed: 0.5 }, { position: 0.5, speed: 2 }, { position: 1, speed: 0.5 }];
    const changed = new SetClipSpeedCommand(clip.id, 1, curve).apply(project);
    const changedClip = clipsOf(changed, videoTrackId(changed))[0];
    assert.ok(clipDuration(changedClip) > 0);
    assert.ok(clipSourceTimeAtElapsed(changedClip, 1) < clipSourceTimeAtElapsed(changedClip, 2));
    assert.match(graph(changed), /setpts='\(if\(lte/);
    assert.match(graph(changed), /log\(/);
  });

  it("split and trim preserve reverse/speed semantics and keep timeline durations exact", () => {
    const { project, clip } = oneClipProject();
    let changed = new SetClipReverseCommand(clip.id, true).apply(project);
    changed = new SetClipSpeedCommand(clip.id, 2, null).apply(changed);
    changed = splitClip(changed, clip.id, 2);
    const split = clipsOf(changed, videoTrackId(changed));
    assert.equal(split.length, 2);
    assert.ok(Math.abs(clipDuration(split[0]) - 2) < 1 / 30);
    assert.ok(Math.abs(clipDuration(split[1]) - 3) < 1 / 30);
    assert.equal(split[0].reverse, true);
    assert.equal(split[1].reverse, true);
    changed = trimClip(changed, split[1].id, "out", split[1].timelineStart + 1);
    assert.ok(Math.abs(clipDuration(clipsOf(changed, videoTrackId(changed))[1]) - 1) < 1 / 30);
  });

  it("overwrite carving keeps the correct source windows on a reversed, retimed clip", () => {
    let project = emptyProject([videoAsset("asset1", 10), videoAsset("insert", 1)]);
    project = addClip(project, videoTrackId(project), "asset1", 0);
    const original = clipsOf(project, videoTrackId(project))[0];
    project = new SetClipReverseCommand(original.id, true).apply(project);
    project = new SetClipSpeedCommand(original.id, 2, null).apply(project);
    project = addClip(project, videoTrackId(project), "insert", 2);
    const clips = clipsOf(project, videoTrackId(project));
    assert.equal(clips.length, 3);
    assert.deepEqual(clips.map((clip) => clip.timelineStart), [0, 2, 3]);
    assert.deepEqual([clips[0].sourceIn, clips[0].sourceOut], [6, 10]);
    assert.deepEqual([clips[2].sourceIn, clips[2].sourceOut], [0, 4]);
    assert.equal(clips[0].reverse, true);
    assert.equal(clips[2].reverse, true);
    assert.equal(clips[0].speed, 2);
    assert.equal(clips[2].speed, 2);
  });

  it("preview mask keeps the center and removes ellipse corners", () => {
    const pixels = new Uint8ClampedArray(5 * 5 * 4).fill(255);
    applyClipMask({ width: 5, height: 5, data: pixels } as ImageData, { ...DEFAULT_CLIP_MASK, shape: "ellipse", width: 0.6, height: 0.6 }, { top: 0, right: 0, bottom: 0, left: 0 });
    assert.equal(pixels[3], 0);
    assert.equal(pixels[(2 * 5 + 2) * 4 + 3], 255);
  });

  it("blend mode persists, maps to Canvas, undoes, and emits alpha-safe FFmpeg compositing", () => {
    let project = emptyProject([videoAsset("base", 2), videoAsset("upper", 2)]);
    project = addClip(project, videoTrackId(project), "base", 0);
    project = addTrack(project, "video", "upper-track");
    project = addClip(project, "upper-track", "upper", 0);
    const upper = clipsOf(project, "upper-track")[0];
    const stack = new UndoStack();
    const changed = stack.execute(project, new SetClipBlendModeCommand(upper.id, "darken"));
    const saved = deserializeProject(serializeProject(changed));
    assert.equal(clipsOf(saved, "upper-track")[0].blendMode, "darken");
    assert.equal(clipBlendCompositeOperation(clipsOf(saved, "upper-track")[0]), "darken");
    const filterGraph = graph(saved);
    assert.match(filterGraph, /blend=all_mode=darken/);
    assert.match(filterGraph, /alphaextract/);
    assert.match(filterGraph, /alphamerge/);
    assert.equal(clipsOf(stack.undo(changed), "upper-track")[0].blendMode, undefined);
    for (const mode of ["overlay", "screen", "darken", "lighten"] as const) {
      const modeProject = new SetClipBlendModeCommand(upper.id, mode).apply(project);
      assert.equal(clipBlendCompositeOperation(clipsOf(modeProject, "upper-track")[0]), mode);
      assert.match(graph(modeProject), new RegExp(`blend=all_mode=${mode}`));
    }
  });
});

let ffmpeg: string | null = null;
try {
  const require = createRequire(path.resolve(import.meta.dirname, "../../../studios/vcut/package.json"));
  ffmpeg = require("ffmpeg-static") as string;
  if (!fs.existsSync(ffmpeg!)) ffmpeg = null;
} catch {}

describe("editing tools with real FFmpeg", { skip: !ffmpeg && "bundled FFmpeg not found" }, () => {
  it("keeps the transparent area around a scaled Darken layer transparent", () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "vcut-blend-mode-"));
    try {
      const baseInput = path.join(directory, "base.mp4");
      const upperInput = path.join(directory, "upper.mp4");
      const output = path.join(directory, "output.mp4");
      for (const [file, color] of [[baseInput, "red"], [upperInput, "blue"]] as const) {
        execFileSync(ffmpeg!, [
          "-v", "error", "-f", "lavfi", "-i", `color=c=${color}:s=160x90:r=30:d=1`,
          "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p", file,
        ], { timeout: 15_000, stdio: "pipe" });
      }

      let project = emptyProject([
        { ...videoAsset("base", 1), width: 160, height: 90, hasAudio: false },
        { ...videoAsset("upper", 1), width: 160, height: 90, hasAudio: false },
      ]);
      project.sequence.width = 160;
      project.sequence.height = 90;
      project.exportSettings = { ...project.exportSettings, width: 160, height: 90, fps: 30 };
      project = addClip(project, videoTrackId(project), "base", 0);
      project = addTrack(project, "video", "upper-track");
      project = addClip(project, "upper-track", "upper", 0);
      const upper = clipsOf(project, "upper-track")[0];
      project = new SetClipTransformCommand(upper.id, { ...IDENTITY_TRANSFORM, scale: 0.5 }).apply(project);
      project = new SetClipBlendModeCommand(upper.id, "darken").apply(project);
      const render = buildExportPlan(project, {
        ...options,
        inputPathFor: (id) => id === "base" ? baseInput : upperInput,
        outputPath: output,
      });
      execFileSync(ffmpeg!, render.args, { timeout: 30_000, stdio: "pipe" });
      const pixels = execFileSync(ffmpeg!, [
        "-v", "error", "-i", output, "-vf", "select=eq(n\\,0),format=rgb24", "-frames:v", "1", "-f", "rawvideo", "pipe:1",
      ], { timeout: 15_000, stdio: ["ignore", "pipe", "pipe"] });
      const rgbAt = (x: number, y: number) => [...pixels.subarray((y * 160 + x) * 3, (y * 160 + x) * 3 + 3)];
      const corner = rgbAt(5, 5);
      const center = rgbAt(80, 45);
      assert.ok(corner[0] > 180 && corner[1] < 60 && corner[2] < 60, `transparent corner should preserve red base: ${corner}`);
      assert.ok(center.every((channel) => channel < 60), `red darkened by blue should be near black: ${center}`);
    } finally {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });

  it("renders flip + reverse + feathered mask + speed curve in one composed export", () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "vcut-edit-tools-"));
    try {
      const input = path.join(directory, "input.mkv");
      const output = path.join(directory, "output.mp4");
      execFileSync(ffmpeg!, [
        "-v", "error", "-f", "lavfi", "-i", "testsrc2=s=160x90:r=30:d=2",
        "-f", "lavfi", "-i", "sine=frequency=440:sample_rate=48000:duration=2",
        "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p", "-c:a", "pcm_s16le", "-t", "2", input,
      ], { timeout: 15_000, stdio: "pipe" });

      let project = emptyProject([{ ...videoAsset("asset1", 2), width: 160, height: 90 }]);
      project.sequence.width = 160;
      project.sequence.height = 90;
      project.exportSettings = { ...project.exportSettings, width: 160, height: 90, fps: 30 };
      project = addClip(project, videoTrackId(project), "asset1", 0);
      const clip = clipsOf(project, videoTrackId(project))[0];
      project = new SetClipFlipHorizontalCommand(clip.id, true).apply(project);
      project = new SetClipReverseCommand(clip.id, true).apply(project);
      project = new SetClipMaskCommand(clip.id, { ...DEFAULT_CLIP_MASK, shape: "ellipse", feather: 0.05 }).apply(project);
      project = new SetClipSpeedCommand(clip.id, 1, [{ position: 0, speed: 0.5 }, { position: 0.5, speed: 2 }, { position: 1, speed: 0.5 }]).apply(project);
      const render = buildExportPlan(project, { ...options, inputPathFor: () => input, outputPath: output });
      execFileSync(ffmpeg!, render.args, { timeout: 30_000, stdio: "pipe" });
      assert.ok(fs.statSync(output).size > 1_000);
    } finally {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });
});
