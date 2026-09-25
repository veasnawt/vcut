import { everyNthBeat } from "../audio/beatDetection.ts";
import { findAsset, findClip } from "../project/createProject.ts";
import type { Clip, Project } from "../project/types.ts";
import { EditError, splitClip } from "./operations.ts";

const hasCurve = (clip: Clip): boolean => Boolean(clip.speedCurve && clip.speedCurve.length >= 2);

/** Where an audio clip's detected beats fall on the timeline (seconds): the asset's beats inside the clip's own source
 *  window, moved to the clip's position and speed. Empty if the clip's asset has no beats, or the clip plays backwards or
 *  on a speed curve (its beats no longer fall on a regular map). */
export function beatTimelineTimes(project: Project, clip: Clip): number[] {
  const asset = findAsset(project, clip.assetId);
  const times = asset?.beats?.times;
  if (!times || times.length === 0 || clip.reverse || hasCurve(clip)) return [];
  const speed = clip.speed && clip.speed > 0 ? clip.speed : 1;
  const out: number[] = [];
  for (const time of times) {
    if (time < clip.sourceIn) continue;
    if (time >= clip.sourceOut) break;
    out.push(clip.timelineStart + (time - clip.sourceIn) / speed);
  }
  return out;
}

/** Every beat on the timeline, from every audio clip that has them — used to snap edits and the playhead to the beat. */
export function allBeatTimes(project: Project): number[] {
  const out: number[] = [];
  for (const track of project.sequence.tracks) {
    if (track.kind !== "audio") continue;
    for (const clip of track.clips) out.push(...beatTimelineTimes(project, clip));
  }
  return out.sort((a, b) => a - b);
}

const isPicture = (project: Project, clip: Clip): boolean => {
  const kind = findAsset(project, clip.assetId)?.kind;
  return kind === "video" || kind === "image" || kind === "color";
};

export interface FitResult {
  project: Project;
  /** Clips that now start and end on a beat. */
  applied: number;
  /** Clips left alone: on a speed curve or reversed, or after the beats ran out. */
  skipped: number;
}

/** Cuts a run of clips to the beat: the first clip starts on the beat nearest where it already starts, and every clip runs
 *  for `everyN` beats, one straight after the other. Each clip keeps its own place in the sequence (its order by start time).
 *  A clip's length changes by moving its out-point; if its source is too short it takes the last stretch of the source
 *  instead of running past the end. Clips that can't be timed this way are skipped and counted. */
export function fitClipsToBeats(project: Project, clipIds: readonly string[], beatTimes: readonly number[], everyN: number): FitResult {
  const grid = everyNthBeat(beatTimes, everyN);
  if (grid.length < 2) throw new EditError("Not enough beats — detect the beats of your music first");
  const draft = structuredClone(project);
  const clips = clipIds
    .map((id) => findClip(draft, id))
    .filter((found): found is NonNullable<typeof found> => Boolean(found) && isPicture(draft, found!.clip))
    .sort((a, b) => a.clip.timelineStart - b.clip.timelineStart);
  if (clips.length === 0) throw new EditError("Select the video or image clips to cut to the beat");

  // Start on the grid beat closest to where the first clip already starts.
  let startIndex = 0;
  let bestDistance = Infinity;
  grid.forEach((time, index) => {
    const distance = Math.abs(time - clips[0].clip.timelineStart);
    if (distance < bestDistance) {
      bestDistance = distance;
      startIndex = index;
    }
  });

  let applied = 0;
  let skipped = 0;
  clips.forEach(({ clip }, k) => {
    const start = grid[startIndex + k];
    const end = grid[startIndex + k + 1];
    if (start === undefined || end === undefined || clip.reverse || hasCurve(clip)) {
      skipped += 1;
      return;
    }
    const speed = clip.speed && clip.speed > 0 ? clip.speed : 1;
    const wanted = (end - start) * speed;
    const asset = findAsset(draft, clip.assetId);
    const available = asset && asset.kind === "video" ? asset.duration : Infinity;
    clip.timelineStart = start;
    if (available >= clip.sourceIn + wanted) {
      clip.sourceOut = clip.sourceIn + wanted;
    } else if (available >= wanted) {
      clip.sourceOut = available;
      clip.sourceIn = available - wanted;
    } else {
      clip.sourceIn = 0;
      clip.sourceOut = Math.max(0.05, available);
    }
    applied += 1;
  });
  draft.updatedAt = Date.now();
  return { project: draft, applied, skipped };
}

/** Splits one clip on the beat: a cut at every `everyN`th beat that falls strictly inside it. Returns the pieces' ids,
 *  earliest first. */
export function splitClipAtBeats(project: Project, clipId: string, beatTimes: readonly number[], everyN: number): { project: Project; clipIds: string[] } {
  const found = findClip(project, clipId);
  if (!found) throw new EditError("That clip no longer exists");
  const start = found.clip.timelineStart;
  const end = start + (found.clip.sourceOut - found.clip.sourceIn) / (found.clip.speed && found.clip.speed > 0 ? found.clip.speed : 1);
  const cuts = everyNthBeat(beatTimes, everyN).filter((time) => time > start + 0.05 && time < end - 0.05);
  if (cuts.length === 0) throw new EditError("No beats fall inside this clip");
  // Latest cut first: each split leaves the earlier part under the original id, so the ones before it stay valid.
  let next = project;
  const ids = [clipId];
  const tails: string[] = [];
  for (const time of [...cuts].sort((a, b) => b - a)) {
    const tailId = `${clipId}_b${tails.length}`;
    next = splitClip(next, clipId, time, tailId);
    tails.push(tailId);
  }
  return { project: next, clipIds: [...ids, ...tails.reverse()] };
}
