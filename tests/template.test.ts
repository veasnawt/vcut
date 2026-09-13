import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { fillTemplateSlot, buildProjectFromTemplate, sanitizeProjectForTemplate, templateSlots } from "../src/project/template.ts";
import { addClip, addTrack, setClipTransform } from "../src/timeline/operations.ts";
import {
  audioAsset,
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
  it("keeps every clip — video/image get a placeholder asset, text/color/audio carry over as-is", () => {
    let base = emptyProject([videoAsset(), imageAsset(), colorAsset(), textAsset(), audioAsset()]);
    base = addTrack(base, "text");
    let project = addClip(base, videoTrackId(base), "asset1", 0); // video
    project = addClip(project, videoTrackId(project), "img1", 10); // image
    project = addClip(project, videoTrackId(project), "color1", 12); // color
    project = addClip(project, textTrackId(project), "text1", 0); // text
    project = addClip(project, audioTrackId(project), "music", 0); // audio

    const template = sanitizeProjectForTemplate(project);

    // Every clip survives — nothing is dropped, unlike this feature's own first version.
    const videoTrackClips = template.tracks.find((t) => t.kind === "video")!.clips;
    assert.equal(videoTrackClips.length, 3);
    const textTrackClips = template.tracks.find((t) => t.kind === "text")!.clips;
    assert.equal(textTrackClips.length, 1);
    const audioTrackClips = template.tracks.find((t) => t.kind === "audio")!.clips;
    assert.equal(audioTrackClips.length, 1);

    // The color/text assets carry over unchanged — no placeholder, same id.
    assert.equal(template.assets.find((a) => a.id === "color1")?.templatePlaceholder, undefined);
    assert.equal(template.assets.find((a) => a.id === "text1")?.templatePlaceholder, undefined);

    // The video/image clips now point at PLACEHOLDER assets, not the real ones — the real "asset1"/
    // "img1" ids are gone entirely.
    assert.equal(template.assets.find((a) => a.id === "asset1"), undefined);
    assert.equal(template.assets.find((a) => a.id === "img1"), undefined);
    const placeholders = template.assets.filter((a) => a.templatePlaceholder);
    assert.equal(placeholders.length, 2);
    assert.ok(placeholders.every((a) => a.relPath === "" && a.sizeBytes === 0));

    // Audio is never a placeholder — it keeps its SAME id and its REAL relPath (still relative to the
    // source project's own mediaDir at this point — see this asset's own doc comment on why), just
    // marked for the server's own POST handler to bundle its real file with the template next.
    const music = template.assets.find((a) => a.id === "music")!;
    assert.equal(music.templateBundledAudio, true);
    assert.equal(music.templatePlaceholder, undefined);
    assert.equal(music.relPath, "music.mp3");
  });

  it("assigns slotIndex in chronological (timelineStart) order across the whole project, not per track — audio never becomes a slot at all", () => {
    const base = emptyProject([videoAsset("v1"), audioAsset("a1"), videoAsset("v2", 5)]);
    let project = addClip(base, videoTrackId(base), "v2", 0); // starts first
    project = addClip(project, audioTrackId(project), "a1", 2); // starts second (but audio, so no slot)
    project = addClip(project, videoTrackId(project), "v1", 20); // starts last

    const template = sanitizeProjectForTemplate(project);
    const built = buildProjectFromTemplate("bp-order", "Order", template);
    const slots = templateSlots(built);

    assert.equal(slots.length, 2);
    assert.deepEqual(
      slots.map((s) => s.kind),
      ["video", "video"]
    );
    // The audio clip's own asset survived the round trip too, just not as a slot.
    assert.ok(built.assets.some((a) => a.kind === "audio"));
  });

  it("groups a duplicated clip (same source asset, different trims) into ONE shared slot", () => {
    const base = emptyProject([videoAsset("v1", 10)]);
    let project = addClip(base, videoTrackId(base), "v1", 0);
    project = addClip(project, videoTrackId(project), "v1", 20);
    // Give the two copies different trim lengths off the SAME source asset — a 3s clip and a 6s clip,
    // as if someone duplicated a clip and re-trimmed the copy.
    project = {
      ...project,
      sequence: {
        ...project.sequence,
        tracks: project.sequence.tracks.map((t) =>
          t.id === videoTrackId(project)
            ? {
                ...t,
                clips: t.clips.map((c, i) => (i === 0 ? { ...c, sourceIn: 0, sourceOut: 3 } : { ...c, sourceIn: 0, sourceOut: 6 })),
              }
            : t
        ),
      },
    };

    const template = sanitizeProjectForTemplate(project);

    // Only ONE placeholder for both clips, not two.
    const placeholders = template.assets.filter((a) => a.templatePlaceholder);
    assert.equal(placeholders.length, 1);
    // The shared slot's requiredDuration is the LONGER of the two (display-only — see this asset's own
    // doc comment; each clip still gets its own correctly-sized trim when the slot is actually filled).
    assert.equal(placeholders[0].templatePlaceholder!.requiredDuration, 6);

    const built = buildProjectFromTemplate("bp-dup", "Duplicate", template);
    const slots = templateSlots(built);
    assert.equal(slots.length, 1, "both clips should share one slot");

    const bothClipsBefore = clipsOf(built, videoTrackId(built));
    assert.equal(bothClipsBefore[0].assetId, bothClipsBefore[1].assetId, "both clips should reference the SAME placeholder");

    // Filling the one shared slot with a video only 4s long: the first clip (originally 3s) fits fully;
    // the second (originally 6s) gets clamped to the 4s actually available — each independently, off
    // its OWN original length, not the shared 6s requiredDuration.
    const filled = fillTemplateSlot(built, slots[0].assetId, videoAsset("real1", 4));
    const [clipA, clipB] = clipsOf(filled, videoTrackId(filled));
    assert.equal(clipA.assetId, "real1");
    assert.equal(clipB.assetId, "real1");
    assert.equal(clipA.sourceOut - clipA.sourceIn, 3, "the originally-3s clip should stay 3s");
    assert.equal(clipB.sourceOut - clipB.sourceIn, 4, "the originally-6s clip should clamp to the 4s available");
  });

  it("captures each clip's own trim length as requiredDuration", () => {
    const base = emptyProject([videoAsset("v1", 10)]);
    // A 4-second trim out of a 10-second source.
    const project = addClip(base, videoTrackId(base), "v1", 0, undefined, undefined);
    const trimmedClip = clipsOf(project, videoTrackId(project))[0];
    const withShortTrim = {
      ...project,
      sequence: {
        ...project.sequence,
        tracks: project.sequence.tracks.map((t) =>
          t.id === videoTrackId(project) ? { ...t, clips: [{ ...trimmedClip, sourceIn: 1, sourceOut: 5 }] } : t
        ),
      },
    };

    const template = sanitizeProjectForTemplate(withShortTrim);
    const placeholder = template.assets.find((a) => a.templatePlaceholder)!;
    assert.equal(placeholder.templatePlaceholder!.requiredDuration, 4);
  });

  it("preserves a clip's own transform/effects/transitions — not just its four basic fields", () => {
    const base = emptyProject([videoAsset()]);
    let project = addClip(base, videoTrackId(base), "asset1", 0);
    const clipId = clipsOf(project, videoTrackId(project))[0].id;
    project = setClipTransform(project, clipId, {
      offsetX: 0.2,
      offsetY: 0,
      scale: 1.5,
      rotationDeg: 0,
      crop: { top: 0, right: 0, bottom: 0, left: 0 },
    });
    project = {
      ...project,
      sequence: {
        ...project.sequence,
        tracks: project.sequence.tracks.map((t) =>
          t.id === videoTrackId(project)
            ? {
                ...t,
                clips: t.clips.map((c) => (c.id === clipId ? { ...c, transitionIn: { duration: 0.5, type: "crossfade" as const } } : c)),
              }
            : t
        ),
      },
    };

    const template = sanitizeProjectForTemplate(project);
    const built = buildProjectFromTemplate("bp-fx", "FX", template);
    const builtClip = clipsOf(built, videoTrackId(built))[0];

    assert.equal(builtClip.transform?.scale, 1.5);
    assert.equal(builtClip.transform?.offsetX, 0.2);
    assert.deepEqual(builtClip.transitionIn, { duration: 0.5, type: "crossfade" });
  });

  it("keeps an empty track structure even when it had no clips to begin with", () => {
    const base = emptyProject([videoAsset()]);
    const template = sanitizeProjectForTemplate(base);
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
  it("builds a valid project with fresh ids for every asset and clip", () => {
    let base = emptyProject([colorAsset(), textAsset()]);
    base = addTrack(base, "text");
    let project = addClip(base, videoTrackId(base), "color1", 0);
    project = addClip(project, textTrackId(project), "text1", 2);
    const template = sanitizeProjectForTemplate(project);

    const built = buildProjectFromTemplate("bp2", "From Template", template);

    assert.equal(built.templateOrigin, true, "a project built from a template must be permanently marked as such");
    assert.equal(built.sequence.width, template.width);
    assert.equal(built.sequence.height, template.height);
    assert.equal(built.sequence.fps, template.fps);
    assert.equal(built.name, "From Template");
    assert.equal(built.assets.length, 2);
    assert.notEqual(built.assets[0].id, "color1");
    assert.notEqual(built.assets[1].id, "text1");

    const builtColorClip = clipsOf(built, videoTrackId(built))[0];
    assert.ok(builtColorClip, "expected the color clip to carry over");
    assert.equal(builtColorClip.timelineStart, 0);

    const builtTextClip = clipsOf(built, textTrackId(built))[0];
    assert.ok(builtTextClip, "expected the text clip to carry over");
    assert.equal(builtTextClip.timelineStart, 2);
  });

  it("passes an audio asset through with a fresh id, still marked templateBundledAudio (not stripped to a placeholder)", () => {
    const base = emptyProject([audioAsset()]);
    const project = addClip(base, audioTrackId(base), "music", 0);
    const template = sanitizeProjectForTemplate(project);

    const built = buildProjectFromTemplate("bp-audio", "Audio", template);

    const builtAudio = built.assets.find((a) => a.kind === "audio")!;
    assert.ok(builtAudio, "expected the audio asset to survive");
    assert.notEqual(builtAudio.id, "music", "should still get a fresh id like every other asset");
    assert.equal(builtAudio.templateBundledAudio, true);
    // Not yet a real, project-local file — `project/route.ts`'s own POST handler resolves this into
    // one right after calling buildProjectFromTemplate (see that function's own doc comment); the pure
    // function itself has no filesystem access to do that step.
    assert.equal(builtAudio.relPath, "music.mp3");
    const builtAudioClip = clipsOf(built, audioTrackId(built))[0];
    assert.equal(builtAudioClip.assetId, builtAudio.id);
  });

  it("produces two independent projects from the same template with no shared ids", () => {
    const base = emptyProject([colorAsset(), videoAsset()]);
    let project = addClip(base, videoTrackId(base), "color1", 0);
    project = addClip(project, videoTrackId(project), "asset1", 5);
    const template = sanitizeProjectForTemplate(project);

    const first = buildProjectFromTemplate("bp3", "First", template);
    const second = buildProjectFromTemplate("bp4", "Second", template);

    assert.notEqual(first.id, second.id);
    assert.notEqual(first.assets[0].id, second.assets[0].id);
    assert.notEqual(clipsOf(first, videoTrackId(first))[0].id, clipsOf(second, videoTrackId(second))[0].id);
    // The placeholder assets themselves are independent too — filling a slot in one project must never
    // touch the other.
    const firstPlaceholderId = templateSlots(first)[0].assetId;
    const secondPlaceholderId = templateSlots(second)[0].assetId;
    assert.notEqual(firstPlaceholderId, secondPlaceholderId);
  });

  it("still gives the built project a usable audio track, matching a fresh project's own default shape", () => {
    const base = emptyProject([videoAsset()]);
    const project = addClip(base, videoTrackId(base), "asset1", 0);
    const template = sanitizeProjectForTemplate(project);

    const built = buildProjectFromTemplate("bp5", "Untitled", template);

    assert.ok(built.sequence.tracks.some((t) => t.kind === "audio"), "expected an audio track to survive");
    assert.equal(clipsOf(built, audioTrackId(built)).length, 0);
  });
});

describe("templateSlots / fillTemplateSlot", () => {
  it("lists exactly the placeholder assets, sorted by slotIndex", () => {
    const base = emptyProject([videoAsset("v1"), videoAsset("v2", 6)]);
    let project = addClip(base, videoTrackId(base), "v2", 0);
    project = addClip(project, videoTrackId(project), "v1", 20);
    const built = buildProjectFromTemplate("bp6", "Slots", sanitizeProjectForTemplate(project));

    const slots = templateSlots(built);
    assert.equal(slots.length, 2);
    assert.deepEqual(
      slots.map((s) => s.slotIndex),
      [0, 1]
    );
  });

  it("returns no slots for an ordinary (non-template) project", () => {
    const base = emptyProject([videoAsset()]);
    const project = addClip(base, videoTrackId(base), "asset1", 0);
    assert.deepEqual(templateSlots(project), []);
  });

  it("binds a real video asset into a slot, capping the trim to the real file's own length", () => {
    const base = emptyProject([videoAsset("v1", 10)]);
    const project = addClip(base, videoTrackId(base), "v1", 0);
    const built = buildProjectFromTemplate("bp7", "Fill", sanitizeProjectForTemplate(project));
    const [slot] = templateSlots(built);

    // The slot needs 10s (the original clip's own trim length); the real pick only has 6.
    const shortReplacement = videoAsset("real1", 6);
    const filled = fillTemplateSlot(built, slot.assetId, shortReplacement);

    assert.equal(filled.assets.some((a) => a.id === slot.assetId), false, "placeholder should be gone");
    assert.ok(filled.assets.some((a) => a.id === "real1"));
    const clip = clipsOf(filled, videoTrackId(filled))[0];
    assert.equal(clip.assetId, "real1");
    assert.equal(clip.sourceIn, 0);
    assert.equal(clip.sourceOut, 6, "should use the full 6s available rather than the 10s required");
  });

  it("lets a picked IMAGE fully satisfy a video-shaped slot at its exact required duration", () => {
    const base = emptyProject([videoAsset("v1", 10)]);
    const project = addClip(base, videoTrackId(base), "v1", 0);
    const built = buildProjectFromTemplate("bp8", "Fill", sanitizeProjectForTemplate(project));
    const [slot] = templateSlots(built);

    const filled = fillTemplateSlot(built, slot.assetId, imageAsset("photo1"));

    const clip = clipsOf(filled, videoTrackId(filled))[0];
    assert.equal(clip.assetId, "photo1");
    assert.equal(clip.sourceOut - clip.sourceIn, 10, "an image has no real length limit to run short on");
  });

  it("does nothing when the given id isn't an open placeholder", () => {
    const base = emptyProject([videoAsset("v1")]);
    const project = addClip(base, videoTrackId(base), "v1", 0);
    const filled = fillTemplateSlot(project, "v1", videoAsset("real1"));
    assert.deepEqual(filled, project);
  });
});
