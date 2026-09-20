import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";
import { buildExportPlan } from "../src/export/buildExportPlan.ts";
import { addClip, addTrack } from "../src/timeline/operations.ts";
import { colorAsset, emptyProject, imageAsset, videoTrackId } from "./fixture.ts";

let ffmpeg: string | null = null;
try {
  ffmpeg = createRequire(path.resolve(import.meta.dirname, "../../../studios/vcut/package.json"))("ffmpeg-static");
  if (!fs.existsSync(ffmpeg!)) ffmpeg = null;
} catch { /* Optional when the host's bundled FFmpeg is unavailable. */ }

/** A centered white rectangle must stay centered while the transition zoom changes per frame.
 *  Static color fixtures cannot catch a crop that silently anchors to the initial input size. */
describe("zoom transition geometry (real FFmpeg)", { skip: !ffmpeg && "bundled FFmpeg not found" }, () => {
  let scratch: string;
  before(() => { scratch = fs.mkdtempSync(path.join(os.tmpdir(), "vcut-zoom-render-")); });
  after(() => {
    if (!scratch) return;
    const target = path.resolve(scratch);
    assert.ok(target.startsWith(path.resolve(os.tmpdir()) + path.sep) && path.basename(target).startsWith("vcut-zoom-render-"));
    fs.rmSync(target, { recursive: true, force: true });
  });

  function center(values: number[]): number {
    const baseline = Math.min(...values);
    const weights = values.map(v => v - baseline);
    const sum = weights.reduce((a, b) => a + b, 0);
    assert.ok(sum > 100, "the pattern must remain visible through blur/flash");
    return weights.reduce((total, weight, i) => total + weight * i, 0) / sum;
  }

  for (const [width, height] of [[320, 180], [180, 320]]) {
    for (const type of ["zoomBlur", "flashZoom"] as const) {
      for (const mode of ["blend", "in", "out"] as const) {
        for (const overlay of [false, true]) {
          it(`${type} ${mode}, ${width}x${height}, ${overlay ? "overlay" : "base"}: zoom stays centered on both axes`, () => {
            const pixels = Buffer.alloc(width * height * 3);
            for (let y = height / 4; y < height * 3 / 4; y++) {
              for (let x = width / 4; x < width * 3 / 4; x++) {
                pixels.fill(255, (y * width + x) * 3, (y * width + x) * 3 + 3);
              }
            }
            const source = path.join(scratch, "pattern.ppm");
            fs.writeFileSync(source, Buffer.concat([Buffer.from(`P6\n${width} ${height}\n255\n`), pixels]));
            const duration = mode === "blend" ? 3 : 2;
            let project = emptyProject([
              { ...imageAsset("a"), width, height }, { ...imageAsset("b"), width, height }, colorAsset("bg", "#0000ff"),
            ]);
            project.sequence.width = width;
            project.sequence.height = height;
            project.exportSettings = { ...project.exportSettings, width, height, fps: 30 };
            let trackId = videoTrackId(project);
            if (overlay) {
              project = addClip(project, trackId, "bg", 0);
              project.sequence.tracks.find(t => t.id === trackId)!.clips[0].sourceOut = duration;
              project = addTrack(project, "video", "overlay");
              trackId = "overlay";
            }
            project = addClip(project, trackId, "a", 0);
            let track = project.sequence.tracks.find(t => t.id === trackId)!;
            track.clips[0].sourceOut = mode === "blend" ? 1 : 2;
            if (mode === "blend") {
              project = addClip(project, trackId, "b", 1);
              track = project.sequence.tracks.find(t => t.id === trackId)!;
              track.clips[1].sourceOut = 2;
              track.clips[1].transitionIn = { type, duration: 0.6 };
            } else if (mode === "in") track.clips[0].transitionIn = { type, duration: 0.6 };
            else track.clips[0].transitionOut = { type, duration: 0.6 };
            const { args } = buildExportPlan(project, {
              inputPathFor: () => source, outputPath: "pipe:1", fontPathFor: f => f, textFilePathFor: c => c.id,
            });
            const i = args.indexOf("-filter_complex");
            const graph = path.join(scratch, "graph.txt");
            fs.writeFileSync(graph, `${args[i + 1]};${args[i + 5]}anullsink`);
            const raw = execFileSync(ffmpeg!, [
              "-v", "error", ...args.slice(0, i), "-filter_complex_script", graph, "-map", args[i + 3],
              "-t", String(duration), "-pix_fmt", "rgb24", "-f", "rawvideo", "pipe:1",
            ], { timeout: 25_000, maxBuffer: 20 * 1024 * 1024 });
            assert.equal(raw.length, duration * 30 * width * height * 3);
            const startFrame = mode === "blend" ? 30 : mode === "out" ? 42 : 0;
            for (const step of [3, 9, 15]) {
              const frame = startFrame + step;
              const red = (x: number, y: number) => raw[(frame * width * height + y * width + x) * 3];
              const cx = center(Array.from({ length: width }, (_, x) => red(x, height / 2)));
              const cy = center(Array.from({ length: height }, (_, y) => red(width / 2, y)));
              assert.ok(Math.abs(cx - (width - 1) / 2) < 1.5, `frame ${frame}: horizontal center ${cx}`);
              assert.ok(Math.abs(cy - (height - 1) / 2) < 1.5, `frame ${frame}: vertical center ${cy}`);
            }
          });
        }
      }
    }
  }
});
