import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import { buildEdgeCleanArgs } from "../src/export/ffmpegCommands.ts";

function bundledFfmpeg(): string | null {
  try {
    const require = createRequire(path.resolve(import.meta.dirname, "../../../studios/vcut/package.json"));
    const binary = require("ffmpeg-static") as string;
    return fs.existsSync(binary) ? binary : null;
  } catch {
    return null;
  }
}

describe("matted video edge cleanup (real FFmpeg)", () => {
  const ffmpeg = bundledFfmpeg();
  it("removes the key-coloured ring around the subject and leaves the subject and background alone", { skip: !ffmpeg }, () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "vcut-edge-"));
    try {
      const KEY = "78ff9b";
      // A near-black disc (like a black shirt — neutral chroma, which a YUV keyer wrongly treats as background) with a SOFT edge over the key colour — what a matting model returns: edge pixels are a mix.
      const soft = path.join(dir, "soft.mp4");
      execFileSync(
        ffmpeg!,
        [
          "-v", "error",
          "-f", "lavfi", "-i", `color=c=0x${KEY}:s=200x200:r=24:d=1`,
          "-f", "lavfi", "-i", "color=c=0x0b0b0b:s=200x200:r=24:d=1",
          "-f", "lavfi", "-i", "color=c=black:s=200x200:r=24:d=1,drawbox=x=50:y=50:w=100:h=100:color=white:t=fill,gblur=sigma=3",
          "-filter_complex", "[1:v][2:v]alphamerge[fg];[0:v][fg]overlay=format=auto,format=yuv420p",
          "-c:v", "libx264", "-crf", "12", "-y", soft,
        ],
        { stdio: "ignore" }
      );
      const cleaned = path.join(dir, "clean.mp4");
      execFileSync(ffmpeg!, buildEdgeCleanArgs(soft, cleaned, { keyHex: `#${KEY}`, width: 200, height: 200, fps: 24 }), { stdio: "ignore" });

      const pixel = (file: string, x: number, y: number): [number, number, number] => {
        const bytes = execFileSync(ffmpeg!, ["-v", "error", "-i", file, "-frames:v", "1", "-vf", `format=rgb24,crop=1:1:${x}:${y}`, "-f", "rawvideo", "pipe:1"], {
          stdio: ["ignore", "pipe", "ignore"],
        });
        return [bytes[0], bytes[1], bytes[2]];
      };
      const distFromKey = ([r, g, b]: [number, number, number]) => Math.hypot(r - 0x78, g - 0xff, b - 0x9b);

      // The blended ring sits on the disc's boundary (x = 50): before cleanup it is a mix (neither red nor key)...
      const before = pixel(soft, 50, 100);
      assert.ok(distFromKey(before) > 40, `expected a blended edge pixel, got ${before}`);
      // ...after cleanup it is the exact key colour, so the later key removes it.
      const after = pixel(cleaned, 50, 100);
      assert.ok(distFromKey(after) < 12, `edge still tinted: ${after}`);
      // The middle of the subject is untouched (still near-black), and far background is still the key colour.
      const centre = pixel(cleaned, 100, 100);
      assert.ok(distFromKey(centre) > 100 && centre[1] < 60, `subject damaged: ${centre}`);
      assert.ok(distFromKey(pixel(cleaned, 5, 5)) < 12);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
