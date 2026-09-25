import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { buildComposePreviewProject } from "../src/playback/composePreview.ts";
import { DEFAULT_TEXT_STYLE } from "../src/project/types.ts";
import { emptyProject } from "./fixture.ts";

describe("buildComposePreviewProject", () => {
  it("returns the project untouched while nothing is typed yet", () => {
    const project = emptyProject();
    assert.equal(buildComposePreviewProject(project, { style: DEFAULT_TEXT_STYLE, content: "  " }, 0), project);
    assert.equal(buildComposePreviewProject(project, null, 0), project);
  });

  it("adds a throwaway text track whose clip carries the draft's animation, so it animates live", () => {
    const project = emptyProject();
    const preview = buildComposePreviewProject(project, { style: DEFAULT_TEXT_STYLE, content: "Hi", animation: { type: "bounce" } }, 1.5)!;
    const track = preview.sequence.tracks[preview.sequence.tracks.length - 1];
    assert.equal(track.kind, "text");
    assert.equal(track.clips[0].textAnimation?.type, "bounce");
    assert.equal(track.clips[0].timelineStart, 1.5);
    assert.equal(project.sequence.tracks.length, preview.sequence.tracks.length - 1, "the real project is not mutated");
  });

  it("has no animation when none was chosen", () => {
    const preview = buildComposePreviewProject(emptyProject(), { style: DEFAULT_TEXT_STYLE, content: "Hi" }, 0)!;
    assert.equal(preview.sequence.tracks[preview.sequence.tracks.length - 1].clips[0].textAnimation, undefined);
  });

  it("loops an animated draft in real time by sliding the clip start back, and leaves a static draft alone", () => {
    const project = emptyProject();
    const animated = buildComposePreviewProject(project, { style: DEFAULT_TEXT_STYLE, content: "Hi", animationIn: { type: "pop" } }, 5, 1.25)!;
    const animatedClip = animated.sequence.tracks[animated.sequence.tracks.length - 1].clips[0];
    assert.ok(animatedClip.timelineStart < 5, "start is slid back so the playhead lands part-way into the clip");
    assert.ok(5 - animatedClip.timelineStart <= 1.25 + 1e-9);
    const still = buildComposePreviewProject(project, { style: DEFAULT_TEXT_STYLE, content: "Hi" }, 5, 1.25)!;
    assert.equal(still.sequence.tracks[still.sequence.tracks.length - 1].clips[0].timelineStart, 5);
  });
});
