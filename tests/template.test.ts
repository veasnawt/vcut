import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  fillTemplateSlot,
  buildProjectFromTemplate,
  sanitizeProjectForTemplate,
  setTemplateClipText,
  templateAudioAssets,
  templateClips,
  templateSlotRequiredLength,
  templateSlots,
  templateVideoAssets,
  trimTemplateSlot,
} from "../src/project/template.ts";
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

  it("does nothing when no clip references the given id at all", () => {
    const base = emptyProject([videoAsset("v1")]);
    const project = addClip(base, videoTrackId(base), "v1", 0);
    const filled = fillTemplateSlot(project, "nonexistent-id", videoAsset("real1"));
    assert.deepEqual(filled, project);
  });

  it("lets a slot's pick be changed after the fact, not just filled once", () => {
    const base = emptyProject([videoAsset("v1", 10)]);
    const project = addClip(base, videoTrackId(base), "v1", 0);
    const built = buildProjectFromTemplate("bp-redo", "Redo", sanitizeProjectForTemplate(project));
    const [slot] = templateSlots(built);

    // First pick.
    const firstFill = fillTemplateSlot(built, slot.assetId, videoAsset("first", 8));
    let clip = clipsOf(firstFill, videoTrackId(firstFill))[0];
    assert.equal(clip.assetId, "first");

    // Change of mind — asked for directly: `TemplateFillScreen.tsx`'s own slot chips let you click an
    // already-filled one and pick something else, so this has to actually work, not silently no-op the
    // way it used to (this function only ever accepted a still-open placeholder before). Re-targeting
    // by the FIRST pick's own asset id (not the long-gone original placeholder id) is what the caller
    // is responsible for — see `TemplateFillScreen.tsx`'s own `assign()`.
    const secondFill = fillTemplateSlot(firstFill, "first", videoAsset("second", 5));
    clip = clipsOf(secondFill, videoTrackId(secondFill))[0];
    assert.equal(clip.assetId, "second");
    assert.equal(clip.sourceOut - clip.sourceIn, 5);
    assert.equal(secondFill.assets.some((a) => a.id === "first"), false, "the first pick should be gone, not left dangling");
  });
});

describe("templateAudioAssets", () => {
  it("returns the bundled audio asset behind a template's music track", () => {
    const base = emptyProject([audioAsset("music", 30)]);
    const project = addClip(base, audioTrackId(base), "music", 0);
    const rows = templateAudioAssets(project);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].id, "music");
  });

  it("returns [] for a project with no audio clip at all", () => {
    const base = emptyProject([videoAsset()]);
    const project = addClip(base, videoTrackId(base), "asset1", 0);
    assert.deepEqual(templateAudioAssets(project), []);
  });

  it("groups a duplicated audio clip (same source asset placed twice) into one row, not two", () => {
    const base = emptyProject([audioAsset("music", 30)]);
    let project = addClip(base, audioTrackId(base), "music", 0);
    project = addClip(project, audioTrackId(project), "music", 15);
    const rows = templateAudioAssets(project);
    assert.equal(rows.length, 1, "both clips share the same underlying asset, so only one row should show");
  });

  it("orders rows by each group's first clip's own timelineStart, not insertion order", () => {
    const base = emptyProject([audioAsset("second", 10), audioAsset("first", 10)]);
    // Placed in the OPPOSITE order from how they should be listed — "second" (added first, so it'd
    // win on insertion order alone) actually starts LATER on the timeline than "first".
    let project = addClip(base, audioTrackId(base), "second", 20);
    project = addClip(project, audioTrackId(project), "first", 0);

    const rows = templateAudioAssets(project);
    assert.deepEqual(
      rows.map((a) => a.id),
      ["first", "second"],
      "the clip starting at timelineStart 0 (\"first\") should be listed before the one starting at 20 (\"second\")"
    );
  });

  it("reads the CURRENT asset a clip points at — reflects an audio replacement immediately, live", () => {
    const base = emptyProject([audioAsset("music", 30)]);
    const project = addClip(base, audioTrackId(base), "music", 0);

    // `fillTemplateSlot` needs no dedicated audio-replace function of its own — reused exactly as a
    // video/image slot pick would be, since it only requires SOME clip to currently reference the id
    // being replaced (see that function's own doc comment).
    const replaced = fillTemplateSlot(project, "music", audioAsset("newsong", 45));

    const rows = templateAudioAssets(replaced);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].id, "newsong");
    assert.equal(replaced.assets.some((a) => a.id === "music"), false, "the old audio asset should be gone, not left dangling");

    const clip = clipsOf(replaced, audioTrackId(replaced))[0];
    assert.equal(clip.assetId, "newsong");
    assert.equal(clip.sourceOut - clip.sourceIn, 30, "capped to the ORIGINAL clip's own required length, not the new track's full 45s");
  });
});

describe("templateVideoAssets / templateSlotRequiredLength / trimTemplateSlot", () => {
  it("lists the video/image assets currently placed, one row per shared source", () => {
    const base = emptyProject([videoAsset("v1", 10), imageAsset("i1")]);
    let project = addClip(base, videoTrackId(base), "v1", 0);
    project = addClip(project, videoTrackId(project), "i1", 10);

    const rows = templateVideoAssets(project);
    assert.deepEqual(
      rows.map((a) => a.id),
      ["v1", "i1"]
    );
  });

  it("groups a duplicated clip into one row, matching templateAudioAssets' own convention", () => {
    const base = emptyProject([videoAsset("v1", 20)]);
    let project = addClip(base, videoTrackId(base), "v1", 0);
    project = addClip(project, videoTrackId(project), "v1", 15);
    assert.equal(templateVideoAssets(project).length, 1);
  });

  it("returns [] for a project with no video/image content", () => {
    const base = emptyProject([audioAsset()]);
    const project = addClip(base, audioTrackId(base), "music", 0);
    assert.deepEqual(templateVideoAssets(project), []);
  });

  it("templateSlotRequiredLength reads the clip's OWN current trim length", () => {
    const base = emptyProject([videoAsset("v1", 20)]);
    const project = addClip(base, videoTrackId(base), "v1", 0);
    const clip = clipsOf(project, videoTrackId(project))[0];
    // A 6-second trim out of a 20-second source.
    const trimmed = {
      ...project,
      sequence: {
        ...project.sequence,
        tracks: project.sequence.tracks.map((t) =>
          t.id === videoTrackId(project) ? { ...t, clips: [{ ...clip, sourceIn: 2, sourceOut: 8 }] } : t
        ),
      },
    };
    assert.equal(templateSlotRequiredLength(trimmed, "v1"), 6);
  });

  it("templateSlotRequiredLength is the LONGEST clip when a source is shared by clips of different lengths", () => {
    const base = emptyProject([videoAsset("v1", 20)]);
    let project = addClip(base, videoTrackId(base), "v1", 0);
    project = addClip(project, videoTrackId(project), "v1", 10);
    project = {
      ...project,
      sequence: {
        ...project.sequence,
        tracks: project.sequence.tracks.map((t) =>
          t.id === videoTrackId(project)
            ? { ...t, clips: t.clips.map((c, i) => (i === 0 ? { ...c, sourceIn: 0, sourceOut: 3 } : { ...c, sourceIn: 0, sourceOut: 7 })) }
            : t
        ),
      },
    };
    assert.equal(templateSlotRequiredLength(project, "v1"), 7);
  });

  it("trimTemplateSlot shifts the shared start point while preserving each clip's own length", () => {
    const base = emptyProject([videoAsset("v1", 20)]);
    const project = addClip(base, videoTrackId(base), "v1", 0);
    const clip = clipsOf(project, videoTrackId(project))[0];
    const sized = {
      ...project,
      sequence: {
        ...project.sequence,
        tracks: project.sequence.tracks.map((t) => (t.id === videoTrackId(project) ? { ...t, clips: [{ ...clip, sourceIn: 0, sourceOut: 5 }] } : t)),
      },
    };

    const trimmed = trimTemplateSlot(sized, "v1", 8);
    const result = clipsOf(trimmed, videoTrackId(trimmed))[0];
    assert.equal(result.sourceIn, 8);
    assert.equal(result.sourceOut, 13, "length (5s) must be preserved, just shifted to start at 8");
  });

  it("trimTemplateSlot clamps sourceIn so the trim window never runs past the real asset's own duration", () => {
    const base = emptyProject([videoAsset("v1", 10)]);
    const project = addClip(base, videoTrackId(base), "v1", 0);
    const clip = clipsOf(project, videoTrackId(project))[0];
    const sized = {
      ...project,
      sequence: {
        ...project.sequence,
        tracks: project.sequence.tracks.map((t) => (t.id === videoTrackId(project) ? { ...t, clips: [{ ...clip, sourceIn: 0, sourceOut: 4 }] } : t)),
      },
    };

    // Asked for sourceIn=9 on a 4s-long clip against a 10s source — 9+4=13 would overrun; clamps to
    // the latest valid start (10 - 4 = 6) instead.
    const trimmed = trimTemplateSlot(sized, "v1", 9);
    const result = clipsOf(trimmed, videoTrackId(trimmed))[0];
    assert.equal(result.sourceIn, 6);
    assert.equal(result.sourceOut, 10);
  });

  it("trimTemplateSlot also clamps a negative sourceIn up to 0", () => {
    const base = emptyProject([videoAsset("v1", 10)]);
    const project = addClip(base, videoTrackId(base), "v1", 0);
    const trimmed = trimTemplateSlot(project, "v1", -5);
    const result = clipsOf(trimmed, videoTrackId(trimmed))[0];
    assert.equal(result.sourceIn, 0);
  });

  it("trimTemplateSlot does nothing when nothing references the given asset id", () => {
    const base = emptyProject([videoAsset("v1", 10)]);
    const project = addClip(base, videoTrackId(base), "v1", 0);
    const untouched = trimTemplateSlot(project, "nonexistent-id", 3);
    assert.deepEqual(untouched, project);
  });

  it("trimTemplateSlot applies the SAME start point to every clip sharing the source, each keeping its own length", () => {
    const base = emptyProject([videoAsset("v1", 20)]);
    let project = addClip(base, videoTrackId(base), "v1", 0);
    project = addClip(project, videoTrackId(project), "v1", 10);
    project = {
      ...project,
      sequence: {
        ...project.sequence,
        tracks: project.sequence.tracks.map((t) =>
          t.id === videoTrackId(project)
            ? { ...t, clips: t.clips.map((c, i) => (i === 0 ? { ...c, sourceIn: 0, sourceOut: 3 } : { ...c, sourceIn: 0, sourceOut: 7 })) }
            : t
        ),
      },
    };

    const trimmed = trimTemplateSlot(project, "v1", 5);
    const [clipA, clipB] = clipsOf(trimmed, videoTrackId(trimmed));
    assert.equal(clipA.sourceIn, 5);
    assert.equal(clipA.sourceOut, 8, "3s length preserved");
    assert.equal(clipB.sourceIn, 5);
    assert.equal(clipB.sourceOut, 12, "7s length preserved");
  });
});

describe("templateClips", () => {
  it("lists video and text clips, in timeline order, one entry per CLIP INSTANCE", () => {
    let base = emptyProject([videoAsset("v1", 5), textAsset("t1", "Hello")]);
    base = addTrack(base, "text");
    let project = addClip(base, textTrackId(base), "t1", 5);
    project = addClip(project, videoTrackId(project), "v1", 0);

    const entries = templateClips(project);
    assert.deepEqual(
      entries.map((e) => e.asset.id),
      ["v1", "t1"],
      "ordered by timelineStart, not by track or insertion order"
    );
  });

  it("does NOT deduplicate a source shared by two clips — unlike templateVideoAssets, a filmstrip shows every instance", () => {
    const base = emptyProject([videoAsset("v1", 10)]);
    let project = addClip(base, videoTrackId(base), "v1", 0);
    project = addClip(project, videoTrackId(project), "v1", 5);
    assert.equal(templateClips(project).length, 2);
  });

  it("excludes audio — a template's music is a single global track, not a per-clip filmstrip entry", () => {
    const base = emptyProject([videoAsset("v1", 5), audioAsset("music", 10)]);
    let project = addClip(base, videoTrackId(base), "v1", 0);
    project = addClip(project, audioTrackId(project), "music", 0);

    const entries = templateClips(project);
    assert.equal(entries.length, 1);
    assert.equal(entries[0].asset.kind, "video");
  });

  it("returns [] for a project with no video/text content", () => {
    const base = emptyProject([audioAsset()]);
    const project = addClip(base, audioTrackId(base), "music", 0);
    assert.deepEqual(templateClips(project), []);
  });
});

describe("setTemplateClipText", () => {
  it("updates a text asset's own content", () => {
    let base = emptyProject([textAsset("t1", "Old text")]);
    base = addTrack(base, "text");
    const project = addClip(base, textTrackId(base), "t1", 0);

    const updated = setTemplateClipText(project, "t1", "New text");
    assert.equal(updated.assets.find((a) => a.id === "t1")?.textContent, "New text");
  });

  it("updates every clip sharing the same text asset (a duplicated text clip)", () => {
    let base = emptyProject([textAsset("t1", "Old text")]);
    base = addTrack(base, "text");
    let project = addClip(base, textTrackId(base), "t1", 0);
    project = addClip(project, textTrackId(project), "t1", 5);

    const updated = setTemplateClipText(project, "t1", "New text");
    const [clipA, clipB] = clipsOf(updated, textTrackId(updated));
    assert.equal(updated.assets.find((a) => a.id === clipA.assetId)?.textContent, "New text");
    assert.equal(updated.assets.find((a) => a.id === clipB.assetId)?.textContent, "New text");
  });

  it("is a no-op when the given id isn't a text asset", () => {
    const base = emptyProject([videoAsset("v1")]);
    const project = addClip(base, videoTrackId(base), "v1", 0);
    const untouched = setTemplateClipText(project, "v1", "New text");
    assert.deepEqual(untouched, project);
  });

  it("is a no-op when the given id doesn't exist at all", () => {
    const base = emptyProject([videoAsset("v1")]);
    const project = addClip(base, videoTrackId(base), "v1", 0);
    const untouched = setTemplateClipText(project, "nonexistent-id", "New text");
    assert.deepEqual(untouched, project);
  });
});
