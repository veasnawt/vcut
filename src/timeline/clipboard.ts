import type { ClipboardEntry } from "../commands/index.ts";
import { clipEnd, findAsset, findClip, sequenceDuration } from "../project/createProject.ts";
import type { Project } from "../project/types.ts";

/** Snapshots `clipIds` for the clipboard: each clip as it stands right now, the track it sits on, and — for
 *  text — the words and style (a text clip's content lives on its asset, and pasting must still work after the
 *  original is deleted, e.g. Cut). Clips that no longer exist are skipped. Order follows `clipIds`. */
export function buildClipboardEntries(project: Project, clipIds: string[]): ClipboardEntry[] {
  const entries: ClipboardEntry[] = [];
  for (const clipId of clipIds) {
    const found = findClip(project, clipId);
    if (!found) continue;
    const asset = findAsset(project, found.clip.assetId);
    const textSnapshot =
      asset?.kind === "text" && asset.textStyle ? { content: asset.textContent ?? "", style: structuredClone(asset.textStyle) } : null;
    entries.push({ clip: structuredClone(found.clip), trackId: found.track.id, textSnapshot });
  }
  return entries;
}

/** Every time an editor would want to jump to: the start and end of every clip on every track, plus the very
 *  start and end of the sequence. Sorted, de-duplicated to within half a millisecond. */
export function editPointTimes(project: Project): number[] {
  const times = new Set<number>([0, sequenceDuration(project)]);
  for (const track of project.sequence.tracks) {
    for (const clip of track.clips) {
      times.add(clip.timelineStart);
      times.add(clipEnd(clip));
    }
  }
  const sorted = [...times].filter((t) => Number.isFinite(t) && t >= 0).sort((a, b) => a - b);
  return sorted.filter((t, i) => i === 0 || t - sorted[i - 1] > 0.0005);
}

/** The nearest edit point strictly before (`direction: -1`) or after (`1`) `playhead`, or `null` at either end.
 *  `epsilon` keeps a playhead sitting exactly on an edit point (or a frame-rounding hair away from it) from
 *  "finding" the point it's already on. */
export function adjacentEditPoint(times: number[], playhead: number, direction: -1 | 1, epsilon = 0.0005): number | null {
  if (direction === 1) return times.find((t) => t > playhead + epsilon) ?? null;
  for (let i = times.length - 1; i >= 0; i--) if (times[i] < playhead - epsilon) return times[i];
  return null;
}
