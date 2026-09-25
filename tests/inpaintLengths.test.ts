import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import { buildExtractClipArgs, buildMaskVideoArgs } from "../src/export/ffmpegCommands.ts";

function bundledFfmpeg(): string | null {
  try {
    const require = createRequire(path.resolve(import.meta.dirname, "../../../studios/vcut/package.json"));
    const binary = require("ffmpeg-static") as string;
    return fs.existsSync(binary) ? binary : null;
  } catch {
    return null;
  }
}

describe("Remove Object chunk source and mask lengths", () => {
  const ffmpeg = bundledFfmpeg();
  it("come out with the identical number of frames, even from a variable-rate source with audio", { skip: !ffmpeg }, () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "vcut-inpaint-"));
    try {
      const src = path.join(dir, "src.mp4");
      // 29.97 fps with audio running slightly longer than the video: the shape that made Bria reject the pair.
      execFileSync(ffmpeg!, ["-v", "error", "-f", "lavfi", "-i", "testsrc2=size=320x240:rate=30000/1001:duration=7", "-f", "lavfi", "-i", "sine=frequency=440:duration=7.4", "-pix_fmt", "yuv420p", "-y", src]);
      const chunk = path.join(dir, "chunk.mp4");
      const mask = path.join(dir, "mask.mp4");
      const fps = 29.97;
      const frames = Math.round(5 * fps);
      execFileSync(ffmpeg!, buildExtractClipArgs(src, chunk, 1.3, 6.3, fps), { stdio: "ignore" });
      execFileSync(ffmpeg!, buildMaskVideoArgs(mask, 320, 240, fps, 5, { x: 10, y: 10, width: 50, height: 50 }, frames), { stdio: "ignore" });
      const count = (file: string) =>
        Number(
          execFileSync(ffmpeg!, ["-v", "error", "-i", file, "-map", "0:v:0", "-f", "framecrc", "-"], { encoding: "utf8" })
            .split("\n")
            .filter((l) => /^0,/.test(l)).length
        );
      assert.equal(count(chunk), frames);
      assert.equal(count(mask), frames);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
