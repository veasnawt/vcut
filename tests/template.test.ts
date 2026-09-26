import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  fillTemplateSlot,
  buildProjectFromTemplate,
  instantiateTemplateContent,
  matchingTemplateAiClipIds,
  pendingTemplateAiTasks,
  sanitizeProjectForTemplate,
  setTemplateClipText,
  templateAudioAssets,
  templateClips,
  templateGroupClips,
  templateGroupItems,
  templateSlotCandidates,
  templateSlotRequiredLength,
  templateSlots,
  templateVideoAssets,
  trimTemplateSlot,
} from "../src/project/template.ts";
import { withAiOrigin } from "../src/project/aiRecipe.ts";
import { InsertTemplateCommand, MoveTemplateGroupCommand, RemoveTemplateGroupCommand, ReplaceTemplateClipCommand } from "../src/commands/index.ts";
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

describe("templateSlotCandidates / keepAssetIds", () => {
  it("lists every video/image clip that would become a slot, in timeline order, one entry per shared asset", () => {
    let base = emptyProject([videoAsset("v2", 5), audioAsset("a1"), videoAsset("v1"), colorAsset(), textAsset()]);
    base = addTrack(base, "text");
    let project = addClip(base, videoTrackId(base), "v1", 20); // starts last
    project = addClip(project, videoTrackId(project), "v2", 0); // starts first
    project = addClip(project, videoTrackId(project), "v2", 6); // second use of the SAME asset
    project = addClip(project, audioTrackId(project), "a1", 0);
    project = addClip(project, videoTrackId(project), "color1", 12);
    project = addClip(project, textTrackId(project), "text1", 0);

    const candidates = templateSlotCandidates(project);

    // v2 (used twice) is one candidate, in FIRST-USE order — v2 before v1 — never audio/color/text.
    assert.deepEqual(candidates.map((c) => c.asset.id), ["v2", "v1"]);
    // requiredDuration is the LONGEST of every clip sharing that asset.
    const v2 = candidates.find((c) => c.asset.id === "v2")!;
    assert.equal(v2.requiredDuration, 5);
  });

  it("keeps a chosen candidate fixed (bundled, no placeholder) instead of turning it into a slot", () => {
    const base = emptyProject([videoAsset("v1"), videoAsset("v2", 5)]);
    let project = addClip(base, videoTrackId(base), "v1", 0);
    project = addClip(project, videoTrackId(project), "v2", 10);

    const template = sanitizeProjectForTemplate(project, new Set(["v1"]));

    assert.equal(templateSlots(buildProjectFromTemplate("bp-keep", "Keep", template)).length, 1);
    const kept = template.assets.find((a) => a.id === "v1")!;
    assert.equal(kept.templatePlaceholder, undefined);
    assert.equal(kept.templateBundledAudio, true);
    assert.equal(kept.relPath, "v1.mp4", "kept asset's real relPath survives, same as bundled audio");
    // v2 (not in keepAssetIds) still becomes a normal, fillable placeholder.
    const v2Slot = template.assets.find((a) => a.templatePlaceholder);
    assert.ok(v2Slot);
    assert.notEqual(v2Slot!.id, "v2");
    // The CLIP itself is tagged too — unlike the asset-level flag (stripped once the real file is
    // copied into a new project), this is what survives to tell a locked clip apart from a real slot
    // once it's actually been inserted somewhere (`TemplateGroupPanel.tsx`'s own doc comment).
    const keptClip = template.tracks.flatMap((t) => t.clips).find((c) => c.assetId === "v1")!;
    assert.equal(keptClip.templateLocked, true);
    const slotClip = template.tracks.flatMap((t) => t.clips).find((c) => c.assetId === v2Slot!.id)!;
    assert.equal(slotClip.templateLocked, undefined);
  });

  it("never locks a kept AUDIO clip — background music/voiceover stays replaceable regardless", () => {
    const base = emptyProject([audioAsset("music")]);
    const project = addClip(base, audioTrackId(base), "music", 0);

    const template = sanitizeProjectForTemplate(project);

    const clip = template.tracks.flatMap((t) => t.clips).find((c) => c.assetId === "music")!;
    assert.equal(clip.templateLocked, undefined);
  });

  it("keeping every candidate leaves a template with zero fillable slots", () => {
    const base = emptyProject([videoAsset("v1"), imageAsset("img1")]);
    let project = addClip(base, videoTrackId(base), "v1", 0);
    project = addClip(project, videoTrackId(project), "img1", 10);

    const template = sanitizeProjectForTemplate(project, new Set(["v1", "img1"]));

    assert.equal(template.assets.some((a) => a.templatePlaceholder), false);
    assert.equal(templateSlots(buildProjectFromTemplate("bp-keep-all", "Keep All", template)).length, 0);
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

describe("instantiateTemplateContent", () => {
  it("is what buildProjectFromTemplate is built on: offset 0 gives identical tracks/assets", () => {
    let base = emptyProject([colorAsset(), textAsset()]);
    base = addTrack(base, "text");
    let project = addClip(base, videoTrackId(base), "color1", 0);
    project = addClip(project, textTrackId(project), "text1", 2);
    const template = sanitizeProjectForTemplate(project);

    const built = buildProjectFromTemplate("bp-compare", "Compare", template);
    const { assets, tracks } = instantiateTemplateContent(template);

    assert.deepEqual(
      tracks.map((t) => ({ kind: t.kind, clips: t.clips.map((c) => c.timelineStart) })),
      built.sequence.tracks.map((t) => ({ kind: t.kind, clips: t.clips.map((c) => c.timelineStart) }))
    );
    assert.equal(assets.length, built.assets.length);
  });

  it("shifts every clip's timelineStart by offsetSeconds, on every track", () => {
    let base = emptyProject([videoAsset(), textAsset()]);
    base = addTrack(base, "text");
    let project = addClip(base, videoTrackId(base), "asset1", 0);
    project = addClip(project, textTrackId(project), "text1", 3);
    const template = sanitizeProjectForTemplate(project);

    const { tracks } = instantiateTemplateContent(template, 10);

    const videoTrack = tracks.find((t) => t.kind === "video" && t.clips.length > 0)!;
    const textTrack = tracks.find((t) => t.kind === "text")!;
    assert.equal(videoTrack.clips[0].timelineStart, 10);
    assert.equal(textTrack.clips[0].timelineStart, 13);
  });

  it("never lets a clip land before 0, even with a large negative offset", () => {
    const base = emptyProject([videoAsset()]);
    const project = addClip(base, videoTrackId(base), "asset1", 5);
    const template = sanitizeProjectForTemplate(project);

    const { tracks } = instantiateTemplateContent(template, -100);

    const videoTrack = tracks.find((t) => t.clips.length > 0)!;
    assert.equal(videoTrack.clips[0].timelineStart, 0);
  });

  it("re-mints every id fresh on each call, so two instantiations of the same template never collide", () => {
    const base = emptyProject([videoAsset()]);
    const project = addClip(base, videoTrackId(base), "asset1", 0);
    const template = sanitizeProjectForTemplate(project);

    const first = instantiateTemplateContent(template);
    const second = instantiateTemplateContent(template);

    assert.notEqual(first.assets[0].id, second.assets[0].id);
    assert.notEqual(first.tracks[0].id, second.tracks[0].id);
    const firstClip = first.tracks.flatMap((t) => t.clips)[0];
    const secondClip = second.tracks.flatMap((t) => t.clips)[0];
    assert.notEqual(firstClip.id, secondClip.id);
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

describe("InsertTemplateCommand", () => {
  it("merges the resolved template's tracks/assets after the project's own, offset to the given point", () => {
    let base = emptyProject([videoAsset("existing")]);
    let project = addClip(base, videoTrackId(base), "existing", 0);
    const originalTrackCount = project.sequence.tracks.length;
    const originalAssetCount = project.assets.length;

    const templateBase = emptyProject([videoAsset("tpl")]);
    const templateProject = addClip(templateBase, videoTrackId(templateBase), "tpl", 0);
    const resolved = sanitizeProjectForTemplate(templateProject);

    const command = new InsertTemplateCommand(resolved, 20, "Test Template");
    const result = command.apply(project);

    assert.equal(result.sequence.tracks.length, originalTrackCount + resolved.tracks.length);
    assert.equal(result.assets.length, originalAssetCount + resolved.assets.length);
    // Appended, not interleaved — the pre-existing track (and its clip) is exactly where it was.
    assert.equal(clipsOf(result, videoTrackId(result))[0].timelineStart, 0);
    // The inserted content lands at the given offset, on a brand-new track.
    const insertedTrack = result.sequence.tracks.find((t) => command.createdTrackIds.includes(t.id))!;
    assert.equal(insertedTrack.clips[0].timelineStart, 20);
  });

  it("undoes back to the exact project it started from", () => {
    const base = emptyProject([videoAsset("existing")]);
    const project = addClip(base, videoTrackId(base), "existing", 0);
    const templateBase = emptyProject([videoAsset("tpl")]);
    const templateProject = addClip(templateBase, videoTrackId(templateBase), "tpl", 0);
    const resolved = sanitizeProjectForTemplate(templateProject);

    const command = new InsertTemplateCommand(resolved, 0, "Test Template");
    command.apply(project);

    assert.deepEqual(command.revert(), project);
  });

  it("throws a clear error if undone before ever being applied", () => {
    const templateBase = emptyProject([videoAsset("tpl")]);
    const templateProject = addClip(templateBase, videoTrackId(templateBase), "tpl", 0);
    const resolved = sanitizeProjectForTemplate(templateProject);
    const command = new InsertTemplateCommand(resolved, 0, "Test Template");
    assert.throws(() => command.revert(), /never applied/);
  });

  it("tags every track it creates with the same templateGroup, carrying the template's own name", () => {
    let templateBase = emptyProject([videoAsset("tpl"), textAsset()]);
    templateBase = addTrack(templateBase, "text");
    let templateProject = addClip(templateBase, videoTrackId(templateBase), "tpl", 0);
    templateProject = addClip(templateProject, textTrackId(templateProject), "text1", 0);
    const resolved = sanitizeProjectForTemplate(templateProject);

    const project = emptyProject([videoAsset("existing")]);
    const command = new InsertTemplateCommand(resolved, 0, "My Template");
    const result = command.apply(project);

    const insertedTracks = result.sequence.tracks.filter((t) => command.createdTrackIds.includes(t.id));
    assert.ok(insertedTracks.length >= 2, "expected at least the video and text tracks to be inserted");
    const groupIds = new Set(insertedTracks.map((t) => t.templateGroup?.id));
    assert.equal(groupIds.size, 1, "every inserted track should share one group id");
    for (const track of insertedTracks) assert.equal(track.templateGroup?.name, "My Template");
    // The pre-existing track is never tagged — only what THIS insert created.
    const untouchedTrack = result.sequence.tracks.find((t) => !command.createdTrackIds.includes(t.id))!;
    assert.equal(untouchedTrack.templateGroup, undefined);
  });

  it("mints a fresh group id each time the same template is inserted again", () => {
    const templateBase = emptyProject([videoAsset("tpl")]);
    const templateProject = addClip(templateBase, videoTrackId(templateBase), "tpl", 0);
    const resolved = sanitizeProjectForTemplate(templateProject);
    const project = emptyProject([videoAsset("existing")]);

    const first = new InsertTemplateCommand(resolved, 0, "My Template");
    const afterFirst = first.apply(project);
    const second = new InsertTemplateCommand(resolved, 5, "My Template");
    const afterSecond = second.apply(afterFirst);

    const firstGroupId = afterSecond.sequence.tracks.find((t) => first.createdTrackIds.includes(t.id))!.templateGroup!.id;
    const secondGroupId = afterSecond.sequence.tracks.find((t) => second.createdTrackIds.includes(t.id))!.templateGroup!.id;
    assert.notEqual(firstGroupId, secondGroupId);
  });
});

describe("InsertTemplateCommand + pending AI steps", () => {
  it("carries a clip's templateAiSteps through onto its fresh id, so pendingTemplateAiTasks sees it on the live project once its slot is filled", () => {
    // "aiResult" is what the template's own author actually filmed with — the OUTPUT of a cutout run on
    // "original". `sanitizeProjectForTemplate` slots the ORIGINAL footage, not the AI result, and tags
    // the clip with the step needed to reproduce it (see that function's own doc comment).
    const original = videoAsset("original", 8);
    const aiResult = withAiOrigin(videoAsset("aiResult", 5), "original", { tool: "cutout" });
    let templateProject = emptyProject([original, aiResult]);
    templateProject = addClip(templateProject, videoTrackId(templateProject), "aiResult", 0);
    const resolved = sanitizeProjectForTemplate(templateProject);

    // Fill the one open slot with the user's own real media, exactly as `ImportTemplateDialog.tsx`'s
    // fill step does on its own scratch draft — `templateAiSteps` is untouched by this.
    const built = buildProjectFromTemplate("draft", "My Template", resolved);
    const slot = templateSlots(built)[0];
    const usersPick = videoAsset("users-pick", 10);
    const filled = fillTemplateSlot(built, slot.assetId, usersPick);

    const liveProject = emptyProject([videoAsset("existing")]);
    const command = new InsertTemplateCommand(
      { width: filled.sequence.width, height: filled.sequence.height, fps: filled.sequence.fps, tracks: filled.sequence.tracks, assets: filled.assets },
      0,
      "My Template"
    );
    const result = command.apply(liveProject);

    const tasks = pendingTemplateAiTasks(result);
    assert.equal(tasks.length, 1);
    assert.equal(tasks[0].step.tool, "cutout");
    assert.equal(tasks[0].assetName, "users-pick.mp4");
    const insertedClip = result.sequence.tracks.find((t) => command.createdTrackIds.includes(t.id))!.clips[0];
    assert.equal(tasks[0].clipId, insertedClip.id);
  });
});

describe("pendingTemplateAiTasks / matchingTemplateAiClipIds", () => {
  it("dedupes many clips sharing the exact same filled asset+step+window into one task — a real, reported bug: a picked photo used for a dozen-plus stacked \"AI Edit\" clips used to run and re-bill the identical edit once per clip", () => {
    const original = imageAsset("original");
    const aiResult = withAiOrigin(imageAsset("aiResult"), "original", { tool: "ai-edit", prompt: "make it pop" });
    let templateProject = emptyProject([original, aiResult]);
    for (let i = 0; i < 5; i++) templateProject = addClip(templateProject, videoTrackId(templateProject), "aiResult", i * 3);
    // `addClip`'s own overlap-carving would otherwise unevenly truncate whichever clips landed close
    // enough together to collide — normalize every clip to the identical window explicitly so this test
    // exercises exactly "five true duplicates," not an accidental side effect of clip spacing.
    const trackId = videoTrackId(templateProject);
    templateProject = {
      ...templateProject,
      sequence: {
        ...templateProject.sequence,
        tracks: templateProject.sequence.tracks.map((t) => (t.id === trackId ? { ...t, clips: t.clips.map((c) => ({ ...c, sourceIn: 0, sourceOut: 2 })) } : t)),
      },
    };
    const resolved = sanitizeProjectForTemplate(templateProject);

    const built = buildProjectFromTemplate("draft", "Stacked", resolved);
    const slot = templateSlots(built)[0];
    const filled = fillTemplateSlot(built, slot.assetId, imageAsset("users-pick"));

    const tasks = pendingTemplateAiTasks(filled);
    assert.equal(tasks.length, 1, "five identical duplicates should collapse into one task");
    assert.equal(tasks[0].affectedClipIds.length, 5);

    const matched = matchingTemplateAiClipIds(filled, tasks[0].clipId);
    assert.deepEqual(new Set(matched), new Set(tasks[0].affectedClipIds));
  });

  it("does not merge two VIDEO clips sharing a slot but trimmed to different lengths — a genuinely different edit each", () => {
    const original = videoAsset("original", 20);
    const aiResult = withAiOrigin(videoAsset("aiResult", 20), "original", { tool: "cutout" });
    let templateProject = emptyProject([original, aiResult]);
    templateProject = addClip(templateProject, videoTrackId(templateProject), "aiResult", 0);
    templateProject = addClip(templateProject, videoTrackId(templateProject), "aiResult", 10);
    // Same shared slot (`templateSlotCandidates`' own "different trims, one slot" grouping), but
    // different trim LENGTHS — `fillTemplateSlot` gives each its own correctly-sized window off the
    // real pick, so after filling they still don't actually match and must stay separate tasks.
    const trackId = videoTrackId(templateProject);
    templateProject = {
      ...templateProject,
      sequence: {
        ...templateProject.sequence,
        tracks: templateProject.sequence.tracks.map((t) =>
          t.id === trackId ? { ...t, clips: t.clips.map((c, i) => (i === 0 ? { ...c, sourceIn: 0, sourceOut: 3 } : { ...c, sourceIn: 0, sourceOut: 6 })) } : t
        ),
      },
    };
    const resolved = sanitizeProjectForTemplate(templateProject);

    const built = buildProjectFromTemplate("draft", "Different lengths", resolved);
    const slot = templateSlots(built)[0];
    const filled = fillTemplateSlot(built, slot.assetId, videoAsset("users-pick", 20));

    const tasks = pendingTemplateAiTasks(filled);
    assert.equal(tasks.length, 2, "different trim lengths must stay separate tasks");
  });

  it("DOES merge two IMAGE clips sharing a slot even when trimmed to different lengths — a still has no 'which frames' to disagree about", () => {
    // The exact real-world shape reported: the same AI-edited photo trimmed to several different
    // lengths across its stacked copies (a "hold longer here, shorter there" template effect) kept
    // listing one task per distinct length even after the first version of this dedup fix, since that
    // version's key still included the window for every asset kind, not just video.
    const original = imageAsset("original");
    const aiResult = withAiOrigin(imageAsset("aiResult"), "original", { tool: "ai-edit", prompt: "make it pop" });
    let templateProject = emptyProject([original, aiResult]);
    templateProject = addClip(templateProject, videoTrackId(templateProject), "aiResult", 0);
    templateProject = addClip(templateProject, videoTrackId(templateProject), "aiResult", 10);
    const trackId = videoTrackId(templateProject);
    templateProject = {
      ...templateProject,
      sequence: {
        ...templateProject.sequence,
        tracks: templateProject.sequence.tracks.map((t) =>
          t.id === trackId ? { ...t, clips: t.clips.map((c, i) => (i === 0 ? { ...c, sourceIn: 0, sourceOut: 3 } : { ...c, sourceIn: 0, sourceOut: 6 })) } : t
        ),
      },
    };
    const resolved = sanitizeProjectForTemplate(templateProject);

    const built = buildProjectFromTemplate("draft", "Different lengths, same still", resolved);
    const slot = templateSlots(built)[0];
    const filled = fillTemplateSlot(built, slot.assetId, imageAsset("users-pick"));

    const tasks = pendingTemplateAiTasks(filled);
    assert.equal(tasks.length, 1, "an image's own trim length never changes what the edit does — must collapse to one task");
    assert.equal(tasks[0].affectedClipIds.length, 2);
  });
});

describe("templateGroupItems", () => {
  it("groups footage clips sharing the same asset into one row, but keeps text clips as separate rows", () => {
    // The exact real-world shape reported: a template using one stacked/duplicated picture across many
    // clips listed one "Replace" row per CLIP in the panel — 44 identical-looking rows for one picture.
    const project = emptyProject([videoAsset("existing")]);
    let templateBase = emptyProject([imageAsset("pic"), textAsset()]);
    templateBase = addTrack(templateBase, "text");
    let templateProject = addClip(templateBase, videoTrackId(templateBase), "pic", 0);
    templateProject = addClip(templateProject, videoTrackId(templateProject), "pic", 2);
    templateProject = addClip(templateProject, videoTrackId(templateProject), "pic", 4);
    templateProject = addClip(templateProject, textTrackId(templateProject), "text1", 0);
    templateProject = addClip(templateProject, textTrackId(templateProject), "text1", 2);
    const resolved = sanitizeProjectForTemplate(templateProject);
    const insert = new InsertTemplateCommand(resolved, 0, "My Template");
    const afterInsert = insert.apply(project);
    const groupId = afterInsert.sequence.tracks.find((t) => insert.createdTrackIds.includes(t.id))!.templateGroup!.id;

    // The raw, ungrouped list still reports the true clip count (3 image + 2 text = 5).
    assert.equal(templateGroupClips(afterInsert, groupId).length, 5);

    const items = templateGroupItems(afterInsert, groupId);
    // The 3 duplicated image clips collapse to ONE row; the 2 text clips stay as 2 separate rows —
    // 1 + 2 = 3 rows total, not 5.
    assert.equal(items.length, 3);
    const imageItem = items.find((i) => i.asset.kind === "image")!;
    assert.equal(imageItem.clipIds.length, 3);
    const textItems = items.filter((i) => i.asset.kind === "text");
    assert.equal(textItems.length, 2);
    assert.ok(textItems.every((i) => i.clipIds.length === 1));
  });

  it("is empty once the group's tracks are gone, same as templateGroupClips", () => {
    const project = emptyProject([videoAsset("existing")]);
    assert.deepEqual(templateGroupItems(project, "tplgroup_nonexistent"), []);
  });
});

describe("ReplaceTemplateClipCommand", () => {
  it("keeps the clip's own trim window length, shrinking to fit a shorter replacement", () => {
    const base = emptyProject([videoAsset("v1", 10)]);
    let project = addClip(base, videoTrackId(base), "v1", 0);
    const trackId = videoTrackId(project);
    const clipId = clipsOf(project, trackId)[0].id;
    project = {
      ...project,
      sequence: {
        ...project.sequence,
        tracks: project.sequence.tracks.map((t) => (t.id === trackId ? { ...t, clips: t.clips.map((c) => ({ ...c, sourceIn: 0, sourceOut: 3 })) } : t)),
      },
    };

    // A longer replacement keeps the original 3s window rather than growing to fill the new asset.
    const longer = videoAsset("v2", 20);
    const withLonger = new ReplaceTemplateClipCommand(clipId, longer).apply({ ...project, assets: [...project.assets, longer] });
    const clipAfterLonger = clipsOf(withLonger, trackId)[0];
    assert.equal(clipAfterLonger.assetId, "v2");
    assert.equal(clipAfterLonger.sourceOut - clipAfterLonger.sourceIn, 3);

    // A SHORTER replacement shrinks the window to fit rather than running past the new asset's end.
    const shorter = videoAsset("v3", 2);
    const withShorter = new ReplaceTemplateClipCommand(clipId, shorter).apply({ ...project, assets: [...project.assets, shorter] });
    const clipAfterShorter = clipsOf(withShorter, trackId)[0];
    assert.equal(clipAfterShorter.assetId, "v3");
    assert.equal(clipAfterShorter.sourceOut - clipAfterShorter.sourceIn, 2);
  });

  it("undoes back to the exact project it started from", () => {
    const base = emptyProject([videoAsset("v1", 10)]);
    const project = addClip(base, videoTrackId(base), "v1", 0);
    const clipId = clipsOf(project, videoTrackId(project))[0].id;
    const replacement = videoAsset("v2", 5);

    const command = new ReplaceTemplateClipCommand(clipId, replacement);
    command.apply({ ...project, assets: [...project.assets, replacement] });

    assert.deepEqual(command.revert(), { ...project, assets: [...project.assets, replacement] });
  });

  it("throws a clear error if the clip no longer exists", () => {
    const base = emptyProject([videoAsset("v1", 10)]);
    const project = addClip(base, videoTrackId(base), "v1", 0);
    const command = new ReplaceTemplateClipCommand("nonexistent-clip", videoAsset("v2", 5));
    assert.throws(() => command.apply(project), /no longer exists/);
  });

  it("throws a clear error if undone before ever being applied", () => {
    const command = new ReplaceTemplateClipCommand("clip1", videoAsset("v2", 5));
    assert.throws(() => command.revert(), /never applied/);
  });
});

describe("RemoveTemplateGroupCommand", () => {
  it("removes every track sharing the given group id, leaving other tracks untouched", () => {
    const project = emptyProject([videoAsset("existing")]);
    const templateBase = emptyProject([videoAsset("tpl"), textAsset()]);
    let templateProject = addTrack(templateBase, "text");
    templateProject = addClip(templateProject, videoTrackId(templateProject), "tpl", 0);
    templateProject = addClip(templateProject, textTrackId(templateProject), "text1", 0);
    const resolved = sanitizeProjectForTemplate(templateProject);

    const insert = new InsertTemplateCommand(resolved, 0, "My Template");
    const afterInsert = insert.apply(project);
    const groupId = afterInsert.sequence.tracks.find((t) => insert.createdTrackIds.includes(t.id))!.templateGroup!.id;
    const originalTrackCount = afterInsert.sequence.tracks.length;

    const remove = new RemoveTemplateGroupCommand(groupId);
    const result = remove.apply(afterInsert);

    assert.equal(result.sequence.tracks.length, originalTrackCount - insert.createdTrackIds.length);
    assert.ok(result.sequence.tracks.every((t) => t.templateGroup?.id !== groupId));
    // The project's own pre-existing track survives untouched.
    assert.ok(result.sequence.tracks.some((t) => t.id === videoTrackId(project)));
  });

  it("is a harmless no-op when the group is already gone", () => {
    const project = emptyProject([videoAsset("existing")]);
    const result = new RemoveTemplateGroupCommand("tplgroup_nonexistent").apply(project);
    assert.deepEqual(result.sequence.tracks, project.sequence.tracks);
  });

  it("undoes back to the exact project it started from", () => {
    const project = emptyProject([videoAsset("existing")]);
    const templateBase = emptyProject([videoAsset("tpl")]);
    const templateProject = addClip(templateBase, videoTrackId(templateBase), "tpl", 0);
    const resolved = sanitizeProjectForTemplate(templateProject);
    const insert = new InsertTemplateCommand(resolved, 0, "My Template");
    const afterInsert = insert.apply(project);
    const groupId = afterInsert.sequence.tracks.find((t) => insert.createdTrackIds.includes(t.id))!.templateGroup!.id;

    const command = new RemoveTemplateGroupCommand(groupId);
    command.apply(afterInsert);

    assert.deepEqual(command.revert(), afterInsert);
  });

  it("throws a clear error if undone before ever being applied", () => {
    const command = new RemoveTemplateGroupCommand("tplgroup_1");
    assert.throws(() => command.revert(), /never applied/);
  });
});

describe("MoveTemplateGroupCommand", () => {
  function insertedGroup() {
    const project = emptyProject([videoAsset("existing")]);
    let templateBase = emptyProject([videoAsset("tpl"), textAsset()]);
    templateBase = addTrack(templateBase, "text");
    let templateProject = addClip(templateBase, videoTrackId(templateBase), "tpl", 0);
    templateProject = addClip(templateProject, textTrackId(templateProject), "text1", 3);
    const resolved = sanitizeProjectForTemplate(templateProject);
    const insert = new InsertTemplateCommand(resolved, 5, "My Template");
    const afterInsert = insert.apply(project);
    const groupId = afterInsert.sequence.tracks.find((t) => insert.createdTrackIds.includes(t.id))!.templateGroup!.id;
    return { afterInsert, groupId, insert };
  }

  it("shifts every clip on every track in the group by the same delta, preserving their relative timing", () => {
    const { afterInsert, groupId, insert } = insertedGroup();
    const before = afterInsert.sequence.tracks
      .filter((t) => insert.createdTrackIds.includes(t.id))
      .flatMap((t) => t.clips)
      .map((c) => c.timelineStart)
      .sort((a, b) => a - b);

    const result = new MoveTemplateGroupCommand(groupId, 2).apply(afterInsert);

    const after = result.sequence.tracks
      .filter((t) => insert.createdTrackIds.includes(t.id))
      .flatMap((t) => t.clips)
      .map((c) => c.timelineStart)
      .sort((a, b) => a - b);
    assert.deepEqual(after, before.map((s) => s + 2));
    // A track outside the group is never touched.
    const untouched = result.sequence.tracks.find((t) => !insert.createdTrackIds.includes(t.id))!;
    assert.deepEqual(untouched.clips, afterInsert.sequence.tracks.find((t) => t.id === untouched.id)!.clips);
  });

  it("clamps a move so the group's own earliest clip never goes negative", () => {
    const { afterInsert, groupId } = insertedGroup();
    // The group's own earliest clip sits at 5 (the insert offset) — shifting by -100 must clamp to
    // exactly -5, not drag the group into negative time.
    const result = new MoveTemplateGroupCommand(groupId, -100).apply(afterInsert);
    const earliest = Math.min(...result.sequence.tracks.flatMap((t) => t.clips).map((c) => c.timelineStart));
    assert.equal(earliest, 0);
  });

  it("is a no-op when the group doesn't exist", () => {
    const project = emptyProject([videoAsset("existing")]);
    const result = new MoveTemplateGroupCommand("tplgroup_nonexistent", 5).apply(project);
    assert.deepEqual(result, project);
  });

  it("undoes back to the exact project it started from", () => {
    const { afterInsert, groupId } = insertedGroup();
    const command = new MoveTemplateGroupCommand(groupId, 3);
    command.apply(afterInsert);
    assert.deepEqual(command.revert(), afterInsert);
  });

  it("throws a clear error if undone before ever being applied", () => {
    const command = new MoveTemplateGroupCommand("tplgroup_1", 1);
    assert.throws(() => command.revert(), /never applied/);
  });
});
