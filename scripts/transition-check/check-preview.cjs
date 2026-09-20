// Optional browser regression checks, independent of the running editor and user projects.
// Set PLAYWRIGHT_MODULE, ESBUILD_MODULE, and CHROMIUM_PATH if these tools aren't locally installed.
const assert = require("node:assert/strict");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
const { createRequire } = require("node:module");
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || "playwright-core");
const esbuild = require(process.env.ESBUILD_MODULE || "esbuild");
const root = path.resolve(__dirname, "../..");
const studioRequire = createRequire(path.resolve(root, "../../studios/vcut/package.json"));
const ffmpeg = studioRequire("ffmpeg-static");

(async () => {
  const bundle = await esbuild.build({
    stdin: { contents: `
      import { PlaybackEngine } from './src/playback/PlaybackEngine.ts';
      import { emptyProject, colorAsset, videoTrackId } from './tests/fixture.ts';
      import { addClip } from './src/timeline/operations.ts';
      window.VCutCheck = { PlaybackEngine, emptyProject, colorAsset, videoTrackId, addClip };
    `, resolveDir: root, loader: "ts" },
    bundle: true, format: "iife", platform: "browser", write: false,
  });
  const media = execFileSync(ffmpeg, ["-v", "error", "-f", "lavfi", "-i", "testsrc2=s=64x64:r=30:d=0.3", "-an", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-movflags", "frag_keyframe+empty_moov", "-f", "mp4", "pipe:1"]);
  const browser = await chromium.launch({ headless: true, ...(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {}) });
  try {
    const page = await browser.newPage();
    await page.addScriptTag({ content: bundle.outputFiles[0].text });
    const result = await page.evaluate(async base64 => {
      const { PlaybackEngine, emptyProject, colorAsset, videoTrackId, addClip } = window.VCutCheck;
      let p = emptyProject([colorAsset("red", "#ff0000")]);
      p = addClip(p, videoTrackId(p), "red", 0);
      const track = p.sequence.tracks.find(t => t.kind === "video"), clip = track.clips[0];
      clip.sourceOut = 2;
      let blocked = 0;
      const engine = new PlaybackEngine({ getProject: () => p, getPlayhead: () => 0, isPlaying: () => false,
        onTimeUpdate() {}, onEnded() {}, onPlaybackBlocked() { blocked++; }, mediaUrlFor: () => null,
        lutUrlFor: () => null, getLiveOverrides: () => [], getLiveTrackGainPreview: () => null });
      try {
        const canvas = document.createElement("canvas");
        canvas.width = 160; canvas.height = 90;
        const ctx = canvas.getContext("2d", { willReadFrequently: true });
        const samples = {};
        for (const type of ["crossfade", "zoomBlur", "flashZoom"]) {
          clip.transitionIn = { type, duration: 0.5 };
          samples[type] = [0, 0.25, 0.5].map(time => {
            ctx.fillStyle = "black"; ctx.fillRect(0, 0, 160, 90);
            engine.drawVideoClip(p, ctx, 160, 90, track, clip, time);
            return [...ctx.getImageData(80, 45, 1, 1).data];
          });
        }
        const video = document.createElement("video"); video.muted = true;
        video.src = "data:video/mp4;base64," + base64;
        document.body.append(video);
        const ended = new Promise(resolve => video.addEventListener("ended", resolve, { once: true }));
        await video.play(); await ended;
        const end = video.currentTime;
        for (let i = 0; i < 10; i++) engine.syncMedia("end-check", video, end + 0.2 + i / 60, true);
        await new Promise(resolve => requestAnimationFrame(resolve));
        const held = { paused: video.paused, time: video.currentTime, end };
        video.currentTime = 0.1;
        await new Promise(resolve => video.addEventListener("seeked", resolve, { once: true }));
        engine.syncMedia("end-check", video, end + 0.2, true);
        if (video.seeking) await new Promise(resolve => video.addEventListener("seeked", resolve, { once: true }));
        const scrubbed = { paused: video.paused, time: video.currentTime, end };
        engine.syncMedia("end-check", video, 0, false);
        video.remove();
        return { samples, held, scrubbed, blocked };
      } finally { engine.detach(); }
    }, media.toString("base64"));
    assert.equal(result.held.paused, true);
    assert.equal(result.held.time, result.held.end);
    assert.equal(result.scrubbed.paused, true);
    assert.ok(result.scrubbed.time > result.scrubbed.end - 0.001);
    assert.equal(result.blocked, 0);
    assert.ok(result.samples.zoomBlur[0][0] < 5, "solo zoom must start hidden, not opaque");
    assert.ok(Math.abs(result.samples.zoomBlur[1][0] - 128) < 15, "solo zoom must retain its reveal alpha");
    assert.ok(result.samples.zoomBlur[2][0] > 240);
    assert.ok(result.samples.flashZoom[0].slice(0, 3).every(c => c > 200), "flash must cover the hidden clip");
    console.log(JSON.stringify(result, null, 2));
    console.log("PASS: actual playback EOF hold, scrub to final frame, solo zoom/flash reveal");
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
