import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { Clip } from "../src/project/types.ts";
import {
  calculateTrimPreview,
  clampFrameDuration,
  resolveMoveDrag,
  resolveTimelineSnap,
  timelineScrollLeftForAnchor,
  timelineSpanPixels,
  timelineTimeAtClientX,
  visibleRulerTicks,
} from "../src/timeline/interaction.ts";
import { addClip, splitClip, trimClip } from "../src/timeline/operations.ts";
import { clipDuration } from "../src/project/createProject.ts";
import { clipsOf, emptyProject, videoAsset, videoTrackId } from "./fixture.ts";

const fps = 30;
const clip: Clip = { id: "clip", assetId: "asset", sourceIn: 0, sourceOut: 10, timelineStart: 0 };

describe("timeline interaction precision", () => {
  it("uses inverse pointer and zoom-anchor equations with scroll and a mobile leading pad", () => {
    const time = timelineTimeAtClientX({
      clientX: 430,
      viewportLeft: 100,
      scrollLeft: 760,
      leadingPad: 180,
      pixelsPerSecond: 120,
    });
    assert.equal(time, 7.583333333333333);
    const scrollLeft = timelineScrollLeftForAnchor({
      time,
      clientX: 430,
      viewportLeft: 100,
      leadingPad: 180,
      pixelsPerSecond: 480,
    });
    const after = timelineTimeAtClientX({
      clientX: 430,
      viewportLeft: 100,
      scrollLeft,
      leadingPad: 180,
      pixelsPerSecond: 480,
    });
    assert.ok(Math.abs(after - time) < 1e-10);
  });

  it("snaps to sequence frames at every zoom without multi-second magnets at overview zoom", () => {
    for (const pixelsPerSecond of [4, 60, 1200]) {
      const result = resolveTimelineSnap({ rawTime: 1.01, points: [1], pixelsPerSecond, fps, pixelRadius: 16 });
      assert.equal(result.time, 1);
      assert.equal(result.target, 1);
    }
    const distant = resolveTimelineSnap({ rawTime: 2, points: [4], pixelsPerSecond: 4, fps, pixelRadius: 16 });
    assert.equal(distant.target, null);
    assert.equal(distant.time, 2);
  });

  it("moves a selection as one frame-aligned unit and snaps its outer edge", () => {
    const result = resolveMoveDrag({
      rawDelta: 0.97,
      selectionStart: 2,
      selectionEnd: 7,
      points: [8],
      pixelsPerSecond: 60,
      fps,
      pixelRadius: 16,
    });
    assert.equal(result.delta, 1);
    assert.equal(result.target, 8);
    const clamped = resolveMoveDrag({
      rawDelta: -10,
      selectionStart: 2,
      selectionEnd: 7,
      points: [],
      pixelsPerSecond: 60,
      fps,
      pixelRadius: 16,
    });
    assert.equal(clamped.delta, -2);
  });

  it("previews constant-speed and reverse trims through playback's source mapping", () => {
    const asset = videoAsset("asset", 10);
    const fast = { ...clip, speed: 2 };
    assert.deepEqual(calculateTrimPreview({ clip: fast, asset, edge: "in", targetTime: 1, fps }), {
      start: 1,
      duration: 4,
      sourceIn: 2,
      sourceOut: 10,
    });
    assert.deepEqual(calculateTrimPreview({ clip: fast, asset, edge: "out", targetTime: 3, fps }), {
      start: 0,
      duration: 3,
      sourceIn: 0,
      sourceOut: 6,
    });
    const reversed = { ...fast, reverse: true };
    assert.deepEqual(calculateTrimPreview({ clip: reversed, asset, edge: "in", targetTime: 1, fps }), {
      start: 1,
      duration: 4,
      sourceIn: 0,
      sourceOut: 8,
    });
    assert.deepEqual(calculateTrimPreview({ clip: reversed, asset, edge: "out", targetTime: 3, fps }), {
      start: 0,
      duration: 3,
      sourceIn: 4,
      sourceOut: 10,
    });
  });

  it("keeps minimum clip width visual-only", () => {
    const duration = 1 / fps;
    assert.equal(timelineSpanPixels(duration, 4, 2), 2);
    assert.equal(duration, 1 / fps);
  });

  it("generates virtualized ruler ticks from integer frame indices", () => {
    const ticks = visibleRulerTicks({ visibleStart: 120, visibleEnd: 121, pixelsPerSecond: 1200, fps, totalDuration: 600 });
    assert.ok(ticks.length < 200);
    assert.ok(ticks.some((tick) => !tick.major));
    assert.ok(ticks.every((tick) => Number.isInteger(tick.seconds * fps)));
    assert.ok(Math.min(...ticks.map((tick) => tick.seconds)) >= 117);
  });

  it("floors transition maxima to full frames", () => {
    assert.equal(clampFrameDuration(0.53, 0.55, fps), 16 / fps);
    assert.equal(clampFrameDuration(0.01, 2, fps), 1 / fps);
  });
});

describe("timeline operations preserve preview/export timing", () => {
  it("keeps retimed split and trim durations exact", () => {
    let project = emptyProject([videoAsset("asset", 10)]);
    project = addClip(project, videoTrackId(project), "asset", 0);
    const original = clipsOf(project, videoTrackId(project))[0];
    original.speed = 3;
    project = splitClip(project, original.id, 1);
    let clips = clipsOf(project, videoTrackId(project));
    assert.ok(Math.abs(clipDuration(clips[0]) - 1) < 1e-9);
    assert.ok(Math.abs(clipDuration(clips[1]) - 7 / 3) < 1e-9);
    project = trimClip(project, clips[1].id, "out", 2);
    clips = clipsOf(project, videoTrackId(project));
    assert.ok(Math.abs(clipDuration(clips[1]) - 1) < 1e-9);
  });
});
