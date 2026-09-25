import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import { buildOutlineLines, isIdentityOutline, outlineMargin } from "../src/export/outlineFilter.ts";
import { setClipOutline } from "../src/timeline/operations.ts";
import { deserializeProject, serializeProject } from "../src/project/serialize.ts";
import { findClip } from "../src/project/createProject.ts";
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
const n = (v: number) => String(Math.round(v * 1000) / 1000);

describe("outline data", () => {
  it("is identity only with no thickness and no glow", () => {
    assert.equal(isIdentityOutline(undefined), true);
    assert.equal(isIdentityOutline({ color: "#f00000", width: 0, glow: 0 }), true);
    assert.equal(isIdentityOutline({ color: "#f00000", width: 3, glow: 0 }), false);
    assert.equal(isIdentityOutline({ color: "#f00000", width: 0, glow: 10 }), false);
  });

  it("clamps, clears on identity, and survives a save and reload", () => {
    const base = emptyProject();
    const withClip = {
      ...base,
      assets: [...base.assets, { id: "a", kind: "video", name: "a", relPath: "a.mp4", duration: 5, hasAudio: false, sizeBytes: 1, importedAt: 0 } as never],
      sequence: {
        ...base.sequence,
        tracks: [{ id: "t", kind: "video" as const, name: "V", locked: false, visible: true, muted: false, solo: false, clips: [{ id: "c", assetId: "a", timelineStart: 0, sourceIn: 0, sourceOut: 5 }] }],
      },
    };
    const set = setClipOutline(withClip, "c", { color: "#ff2222", width: 99, glow: 500, glowColor: "#ff0000" });
    const outline = findClip(set, "c")!.clip.outline!;
    assert.equal(outline.width, 24);
    assert.equal(outline.glow, 60);
    const reloaded = findClip(deserializeProject(serializeProject(set)), "c")!.clip.outline!;
    assert.deepEqual(reloaded, outline);
    assert.equal(findClip(setClipOutline(set, "c", { color: "#ff2222", width: 0, glow: 0 }), "c")!.clip.outline, undefined);
    assert.equal(findClip(setClipOutline(set, "c", null), "c")!.clip.outline, undefined);
  });
});

describe("outline filter graph (real FFmpeg)", () => {
  const ffmpeg = bundledFfmpeg();
  it("draws a coloured ring and glow around a transparent-background subject, keeping the subject on top and centred", { skip: !ffmpeg }, () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "vcut-outline-"));
    try {
      // A blue square (60x60) with transparent surroundings, on a 200x200 canvas.
      const subject = path.join(dir, "subject.png");
      execFileSync(
        ffmpeg!,
        ["-v", "error", "-f", "lavfi", "-i", "color=c=0x2244cc:s=60x60:d=1", "-vf", "format=rgba,pad=200:200:70:70:color=black@0", "-frames:v", "1", "-y", subject],
        { stdio: "ignore" }
      );
      const outline = { color: "#ff0000", width: 6, glow: 12, glowColor: "#ff0000" };
      const lines = buildOutlineLines("in", "out", outline, n);
      const graph = ["[0:v]null[in]", ...lines].join(";");
      const out = path.join(dir, "out.png");
      execFileSync(ffmpeg!, ["-v", "error", "-i", subject, "-filter_complex", graph, "-map", "[out]", "-frames:v", "1", "-y", out], { stdio: "ignore" });

      const margin = outlineMargin(outline);
      const px = (x: number, y: number): [number, number, number, number] => {
        const bytes = execFileSync(ffmpeg!, ["-v", "error", "-i", out, "-vf", `format=rgba,crop=1:1:${x}:${y}`, "-f", "rawvideo", "pipe:1"], { stdio: ["ignore", "pipe", "ignore"] });
        return [bytes[0], bytes[1], bytes[2], bytes[3]];
      };
      const left = 70 + margin; // the subject's left edge in the padded output
      const mid = 100 + margin;
      // Centred: the subject (blue) is where it was, plus the margin on every side.
      const centre = px(mid, mid);
      assert.ok(centre[2] > 150 && centre[0] < 90 && centre[3] === 255, `subject not on top: ${centre}`);
      // Just outside the subject's edge, inside the outline's thickness: solid red.
      const ring = px(left - 3, mid);
      assert.ok(ring[0] > 200 && ring[1] < 60 && ring[3] > 240, `no outline: ${ring}`);
      // Beyond the outline, in the glow: red, but fading (partly transparent).
      const halo = px(left - 10, mid);
      assert.ok(halo[0] > 150 && halo[3] > 10 && halo[3] < 250, `no glow: ${halo}`);
      // Far away: nothing.
      assert.equal(px(2, 2)[3], 0);
    } catch (error) {
      const text = String((error as { stderr?: Buffer | string }).stderr ?? "");
      assert.fail(`ffmpeg failed: ${text.slice(-600)}`);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

import { buildExportPlan } from "../src/export/buildExportPlan.ts";
import { IDENTITY_TRANSFORM } from "../src/project/types.ts";
import { addClip, setClipTransform } from "../src/timeline/operations.ts";
import { clipsOf, colorAsset, emptyProject as emptyFixtureProject, videoTrackId } from "./fixture.ts";

describe("outline in a real export", () => {
  const ffmpeg = bundledFfmpeg();
  it("draws the ring around a scaled clip and leaves the rest of the frame alone", { skip: !ffmpeg && "bundled FFmpeg not found" }, () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "vcut-outline-export-"));
    try {
      const size = 120;
      let project = emptyFixtureProject([colorAsset("box", "#2244cc")]);
      project.sequence.width = size;
      project.sequence.height = size;
      project.exportSettings = { ...project.exportSettings, width: size, height: size, fps: 30 };
      const base = videoTrackId(project);
      project = addClip(project, base, "box", 0);
      const clipId = clipsOf(project, base)[0].id;
      project = setClipTransform(project, clipId, { ...IDENTITY_TRANSFORM, scale: 0.4 });
      project = setClipOutline(project, clipId, { color: "#ff0000", width: 6, glow: 0 });

      const outputPath = path.join(dir, "out.mp4");
      const { args } = buildExportPlan(project, {
        inputPathFor: () => dir,
        outputPath,
        fontPathFor: (f) => f,
        textFilePathFor: (c) => path.join(dir, `${c.id}.txt`),
      });
      execFileSync(ffmpeg!, args, { stdio: "pipe" });
      const raw = execFileSync(ffmpeg!, ["-hide_banner", "-loglevel", "error", "-i", outputPath, "-frames:v", "1", "-f", "rawvideo", "-pix_fmt", "rgb24", "-"], { maxBuffer: 1 << 22 });
      const pixel = (x: number, y: number) => {
        const o = (y * size + x) * 3;
        return [raw[o], raw[o + 1], raw[o + 2]];
      };
      // The 48px box is centred: it spans 36..84. The ring is the 6px just outside it.
      const inside = pixel(60, 60);
      const ring = pixel(36 - 3, 60);
      const outside = pixel(6, 6);
      assert.ok(inside[2] > 150 && inside[0] < 90, `box colour lost: ${inside}`);
      assert.ok(ring[0] > 200 && ring[1] < 60 && ring[2] < 60, `no ring in the export: ${ring}`);
      assert.ok(outside.every((c) => c < 25), `frame corner changed: ${outside}`);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
