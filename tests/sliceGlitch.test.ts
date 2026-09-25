import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import { applySliceGlitch, sliceGlitchGeqExpression, sliceGlitchSlices, SLICE_GLITCH_COUNT } from "../src/timeline/pixelEffects.ts";
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

/** A frame where every pixel says where it came from: red = column, green = row. */
function coordinateFrame(width: number, height: number): ImageData {
  const data = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 4;
      data[i] = Math.round((x / (width - 1)) * 255);
      data[i + 1] = Math.round((y / (height - 1)) * 255);
      data[i + 2] = 128;
      data[i + 3] = 255;
    }
  }
  return { width, height, data } as unknown as ImageData;
}

describe("Slice Glitch (preview)", () => {
  it("shifts only thin strips, and nothing at intensity 0", () => {
    const width = 200;
    const height = 200;
    const frame = coordinateFrame(width, height);
    const original = frame.data.slice();
    applySliceGlitch(frame, 1.234, 1, 0);
    assert.deepEqual([...frame.data], [...original]);
    applySliceGlitch(frame, 1.234, 1, 1);
    const changedRows = new Set<number>();
    for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) if (frame.data[(y * width + x) * 4] !== original[(y * width + x) * 4]) changedRows.add(y);
    assert.ok(changedRows.size > 0, "some rows should move");
    assert.ok(changedRows.size <= SLICE_GLITCH_COUNT * Math.round(height * 0.03) + 1, `too many rows moved: ${changedRows.size}`);
  });

  it("is a pure function of time, holds for a burst, and changes between bursts", () => {
    const a = coordinateFrame(120, 120);
    const b = coordinateFrame(120, 120);
    const c = coordinateFrame(120, 120);
    applySliceGlitch(a, 2.01, 1);
    applySliceGlitch(b, 2.05, 1);
    applySliceGlitch(c, 2.31, 1);
    assert.deepEqual([...a.data], [...b.data]);
    assert.notDeepEqual([...a.data], [...c.data]);
    const s0 = sliceGlitchSlices(20, 0);
    assert.deepEqual(s0, sliceGlitchSlices(20, 0));
  });

  it("is saved and reloaded as a clip's pixel effect", () => {
    const base = emptyProject();
    const project = {
      ...base,
      assets: [...base.assets, { id: "a", kind: "video", name: "a", relPath: "a.mp4", duration: 5, hasAudio: false, sizeBytes: 1, importedAt: 0 } as never],
      sequence: { ...base.sequence, tracks: [{ id: "t", kind: "video" as const, name: "V", locked: false, visible: true, muted: false, solo: false, clips: [{ id: "c", assetId: "a", timelineStart: 0, sourceIn: 0, sourceOut: 5, pixelEffect: { type: "sliceGlitch" as const, speed: 2 } }] }] },
    };
    assert.deepEqual(findClip(deserializeProject(serializeProject(project)), "c")!.clip.pixelEffect, { type: "sliceGlitch", speed: 2 });
  });
});

describe("Slice Glitch export matches the preview (real FFmpeg)", () => {
  const ffmpeg = bundledFfmpeg();
  it("moves the same rows by the same amount as the preview function", { skip: !ffmpeg }, () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "vcut-slice-"));
    try {
      const width = 320;
      const height = 320;
      const time = 1.234;
      // Source: red = column, green = row, as a raw RGBA frame FFmpeg can read.
      const frame = coordinateFrame(width, height);
      const rawIn = path.join(dir, "in.rgba");
      fs.writeFileSync(rawIn, Buffer.from(frame.data.buffer, frame.data.byteOffset, frame.data.byteLength));
      const rawOut = path.join(dir, "out.rgba");
      // T is the frame's timestamp: seek so frame 0 sits at `time` with setpts.
      execFileSync(
        ffmpeg!,
        ["-v", "error", "-f", "rawvideo", "-pix_fmt", "rgba", "-s", `${width}x${height}`, "-framerate", "30", "-i", rawIn, "-vf", `format=gbrap,setpts=PTS+${time}/TB,geq=r='${sliceGlitchGeqExpression(1).replace(/p\(/g, "p(")}':g='${sliceGlitchGeqExpression(1)}':b='${sliceGlitchGeqExpression(1)}':a='${sliceGlitchGeqExpression(1)}'`, "-frames:v", "1", "-f", "rawvideo", "-pix_fmt", "rgba", "-y", rawOut],
        { stdio: "pipe" }
      );
      const exported = fs.readFileSync(rawOut);
      const preview = coordinateFrame(width, height);
      applySliceGlitch(preview, time, 1);
      let differingRows = 0;
      let movedRows = 0;
      for (let y = 0; y < height; y++) {
        let rowDiff = 0;
        let rowMoved = false;
        for (let x = 0; x < width; x++) {
          const i = (y * width + x) * 4;
          if (Math.abs(exported[i] - preview.data[i]) > 3) rowDiff++;
          if (frame.data[i] !== preview.data[i]) rowMoved = true;
        }
        if (rowMoved) movedRows++;
        if (rowDiff > width * 0.02) differingRows++;
      }
      assert.ok(movedRows > 0, "the preview should move something at this time");
      assert.ok(differingRows <= 1, `${differingRows} of ${movedRows} moved rows differ between export and preview`);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
