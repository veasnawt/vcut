import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { deserializeProject, serializeProject } from "../src/project/serialize.ts";
import { findClip } from "../src/project/createProject.ts";
import type { Asset, Clip, Project } from "../src/project/types.ts";
import { allBeatTimes, beatTimelineTimes, fitClipsToBeats, splitClipAtBeats } from "../src/timeline/beatSync.ts";
import { snapPoints } from "../src/timeline/queries.ts";
import { emptyProject } from "./fixture.ts";

const beats = Array.from({ length: 41 }, (_, i) => Math.round((0.5 + i * 0.5) * 1000) / 1000); // 120 BPM from 0.5 s
const music: Asset = { id: "song", kind: "audio", name: "song", relPath: "song.mp3", duration: 30, hasAudio: true, sizeBytes: 1, importedAt: 0, beats: { bpm: 120, confidence: 0.9, times: beats } } as Asset;
const video = (id: string): Asset => ({ id, kind: "video", name: id, relPath: `${id}.mp4`, duration: 12, hasAudio: false, sizeBytes: 1, importedAt: 0 }) as Asset;
const clip = (id: string, assetId: string, extra: Partial<Clip> = {}): Clip => ({ id, assetId, timelineStart: 0, sourceIn: 0, sourceOut: 3, ...extra }) as Clip;

function project(clips: Clip[], musicClip: Clip = clip("m", "song", { timelineStart: 2, sourceIn: 1, sourceOut: 11 })): Project {
  const base = emptyProject();
  return {
    ...base,
    assets: [...base.assets, music, video("a"), video("b"), video("c")],
    sequence: {
      ...base.sequence,
      tracks: [
        { id: "v", kind: "video", name: "V1", locked: false, visible: true, muted: false, solo: false, clips },
        { id: "au", kind: "audio", name: "A1", locked: false, visible: true, muted: false, solo: false, clips: [musicClip] },
      ],
    },
  };
}

describe("beat times on the timeline", () => {
  it("maps the asset's beats through the clip's position, trim and speed", () => {
    const p = project([]);
    const m = findClip(p, "m")!.clip;
    const times = beatTimelineTimes(p, m);
    // Source beats at 1.0 s..10.5 s land at timeline 2.0 s onward (clip starts at 2 s, in-point 1 s).
    assert.equal(times[0], 2);
    assert.equal(times[1], 2.5);
    assert.ok(times.at(-1)! < 12);
    const fast = { ...m, speed: 2 };
    assert.equal(beatTimelineTimes(p, fast)[1], 2.25);
    assert.deepEqual(beatTimelineTimes(p, { ...m, reverse: true }), []);
  });

  it("collects every music clip's beats and adds them to the snap points", () => {
    const p = project([clip("a1", "a")]);
    assert.ok(allBeatTimes(p).length > 10);
    assert.ok(snapPoints(p).includes(2.5));
  });

  it("survives a save and reload", () => {
    const reloaded = deserializeProject(serializeProject(project([])));
    const asset = reloaded.assets.find((a) => a.id === "song")!;
    assert.equal(asset.beats?.bpm, 120);
    assert.equal(asset.beats?.times.length, 41);
  });
});

describe("cutting clips to the beat", () => {
  const grid = beats.map((b) => b + 1.5); // timeline beats: 2.0, 2.5, ...

  it("gives each clip a whole number of beats, one after another, starting on the nearest beat", () => {
    const p = project([clip("c1", "a", { timelineStart: 0.1, sourceOut: 3 }), clip("c2", "b", { timelineStart: 3.1, sourceOut: 3 }), clip("c3", "c", { timelineStart: 6.1, sourceOut: 3 })]);
    const result = fitClipsToBeats(p, ["c1", "c2", "c3"], grid, 2);
    assert.equal(result.applied, 3);
    const starts = ["c1", "c2", "c3"].map((id) => findClip(result.project, id)!.clip.timelineStart);
    const lengths = ["c1", "c2", "c3"].map((id) => { const c = findClip(result.project, id)!.clip; return c.sourceOut - c.sourceIn; });
    assert.deepEqual(starts, [2, 3, 4]);
    assert.deepEqual(lengths, [1, 1, 1]);
  });

  it("every 4 beats is one bar per clip", () => {
    const p = project([clip("c1", "a"), clip("c2", "b")]);
    const result = fitClipsToBeats(p, ["c1", "c2"], grid, 4);
    const c1 = findClip(result.project, "c1")!.clip;
    assert.equal(c1.sourceOut - c1.sourceIn, 2);
    assert.equal(findClip(result.project, "c2")!.clip.timelineStart, c1.timelineStart + 2);
  });

  it("honours speed, and reuses the end of a source that is too short instead of running past it", () => {
    const p = project([clip("c1", "a", { speed: 2, sourceIn: 10, sourceOut: 11.5 })]);
    const result = fitClipsToBeats(p, ["c1"], grid, 4);
    const c = findClip(result.project, "c1")!.clip;
    assert.equal(c.sourceOut - c.sourceIn, 4); // 2 s of timeline at 2x speed
    assert.ok(c.sourceOut <= 12);
  });

  it("skips reversed clips and stops when the beats run out, and says so", () => {
    const p = project([clip("c1", "a", { reverse: true }), clip("c2", "b")]);
    const result = fitClipsToBeats(p, ["c1", "c2"], grid.slice(0, 2), 1);
    assert.equal(result.skipped, 2);
  });

  it("refuses without beats or clips", () => {
    assert.throws(() => fitClipsToBeats(project([clip("c1", "a")]), ["c1"], [1], 1), /Not enough beats/);
    assert.throws(() => fitClipsToBeats(project([]), [], grid, 1), /Select/);
  });
});

describe("splitting a clip on the beat", () => {
  it("cuts at every beat inside the clip and keeps the original id on the first piece", () => {
    const p = project([clip("long", "a", { timelineStart: 2, sourceIn: 0, sourceOut: 4 })]);
    const grid = beats.map((b) => b + 1.5);
    const result = splitClipAtBeats(p, "long", grid, 2);
    // Beats every second inside 2..6: cuts at 3, 4, 5 -> four pieces.
    assert.equal(result.clipIds.length, 4);
    assert.equal(result.clipIds[0], "long");
    const starts = result.clipIds.map((id) => findClip(result.project, id)!.clip.timelineStart);
    assert.deepEqual(starts, [2, 3, 4, 5]);
    assert.throws(() => splitClipAtBeats(p, "long", [100, 101], 1), /No beats/);
  });
});
