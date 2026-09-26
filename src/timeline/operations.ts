import { clipDuration, clipEnd, createClip, createTextAsset, findAsset, findClip, findTrack, newId } from "../project/createProject.ts";
import type { ClipOutline, ChromaKeySettings, Asset, Clip, ClipBlendMode, ClipEffects, ClipMask, ClipTransform, ColorCurve, ColorGrading, CoverSelection, Project, SpeedCurvePoint, TextCrop, TextStyle, Track, TrackKind } from "../project/types.ts";
import { CLIP_BLEND_MODES, DEFAULT_TEXT_STYLE, IMAGE_DEFAULT_DURATION, isIdentityColorGrading, isIdentityEffects, isIdentityTextCrop, isIdentityTransform, TEXT_DEFAULT_DURATION } from "../project/types.ts";
import { frameDuration, snapToFrame } from "./time.ts";
import { normalizeLutIntensity } from "./lut.ts";
import { clampClipSpeed, clipProgressAtElapsed, clipSourceTimeAtElapsed, normalizedSpeedCurve, sliceSpeedCurve } from "./clipTiming.ts";

/** Every operation here is PURE: it takes a project and returns a NEW project, never mutating the
 *  input. That's what lets the undo stack keep a previous project value and restore it exactly, and
 *  what lets React see a changed reference and re-render.
 *
 *  Implemented as "structuredClone, then mutate the clone" rather than nested spread objects. The
 *  model is plain serializable data (see project/types.ts), so the clone is both correct and cheap at
 *  project scale, and the resulting code reads like the edit it performs instead of like a pile of
 *  object-spread plumbing. */
function edit(project: Project, mutate: (draft: Project) => void): Project {
  const draft = structuredClone(project);
  mutate(draft);
  draft.updatedAt = Date.now();
  return draft;
}

/** Thrown when an operation can't be performed as asked (clip not found, split outside the clip,
 *  trim that would leave nothing). Callers turn this into a status message; nothing is mutated. */
export class EditError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "EditError";
  }
}

function sortClips(track: Track): void {
  track.clips.sort((a, b) => a.timelineStart - b.timelineStart);
}

/** Returns the part of `clip` visible between two clip-relative TIMELINE times. This is shared by
 * overwrite edits so a retimed/reversed clip is cut through the same timeline-to-source mapping as
 * preview and export, rather than treating one timeline second as one source second. */
function clipTimelineWindow(
  clip: Clip,
  fromElapsed: number,
  toElapsed: number,
  timelineStart: number,
  id = clip.id
): Clip {
  const duration = clipDuration(clip);
  const from = Math.min(duration, Math.max(0, fromElapsed));
  const to = Math.min(duration, Math.max(from, toElapsed));
  const fromProgress = clipProgressAtElapsed(clip, from);
  const toProgress = clipProgressAtElapsed(clip, to);
  const fromSource = clipSourceTimeAtElapsed(clip, from);
  const toSource = clipSourceTimeAtElapsed(clip, to);
  const next: Clip = {
    ...structuredClone(clip),
    id,
    sourceIn: clip.reverse ? toSource : fromSource,
    sourceOut: clip.reverse ? fromSource : toSource,
    timelineStart,
  };

  const curve = sliceSpeedCurve(clip.speedCurve, fromProgress, toProgress);
  if (curve) next.speedCurve = curve;
  else delete next.speedCurve;

  for (const key of ["transformKeyframes", "effectsKeyframes", "colorGradingKeyframes", "gainKeyframes"] as const) {
    const frames = clip[key];
    if (!frames) continue;
    const selected = frames
      .filter((frame) => frame.time >= from - 1e-6 && frame.time <= to + 1e-6)
      .map((frame) => ({ ...structuredClone(frame), time: Math.min(to - from, Math.max(0, frame.time - from)) }));
    if (selected.length) (next as any)[key] = selected;
    else delete (next as any)[key];
  }

  if (from > 1e-6) delete next.transitionIn;
  if (to < duration - 1e-6) delete next.transitionOut;
  return next;
}

/** Carves `[start, end)` out of every clip on `track` except `exceptClipId`. A clip fully covered is
 *  removed; one overlapped at an edge is trimmed; one straddling the range is split in two.
 *
 *  This is "overwrite" behavior — the incoming clip wins. Chosen over rippling everything sideways
 *  because it's what the creator sees themselves doing when they drag a clip somewhere: the thing
 *  they dragged ends up exactly where they dropped it, and nothing else silently moves.
 *
 *  `tailId` names the one clip this can create (the far side of a straddled clip). Callers that need
 *  redo to be reproducible pass a fixed id — see the note on `AddClipCommand.clipId`. Only ONE clip
 *  can ever straddle the range, because clips on a track never overlap each other, so a single id is
 *  always enough. */
function carveRange(
  track: Track,
  start: number,
  end: number,
  exceptClipId: string,
  fps: number,
  tailId?: string
): void {
  const result: Clip[] = [];
  for (const clip of track.clips) {
    if (clip.id === exceptClipId) {
      result.push(clip);
      continue;
    }
    const cStart = clip.timelineStart;
    const cEnd = clipEnd(clip);

    // No overlap at all.
    if (cEnd <= start || cStart >= end) {
      result.push(clip);
      continue;
    }
    // Fully covered — drop it.
    if (cStart >= start && cEnd <= end) continue;

    const min = frameDuration(fps);

    // Straddles the whole range: keep a head and a tail, which means splitting it in two.
    if (cStart < start && cEnd > end) {
      const headDur = start - cStart;
      const tailDur = cEnd - end;
      if (headDur >= min) {
        result.push(clipTimelineWindow(clip, 0, headDur, cStart));
      }
      if (tailDur >= min) {
        const tail = clipTimelineWindow(clip, end - cStart, cEnd - cStart, end, tailId ?? newId("c"));
        result.push(tail);
      }
      continue;
    }
    // Overlapped on its tail — keep the head.
    if (cStart < start) {
      const headDur = start - cStart;
      if (headDur >= min) result.push(clipTimelineWindow(clip, 0, headDur, cStart));
      continue;
    }
    // Overlapped on its head — keep the tail, which shifts its in-point into the source.
    const trimmed = end - cStart;
    if (cEnd - end >= min) {
      result.push(clipTimelineWindow(clip, trimmed, cEnd - cStart, end));
    }
  }
  track.clips = result;
  sortClips(track);
}

/** How long a newly-placed clip of this asset should be. Video/audio use their full length; a still
 *  image, a color-matte background, or a text clip has no intrinsic duration and gets a sensible
 *  default the user can then trim. */
export function defaultClipDuration(asset: Asset): number {
  if (asset.kind === "image" || asset.kind === "color") return IMAGE_DEFAULT_DURATION;
  if (asset.kind === "text") return TEXT_DEFAULT_DURATION;
  return asset.duration;
}

/** Which kind of track this asset belongs on. Images are visual, so they live on a video track
 *  alongside actual video; text has its own track kind (composited OVER the video track at both
 *  render sites — see PlaybackEngine and buildExportPlan — which a video track's single-layer model
 *  can't do); only audio-only media goes on an audio track. */
export function trackKindForAsset(asset: Asset): TrackKind {
  if (asset.kind === "audio") return "audio";
  if (asset.kind === "text") return "text";
  return "video";
}

export function addClip(
  project: Project,
  trackId: string,
  assetId: string,
  timelineStart: number,
  clipId?: string,
  carveTailId?: string
): Project {
  const asset = findAsset(project, assetId);
  if (!asset) throw new EditError("That media is no longer in the project");

  return edit(project, (draft) => {
    const track = findTrack(draft, trackId);
    if (!track) throw new EditError("That track no longer exists");
    if (track.locked) throw new EditError(`${track.name} is locked`);
    // Enforced here rather than only in the UI so every path into the model is covered — dropping
    // from the library, double-clicking an asset, and any future scripted edit all go through this.
    // `moveClip` has always had the equivalent check; without it here, an image could be dropped onto
    // an audio track and then simply never render.
    const wantedKind = trackKindForAsset(asset);
    if (track.kind !== wantedKind) {
      const describeAsset = wantedKind === "audio" ? "audio" : wantedKind === "text" ? "text" : "visual";
      throw new EditError(
        `"${asset.name}" is ${describeAsset} media — it belongs on a ${wantedKind} track, not ${track.name}`
      );
    }

    const fps = draft.sequence.fps;
    const start = snapToFrame(Math.max(0, timelineStart), fps);
    const duration = snapToFrame(defaultClipDuration(asset), fps);
    const clip = createClip({ assetId, sourceIn: 0, sourceOut: duration, timelineStart: start });
    // Preserving the id matters for undo/redo: redoing an add must recreate the SAME clip id, or any
    // later command that referenced it (a move, a trim) would no longer resolve.
    if (clipId) clip.id = clipId;

    carveRange(track, start, start + duration, clip.id, fps, carveTailId);
    track.clips.push(clip);
    sortClips(track);
  });
}

/** Splits the clip under `atTime` into two adjacent clips. The split must land strictly INSIDE the
 *  clip — splitting exactly on an edge would produce a zero-length clip, so it's rejected. */
export function splitClip(project: Project, clipId: string, atTime: number, newClipId?: string): Project {
  return edit(project, (draft) => {
    const found = findClip(draft, clipId);
    if (!found) throw new EditError("That clip no longer exists");
    const { track, clip } = found;
    if (track.locked) throw new EditError(`${track.name} is locked`);

    const fps = draft.sequence.fps;
    const at = snapToFrame(atTime, fps);
    const min = frameDuration(fps);

    if (at <= clip.timelineStart + min / 2 || at >= clipEnd(clip) - min / 2) {
      throw new EditError("Move the playhead inside the clip to split it");
    }

    const offsetIntoSource = at - clip.timelineStart;
    const progress = clipProgressAtElapsed(clip, offsetIntoSource);
    const splitSourceTime = clipSourceTimeAtElapsed(clip, offsetIntoSource);
    const originalSourceIn = clip.sourceIn;
    const originalSourceOut = clip.sourceOut;
    const originalCurve = clip.speedCurve;

    const tail: Clip = {
      ...structuredClone(clip),
      id: newClipId ?? newId("c"),
      sourceIn: clip.reverse ? originalSourceIn : splitSourceTime,
      sourceOut: clip.reverse ? splitSourceTime : originalSourceOut,
      timelineStart: at,
    };
    delete tail.transitionIn;

    // Both resulting pieces are the SAME original clip, just cut in two — a clip's own
    // Transform/Effects/animation/audio settings describe its CONTENT, not its position on the
    // timeline, so both halves keep them identically. Only `transitionOut` MOVES rather than copies:
    // it was describing the fade at the original clip's own END, which is now the tail's end, not the
    // (shortened) head's — leaving it on the head too would fade out mid-content at the cut, which is
    // never what splitting a clip means. `transitionIn` stays on the head only (unchanged — its own
    // start never moved) and is deliberately NOT given to the tail: a split creates an ordinary hard
    // cut between the two pieces, not a new crossfade neither side asked for.
    if (clip.transitionOut) {
      tail.transitionOut = clip.transitionOut;
      delete clip.transitionOut;
    }

    // Keyframe times are CLIP-WINDOW-relative (0 = this clip's own `timelineStart` — see
    // `Keyframe.time`'s own doc comment), so a straight copy would be wrong on both sides: the head
    // keeps its own `timelineStart`, so its keyframes stay valid as-is (just no longer reaching past
    // its new, shorter duration); the tail's `timelineStart` moved to `at`, so ITS keyframes need
    // re-basing by `offsetIntoSource` — the same value already computed above for the source-time cut.
    // Split AT a keyframe's own time keeps that keyframe on BOTH sides (at time 0 for the tail) so the
    // value is continuous right at the cut, rather than silently jumping.
    if (clip.transformKeyframes) {
      tail.transformKeyframes = clip.transformKeyframes
        .filter((k) => k.time >= offsetIntoSource)
        .map((k) => ({ ...k, time: k.time - offsetIntoSource }));
      clip.transformKeyframes = clip.transformKeyframes.filter((k) => k.time <= offsetIntoSource);
      if (clip.transformKeyframes.length === 0) delete clip.transformKeyframes;
      if (tail.transformKeyframes.length === 0) delete tail.transformKeyframes;
    }
    if (clip.effectsKeyframes) {
      tail.effectsKeyframes = clip.effectsKeyframes
        .filter((k) => k.time >= offsetIntoSource)
        .map((k) => ({ ...k, time: k.time - offsetIntoSource }));
      clip.effectsKeyframes = clip.effectsKeyframes.filter((k) => k.time <= offsetIntoSource);
      if (clip.effectsKeyframes.length === 0) delete clip.effectsKeyframes;
      if (tail.effectsKeyframes.length === 0) delete tail.effectsKeyframes;
    }

    if (clip.reverse) clip.sourceIn = splitSourceTime;
    else clip.sourceOut = splitSourceTime;
    const headCurve = sliceSpeedCurve(originalCurve, 0, progress);
    const tailCurve = sliceSpeedCurve(originalCurve, progress, 1);
    if (headCurve) clip.speedCurve = headCurve;
    else delete clip.speedCurve;
    if (tailCurve) tail.speedCurve = tailCurve;
    else delete tail.speedCurve;
    track.clips.push(tail);
    sortClips(track);
  });
}

/** Trims one edge of a clip to a new TIMELINE time.
 *
 *  Trimming the in-point moves both `timelineStart` and `sourceIn` together, so the visible frames
 *  stay locked to the media rather than sliding — that's the behavior every editor has and the one
 *  users expect. Trimming the out-point only moves `sourceOut`.
 *
 *  Both edges are clamped to the source's real extent and to a one-frame minimum, so a trim can
 *  never invent frames that don't exist or collapse a clip to nothing. */
export function trimClip(project: Project, clipId: string, edge: "in" | "out", toTime: number): Project {
  return edit(project, (draft) => {
    const found = findClip(draft, clipId);
    if (!found) throw new EditError("That clip no longer exists");
    const { track, clip } = found;
    if (track.locked) throw new EditError(`${track.name} is locked`);

    const fps = draft.sequence.fps;
    const min = frameDuration(fps);
    const asset = findAsset(draft, clip.assetId);
    // Images, color-matte backgrounds, and text have no fixed source length — there's no real file
    // position their sourceIn/sourceOut is actually indexing into, just a bookkeeping window whose
    // WIDTH is the only thing that matters, so neither edge has a genuine "ran out of source" limit
    // the way real media does.
    const hasFixedSourceLength = Boolean(asset) && asset!.kind !== "image" && asset!.kind !== "text" && asset!.kind !== "color";
    const sourceLimit = hasFixedSourceLength ? asset!.duration : Number.POSITIVE_INFINITY;
    const target = snapToFrame(toTime, fps);

    // Retimed video uses a nonlinear timeline-to-source mapping. Handle inward trims through that
    // shared mapping and re-normalize the surviving curve; the legacy arithmetic below remains the
    // exact identity-speed path.
    if (asset?.kind === "video" && (clip.reverse || clip.speedCurve || Math.abs((clip.speed ?? 1) - 1) > 1e-6)) {
      const oldDuration = clipDuration(clip);
      const trimKeyframes = (removed: number, nextDuration: number) => {
        for (const key of ["transformKeyframes", "effectsKeyframes", "colorGradingKeyframes", "gainKeyframes"] as const) {
          const frames = clip[key];
          if (!frames) continue;
          const next = frames
            .filter((frame) => frame.time >= removed - 1e-6 && frame.time <= removed + nextDuration + 1e-6)
            .map((frame) => ({ ...frame, time: Math.min(nextDuration, Math.max(0, frame.time - removed)) }));
          if (next.length) (clip as any)[key] = next;
          else delete (clip as any)[key];
        }
      };
      if (edge === "in") {
        const applied = Math.min(Math.max(target - clip.timelineStart, 0), oldDuration - min);
        const progress = clipProgressAtElapsed(clip, applied);
        const sourceAt = clipSourceTimeAtElapsed(clip, applied);
        const curve = sliceSpeedCurve(clip.speedCurve, progress, 1);
        if (clip.reverse) clip.sourceOut = sourceAt;
        else clip.sourceIn = sourceAt;
        if (curve) clip.speedCurve = curve;
        else delete clip.speedCurve;
        clip.timelineStart = snapToFrame(clip.timelineStart + applied, fps);
        trimKeyframes(applied, oldDuration - applied);
      } else {
        const desired = Math.min(oldDuration, Math.max(min, target - clip.timelineStart));
        const progress = clipProgressAtElapsed(clip, desired);
        const sourceAt = clipSourceTimeAtElapsed(clip, desired);
        const curve = sliceSpeedCurve(clip.speedCurve, 0, progress);
        if (clip.reverse) clip.sourceIn = sourceAt;
        else clip.sourceOut = sourceAt;
        if (curve) clip.speedCurve = curve;
        else delete clip.speedCurve;
        trimKeyframes(0, desired);
      }
      sortClips(track);
      return;
    }

    if (edge === "in") {
      const delta = target - clip.timelineStart;
      // Can't pull the in-point earlier than the start of the source media, nor later than one frame
      // before the out-point — the sourceIn floor only applies to real media (see
      // `hasFixedSourceLength`'s own comment just above); confirmed a real, reported bug otherwise:
      // an image/color/text clip's in-edge was silently unable to extend earlier than wherever it
      // happened to start, since `sourceIn` starts at exactly 0 for every newly-created clip and this
      // floor used to apply unconditionally, the one place in this function that DIDN'T already have
      // the same kind-based exemption `sourceLimit` above gives the out-edge.
      const minDelta = hasFixedSourceLength ? -clip.sourceIn : Number.NEGATIVE_INFINITY;
      const maxDelta = clipDuration(clip) - min;
      const applied = Math.min(Math.max(delta, minDelta), maxDelta);
      const newStart = clip.timelineStart + applied;
      if (newStart < 0) {
        // Dragging the in-point past time zero would push the clip off the front of the timeline.
        const corrected = applied - newStart;
        clip.sourceIn = clip.sourceIn + corrected;
        clip.timelineStart = 0;
        return;
      }
      clip.sourceIn = clip.sourceIn + applied;
      clip.timelineStart = snapToFrame(newStart, fps);
    } else {
      const desiredDuration = target - clip.timelineStart;
      const maxDuration = sourceLimit - clip.sourceIn;
      const duration = Math.min(Math.max(desiredDuration, min), maxDuration);
      clip.sourceOut = clip.sourceIn + duration;
    }
    sortClips(track);
  });
}

/** Moves a clip to a new position, optionally onto a different track of the same kind. Anything the
 *  clip lands on is overwritten (see `carveRange`). */
export function moveClip(
  project: Project,
  clipId: string,
  toTrackId: string,
  toStart: number,
  carveTailId?: string
): Project {
  return edit(project, (draft) => {
    const found = findClip(draft, clipId);
    if (!found) throw new EditError("That clip no longer exists");
    const { track: fromTrack, clip } = found;
    const toTrack = findTrack(draft, toTrackId);
    if (!toTrack) throw new EditError("That track no longer exists");
    if (fromTrack.locked) throw new EditError(`${fromTrack.name} is locked`);
    if (toTrack.locked) throw new EditError(`${toTrack.name} is locked`);
    if (fromTrack.kind !== toTrack.kind) {
      throw new EditError(`A ${fromTrack.kind} clip can't be moved to an ${toTrack.kind} track`);
    }

    const fps = draft.sequence.fps;
    const start = snapToFrame(Math.max(0, toStart), fps);
    const duration = clipDuration(clip);

    fromTrack.clips = fromTrack.clips.filter((c) => c.id !== clipId);
    carveRange(toTrack, start, start + duration, clip.id, fps, carveTailId);
    clip.timelineStart = start;
    toTrack.clips.push(clip);
    sortClips(fromTrack);
    sortClips(toTrack);
  });
}

export function deleteClips(project: Project, clipIds: string[]): Project {
  const ids = new Set(clipIds);
  return edit(project, (draft) => {
    for (const track of draft.sequence.tracks) {
      if (track.locked) continue;
      track.clips = track.clips.filter((c) => !ids.has(c.id));
    }
  });
}

/** Re-inserts previously-removed clips exactly where they were — how `DeleteClipsCommand` undoes
 *  itself, and why delete is safe to offer without a confirmation prompt. */
export function restoreClips(project: Project, entries: { trackId: string; clip: Clip }[]): Project {
  return edit(project, (draft) => {
    for (const { trackId, clip } of entries) {
      const track = findTrack(draft, trackId);
      if (!track) continue;
      track.clips.push(structuredClone(clip));
      sortClips(track);
    }
  });
}

export function setTrackFlag(
  project: Project,
  trackId: string,
  flag: "locked" | "visible" | "muted" | "solo",
  value: boolean
): Project {
  return edit(project, (draft) => {
    const track = findTrack(draft, trackId);
    if (!track) throw new EditError("That track no longer exists");
    track[flag] = value;
  });
}

/** Sets a track's own gain (linear — see `Track.gain`'s own doc comment), applying uniformly to
 *  every clip on the track on top of each clip's individual `gain`. Same "delete rather than store
 *  the identity value" convention as `setClipGain`, and the SAME `[0,4]` (400%) clamp applied at BOTH
 *  write time (here) and parse time (`parseTrack`) — unlike `Clip.gain`, whose parse-time clamp is
 *  `[0,1]` while its write-time clamp is `[0,4]`, a pre-existing inconsistency not worth repeating on
 *  a brand new field. Not gated on `track.locked` — `setTrackFlag` doesn't gate its own flag writes on
 *  lock either, and a track's own mixer fader is exactly that kind of track-level control, not a
 *  timeline edit `locked` is meant to guard (moving/trimming/deleting what's ON the track). */
export function setTrackGain(project: Project, trackId: string, gain: number): Project {
  return edit(project, (draft) => {
    const track = findTrack(draft, trackId);
    if (!track) throw new EditError("That track no longer exists");
    const clamped = Math.min(4, Math.max(0, gain));
    if (clamped === 1) {
      delete track.gain;
    } else {
      track.gain = clamped;
    }
  });
}

/** Sets a track's own stereo pan (see `Track.pan`'s own doc comment) — same clamp/delete-at-identity
 *  shape as `setTrackGain`, just a `[-1,1]` range around a `0` (center) identity instead of `[0,4]`
 *  around `1`. Not gated on `track.locked` — same reasoning as `setTrackGain`: a mixer control, not a
 *  timeline edit `locked` is meant to guard. */
export function setTrackPan(project: Project, trackId: string, pan: number): Project {
  return edit(project, (draft) => {
    const track = findTrack(draft, trackId);
    if (!track) throw new EditError("That track no longer exists");
    const clamped = Math.min(1, Math.max(-1, pan));
    if (clamped === 0) {
      delete track.pan;
    } else {
      track.pan = clamped;
    }
  });
}

/** Sets the sequence's overall master gain (see `Sequence.masterGain`'s own doc comment) — same
 *  clamp/delete-at-identity shape as `setTrackGain`, just addressed by the project's one sequence
 *  instead of a `trackId`, so there's no "not found" case to guard. */
export function setMasterGain(project: Project, gain: number): Project {
  return edit(project, (draft) => {
    const clamped = Math.min(4, Math.max(0, gain));
    if (clamped === 1) {
      delete draft.sequence.masterGain;
    } else {
      draft.sequence.masterGain = clamped;
    }
  });
}

/** Sets (or clears, when `cover` is `null`) the exported file's attached cover image (see
 *  `ExportSettings.cover`'s own doc comment) — persisted on the project itself, not the transient
 *  per-dialog state a resolution/CRF pick still is, since the track-header control that sets this
 *  needs somewhere to write to independent of whether the Export dialog even happens to be open. */
export function setExportCover(project: Project, cover: CoverSelection | null): Project {
  return edit(project, (draft) => {
    if (cover === null) {
      delete draft.exportSettings.cover;
    } else {
      draft.exportSettings.cover = cover;
    }
  });
}

/** Top-to-bottom grouping every track-ordering operation in this file maintains: video (the base
 *  layer), then text (composited over it), then audio (no visual role at all). Interleaving them
 *  would make "drag a clip one track down" land on a mismatched track kind and look like the drag
 *  simply failed — every editor groups by kind for this reason. */
export const isVisualTrackKind = (kind: TrackKind): boolean => kind === "video" || kind === "text";

const TRACK_ID_PREFIX: Record<TrackKind, string> = { video: "v", audio: "a", text: "t" };
const TRACK_NAME_PREFIX: Record<TrackKind, string> = { video: "V", audio: "A", text: "T" };

function insertionIndexForKind(tracks: Track[], kind: TrackKind): number {
  if (kind === "video") {
    const firstNonVideo = tracks.findIndex((t) => t.kind !== "video");
    return firstNonVideo !== -1 ? firstNonVideo : tracks.length;
  }
  if (kind === "text") {
    const firstAudio = tracks.findIndex((t) => t.kind === "audio");
    return firstAudio !== -1 ? firstAudio : tracks.length;
  }
  return tracks.length;
}

/** One past the HIGHEST `${prefix}N` currently used by a same-kind track — NOT just "count of
 *  same-kind tracks + 1", which produces a genuine duplicate once a track has ever been deleted:
 *  e.g. A1+A2 exist, A1 gets deleted, leaving only A2 — the next new audio track would compute
 *  count=1 -> "A2" again, colliding with the survivor. Confirmed live: this is exactly what happened
 *  when a voiceover recording auto-created a new audio track (see
 *  `editorStore.beginVoiceoverRecording`) after an earlier audio track had been removed.
 *
 *  Deliberately the highest-plus-one, not the lowest-unused gap: a gap-filling scheme would reuse
 *  "A1" here, but the new track is inserted at the END of the audio group (see
 *  `insertionIndexForKind`) — so the track list would read "A2" above "A1" top-to-bottom, numbers
 *  running backward. Always incrementing past the highest number ever assigned keeps numbering
 *  monotonic even across deletions, at the cost of gaps never being reclaimed — a smaller, less
 *  confusing tradeoff. */
function nextTrackName(tracks: Track[], kind: TrackKind): string {
  const prefix = TRACK_NAME_PREFIX[kind];
  let maxN = 0;
  for (const t of tracks) {
    if (t.kind !== kind) continue;
    const match = /^\D*(\d+)$/.exec(t.name);
    if (match) maxN = Math.max(maxN, Number(match[1]));
  }
  return `${prefix}${maxN + 1}`;
}

/** Adds a track, placing visual tracks in the visual stack and audio tracks in the audio group. */
export function addTrack(project: Project, kind: TrackKind, trackId?: string): Project {
  return edit(project, (draft) => {
    const name = nextTrackName(draft.sequence.tracks, kind);
    draft.sequence.tracks.splice(insertionIndexForKind(draft.sequence.tracks, kind), 0, {
      id: trackId ?? newTrackId(kind),
      kind,
      name,
      clips: [],
      locked: false,
      visible: true,
      muted: false,
      solo: false,
    });
  });
}

function newTrackId(kind: TrackKind): string {
  return newId(TRACK_ID_PREFIX[kind]);
}

/** Moves `trackId` to just before `beforeTrackId` within its own group (visual or audio).
 *  `beforeTrackId: null` means "move to the end of its group".
 *  Visual tracks (video and text) can be freely interleaved to control layer order! */
export function reorderTrack(project: Project, trackId: string, beforeTrackId: string | null): Project {
  return edit(project, (draft) => {
    const tracks = draft.sequence.tracks;
    const from = tracks.find((t) => t.id === trackId);
    if (!from) throw new EditError("That track no longer exists");

    const target = beforeTrackId ? tracks.find((t) => t.id === beforeTrackId) : undefined;
    if (beforeTrackId && !target) throw new EditError("That track no longer exists");

    if (target && isVisualTrackKind(from.kind) !== isVisualTrackKind(target.kind)) {
      throw new EditError(`${isVisualTrackKind(from.kind) ? "Visual" : "Audio"} and ${isVisualTrackKind(target.kind) ? "visual" : "audio"} tracks can't be mixed together`);
    }

    const without = tracks.filter((t) => t.id !== trackId);
    const insertAt = target ? without.findIndex((t) => t.id === beforeTrackId) : insertionIndexForKind(without, from.kind);
    without.splice(insertAt, 0, from);
    draft.sequence.tracks = without;
  });
}

/** Moves a visual or audio track one step up or down in the layer stack.
 *  In the timeline sequence array:
 *  - index 0 is the base layer (drawn first)
 *  - higher index is a higher layer (drawn on top)
 *  Direction "up" (bring forward) moves to higher index (+1).
 *  Direction "down" (send backward) moves to lower index (-1). */
export function moveTrackLayer(project: Project, trackId: string, direction: "up" | "down"): Project {
  return edit(project, (draft) => {
    const tracks = draft.sequence.tracks;
    const index = tracks.findIndex((t) => t.id === trackId);
    if (index === -1) throw new EditError("That track no longer exists");

    const track = tracks[index];
    const isVisual = isVisualTrackKind(track.kind);

    const targetIndex = direction === "up" ? index + 1 : index - 1;
    if (targetIndex < 0 || targetIndex >= tracks.length) return;

    const targetTrack = tracks[targetIndex];
    if (isVisualTrackKind(targetTrack.kind) !== isVisual) return;

    tracks[index] = targetTrack;
    tracks[targetIndex] = track;
  });
}

/** What a matted-video cutout needs to be placed as a clip. */
export interface VideoCutoutInfo {
  /** The flat colour the removed background was painted with. */
  keyColor: string;
  /** Seconds of the source clip the cutout covers. */
  windowSeconds: number;
}

/** Clip fields that make a matted video play in place of the clip it was cut from (the key is tight on purpose: the matte's
 *  background is one flat colour, so a small similarity removes it, while a wide one also eats light skin and clothes, which sit
 *  close to the mint key in RGB — measured on real footage: 0.2 turned a cream jacket and a face grey, 0.1 keeps them): it starts at 0 (the cutout file
 *  holds only the clip's own window), keeps the clip's speed, and keys out the flat background colour. */
export function videoCutoutFields(source: Clip, info: VideoCutoutInfo): Pick<Clip, "sourceIn" | "sourceOut" | "chromaKey" | "speed"> {
  return {
    sourceIn: 0,
    sourceOut: info.windowSeconds,
    chromaKey: { color: info.keyColor, similarity: 0.1, smoothness: 0.06, despill: 0.9 },
    ...(source.speed !== undefined ? { speed: source.speed } : null),
  };
}

/** Swaps a clip's video for its matted cutout, in place: same position on the timeline, subject only. */
export function applyVideoCutout(project: Project, clipId: string, cutoutAsset: Asset, info: VideoCutoutInfo): Project {
  return edit(project, (draft) => {
    const found = findClip(draft, clipId);
    if (!found) throw new EditError("That clip no longer exists");
    if (!draft.assets.some((a) => a.id === cutoutAsset.id)) draft.assets.push(cutoutAsset);
    Object.assign(found.clip, videoCutoutFields(found.clip, info), { assetId: cutoutAsset.id });
  });
}

/** Creates the viral 'Text Behind Subject' effect:
 *  1. Inserts a new text track directly after the source track.
 *  2. Adds a bold styled Text clip on that text track matching the source clip's duration and position.
 *  3. Inserts a new video track directly after the text track.
 *  4. Adds the cutout clip with the removed background on that top video track.
 *  Because tracks render in sequence order, the text sits behind the cutout subject! */
export function createTextBehindSubject(
  project: Project,
  sourceClipId: string,
  cutoutAsset: Asset,
  initialText = "TEXT BEHIND PERSON",
  customTextClipId?: string,
  customCutoutClipId?: string,
  /** Set when `cutoutAsset` is a matted VIDEO (see `videoCutoutClip`) rather than a still. */
  videoCutout?: VideoCutoutInfo
): { project: Project; textClipId: string; cutoutClipId: string } {
  const found = findClip(project, sourceClipId);
  if (!found) throw new EditError("Clip not found");
  const sourceClip = found.clip;

  const textTrackId = newTrackId("text");
  const cutoutTrackId = newTrackId("video");
  const textClipId = customTextClipId ?? newId("c");
  const cutoutClipId = customCutoutClipId ?? newId("c");

  const duration = clipDuration(sourceClip);

  // Modern bold punchy text style for the effect
  const boldStyle: TextStyle = {
    ...DEFAULT_TEXT_STYLE,
    fontSize: 90,
    bold: true,
    color: "#ffffff",
    align: "center",
    shadowColor: "rgba(0,0,0,0.6)",
    shadowOffsetX: 2,
    shadowOffsetY: 4,
  };

  const textAsset = createTextAsset(initialText, boldStyle);

  const updatedProject = edit(project, (draft) => {
    // Add text asset
    draft.assets.push(textAsset);
    // Add cutout asset if not already present
    if (!draft.assets.some((a) => a.id === cutoutAsset.id)) {
      draft.assets.push(cutoutAsset);
    }

    const sourceTrackIdx = draft.sequence.tracks.findIndex((t) => t.id === found.track.id);
    const insertIdx = sourceTrackIdx !== -1 ? sourceTrackIdx + 1 : insertionIndexForKind(draft.sequence.tracks, "text");

    const textTrack: Track = {
      id: textTrackId,
      kind: "text",
      name: nextTrackName(draft.sequence.tracks, "text"),
      clips: [
        {
          id: textClipId,
          assetId: textAsset.id,
          timelineStart: sourceClip.timelineStart,
          sourceIn: 0,
          sourceOut: duration,
        },
      ],
      locked: false,
      visible: true,
      muted: false,
      solo: false,
    };

    const cutoutTrack: Track = {
      id: cutoutTrackId,
      kind: "video",
      name: nextTrackName(draft.sequence.tracks, "video"),
      clips: [
        {
          id: cutoutClipId,
          assetId: cutoutAsset.id,
          timelineStart: sourceClip.timelineStart,
          sourceIn: sourceClip.sourceIn,
          sourceOut: sourceClip.sourceOut,
          transform: sourceClip.transform ? { ...sourceClip.transform } : undefined,
          ...(videoCutout ? videoCutoutFields(sourceClip, videoCutout) : null),
        },
      ],
      locked: false,
      visible: true,
      muted: false,
      solo: false,
    };

    // Insert text track, then cutout video track right above it
    draft.sequence.tracks.splice(insertIdx, 0, textTrack, cutoutTrack);
  });

  return { project: updatedProject, textClipId, cutoutClipId };
}

/** Removes a track and everything on it. Locked is a deliberate refusal, not a silent skip like
 *  `deleteClips`' locked-track handling — that function is a bulk op over a selection where silently
 *  protecting a locked track's clips and continuing is the right behavior, but this has exactly one
 *  target, so a clear refusal ("unlock it first") is more honest than pretending the click did
 *  nothing. The caller (`RemoveTrackCommand`) is what makes this safe to offer at all: it captures the
 *  removed track's full clip list before calling this, so undo restores every clip exactly. */
export function removeTrack(project: Project, trackId: string): Project {
  return edit(project, (draft) => {
    const track = findTrack(draft, trackId);
    if (!track) throw new EditError("That track no longer exists");
    if (track.locked) throw new EditError(`${track.name} is locked`);
    draft.sequence.tracks = draft.sequence.tracks.filter((t) => t.id !== trackId);
  });
}

/** Smallest fraction of the source that a crop must leave visible on each axis. Exists so a crop can
 *  never produce a zero or negative-size rect — `top: 0.9, bottom: 0.9` would otherwise be accepted
 *  and silently break the compositor and the export filter graph alike. */
const MIN_VISIBLE_FRACTION = 0.02;
const MIN_SCALE = 0.05;
const MAX_SCALE = 20;
/** A resize-corner drag multiplies `fontSize` directly (there's no separate scale field for text — see
 *  `TextStyle.fontSize`'s own comment) — clamped so a runaway drag or a hand-edited project file can't
 *  produce an invisible (near-zero) or absurdly-oversized-and-unrenderable value. */
const MIN_FONT_SIZE = 8;
const MAX_FONT_SIZE = 600;
/** A stroke wider than this stops reading as an outline and starts swallowing the glyph shapes it's
 *  supposed to be tracing — bounded relative to nothing in particular, just a generous ceiling. */
const MIN_STROKE_WIDTH = 0;
const MAX_STROKE_WIDTH = 60;
/** Below this, lines start overlapping; above it, a caption stops reading as one block. */
const MIN_LINE_HEIGHT_MULTIPLIER = 0.5;
const MAX_LINE_HEIGHT_MULTIPLIER = 3;

/** Clamps a user-supplied transform to values both renderers can safely draw. Rotation is the one
 *  field left untouched — see `ClipTransform.rotationDeg`'s own comment for why. */
function clampTransform(transform: ClipTransform): ClipTransform {
  const scale = Math.min(MAX_SCALE, Math.max(MIN_SCALE, transform.scale));

  // Each crop value is clamped to 0..(1 - MIN_VISIBLE_FRACTION) first so neither side can alone
  // consume the whole source, then the PAIR is re-balanced if it still leaves too little — clamping
  // each side independently isn't enough on its own (0.9 top + 0.9 bottom both individually pass a
  // 0..0.98 clamp but together leave nothing visible).
  function clampPair(a: number, b: number): [number, number] {
    const cap = 1 - MIN_VISIBLE_FRACTION;
    let ca = Math.min(cap, Math.max(0, a));
    let cb = Math.min(cap, Math.max(0, b));
    const over = ca + cb - cap;
    if (over > 0) {
      // Scale both down proportionally rather than favoring whichever was clamped first, so the
      // crop's rough shape survives even when it has to shrink to become valid.
      const factor = cap / (ca + cb);
      ca *= factor;
      cb *= factor;
    }
    return [ca, cb];
  }

  const [top, bottom] = clampPair(transform.crop.top, transform.crop.bottom);
  const [left, right] = clampPair(transform.crop.left, transform.crop.right);

  return {
    offsetX: transform.offsetX,
    offsetY: transform.offsetY,
    scale,
    rotationDeg: transform.rotationDeg,
    crop: { top, right, bottom, left },
  };
}

/** Sets a clip's transform (position/scale/rotation/crop) wholesale — callers read the current value
 *  (`clip.transform ?? IDENTITY_TRANSFORM`), patch the one field the user changed, and pass the whole
 *  object back, rather than this taking a partial patch itself. That keeps clamping in exactly one
 *  place instead of needing to merge-then-clamp on every call site. */
export function setClipTransform(project: Project, clipId: string, transform: ClipTransform): Project {
  return edit(project, (draft) => {
    const found = findClip(draft, clipId);
    if (!found) throw new EditError("That clip no longer exists");
    if (found.track.locked) throw new EditError(`${found.track.name} is locked`);
    const clamped = clampTransform(transform);
    // Storing an identity object instead of deleting the field would make undoing back to "never
    // transformed" leave a structurally different (if semantically equivalent) clip — the round-trip
    // exactness every other operation in this file preserves.
    if (isIdentityTransform(clamped)) {
      delete found.clip.transform;
    } else {
      found.clip.transform = clamped;
    }
  });
}

/** Toggles a visual clip's horizontal mirror without changing its source or transform geometry. */
export function setClipFlipHorizontal(project: Project, clipId: string, enabled: boolean): Project {
  return edit(project, (draft) => {
    const found = findClip(draft, clipId);
    if (!found) throw new EditError("That clip no longer exists");
    if (found.track.locked) throw new EditError(`${found.track.name} is locked`);
    if (enabled) found.clip.flipHorizontal = true;
    else delete found.clip.flipHorizontal;
  });
}

/** `setClipFlipHorizontal`'s own counterpart for the vertical mirror — see `Clip.flipVertical`'s own
 *  doc comment. Independent of `flipHorizontal`: a clip can be flipped on both axes at once (the same
 *  as a 180° rotation composed with neither, or either alone). */
export function setClipFlipVertical(project: Project, clipId: string, enabled: boolean): Project {
  return edit(project, (draft) => {
    const found = findClip(draft, clipId);
    if (!found) throw new EditError("That clip no longer exists");
    if (found.track.locked) throw new EditError(`${found.track.name} is locked`);
    if (enabled) found.clip.flipVertical = true;
    else delete found.clip.flipVertical;
  });
}

/** Sets how an image/video clip composites with visual tracks below it. Normal is represented by an
 * absent field, following the model's existing compact identity-value convention. */
export function setClipBlendMode(project: Project, clipId: string, blendMode: ClipBlendMode): Project {
  return edit(project, (draft) => {
    const found = findClip(draft, clipId);
    if (!found) throw new EditError("That clip no longer exists");
    if (found.track.locked) throw new EditError(`${found.track.name} is locked`);
    const asset = findAsset(draft, found.clip.assetId);
    if (found.track.kind !== "video" || (asset?.kind !== "video" && asset?.kind !== "image")) {
      throw new EditError("Blend is only available for image and video clips");
    }
    if (!CLIP_BLEND_MODES.includes(blendMode)) throw new EditError("Unknown blend mode");
    if (blendMode === "normal") delete found.clip.blendMode;
    else found.clip.blendMode = blendMode;
  });
}

export function setClipReverse(project: Project, clipId: string, enabled: boolean): Project {
  return edit(project, (draft) => {
    const found = findClip(draft, clipId);
    if (!found) throw new EditError("That clip no longer exists");
    if (found.track.locked) throw new EditError(`${found.track.name} is locked`);
    const asset = findAsset(draft, found.clip.assetId);
    if (asset?.kind !== "video") throw new EditError("Reverse is only available for video clips");
    if (enabled) found.clip.reverse = true;
    else delete found.clip.reverse;
  });
}

function clampClipMask(mask: ClipMask): ClipMask {
  return {
    shape: mask.shape === "ellipse" ? "ellipse" : "rectangle",
    centerX: Math.min(1, Math.max(0, mask.centerX)),
    centerY: Math.min(1, Math.max(0, mask.centerY)),
    width: Math.min(1, Math.max(0.01, mask.width)),
    height: Math.min(1, Math.max(0.01, mask.height)),
    feather: Math.min(0.5, Math.max(0, mask.feather)),
    invert: mask.invert === true,
  };
}

export function setClipMask(project: Project, clipId: string, mask: ClipMask | null): Project {
  return edit(project, (draft) => {
    const found = findClip(draft, clipId);
    if (!found) throw new EditError("That clip no longer exists");
    if (found.track.locked) throw new EditError(`${found.track.name} is locked`);
    if (mask) found.clip.mask = clampClipMask(mask);
    else delete found.clip.mask;
  });
}

/** Applies constant or curved video speed and ripples later clips by the duration delta. */
export function setClipSpeed(project: Project, clipId: string, speed: number, curve: SpeedCurvePoint[] | null = null): Project {
  return edit(project, (draft) => {
    const found = findClip(draft, clipId);
    if (!found) throw new EditError("That clip no longer exists");
    if (found.track.locked) throw new EditError(`${found.track.name} is locked`);
    const asset = findAsset(draft, found.clip.assetId);
    if (asset?.kind !== "video") throw new EditError("Speed is only available for video clips");
    const oldDuration = clipDuration(found.clip);
    const oldEnd = found.clip.timelineStart + oldDuration;
    const clampedSpeed = clampClipSpeed(speed);
    if (Math.abs(clampedSpeed - 1) < 1e-6) delete found.clip.speed;
    else found.clip.speed = clampedSpeed;
    const normalized = normalizedSpeedCurve(curve ?? undefined, clampedSpeed);
    if (normalized) found.clip.speedCurve = normalized;
    else delete found.clip.speedCurve;
    const newDuration = clipDuration(found.clip);
    const ratio = oldDuration > 1e-9 ? newDuration / oldDuration : 1;
    for (const key of ["transformKeyframes", "effectsKeyframes", "colorGradingKeyframes", "gainKeyframes"] as const) {
      const frames = found.clip[key];
      if (frames) for (const frame of frames) frame.time = Math.min(newDuration, Math.max(0, frame.time * ratio));
    }
    const delta = newDuration - oldDuration;
    if (Math.abs(delta) > 1e-9) {
      for (const other of found.track.clips) {
        if (other.id !== found.clip.id && other.timelineStart >= oldEnd - 1e-6) {
          other.timelineStart = snapToFrame(Math.max(0, other.timelineStart + delta), draft.sequence.fps);
        }
      }
      sortClips(found.track);
    }
  });
}

/** Same edge-PAIR rebalancing `clampTransform`'s own nested `clampPair` uses — `TextCrop` behaves like
 *  `ClipTransform.crop` (two independent axes, each pair must together leave `MIN_VISIBLE_FRACTION`
 *  visible), not like `ClipEffects`'s independently-clamped fields. Duplicated rather than extracted
 *  from `clampTransform`'s own closure — small enough that a shared top-level helper isn't worth the
 *  extra indirection for two call sites. */
function clampTextCrop(crop: TextCrop): TextCrop {
  function clampPair(a: number, b: number): [number, number] {
    const cap = 1 - MIN_VISIBLE_FRACTION;
    let ca = Math.min(cap, Math.max(0, a));
    let cb = Math.min(cap, Math.max(0, b));
    const over = ca + cb - cap;
    if (over > 0) {
      const factor = cap / (ca + cb);
      ca *= factor;
      cb *= factor;
    }
    return [ca, cb];
  }
  const [top, bottom] = clampPair(crop.top, crop.bottom);
  const [left, right] = clampPair(crop.left, crop.right);
  return { top, right, bottom, left };
}

/** Sets a text clip's crop wholesale — mirrors `setClipTransform`'s identity-collapse shape exactly
 *  (not `setClipChromaKey`'s presence-toggle one — see `TextCrop`'s own doc comment for why). */
export function setClipTextCrop(project: Project, clipId: string, crop: TextCrop): Project {
  return edit(project, (draft) => {
    const found = findClip(draft, clipId);
    if (!found) throw new EditError("That clip no longer exists");
    if (found.track.locked) throw new EditError(`${found.track.name} is locked`);
    const clamped = clampTextCrop(crop);
    if (isIdentityTextCrop(clamped)) {
      delete found.clip.textCrop;
    } else {
      found.clip.textCrop = clamped;
    }
  });
}

/** Mirrors `setClipTransformKeyframes`, for a text clip's `TextCrop`. */
export function setClipTextCropKeyframes(project: Project, clipId: string, keyframes: Clip["textCropKeyframes"] | null): Project {
  return edit(project, (draft) => {
    const found = findClip(draft, clipId);
    if (!found) throw new EditError("That clip no longer exists");
    if (found.track.locked) throw new EditError(`${found.track.name} is locked`);
    if (!keyframes || keyframes.length === 0) {
      delete found.clip.textCropKeyframes;
      return;
    }
    const duration = clipDuration(found.clip);
    found.clip.textCropKeyframes = keyframes
      .map((k) => ({ id: k.id, time: Math.min(duration, Math.max(0, k.time)), value: clampTextCrop(k.value) }))
      .sort((a, b) => a.time - b.time);
  });
}

const MIN_BRIGHTNESS = -1;
const MAX_BRIGHTNESS = 1;
const MIN_CONTRAST = 0;
const MAX_CONTRAST = 2;
const MIN_SATURATION = 0;
const MAX_SATURATION = 2;
const MIN_BLUR = 0;
const MAX_BLUR = 60;
const MIN_OPACITY = 0;
const MAX_OPACITY = 1;

function clampEffects(effects: ClipEffects): ClipEffects {
  return {
    brightness: Math.min(MAX_BRIGHTNESS, Math.max(MIN_BRIGHTNESS, effects.brightness)),
    contrast: Math.min(MAX_CONTRAST, Math.max(MIN_CONTRAST, effects.contrast)),
    saturation: Math.min(MAX_SATURATION, Math.max(MIN_SATURATION, effects.saturation)),
    blur: Math.min(MAX_BLUR, Math.max(MIN_BLUR, effects.blur)),
    opacity: Math.min(MAX_OPACITY, Math.max(MIN_OPACITY, effects.opacity)),
  };
}

/** Sets a clip's effects (brightness/contrast/saturation/blur/opacity) wholesale — same "read
 *  current, patch one field, pass the whole object back" pattern as `setClipTransform`, and for the
 *  same reason: clamping stays in exactly one place instead of needing to merge-then-clamp on every
 *  call site. */
export function setClipEffects(project: Project, clipId: string, effects: ClipEffects): Project {
  return edit(project, (draft) => {
    const found = findClip(draft, clipId);
    if (!found) throw new EditError("That clip no longer exists");
    if (found.track.locked) throw new EditError(`${found.track.name} is locked`);
    const clamped = clampEffects(effects);
    // Storing an identity object instead of deleting the field would make undoing back to "no
    // effects applied" leave a structurally different (if semantically equivalent) clip — the
    // round-trip exactness every other operation in this file preserves.
    if (isIdentityEffects(clamped)) {
      delete found.clip.effects;
    } else {
      found.clip.effects = clamped;
    }
  });
}

function clampCurve(curve: ColorCurve): ColorCurve {
  return curve
    .map((p) => ({ x: Math.min(1, Math.max(0, p.x)), y: Math.min(1, Math.max(0, p.y)) }))
    .sort((a, b) => a.x - b.x);
}

function clampColorGrading(grading: ColorGrading): ColorGrading {
  return {
    master: clampCurve(grading.master),
    red: clampCurve(grading.red),
    green: clampCurve(grading.green),
    blue: clampCurve(grading.blue),
  };
}

/** Sets a clip's RGB curves color grading wholesale — mirrors `setClipEffects` exactly (identity-collapse,
 *  not a presence-toggle the way `setClipChromaKey` is, since color grading has an unambiguous identity
 *  value — the flat diagonal — the same way effects' 0/1 values do). Deliberately does NOT enforce "the
 *  two endpoints must stay at x=0/x=1" here — that invariant belongs to `CurveEditor.tsx`'s own drag
 *  logic (endpoints are Y-only draggable in the UI), the same "some invariants enforced here, others left
 *  to the UI that produces well-formed input" split `clampTransform`'s own crop clamp already follows. */
export function setClipColorGrading(project: Project, clipId: string, grading: ColorGrading): Project {
  return edit(project, (draft) => {
    const found = findClip(draft, clipId);
    if (!found) throw new EditError("That clip no longer exists");
    if (found.track.locked) throw new EditError(`${found.track.name} is locked`);
    const clamped = clampColorGrading(grading);
    if (isIdentityColorGrading(clamped)) {
      delete found.clip.colorGrading;
    } else {
      found.clip.colorGrading = clamped;
    }
  });
}

/** Mirrors `setClipEffectsKeyframes`, for `ColorGrading`. */
export function setClipColorGradingKeyframes(project: Project, clipId: string, keyframes: Clip["colorGradingKeyframes"] | null): Project {
  return edit(project, (draft) => {
    const found = findClip(draft, clipId);
    if (!found) throw new EditError("That clip no longer exists");
    if (found.track.locked) throw new EditError(`${found.track.name} is locked`);
    if (!keyframes || keyframes.length === 0) {
      delete found.clip.colorGradingKeyframes;
      return;
    }
    const duration = clipDuration(found.clip);
    found.clip.colorGradingKeyframes = keyframes
      .map((k) => ({ id: k.id, time: Math.min(duration, Math.max(0, k.time)), value: clampColorGrading(k.value) }))
      .sort((a, b) => a.time - b.time);
  });
}

function clampChromaKey(settings: ChromaKeySettings): ChromaKeySettings {
  const isHex = /^#[0-9a-fA-F]{6}$/.test(settings.color);
  return {
    color: isHex ? settings.color : "#00ff00",
    similarity: Math.min(1, Math.max(0, settings.similarity)),
    smoothness: Math.min(1, Math.max(0, settings.smoothness)),
    ...(settings.despill ? { despill: Math.min(1, Math.max(0, settings.despill)) } : null),
  };
}

/** Sets or clears a clip's chroma key (`null` clears it — no identity-sentinel collapse the way
 *  `setClipTransform`'s does, matching `setClipTransitionIn`'s "no chroma key" shape: unlike a
 *  transform, there's no "chroma key value that's secretly a no-op" to collapse toward, only present
 *  or absent). See `ChromaKeySettings`'s own doc comment for why the fields mirror FFmpeg's `colorkey`
 *  filter so closely. */
/** Sets or clears a clip's outline/glow (`null`, or one with no thickness and no glow, clears it). */
export function setClipOutline(project: Project, clipId: string, outline: ClipOutline | null): Project {
  return edit(project, (draft) => {
    const found = findClip(draft, clipId);
    if (!found) throw new EditError("That clip no longer exists");
    if (found.track.locked) throw new EditError(`${found.track.name} is locked`);
    const width = outline ? Math.min(24, Math.max(0, outline.width)) : 0;
    const glow = outline ? Math.min(60, Math.max(0, outline.glow)) : 0;
    if (!outline || (width <= 0 && glow <= 0)) {
      delete found.clip.outline;
      return;
    }
    const isHex = (c: string | undefined) => typeof c === "string" && /^#[0-9a-fA-F]{6}$/.test(c);
    found.clip.outline = {
      color: isHex(outline.color) ? outline.color : "#ffffff",
      width,
      glow,
      ...(isHex(outline.glowColor) ? { glowColor: outline.glowColor } : null),
    };
  });
}

export function setClipChromaKey(project: Project, clipId: string, settings: ChromaKeySettings | null): Project {
  return edit(project, (draft) => {
    const found = findClip(draft, clipId);
    if (!found) throw new EditError("That clip no longer exists");
    if (found.track.locked) throw new EditError(`${found.track.name} is locked`);
    if (!settings) {
      delete found.clip.chromaKey;
    } else {
      found.clip.chromaKey = clampChromaKey(settings);
    }
  });
}

/** Sets or clears a clip's LUT (`null` clears it) — mirrors `setClipChromaKey` exactly: no identity-
 *  sentinel collapse (a LUT choice is discrete, "some LUT" or "no LUT", the same "present or absent,
 *  not secretly-a-no-op" shape chroma key has, unlike `setClipTransform`'s identity-collapsing one).
 *  Deliberately does NOT validate `lutId` against `project.luts` here — same reasoning
 *  `setClipChromaKey` needs no cross-reference check for its own `color` field: this is a pure,
 *  project-shape edit; a dangling reference (the LUT was deleted from a stale caller's perspective) is
 *  harmless and handled at RENDER time (`PlaybackEngine`'s cache-miss path just skips it), not here. */
export function setClipLut(project: Project, clipId: string, lutId: string | null): Project {
  return edit(project, (draft) => {
    const found = findClip(draft, clipId);
    if (!found) throw new EditError("That clip no longer exists");
    if (found.track.locked) throw new EditError(`${found.track.name} is locked`);
    if (!lutId) {
      delete found.clip.lutId;
      delete found.clip.lutIntensity;
    } else {
      found.clip.lutId = lutId;
    }
  });
}

/** Sets how strongly a clip's LUT is applied (`0..1`; `1` clears the field back to its "full strength"
 *  default so a project with no adjustment serializes exactly as before). */
export function setClipLutIntensity(project: Project, clipId: string, intensity: number | null): Project {
  return edit(project, (draft) => {
    const found = findClip(draft, clipId);
    if (!found) throw new EditError("That clip no longer exists");
    if (found.track.locked) throw new EditError(`${found.track.name} is locked`);
    const value = intensity === null ? 1 : normalizeLutIntensity(intensity);
    if (value >= 1) delete found.clip.lutIntensity;
    else found.clip.lutIntensity = value;
  });
}

/** Clears `lutId` from every clip that references `lutId` — the cascade a LUT deletion needs so a
 *  removed `LutAsset` doesn't leave clips pointing at a file that no longer exists. Used by the LUT
 *  import route's `DELETE` handler, which edits `project.json` directly (server-side, outside the
 *  undo stack — deleting a LUT from the library isn't itself a timeline edit, the same "library
 *  mutation, not a Command" split `MediaLibrary`'s own asset removal already follows) rather than
 *  through `run(new SetClipLutCommand(...))` per affected clip. */
export function removeLutReferences(project: Project, lutId: string): Project {
  return edit(project, (draft) => {
    for (const track of draft.sequence.tracks) {
      for (const clip of track.clips) {
        if (clip.lutId === lutId) {
          delete clip.lutId;
          delete clip.lutIntensity;
        }
      }
    }
  });
}

/** Sets or clears a clip's Transform keyframes wholesale (`null`/empty clears them, matching
 *  `setClipTransitionIn`'s "no identity sentinel, absent/null is itself meaningful" shape — an empty
 *  keyframe list is a distinct, meaningful state, "not keyframed," not a value to collapse toward like
 *  `setClipTransform`'s identity check does). Each keyframe's own `value` is clamped through the same
 *  `clampTransform` `setClipTransform` already uses (no new clamping logic), and `time` is clamped to
 *  `[0, clipDuration(clip)]` before the whole array is re-sorted — callers (the Inspector's auto-key
 *  helper, `TransformHandles`' drag commit) always pass the FULL next array, never a single point to
 *  merge in here. */
export function setClipTransformKeyframes(project: Project, clipId: string, keyframes: Clip["transformKeyframes"] | null): Project {
  return edit(project, (draft) => {
    const found = findClip(draft, clipId);
    if (!found) throw new EditError("That clip no longer exists");
    if (found.track.locked) throw new EditError(`${found.track.name} is locked`);
    if (!keyframes || keyframes.length === 0) {
      delete found.clip.transformKeyframes;
      return;
    }
    const duration = clipDuration(found.clip);
    found.clip.transformKeyframes = keyframes
      .map((k) => ({ id: k.id, time: Math.min(duration, Math.max(0, k.time)), value: clampTransform(k.value) }))
      .sort((a, b) => a.time - b.time);
  });
}

/** Mirrors `setClipTransformKeyframes`, for `ClipEffects`. */
export function setClipEffectsKeyframes(project: Project, clipId: string, keyframes: Clip["effectsKeyframes"] | null): Project {
  return edit(project, (draft) => {
    const found = findClip(draft, clipId);
    if (!found) throw new EditError("That clip no longer exists");
    if (found.track.locked) throw new EditError(`${found.track.name} is locked`);
    if (!keyframes || keyframes.length === 0) {
      delete found.clip.effectsKeyframes;
      return;
    }
    const duration = clipDuration(found.clip);
    found.clip.effectsKeyframes = keyframes
      .map((k) => ({ id: k.id, time: Math.min(duration, Math.max(0, k.time)), value: clampEffects(k.value) }))
      .sort((a, b) => a.time - b.time);
  });
}

/** Mirrors `setClipEffectsKeyframes`, for `Clip.gainKeyframes` — `[0,4]` clamp on each keyframe's
 *  `value`, the same bound `setClipGain` applies to the unkeyframed field (consistently at both parse
 *  and write time, deliberately not repeating `Clip.gain`'s own pre-existing `[0,1]`-parse/`[0,4]`-
 *  write inconsistency on this brand new field — see `serialize.ts`'s own parse-side comment). */
export function setClipGainKeyframes(project: Project, clipId: string, keyframes: Clip["gainKeyframes"] | null): Project {
  return edit(project, (draft) => {
    const found = findClip(draft, clipId);
    if (!found) throw new EditError("That clip no longer exists");
    if (found.track.locked) throw new EditError(`${found.track.name} is locked`);
    if (!keyframes || keyframes.length === 0) {
      delete found.clip.gainKeyframes;
      return;
    }
    const duration = clipDuration(found.clip);
    found.clip.gainKeyframes = keyframes
      .map((k) => ({ id: k.id, time: Math.min(duration, Math.max(0, k.time)), value: Math.min(4, Math.max(0, k.value)) }))
      .sort((a, b) => a.time - b.time);
  });
}

/** Same clamps `setTextAsset` applies to a static `TextStyle` — reused here so a keyframed value can
 *  never smuggle in an out-of-range font size/stroke width/line height that direct editing would have
 *  rejected. `fontSize`/`strokeWidth`/`lineHeightMultiplier` are the only TextStyle fields with a
 *  natural bound; the rest (offsetX/offsetY/rotationDeg/shadowOffsetX/Y) are deliberately unclamped,
 *  same reasoning as `clampTransform`'s own offset/rotation fields. */
function clampTextStyle(style: TextStyle): TextStyle {
  return {
    ...style,
    fontSize: Math.min(MAX_FONT_SIZE, Math.max(MIN_FONT_SIZE, style.fontSize)),
    strokeWidth: Math.min(MAX_STROKE_WIDTH, Math.max(MIN_STROKE_WIDTH, style.strokeWidth)),
    lineHeightMultiplier: Math.min(MAX_LINE_HEIGHT_MULTIPLIER, Math.max(MIN_LINE_HEIGHT_MULTIPLIER, style.lineHeightMultiplier)),
  };
}

/** Mirrors `setClipTransformKeyframes`, for a text clip's `TextStyle` — see `Clip.textStyleKeyframes`'s
 *  own doc comment for why this lives on the clip rather than alongside `setTextAsset`'s own static-
 *  value path. */
export function setClipTextStyleKeyframes(project: Project, clipId: string, keyframes: Clip["textStyleKeyframes"] | null): Project {
  return edit(project, (draft) => {
    const found = findClip(draft, clipId);
    if (!found) throw new EditError("That clip no longer exists");
    if (found.track.locked) throw new EditError(`${found.track.name} is locked`);
    if (!keyframes || keyframes.length === 0) {
      delete found.clip.textStyleKeyframes;
      return;
    }
    const duration = clipDuration(found.clip);
    found.clip.textStyleKeyframes = keyframes
      .map((k) => ({ id: k.id, time: Math.min(duration, Math.max(0, k.time)), value: clampTextStyle(k.value) }))
      .sort((a, b) => a.time - b.time);
  });
}

/** Sets or clears a clip's `transitionIn` (`null` clears it, matching `setClipMuted`'s `false`
 *  convention for a boolean-shaped optional field). Only `duration` is clamped — floored at one
 *  frame so a transition can never collapse to a zero-length no-op that still occupies a field; no
 *  ceiling here, since `findTransitionPartner` (`timeline/transitions.ts`) already bounds it against
 *  both clips' REAL current lengths at the point something actually renders it, which is a tighter,
 *  always-current limit than anything this function could enforce up front. */
export function setClipTransitionIn(project: Project, clipId: string, transitionIn: Clip["transitionIn"] | null): Project {
  return edit(project, (draft) => {
    const found = findClip(draft, clipId);
    if (!found) throw new EditError("That clip no longer exists");
    if (found.track.locked) throw new EditError(`${found.track.name} is locked`);
    if (!transitionIn) {
      delete found.clip.transitionIn;
    } else {
      const min = frameDuration(draft.sequence.fps);
      found.clip.transitionIn = { ...transitionIn, duration: Math.max(min, transitionIn.duration) };
    }
  });
}

/** Sets or clears a clip's `transitionOut` — same shape/clamping as `setClipTransitionIn` above, just
 *  the tail-fade field instead of the head-blend one. */
export function setClipTransitionOut(project: Project, clipId: string, transitionOut: Clip["transitionOut"] | null): Project {
  return edit(project, (draft) => {
    const found = findClip(draft, clipId);
    if (!found) throw new EditError("That clip no longer exists");
    if (found.track.locked) throw new EditError(`${found.track.name} is locked`);
    if (!transitionOut) {
      delete found.clip.transitionOut;
    } else {
      const min = frameDuration(draft.sequence.fps);
      found.clip.transitionOut = { ...transitionOut, duration: Math.max(min, transitionOut.duration) };
    }
  });
}

/** Sets or clears a clip's `textAnimation` — no clamping needed (unlike the transitions above, there's
 *  no duration field to floor against a minimum frame). */
export function setClipTextAnimation(project: Project, clipId: string, textAnimation: Clip["textAnimation"] | null): Project {
  return edit(project, (draft) => {
    const found = findClip(draft, clipId);
    if (!found) throw new EditError("That clip no longer exists");
    if (found.track.locked) throw new EditError(`${found.track.name} is locked`);
    if (!textAnimation) {
      delete found.clip.textAnimation;
    } else {
      found.clip.textAnimation = { ...textAnimation };
    }
  });
}

/** Sets or clears a text clip's entrance (`"in"`) or exit (`"out"`) animation — same shape as
 *  `setClipTextAnimation`, one field per side. */
export function setClipTextInOut(project: Project, clipId: string, which: "in" | "out", animation: Clip["textAnimationIn"] | null): Project {
  return edit(project, (draft) => {
    const found = findClip(draft, clipId);
    if (!found) throw new EditError("That clip no longer exists");
    if (found.track.locked) throw new EditError(`${found.track.name} is locked`);
    const key = which === "in" ? "textAnimationIn" : "textAnimationOut";
    if (!animation) {
      delete found.clip[key];
    } else {
      found.clip[key] = { ...animation };
    }
  });
}

/** Mirrors `setClipTextAnimation`'s exact shape, for `Clip.pixelEffect` instead — see its own doc
 *  comment for why this isn't keyframeable and so needs no `*Keyframes` sibling the way
 *  `transform`/`effects`/`colorGrading` each have. */
export function setClipPixelEffect(project: Project, clipId: string, pixelEffect: Clip["pixelEffect"] | null): Project {
  return edit(project, (draft) => {
    const found = findClip(draft, clipId);
    if (!found) throw new EditError("That clip no longer exists");
    if (found.track.locked) throw new EditError(`${found.track.name} is locked`);
    if (!pixelEffect) {
      delete found.clip.pixelEffect;
    } else {
      found.clip.pixelEffect = { ...pixelEffect };
    }
  });
}

/** Replaces a clip's ordered face-effect stack. This operation only edits project data; licensed SDK
 * work belongs to the provider runtime so undo/redo remains synchronous and deterministic. */
export function setClipFaceEffects(project: Project, clipId: string, faceEffects: Clip["faceEffects"] | null): Project {
  return edit(project, (draft) => {
    const found = findClip(draft, clipId);
    if (!found) throw new EditError("That clip no longer exists");
    if (found.track.locked) throw new EditError(`${found.track.name} is locked`);
    const asset = findAsset(draft, found.clip.assetId);
    if (!asset || (asset.kind !== "video" && asset.kind !== "image")) {
      throw new EditError("Face Effects can only be applied to images and videos");
    }
    if (!faceEffects || faceEffects.length === 0) {
      delete found.clip.faceEffects;
      return;
    }
    const ids = new Set<string>();
    found.clip.faceEffects = faceEffects.map((effect) => {
      if (typeof effect.id !== "string" || !effect.id || ids.has(effect.id)) throw new EditError("Each Face Effect must have a unique id");
      if (typeof effect.presetId !== "string" || !effect.presetId) throw new EditError("Face Effect preset is missing");
      if (!Number.isFinite(effect.intensity)) throw new EditError("Face Effect intensity must be a finite number");
      if (effect.target.kind === "trackedFace" && !effect.target.trackingId) {
        throw new EditError("Tracked Face id is missing");
      }
      ids.add(effect.id);
      return {
        ...effect,
        intensity: Math.min(1, Math.max(0, effect.intensity)),
        target: effect.target.kind === "trackedFace"
          ? { kind: "trackedFace", trackingId: effect.target.trackingId }
          : { kind: "all" },
      };
    });
  });
}

/** Mutes or unmutes a clip's own embedded audio. Like `transform`, `false` deletes the field rather
 *  than storing it explicitly — an unmuted clip's JSON stays exactly as small as it was before this
 *  feature existed, and undoing a mute toggle restores a truly absent field. */
export function setClipMuted(project: Project, clipId: string, muted: boolean): Project {
  return edit(project, (draft) => {
    const found = findClip(draft, clipId);
    if (!found) throw new EditError("That clip no longer exists");
    if (found.track.locked) throw new EditError(`${found.track.name} is locked`);
    if (muted) {
      found.clip.mutedAudio = true;
    } else {
      delete found.clip.mutedAudio;
    }
  });
}

/** Sets a clip's own audio gain (linear — see `Clip.gain`'s own doc comment). Routed through
 *  `AudioMixEngine`'s `GainNode`s rather than a media element's native `.volume`, so this can
 *  genuinely amplify, not just attenuate; the `4` ceiling (400%) is ordinary input-sanity clamping for
 *  the UI, not an architectural limit — `GainNode` itself has no ceiling. Same "delete rather than
 *  store the identity value" convention as `transform`/`effects`: an untouched clip's JSON stays
 *  exactly as small as before this feature existed, and undoing a gain change restores a truly absent
 *  field rather than an explicit `1`. */
export function setClipGain(project: Project, clipId: string, gain: number): Project {
  return edit(project, (draft) => {
    const found = findClip(draft, clipId);
    if (!found) throw new EditError("That clip no longer exists");
    if (found.track.locked) throw new EditError(`${found.track.name} is locked`);
    const clamped = Math.min(4, Math.max(0, gain));
    if (clamped === 1) {
      delete found.clip.gain;
    } else {
      found.clip.gain = clamped;
    }
  });
}

/** Sets a clip's own stereo pan (see `Clip.pan`'s own doc comment) — same `[-1,1]`/delete-at-`0` shape
 *  `setTrackPan` uses, but gated on `found.track.locked` the way `setClipGain` is: a CLIP-level edit,
 *  unlike a track's own mixer fader/pan (which aren't timeline edits `locked` is meant to guard). */
export function setClipPan(project: Project, clipId: string, pan: number): Project {
  return edit(project, (draft) => {
    const found = findClip(draft, clipId);
    if (!found) throw new EditError("That clip no longer exists");
    if (found.track.locked) throw new EditError(`${found.track.name} is locked`);
    const clamped = Math.min(1, Math.max(-1, pan));
    if (clamped === 0) {
      delete found.clip.pan;
    } else {
      found.clip.pan = clamped;
    }
  });
}

/** Sets a text asset's content and style wholesale — same "read current, patch one field, pass the
 *  whole object back" pattern as `setClipTransform`, and for the same reason: this is asset-level
 *  data (see `Asset.textContent`'s own doc comment), not clip-level, so it's addressed by asset id
 *  rather than clip id. Not locked-track-gated: editing what a text asset SAYS isn't a timeline edit
 *  the way moving/trimming its clip is — the same reasoning `removeAsset` already applies elsewhere. */
export function setTextAsset(project: Project, assetId: string, content: string, style: TextStyle): Project {
  return edit(project, (draft) => {
    const asset = draft.assets.find((a) => a.id === assetId);
    if (!asset) throw new EditError("That text no longer exists");
    if (asset.kind !== "text") throw new EditError("That asset isn't text");
    asset.textContent = content;
    // rotationDeg and the shadow offsets are deliberately left unclamped — same "any degree, multi-turn
    // drags exceed 360" reasoning as `ClipTransform.rotationDeg` (see `clampTransform`'s own comment);
    // a shadow offset has no natural bound the way size/stroke/line-height do.
    const fallback = DEFAULT_TEXT_STYLE;
    asset.textStyle = {
      ...style,
      fontSize: Math.min(MAX_FONT_SIZE, Math.max(MIN_FONT_SIZE, Number.isFinite(style.fontSize) ? style.fontSize : fallback.fontSize)),
      strokeWidth: Math.min(MAX_STROKE_WIDTH, Math.max(MIN_STROKE_WIDTH, Number.isFinite(style.strokeWidth) ? style.strokeWidth : fallback.strokeWidth)),
      lineHeightMultiplier: Math.min(
        MAX_LINE_HEIGHT_MULTIPLIER,
        Math.max(MIN_LINE_HEIGHT_MULTIPLIER, Number.isFinite(style.lineHeightMultiplier) ? style.lineHeightMultiplier : fallback.lineHeightMultiplier)
      ),
    };
    // Keeps the media library's own listing in sync — it shows `asset.name`, which was seeded from
    // the content at creation and would otherwise go stale forever the moment the text changes.
    asset.name = content.slice(0, 40) || "Text";
  });
}
