import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import fs from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";
import { buildExportPlan } from "../src/export/buildExportPlan.ts";
import type { Project } from "../src/project/types.ts";
import { addClip, addTrack } from "../src/timeline/operations.ts";
import { TRANSITION_TYPE_OPTIONS } from "../src/timeline/transitions.ts";
import { colorAsset, emptyProject, videoTrackId } from "./fixture.ts";

function bundledFfmpeg(): string | null {
  try {
    const require = createRequire(path.resolve(import.meta.dirname, "../../../studios/vcut/package.json"));
    const binary = require("ffmpeg-static") as string;
    return fs.existsSync(binary) ? binary : null;
  } catch { return null; }
}

function render(ffmpeg: string, project: Project): Buffer {
  const { args, duration } = buildExportPlan(project, { inputPathFor: () => "", outputPath: "pipe:1", fontPathFor: f => f, textFilePathFor: c => c.id });
  const i = args.indexOf("-filter_complex");
  return execFileSync(ffmpeg, [
    "-v", "error", ...args.slice(0, i), "-filter_complex", `${args[i + 1]};${args[i + 5]}anullsink`,
    "-map", args[i + 3], "-t", String(duration), "-pix_fmt", "rgb24", "-f", "rawvideo", "pipe:1",
  ], { maxBuffer: 20 * 1024 * 1024, timeout: 20_000 });
}

describe("transition boundary frames (real FFmpeg)", () => {
  const ffmpeg = bundledFfmpeg();
  for (const overlay of [false, true]) {
    for (const type of TRANSITION_TYPE_OPTIONS) {
      it(`${type} solo fade-in ends without a ${overlay ? "lower-track" : "black"} flash`, { skip: !ffmpeg && "bundled FFmpeg not found" }, () => {
        let project = emptyProject([colorAsset("red", "#ff0000"), colorAsset("blue", "#0000ff")]);
        project.sequence.width = 160;
        project.sequence.height = 90;
        project.exportSettings = { ...project.exportSettings, width: 160, height: 90, fps: 30 };
        project = addClip(project, videoTrackId(project), overlay ? "blue" : "red", 0);
        if (overlay) {
          project = addTrack(project, "video", "overlay");
          project = addClip(project, "overlay", "red", 0);
        }
        const tracks = project.sequence.tracks.filter(t => t.kind === "video");
        for (const track of tracks) track.clips[0].sourceOut = 1;
        tracks[tracks.length - 1].clips[0].transitionIn = { type, duration: 0.5 };
        const raw = render(ffmpeg!, project);
        assert.equal(raw.length, 30 * 160 * 90 * 3);
        if (type === "flashZoom") {
          const first = raw.subarray((45 * 160 + 80) * 3, (45 * 160 + 80) * 3 + 3);
          assert.ok([...first].every(channel => channel > 200), `white pulse at the hidden end: ${first}`);
        }
        for (const frame of [15, 16, 29]) {
          const offset = (frame * 160 * 90 + 45 * 160 + 80) * 3;
          const [r, g, b] = raw.subarray(offset, offset + 3);
          assert.ok(r > 240 && g < 10 && b < 10, `frame ${frame}: ${r},${g},${b}`);
        }
      });
    }
  }
});


describe("Flash Zoom white pulse (real FFmpeg)", () => {
  const ffmpeg = bundledFfmpeg();
  for (const overlay of [false, true]) {
    for (const mode of ["blend", "in", "out"] as const) {
      it(`${mode}, ${overlay ? "overlay" : "base"}: flash rises and falls on black footage`, { skip: !ffmpeg && "bundled FFmpeg not found" }, () => {
        let p = emptyProject([colorAsset("a", "#000000"), colorAsset("b", "#000000"), colorAsset("bg", "#000000")]);
        p.sequence.width = 160; p.sequence.height = 90;
        p.exportSettings = { ...p.exportSettings, width: 160, height: 90, fps: 30 };
        let id = videoTrackId(p);
        if (overlay) {
          p = addClip(p, id, "bg", 0);
          p.sequence.tracks.find(t => t.id === id)!.clips[0].sourceOut = 3;
          p = addTrack(p, "video", "overlay"); id = "overlay";
        }
        p = addClip(p, id, "a", 0);
        let track = p.sequence.tracks.find(t => t.id === id)!;
        track.clips[0].sourceOut = mode === "blend" ? 1 : 3;
        if (mode === "blend") {
          p = addClip(p, id, "b", 1);
          track = p.sequence.tracks.find(t => t.id === id)!;
          track.clips[1].sourceOut = 2;
          track.clips[1].transitionIn = { type: "flashZoom", duration: 1 };
        } else if (mode === "in") track.clips[0].transitionIn = { type: "flashZoom", duration: 1 };
        else track.clips[0].transitionOut = { type: "flashZoom", duration: 1 };
        const raw = render(ffmpeg!, p);
        const start = mode === "blend" ? 15 : mode === "out" ? 60 : 0;
        for (const frame of [0, 6, 15, 24, 29]) {
          const q = frame / 30;
          const k = mode === "blend" ? 4 * q * (1 - q) : mode === "in" ? 1 - q : q;
          const expected = 255 * 0.88 * k;
          const offset = ((start + frame) * 160 * 90 + 45 * 160 + 80) * 3;
          for (const channel of raw.subarray(offset, offset + 3)) {
            // Allow 8-bit alpha and RGB/YUV range conversion differences in solo fade chains.
            assert.ok(Math.abs(channel - expected) < 8, `frame ${frame}: expected ${expected}, got ${channel}`);
          }
        }
      });
    }
  }
});
