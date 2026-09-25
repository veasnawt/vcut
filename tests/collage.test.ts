import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import { buildExportPlan } from "../src/export/buildExportPlan.ts";
import { computeTransformedBox } from "../src/playback/transformGeometry.ts";
import { findClip } from "../src/project/createProject.ts";
import { applyGridLayout, cellFillTransform, cellToPixels, findGridLayout, GRID_LAYOUTS, stackCopies } from "../src/timeline/collage.ts";
import { addClip } from "../src/timeline/operations.ts";
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

describe("collage geometry", () => {
  it("makes a source cover its cell exactly, whatever the source's shape", () => {
    for (const [sw, sh] of [[1920, 1080], [1080, 1920], [1000, 1000]]) {
      const cell = { x: 540, y: 0, w: 540, h: 960 };
      const t = cellFillTransform(sw, sh, 1080, 1920, cell);
      const box = computeTransformedBox(sw, sh, 1080, 1920, t)!;
      assert.ok(Math.abs(box.width - cell.w) < 1.5 && Math.abs(box.height - cell.h) < 1.5, `size ${box.width}x${box.height} for ${sw}x${sh}`);
      assert.ok(Math.abs(box.centerX - (cell.x + cell.w / 2)) < 1.5 && Math.abs(box.centerY - (cell.y + cell.h / 2)) < 1.5);
    }
  });

  it("every layout's cells stay inside the frame and don't overlap", () => {
    for (const layout of GRID_LAYOUTS) {
      for (const c of layout.cells) assert.ok(c.x >= 0 && c.y >= 0 && c.x + c.w <= 1.0001 && c.y + c.h <= 1.0001, layout.id);
      for (let i = 0; i < layout.cells.length; i++) {
        for (let j = i + 1; j < layout.cells.length; j++) {
          const a = layout.cells[i];
          const b = layout.cells[j];
          const overlap = Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x) > 1e-6 && Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y) > 1e-6;
          assert.equal(overlap, false, `${layout.id} ${i}/${j}`);
        }
      }
    }
  });

  it("a gap shrinks each cell", () => {
    const px = cellToPixels({ x: 0, y: 0, w: 0.5, h: 0.5 }, 1000, 1000, 20);
    assert.deepEqual([px.x, px.y, px.w, px.h], [10, 10, 480, 480]);
  });
});

function twoClipProject() {
  let project = emptyProject([colorAsset("red", "#ff0000"), colorAsset("blue", "#0000ff")]);
  project.sequence.width = 120;
  project.sequence.height = 120;
  project.exportSettings = { ...project.exportSettings, width: 120, height: 120, fps: 30 };
  const base = videoTrackId(project);
  project = addClip(project, base, "red", 0);
  const first = clipsOf(project, base)[0].id;
  return { project, first, base };
}

describe("grid layout and stacked copies", () => {
  it("fills leftover cells with copies on new tracks above, and leaves the source's timing alone", () => {
    const { project, first } = twoClipProject();
    const result = applyGridLayout(project, [first], "grid-2x2", { gap: 0, fillWithCopies: true });
    assert.equal(result.clipIds.length, 4);
    const tracks = result.project.sequence.tracks.filter((t) => t.kind === "video");
    assert.equal(tracks.length, 4);
    assert.equal(findClip(result.project, first)!.clip.timelineStart, 0);
    const scales = result.clipIds.map((id) => findClip(result.project, id)!.clip.transform?.scale);
    assert.ok(scales.every((s) => s !== undefined && s > 0));
  });

  it("without filling, only the given clips are arranged", () => {
    const { project, first } = twoClipProject();
    const result = applyGridLayout(project, [first], "side-by-side", { gap: 0, fillWithCopies: false });
    assert.equal(result.clipIds.length, 1);
    assert.equal(result.project.sequence.tracks.filter((t) => t.kind === "video").length, 1);
  });

  it("stacks copies BEHIND the clip: nearest directly under it, stepped, smaller and fainter", () => {
    const { project, first } = twoClipProject();
    const result = stackCopies(project, first, { count: 3, offsetX: 10, offsetY: -6, scaleStep: 0.1, fade: 0.6, delay: 0.2 });
    assert.equal(result.clipIds.length, 3);
    const order = result.project.sequence.tracks.filter((t) => t.kind === "video").map((t) => t.clips[0].id);
    assert.equal(order.at(-1), first, "the original stays on top");
    const near = findClip(result.project, result.clipIds[0])!.clip;
    const far = findClip(result.project, result.clipIds[2])!.clip;
    assert.equal(order.at(-2), near.id);
    assert.ok((far.transform!.scale) < (near.transform!.scale));
    assert.ok(far.transform!.offsetX > near.transform!.offsetX);
    assert.ok((far.effects!.opacity) < (near.effects!.opacity));
    assert.ok(far.timelineStart > near.timelineStart);
    assert.equal(findGridLayout("nope"), undefined);
  });
});

describe("collage in a real export", () => {
  const ffmpeg = bundledFfmpeg();
  it("side by side: one clip fills the left half and the other the right", { skip: !ffmpeg && "bundled FFmpeg not found" }, () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "vcut-collage-"));
    try {
      const { project: one } = twoClipProject();
      const base = videoTrackId(one);
      // A second clip on its own track, so both play at once.
      let project = { ...one, sequence: { ...one.sequence, tracks: [...one.sequence.tracks] } };
      const idx = project.sequence.tracks.findIndex((t) => t.id === base);
      project.sequence.tracks.splice(idx + 1, 0, { id: "v-extra", kind: "video", name: "V2", locked: false, visible: true, muted: false, solo: false, clips: [] });
      project = addClip(project, "v-extra", "blue", 0);
      const ids = [clipsOf(project, base)[0].id, clipsOf(project, "v-extra")[0].id];
      const laid = applyGridLayout(project, ids, "side-by-side", { gap: 0, fillWithCopies: false });

      const outputPath = path.join(dir, "out.mp4");
      const { args } = buildExportPlan(laid.project, { inputPathFor: () => dir, outputPath, fontPathFor: (f) => f, textFilePathFor: (c) => path.join(dir, `${c.id}.txt`) });
      execFileSync(ffmpeg!, args, { stdio: "pipe" });
      const raw = execFileSync(ffmpeg!, ["-hide_banner", "-loglevel", "error", "-i", outputPath, "-frames:v", "1", "-f", "rawvideo", "-pix_fmt", "rgb24", "-"], { maxBuffer: 1 << 22 });
      const px = (x: number, y: number) => [raw[(y * 120 + x) * 3], raw[(y * 120 + x) * 3 + 1], raw[(y * 120 + x) * 3 + 2]];
      const left = px(20, 60);
      const right = px(100, 60);
      assert.ok(left[0] > 200 && left[2] < 60, `left half should be red: ${left}`);
      assert.ok(right[2] > 200 && right[0] < 60, `right half should be blue: ${right}`);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
