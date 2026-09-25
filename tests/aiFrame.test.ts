import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { buildAiFramePngArgs } from "../src/export/ffmpegCommands.ts";
import { sourceTimeAtPlayhead } from "../src/timeline/queries.ts";
import type { Clip } from "../src/project/types.ts";

const clip = { id: "c", assetId: "a", timelineStart: 10, sourceIn: 5, sourceOut: 15, speed: 2 } as unknown as Clip;

describe("AI frame helpers", () => {
  it("caps the long edge, never upscales, and keeps sides divisible", () => {
    const args = buildAiFramePngArgs("in.mp4", "out.png", { maxEdge: 1024, multipleOf: 8 });
    const vf = args[args.indexOf("-vf") + 1];
    assert.match(vf, /min\(1024,iw\)/);
    assert.match(vf, /force_divisible_by=8/);
    assert.match(vf, /force_original_aspect_ratio=decrease/);
    assert.ok(!args.includes("-ss"));
  });
  it("seeks before the input when a time is given", () => {
    const args = buildAiFramePngArgs("in.mp4", "out.png", { maxEdge: 512, atSeconds: 3.5 });
    assert.deepEqual(args.slice(0, 3), ["-ss", "3.5", "-i"]);
  });
  it("maps the playhead into source time, honouring speed and the source window", () => {
    assert.equal(sourceTimeAtPlayhead(clip, 11), 7);
    assert.equal(sourceTimeAtPlayhead(clip, 0), 5);
  });
});
