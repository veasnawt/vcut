import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { PasteClipsCommand } from "../src/commands/index.ts";
import { adjacentEditPoint, buildClipboardEntries, editPointTimes } from "../src/timeline/clipboard.ts";
import { addClip, addTrack, deleteClips } from "../src/timeline/operations.ts";
import { clipsOf, emptyProject, textAsset, textTrackId, videoTrackId } from "./fixture.ts";

function twoClipProject() {
  let project = emptyProject();
  const track = videoTrackId(project);
  project = addClip(project, track, "asset1", 0); // 0..10 (fixture asset is 10s)
  const first = clipsOf(project, track)[0];
  project = addClip(project, track, "asset1", 12);
  const second = clipsOf(project, track)[1];
  return { project, track, first, second };
}

describe("buildClipboardEntries", () => {
  it("snapshots clips with their track, in the requested order, skipping unknown ids", () => {
    const { project, track, first, second } = twoClipProject();
    const entries = buildClipboardEntries(project, [second.id, "nope", first.id]);
    assert.deepEqual(entries.map((e) => e.clip.id), [second.id, first.id]);
    assert.ok(entries.every((e) => e.trackId === track && e.textSnapshot === null));
  });

  it("snapshots are copies — later edits to the project don't change them", () => {
    const { project, first } = twoClipProject();
    const [entry] = buildClipboardEntries(project, [first.id]);
    first.timelineStart = 99;
    assert.equal(entry.clip.timelineStart, 0);
  });

  it("carries a text clip's words and style so it can be pasted after the original is deleted (Cut)", () => {
    let project = addTrack(emptyProject([textAsset("txt", "Hello")]), "text");
    project = addClip(project, textTrackId(project), "txt", 1);
    const clip = clipsOf(project, textTrackId(project))[0];
    const [entry] = buildClipboardEntries(project, [clip.id]);
    assert.equal(entry.textSnapshot?.content, "Hello");
    const cut = deleteClips(project, [clip.id]);
    const pasted = new PasteClipsCommand([entry], 5).apply(cut);
    const pastedClip = clipsOf(pasted, textTrackId(pasted))[0];
    assert.equal(pastedClip.timelineStart, 5);
    assert.equal(pasted.assets.find((a) => a.id === pastedClip.assetId)?.textContent, "Hello");
  });
});

describe("copy + paste round trip", () => {
  it("pastes at the playhead keeping the group's relative spacing, on the original track, with fresh ids", () => {
    const { project, track, first, second } = twoClipProject();
    const entries = buildClipboardEntries(project, [first.id, second.id]);
    const command = new PasteClipsCommand(entries, 30);
    const pasted = command.apply(project);
    const clips = clipsOf(pasted, track);
    assert.equal(clips.length, 4);
    const created = clips.filter((c) => command.createdClipIds.includes(c.id)).sort((a, b) => a.timelineStart - b.timelineStart);
    assert.equal(created.length, 2);
    assert.equal(created[0].timelineStart, 30);
    assert.ok(Math.abs(created[1].timelineStart - 42) < 1e-6, `spacing kept, got ${created[1].timelineStart}`);
    assert.ok(created.every((c) => c.id !== first.id && c.id !== second.id));
  });

  it("undo removes exactly what paste added", () => {
    const { project, first } = twoClipProject();
    const command = new PasteClipsCommand(buildClipboardEntries(project, [first.id]), 40);
    const pasted = command.apply(project);
    const undone = command.revert(pasted);
    assert.equal(clipsOf(undone, videoTrackId(undone)).length, 2);
  });
});

describe("edit points", () => {
  it("lists every clip start/end plus 0 and the sequence end, sorted and de-duplicated", () => {
    const { project } = twoClipProject();
    assert.deepEqual(editPointTimes(project), [0, 10, 12, 22]);
  });

  it("finds the previous / next point relative to the playhead, and null past the ends", () => {
    const times = [0, 10, 12, 22];
    assert.equal(adjacentEditPoint(times, 5, 1), 10);
    assert.equal(adjacentEditPoint(times, 5, -1), 0);
    assert.equal(adjacentEditPoint(times, 10, 1), 12, "sitting ON a point moves past it");
    assert.equal(adjacentEditPoint(times, 10, -1), 0);
    assert.equal(adjacentEditPoint(times, 22, 1), null);
    assert.equal(adjacentEditPoint(times, 0, -1), null);
  });
});
