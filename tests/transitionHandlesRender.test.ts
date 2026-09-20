import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";
import { buildExportPlan } from "../src/export/buildExportPlan.ts";
import { buildAudioOnlyExportPlan } from "../src/export/buildAudioOnlyExportPlan.ts";
import { IDENTITY_EFFECTS, IDENTITY_TRANSFORM, type Project } from "../src/project/types.ts";
import { addClip, addTrack } from "../src/timeline/operations.ts";
import { TRANSITION_TYPE_OPTIONS } from "../src/timeline/transitions.ts";
import { colorAsset, emptyProject, videoAsset, videoTrackId } from "./fixture.ts";

let ffmpeg: string | null = null;
try {
  const require = createRequire(path.resolve(import.meta.dirname, "../../../studios/vcut/package.json"));
  ffmpeg = require("ffmpeg-static") as string;
  if (!fs.existsSync(ffmpeg!)) ffmpeg = null;
} catch { /* Render tests are optional without the bundled binary. */ }

describe("transition source handles (real FFmpeg)", { skip: !ffmpeg && "bundled FFmpeg not found" }, () => {
  let directory: string;
  before(() => {
    directory = fs.mkdtempSync(path.join(os.tmpdir(), "vcut-transition-handles-"));
    for (const seconds of [1, 3]) {
      execFileSync(ffmpeg!, [
        "-v", "error", "-f", "lavfi", "-i", `testsrc2=s=160x90:r=30:d=${seconds}`,
        "-f", "lavfi", "-i", `sine=frequency=1000:sample_rate=48000:duration=${seconds}`,
        "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p", "-c:a", "pcm_s16le",
        "-t", String(seconds), path.join(directory, `${seconds}.mkv`),
      ], { timeout: 15_000, stdio: "pipe" });
    }
  });
  after(() => {
    if (!directory) return;
    const target = path.resolve(directory);
    const tmpRoot = path.resolve(os.tmpdir()) + path.sep;
    assert.ok(target.startsWith(tmpRoot) && path.basename(target).startsWith("vcut-transition-handles-"));
    fs.rmSync(target, { recursive: true, force: true });
  });

  function fixture(sourceDuration: number, overlay = false, keyframed = false): Project {
    let p = emptyProject([
      { ...videoAsset("a", sourceDuration), width: 160, height: 90 },
      { ...videoAsset("b", 3), width: 160, height: 90 },
      colorAsset("bg", "#0000ff"),
    ]);
    p.sequence.width = 160;
    p.sequence.height = 90;
    p.exportSettings = { ...p.exportSettings, width: 160, height: 90, fps: 30 };
    let trackId = videoTrackId(p);
    if (overlay) {
      p = addClip(p, trackId, "bg", 0);
      p.sequence.tracks.find(t => t.id === trackId)!.clips[0].sourceOut = 3;
      p = addTrack(p, "video", "overlay");
      trackId = "overlay";
    }
    p = addClip(p, trackId, "a", 0);
    p.sequence.tracks.find(t => t.id === trackId)!.clips[0].sourceOut = 1;
    p = addClip(p, trackId, "b", 1);
    const [a, b] = p.sequence.tracks.find(t => t.id === trackId)!.clips;
    b.sourceOut = 2;
    b.transitionIn = { type: "crossfade", duration: 0.5 };
    if (overlay) {
      for (const clip of [a, b]) clip.transform = { ...IDENTITY_TRANSFORM, scale: 0.7 };
    }
    if (keyframed) {
      for (const clip of [a, b]) {
        clip.transformKeyframes = [
          { id: `${clip.id}-t0`, time: 0, value: { ...IDENTITY_TRANSFORM, scale: 0.6 } },
          { id: `${clip.id}-t1`, time: 0.8, value: { ...IDENTITY_TRANSFORM, scale: 0.8 } },
        ];
        clip.effectsKeyframes = [
          { id: `${clip.id}-e0`, time: 0, value: { ...IDENTITY_EFFECTS, brightness: 0.05 } },
          { id: `${clip.id}-e1`, time: 0.8, value: { ...IDENTITY_EFFECTS, brightness: 0.15 } },
        ];
      }
    }
    return p;
  }

  function options(sourceDuration: number) {
    return { inputPathFor: (id: string) => path.join(directory, `${id === "a" ? sourceDuration : 3}.mkv`), outputPath: "pipe:1", fontPathFor: (f: string) => f, textFilePathFor: (c: { id: string }) => c.id };
  }

  for (const variant of ["handle", "overlay", "keyframes", "exhausted-keyframes"] as const) {
    for (const type of TRANSITION_TYPE_OPTIONS) {
      it(`${type}: ${variant} renders the entire timeline`, () => {
        const sourceDuration = variant === "exhausted-keyframes" ? 1 : 3;
        const p = fixture(sourceDuration, variant === "overlay", variant.includes("keyframes"));
        const track = p.sequence.tracks.find(t => t.clips.some(c => c.assetId === "b"))!;
        track.clips[1].transitionIn!.type = type;
        const { args } = buildExportPlan(p, options(sourceDuration));
        const i = args.indexOf("-filter_complex");
        // Match the server's spillFilterComplexToScript: keyframed graphs can exceed Windows'
        // command-line limit even when the input count is small.
        const graphPath = path.join(directory, "graph.txt");
        fs.writeFileSync(graphPath, `${args[i + 1]};${args[i + 5]}anullsink`);
        const raw = execFileSync(ffmpeg!, [
          "-v", "error", ...args.slice(0, i), "-filter_complex_script", graphPath,
          "-map", args[i + 3], "-t", "3", "-pix_fmt", "rgb24", "-f", "rawvideo", "pipe:1",
        ], { timeout: 20_000, maxBuffer: 20 * 1024 * 1024 });
        assert.equal(raw.length, 90 * 160 * 90 * 3, "transition must not change sequence length");
        if (variant === "overlay") {
          // Corner is transparent for both scaled clips. It must still reveal the blue base after
          // the blend; catches alpha loss caused by filter format negotiation.
          const offset = (46 * 160 * 90 + 2 * 160 + 2) * 3;
          assert.ok(raw[offset + 2] > 240 && raw[offset] < 10);
        }
      });
    }
  }

  function audio(p: Project, sourceDuration: number, audioOnly: boolean): Buffer {
    const { args } = audioOnly ? buildAudioOnlyExportPlan(p, options(sourceDuration)) : buildExportPlan(p, options(sourceDuration));
    const i = args.indexOf("-filter_complex");
    const graph = args[i + 1] + (audioOnly ? "" : `;${args[i + 3]}nullsink`);
    return execFileSync(ffmpeg!, [
      "-v", "error", ...args.slice(0, i), "-filter_complex", graph,
      "-map", args[i + (audioOnly ? 3 : 5)], "-t", "3", "-ar", "48000", "-ac", "1", "-f", "f32le", "pipe:1",
    ], { timeout: 15_000, maxBuffer: 4 * 1024 * 1024 });
  }

  function rms(raw: Buffer, start: number, duration: number): number {
    let sum = 0;
    const from = Math.round(start * 48000), count = Math.round(duration * 48000);
    for (let i = from; i < from + count; i++) sum += raw.readFloatLE(i * 4) ** 2;
    return Math.sqrt(sum / count);
  }

  for (const keyframed of [false, true]) {
    it(`an exhausted outgoing source contributes silence, not a repeated audio tail (${keyframed ? "keyframes" : "static"})`, () => {
      const p = fixture(1, false, keyframed);
      p.sequence.tracks.find(t => t.kind === "video")!.clips[1].mutedAudio = true;
      const full = audio(p, 1, false);
      const only = audio(p, 1, true);
      assert.ok(rms(full, 0.9, 0.05) > 0.01, "outgoing sound exists before the cut");
      assert.ok(rms(full, 1, 0.04) < 0.0001, "no sound may replay after the source ends");
      assert.ok(rms(only, 1, 0.04) < 0.0001);
    });
  }

  it("a real source handle stays audible in both export modes and fades to silence", () => {
    const p = fixture(3);
    p.sequence.tracks.find(t => t.kind === "video")!.clips[1].mutedAudio = true;
    for (const only of [false, true]) {
      const raw = audio(p, 3, only);
      assert.ok(rms(raw, 1.05, 0.05) > 0.01);
      assert.ok(rms(raw, 1.05, 0.05) > rms(raw, 1.4, 0.05) * 3);
      assert.ok(rms(raw, 1.5, 0.05) < 0.0001);
    }
  });
});
