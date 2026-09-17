import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import { buildExportPlan } from "../src/export/buildExportPlan.ts";
import { IDENTITY_TRANSFORM } from "../src/project/types.ts";
import { addClip, setClipTransform, trimClip } from "../src/timeline/operations.ts";
import { clipsOf, colorAsset, emptyProject, videoTrackId } from "./fixture.ts";

/** Resolves the same bundled FFmpeg the vcut server uses; `null` skips the test — same pattern
 *  `stickers.test.ts`'s own `bundledFfmpeg` uses for its real-render regression test. */
function bundledFfmpeg(): string | null {
  try {
    const require = createRequire(path.resolve(import.meta.dirname, "../../../studios/vcut/package.json"));
    const binary = require("ffmpeg-static") as string;
    return fs.existsSync(binary) ? binary : null;
  } catch {
    return null;
  }
}

describe("color-matte export render (real FFmpeg)", () => {
  const ffmpeg = bundledFfmpeg();

  /** A real, reported production crash: a color-matte clip's `Asset.relPath` is always `""` (there's
   *  no real file behind it — see that field's own doc comment), and the server's own `inputPathFor`
   *  used to naively resolve that empty path straight through to the project's own media DIRECTORY.
   *  FFmpeg then failed to open it as an `-i` input ("Is a directory" on Linux, "Permission denied" on
   *  Windows — reproduced identically locally before this fix). `buildExportPlan.ts`'s own arg-level
   *  tests ("buildExportPlan with a color-matte clip") already caught the args regressing; this one
   *  spawns the real binary to prove the fix actually decodes and renders, not just that the argv looks
   *  right — the exact gap that let the original bug ship unnoticed. */
  it("renders a color-matte background correctly even when inputPathFor points at a directory", { skip: !ffmpeg && "bundled FFmpeg not found" }, () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "vcut-color-render-"));
    try {
      const SIZE = 240;
      let project = emptyProject([colorAsset("bg", "#e4c3f4")]);
      project.sequence.width = SIZE;
      project.sequence.height = SIZE;
      project.exportSettings = { ...project.exportSettings, width: SIZE, height: SIZE, fps: 30 };
      const base = videoTrackId(project);
      project = addClip(project, base, "bg", 0);
      project = trimClip(project, clipsOf(project, base)[0].id, "out", 1);
      project = setClipTransform(project, clipsOf(project, base)[0].id, { ...IDENTITY_TRANSFORM, rotationDeg: 15, scale: 0.8 });

      const outputPath = path.join(dir, "out.mp4");
      const { args } = buildExportPlan(project, {
        // Reproduces the real server bug: for a color asset this resolves to a DIRECTORY, not a file —
        // proves the fix never actually asks FFmpeg to open it.
        inputPathFor: () => dir,
        outputPath,
        fontPathFor: (f) => f,
        textFilePathFor: (c) => path.join(dir, `${c.id}.txt`),
      });
      execFileSync(ffmpeg!, args, { stdio: "pipe" });
      assert.ok(fs.existsSync(outputPath));

      const raw = execFileSync(ffmpeg!, ["-hide_banner", "-loglevel", "error", "-i", outputPath, "-f", "rawvideo", "-pix_fmt", "rgb24", "-"], {
        maxBuffer: 1 << 26,
      });
      const frameBytes = SIZE * SIZE * 3;
      assert.equal(raw.length % frameBytes, 0);
      const frames = raw.length / frameBytes;
      assert.ok(frames >= 25, `expected ~30 frames, got ${frames}`);
      // Centre pixel should be close to #e4c3f4 (228, 195, 244), allowing encoder drift.
      const centre = frameBytes / 2 + (SIZE / 2) * 3;
      const [r, g, b] = [raw[centre], raw[centre + 1], raw[centre + 2]];
      assert.ok(Math.abs(r - 228) < 25 && Math.abs(g - 195) < 25 && Math.abs(b - 244) < 25, `centre pixel ${r},${g},${b} not close to #e4c3f4`);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
