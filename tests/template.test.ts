import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { addClip, addTrack } from "../src/timeline/operations.ts";
import { buildProjectFromTemplate, sanitizeProjectForTemplate } from "../src/project/template.ts";
import {
  audioTrackId,
  clipsOf,
  colorAsset,
  emptyProject,
  imageAsset,
  textAsset,
  textTrackId,
  videoAsset,
  videoTrackId,
} from "./fixture.ts";

describe("sanitizeProjectForTemplate", () => {
  it("keeps text and color clips, drops video/audio/image clips", () => {
    let base = emptyProject([videoAsset(), imageAsset(), colorAsset(), textAsset()]);
    base = addTrack(base, "text");
    let project = addClip(base, videoTrackId(base), "asset1", 0); // video
    project = addClip(project, videoTrackId(project), "img1", 10); // image
    project = addClip(project, videoTrackId(project), "color1", 12); // color
    project = addClip(project, textTrackId(project), "text1", 0); // text

    const template = sanitizeProjectForTemplate(project);

    const videoTrackClips = template.tracks.find((t) => t.kind === "video")!.clips;
    // Only the color clip survives on the video track — the video and image clips are both dropped.
    assert.equal(videoTrackClips.length, 1);
    assert.equal(template.assets.find((a) => a.id === "color1") !== undefined, true);
    assert.equal(template.assets.find((a) => a.id === "asset1"), undefined);
    assert.equal(template.assets.find((a) => a.id === "img1"), undefined);

    const textTrackClips = template.tracks.find((t) => t.kind === "text")!.clips;
    assert.equal(textTrackClips.length, 1);
    assert.equal(template.assets.find((a) => a.id === "text1") !== undefined, true);
  });

  it("keeps an empty track structure even when every clip on it was dropped", () => {
    const base = emptyProject([videoAsset()]);
    const project = addClip(base, videoTrackId(base), "asset1", 0);

    const template = sanitizeProjectForTemplate(project);

    // The video track itself still exists in the template, just with no clips — a template's whole
    // point is preserving the TRACK LAYOUT, not just whatever content happened to survive filtering.
    const videoTrack = template.tracks.find((t) => t.kind === "video");
    assert.ok(videoTrack, "expected the video track to still be present");
    assert.equal(videoTrack!.clips.length, 0);
  });

  it("captures the sequence's own dimensions and fps", () => {
    const base = emptyProject([]);
    const template = sanitizeProjectForTemplate(base);
    assert.equal(template.width, base.sequence.width);
    assert.equal(template.height, base.sequence.height);
    assert.equal(template.fps, base.sequence.fps);
  });
});

describe("buildProjectFromTemplate", () => {
  it("builds a valid, empty-of-real-media project from a sanitized template", () => {
    let base = emptyProject([colorAsset(), textAsset()]);
    base = addTrack(base, "text");
    let project = addClip(base, videoTrackId(base), "color1", 0);
    project = addClip(project, textTrackId(project), "text1", 2);
    const template = sanitizeProjectForTemplate(project);

    const built = buildProjectFromTemplate("bp2", "From Template", template);

    assert.equal(built.sequence.width, template.width);
    assert.equal(built.sequence.height, template.height);
    assert.equal(built.sequence.fps, template.fps);
    assert.equal(built.name, "From Template");
    assert.equal(built.assets.length, 2);
    // Every id is freshly minted, not copied verbatim — the same template used twice must never
    // produce two projects that quietly share an asset id.
    assert.notEqual(built.assets[0].id, "color1");
    assert.notEqual(built.assets[1].id, "text1");

    const builtColorClip = clipsOf(built, videoTrackId(built))[0];
    assert.ok(builtColorClip, "expected the color clip to carry over");
    assert.equal(builtColorClip.timelineStart, 0);

    const builtTextClip = clipsOf(built, textTrackId(built))[0];
    assert.ok(builtTextClip, "expected the text clip to carry over");
    assert.equal(builtTextClip.timelineStart, 2);
  });

  it("produces two independent projects from the same template with no shared ids", () => {
    const base = emptyProject([colorAsset()]);
    const project = addClip(base, videoTrackId(base), "color1", 0);
    const template = sanitizeProjectForTemplate(project);

    const first = buildProjectFromTemplate("bp3", "First", template);
    const second = buildProjectFromTemplate("bp4", "Second", template);

    assert.notEqual(first.id, second.id);
    assert.notEqual(first.assets[0].id, second.assets[0].id);
    assert.notEqual(clipsOf(first, videoTrackId(first))[0].id, clipsOf(second, videoTrackId(second))[0].id);
  });

  it("still gives the built project a usable audio track, matching a fresh project's own default shape", () => {
    // A template built from a project whose audio track had nothing kept on it (real audio is always
    // dropped) should still leave that track itself in place — same "structure survives even with all
    // its clips filtered out" behavior the sanitize-side test above covers.
    const base = emptyProject([videoAsset()]);
    const project = addClip(base, videoTrackId(base), "asset1", 0);
    const template = sanitizeProjectForTemplate(project);

    const built = buildProjectFromTemplate("bp5", "Untitled", template);

    assert.ok(built.sequence.tracks.some((t) => t.kind === "audio"), "expected an audio track to survive");
    assert.equal(clipsOf(built, audioTrackId(built)).length, 0);
  });
});
