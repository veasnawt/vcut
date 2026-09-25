import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import { buildProxyArgs, isProxyRelPath, PROXY_MAX_HEIGHT, proxyRelPathFor } from "../src/export/proxyCommands.ts";

function bundledFfmpeg(): string | null {
  try {
    const require = createRequire(path.resolve(import.meta.dirname, "../../../studios/vcut/package.json"));
    const binary = require("ffmpeg-static") as string;
    return fs.existsSync(binary) ? binary : null;
  } catch {
    return null;
  }
}

describe("proxy names", () => {
  it("puts the proxy next to the original as an mp4", () => {
    assert.equal(proxyRelPathFor("clip.mov"), "clip-proxy.mp4");
    assert.equal(proxyRelPathFor("holiday-a1b2.MXF"), "holiday-a1b2-proxy.mp4");
    assert.equal(proxyRelPathFor("noext"), "noext-proxy.mp4");
  });
  it("is idempotent and recognises proxies (never proxy a proxy)", () => {
    assert.equal(proxyRelPathFor("clip-proxy.mp4"), "clip-proxy.mp4");
    assert.equal(isProxyRelPath("clip-proxy.mp4"), true);
    assert.equal(isProxyRelPath("clip.mp4"), false);
  });
});

describe("buildProxyArgs", () => {
  it("makes H.264 yuv420p AAC mp4 with faststart, capped to 720p tall and never upscaled", () => {
    const args = buildProxyArgs("in.mov", "out.mp4", 29.97);
    const joined = args.join(" ");
    assert.ok(joined.includes("libx264") && joined.includes("yuv420p") && joined.includes("aac") && joined.includes("+faststart"));
    assert.ok(args.some((a) => a.includes(`min(${PROXY_MAX_HEIGHT},ih)`)), "scale down only");
    assert.equal(args.at(-1), "out.mp4");
    assert.ok(args.includes("0:a:0?"), "audio optional so a silent source doesn't fail");
  });
  it("uses a constant frame rate clamped to 24..60", () => {
    const rate = (fps?: number) => buildProxyArgs("a", "b", fps).find((a) => a.includes("fps="))!.match(/fps=(\d+)/)![1];
    assert.equal(rate(29.97), "30");
    assert.equal(rate(120), "60");
    assert.equal(rate(10), "24");
    assert.equal(rate(undefined), "30");
    assert.equal(rate(Number.NaN), "30");
  });
});

describe("a real proxy (real FFmpeg)", () => {
  const ffmpeg = bundledFfmpeg();
  it("turns a ProRes 1080p source into a small H.264 720p file", { skip: !ffmpeg && "bundled FFmpeg not found" }, () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "vcut-proxy-"));
    try {
      const source = path.join(dir, "source.mov");
      const output = path.join(dir, "source-proxy.mp4");
      execFileSync(ffmpeg!, ["-y", "-loglevel", "error", "-f", "lavfi", "-i", "testsrc=size=1920x1080:rate=25:duration=2", "-f", "lavfi", "-i", "sine=frequency=440:duration=2", "-c:v", "prores_ks", "-profile:v", "0", "-c:a", "pcm_s16le", source]);
      execFileSync(ffmpeg!, buildProxyArgs(source, output, 25), { stdio: "pipe" });
      // ffmpeg -i prints the stream summary on stderr and exits non-zero without an output; capture stderr.
      let info = "";
      try {
        execFileSync(ffmpeg!, ["-hide_banner", "-i", output], { stdio: "pipe" });
      } catch (err) {
        info = String((err as { stderr?: Buffer }).stderr ?? "");
      }
      assert.match(info, /Video: h264/, "H.264, playable everywhere");
      assert.match(info, /yuv420p/);
      assert.match(info, /Audio: aac/);
      assert.match(info, /1280x720/, "scaled down to 720p");
      assert.ok(fs.statSync(output).size < fs.statSync(source).size / 3, "far smaller than the ProRes original");
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
