import { clipEnd } from "../project/createProject.ts";
import type { Clip, Project, Track, TrackKind } from "../project/types.ts";

/** The clip playing at `time` on this track, if any. Ranges are half-open — `[start, end)` — so two
 *  adjacent clips never both claim the boundary frame, which would make playback flicker between
 *  them and export ambiguous. */
export function clipAtTime(track: Track, time: number): Clip | undefined {
  return track.clips.find((c) => time >= c.timelineStart && time < clipEnd(c));
}

/** Every time value worth snapping to while dragging: zero, clip edges, and the playhead.
 *
 *  `trackKind`, when given, only collects edges from tracks of that SAME kind — `moveClip` already
 *  refuses to land a clip on a different-kind track, so a video clip being dragged can only ever end
 *  up on another video track anyway; without this filter, its snap points were pulled from every
 *  track regardless of kind, so it could get magnetically pulled toward some numerically-nearby text
 *  caption or audio clip's edge that has nothing to do with where it can actually land — noise that
 *  worked against exactly the "two clips of the same kind stick together" feel this is for. Omit it
 *  to fall back to every track (used by non-drag callers that don't have a kind to scope to).
 *
 *  `excludeClipIds` drops the clip(s) being dragged, which would otherwise snap to where they
 *  already are — a plain array (not just one id) so a multi-clip group drag can exclude every
 *  selected clip, not only the one directly under the pointer; otherwise the dragged clip could snap
 *  against its own group-mate's edge, which never means anything useful. */
export function snapPoints(
  project: Project,
  options?: { trackKind?: TrackKind; excludeClipIds?: string[]; playhead?: number }
): number[] {
  const exclude = new Set(options?.excludeClipIds ?? []);
  const points = new Set<number>([0]);
  for (const track of project.sequence.tracks) {
    if (options?.trackKind && track.kind !== options.trackKind) continue;
    for (const clip of track.clips) {
      if (exclude.has(clip.id)) continue;
      points.add(clip.timelineStart);
      points.add(clipEnd(clip));
    }
  }
  if (options?.playhead !== undefined) points.add(options.playhead);
  return [...points].sort((a, b) => a - b);
}

/** Snaps `time` to the nearest point within `threshold`, or returns it unchanged. `threshold` is
 *  supplied in SECONDS by the caller, converted from a fixed pixel distance at the current zoom — so
 *  snapping feels identically "sticky" whether zoomed way in or way out. */
export function snapTime(time: number, points: number[], threshold: number): number {
  let best = time;
  let bestDistance = threshold;
  for (const point of points) {
    const distance = Math.abs(point - time);
    if (distance < bestDistance) {
      bestDistance = distance;
      best = point;
    }
  }
  return best;
}

/** Where a NEW clip of `duration` seconds should start on `track` so it doesn't destroy anything
 *  already there: `desiredStart` (typically the playhead) if that range is actually free, or right
 *  after whichever clip is actually IN THE WAY otherwise — nudged forward past one conflict at a time
 *  (not straight to the track's own last clip, an earlier version of this that landed a new clip far
 *  away from the playhead whenever anything ELSE happened to sit later on the same track, confirmed
 *  directly as a real, reported "why did my text land way over there" surprise) until a genuinely free
 *  span is found, so back-to-back existing clips are each skipped in turn rather than only the first.
 *
 *  `addClip`'s own placement (operations.ts) carves away — or fully deletes — whatever already
 *  occupies the range being placed into, which is correct for a deliberate manual placement (dragging
 *  a clip, or double-clicking a specific asset onto a specific spot). It's a bad default for a "quick
 *  add" action meant to be pressed repeatedly without the user picking an exact spot each time (the
 *  toolbar's Text/Record buttons): pressing one twice without moving the playhead would silently carve
 *  away the first result to make room for the second, identically-positioned one — which looks like
 *  "replaced", not "added", and leaves the first one's now-orphaned asset behind in the Media library
 *  with nothing on the timeline to show for it. */
export function nonOverlappingStart(track: Track, desiredStart: number, duration: number): number {
  let start = desiredStart;
  for (;;) {
    const end = start + duration;
    const blocking = track.clips.find((c) => c.timelineStart < end && clipEnd(c) > start);
    if (!blocking) return start;
    start = clipEnd(blocking);
  }
}

/** Same idea as `nonOverlappingStart`, for a clip whose final duration isn't known yet (a live
 *  recording, still growing) — so there's no meaningful duration to check overlap against. Falls back
 *  the same way (right after whichever clip `at` actually falls inside, nudging past however many sit
 *  back-to-back from there) whenever the raw point isn't already free. */
export function nonOverlappingPointStart(track: Track, at: number): number {
  let point = at;
  for (;;) {
    const blocking = track.clips.find((c) => c.timelineStart <= point && clipEnd(c) > point);
    if (!blocking) return point;
    point = clipEnd(blocking);
  }
}

/** Whether anything is on the timeline at all — drives empty states and whether export is offered. */
export function isEmpty(project: Project): boolean {
  return project.sequence.tracks.every((t) => t.clips.length === 0);
}

/** Clips that make up the rendered video, in timeline order. Skips hidden tracks, matching what the
 *  compositor draws — so what you see in preview is what gets exported. */
export function visibleVideoClips(project: Project): { track: Track; clip: Clip }[] {
  const out: { track: Track; clip: Clip }[] = [];
  for (const track of project.sequence.tracks) {
    if (track.kind !== "video" || !track.visible) continue;
    for (const clip of track.clips) out.push({ track, clip });
  }
  return out.sort((a, b) => a.clip.timelineStart - b.clip.timelineStart);
}

/** Audible clips, honoring solo-overrides-mute (standard DAW behavior: if anything is soloed, only
 *  soloed tracks are heard). */
export function audibleClips(project: Project): { track: Track; clip: Clip }[] {
  const tracks = project.sequence.tracks.filter((t) => t.kind === "audio");
  const anySolo = tracks.some((t) => t.solo);
  const out: { track: Track; clip: Clip }[] = [];
  for (const track of tracks) {
    if (anySolo ? !track.solo : track.muted) continue;
    for (const clip of track.clips) out.push({ track, clip });
  }
  return out.sort((a, b) => a.clip.timelineStart - b.clip.timelineStart);
}
